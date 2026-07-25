'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createStore, hashValue } = require('./store');
const { normalizeClaim, applyClaimUpdate } = require('./claims');
const { clampBudget, consumeRetry, triggerScore } = require('./budget');
const { buildRubric, evaluateGate } = require('./verify');

const decisions = new Set(['proceed', 'proceed_with_change', 'blocked', 'escalate', 'stop_reflecting', 'closed', 'skip']);

class ReflectCore {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.store = options.store ?? createStore(options.storeRoot ?? process.env.TETHER_STORE_ROOT ?? path.join(this.projectRoot, '.tether'));
    this.authority = options.authority ?? 'model';
  }

  assess(input = {}, authority = this.authority) {
    const summary = bounded(input.summary ?? input.task ?? '', 2_000);
    if (!summary) throw new Error('assess requires summary');
    const claims = Array.isArray(input.claims) ? input.claims : [];
    const suppliedFlags = input.trigger_flags ?? input.triggerFlags ?? {};
    const triggerFlags = {
      ...suppliedFlags,
      // Material claims are a deterministic trigger even when a weak caller omits the flag.
      openMaterialClaims: suppliedFlags.openMaterialClaims ?? claims.some((claim) => ['material', 'critical'].includes(claim.materiality ?? 'material')),
    };
    const run = this.store.append('runs', {
      id: input.run_id ?? input.runId ?? crypto.randomUUID(), summary,
      task_kind: input.task_kind ?? input.taskKind ?? 'default', acceptance_criteria: normalizeCriteria(input.acceptance_criteria ?? input.acceptanceCriteria ?? []),
      authority, profile: input.profile ?? 'strong', status: 'open',
      trigger_flags: triggerFlags,
      trigger_score: triggerScore(triggerFlags), budget: clampBudget(input.budget),
      created_at: new Date().toISOString(), workspace_hash: input.workspace_hash ?? null,
    });
    for (const claim of claims) this.store.append('claims', normalizeClaim(claim, run.id));
    const score = run.trigger_score;
    const decision = score < 2 ? 'skip' : score >= 6 ? 'proceed_with_change' : 'proceed';
    return this.response(run, decision, score >= 6 ? ['Run verify before signoff.'] : [], [], { trigger_score: score });
  }

  checkpoint(input = {}, authority = this.authority) {
    const run = this.requireRun(input);
    if (authority === 'model' && input.waiver) throw new Error('model authority cannot waive claims or gates');
    for (const key of input.invalidated_keys ?? input.invalidatedKeys ?? []) {
      for (const claim of this.store.list('claims').filter((item) => item.run_id === run.id && item.invalidation_key === key && ['supported', 'refuted'].includes(item.status))) {
        this.store.append('claims', { ...claim, status: 'stale', stale_reason: `invalidation key changed: ${key}` });
      }
    }
    const updates = Array.isArray(input.claim_updates) ? input.claim_updates : (Array.isArray(input.claimUpdates) ? input.claimUpdates : []);
    for (const update of updates) {
      const current = this.store.get('claims', update.id);
      if (!current || current.run_id !== run.id) throw new Error(`unknown claim for run: ${update.id}`);
      this.store.append('claims', applyClaimUpdate(current, { ...update, run_id: run.id }));
    }
    const evidence = Array.isArray(input.evidence) ? input.evidence : [];
    for (const item of evidence.slice(0, 30)) this.store.append('evidence', normalizeEvidence(item, run.id, this.store, this.projectRoot));
    let retry = null;
    if (input.failure) {
      const failure = normalizeFailure(input.failure);
      retry = consumeRetry(this.store, run.id, failure.error_fingerprint, input.max_retries ?? 2);
      this.store.append('failures', { run_id: run.id, ...failure, retry_remaining: retry.remaining });
    }
    const decision = retry?.blocked ? 'blocked' : input.decision && decisions.has(input.decision) ? input.decision : 'proceed_with_change';
    const next = retry?.blocked ? ['Produce new evidence or escalate; identical retry budget is exhausted.'] : [];
    return this.response(run, decision, next, updates.map((update) => ({ id: update.id, status: update.status ?? 'updated' })), { retry });
  }

  verify(input = {}, authority = this.authority) {
    let run = this.requireRun(input);
    if (input.gate === 'high_risk') {
      run = this.store.append('runs', {
        ...run,
        intent_restatement: bounded(input.intent_restatement ?? '', 2_000),
        blast_radius: bounded(input.blast_radius ?? '', 2_000),
        why_safe: bounded(input.why_safe ?? '', 2_000),
      });
    }
    const rubric = buildRubric(run, input.rubric ?? input);
    this.store.append('rubrics', rubric);
    const checks = Array.isArray(input.checks) ? input.checks : (input.check ? [input.check] : []);
    for (const check of checks) this.store.append('checks', normalizeCheck(check, run.id, this.store));
    if (input.workspace_hash ?? input.workspaceHash) {
      run = this.store.append('runs', { ...run, verified_workspace_hash: input.workspace_hash ?? input.workspaceHash });
    }
    const gate = input.gate ?? null;
    const gateResult = gate ? evaluateGate(run, this.store, gate) : null;
    const decision = gateResult ? (gateResult.ok ? 'proceed' : 'blocked') : 'proceed';
    return this.response(run, decision, gateResult?.deficits ?? [], [], { rubric_id: rubric.id, gate: gateResult });
  }

  close(input = {}, authority = this.authority) {
    const run = this.requireRun(input);
    if (authority === 'model' && input.waiver) throw new Error('model authority cannot waive claims or gates');
    if (run.status === 'closed' && run.close_ledger_hash === this.ledgerHash(run.id)) {
      return this.response(run, 'closed', [], [], { idempotent: true });
    }
    const gate = evaluateGate(run, this.store, 'signoff');
    if (!gate.ok) return this.response(run, 'blocked', gate.deficits.map((deficit) => `Signoff deficit: ${deficit.code}`), [], { gate });
    const workspaceHash = input.workspace_hash ?? input.workspaceHash ?? run.workspace_hash;
    if (run.verified_workspace_hash && workspaceHash && run.verified_workspace_hash !== workspaceHash) {
      return this.response(run, 'blocked', ['Workspace changed after verification; run verify again.'], [], { code: 'workspace_changed' });
    }
    const ledgerHash = this.ledgerHash(run.id);
    this.store.append('decisions', { run_id: run.id, decision: 'closed', summary: bounded(input.summary ?? run.summary, 1_024), ledger_hash: ledgerHash, authority });
    for (const candidate of (input.memory_candidates ?? input.memoryCandidates ?? [])) {
      this.store.append('memory_candidates', { run_id: run.id, ...candidate, status: 'pending', authority: 'quarantine' });
    }
    const closed = this.store.append('runs', { ...run, status: 'closed', close_ledger_hash: ledgerHash, closed_at: new Date().toISOString() });
    return this.response(closed, 'closed', [], [], { gate, ledger_hash: ledgerHash });
  }

  show(runId) {
    const run = this.store.get('runs', runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    return this.state(run);
  }

  audit() {
    const runs = this.store.list('runs');
    return {
      runs: runs.length, open_runs: runs.filter((run) => run.status !== 'closed').length,
      approved_memory_candidates: this.store.list('memory_candidates').filter((row) => row.status === 'approved').length,
      stale_or_open_claims: this.store.list('claims').filter((row) => ['stale', 'open'].includes(row.status)).length,
      blocked_gates: this.store.list('decisions').filter((row) => row.decision === 'blocked').length,
    };
  }

  purge(runId) {
    if (!runId) throw new Error('purge requires run_id');
    this.store.purge((row) => row.run_id !== runId && row.id !== runId);
    return { purged: runId };
  }

  requireRun(input) {
    const runId = input.run_id ?? input.runId;
    if (typeof runId !== 'string' || !runId) throw new Error('operation requires run_id');
    const run = this.store.get('runs', runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    return run;
  }

  ledgerHash(runId) {
    const run = this.store.get('runs', runId);
    return `sha256:${hashValue({
      // Close status and timestamps are outputs of this hash, so they must not feed back into it.
      run: run ? { id: run.id, summary: run.summary, task_kind: run.task_kind, acceptance_criteria: run.acceptance_criteria, workspace_hash: run.workspace_hash } : null,
      claims: this.store.list('claims').filter((row) => row.run_id === runId),
      evidence: this.store.list('evidence').filter((row) => row.run_id === runId), checks: this.store.list('checks').filter((row) => row.run_id === runId),
    })}`;
  }

  state(run) {
    return {
      run_id: run.id, operation: 'checkpoint', decision: run.status === 'closed' ? 'closed' : 'proceed', summary: bounded(run.summary, 1_024),
      claims: this.store.list('claims').filter((row) => row.run_id === run.id), evidence: this.store.list('evidence').filter((row) => row.run_id === run.id),
      checks: this.store.list('checks').filter((row) => row.run_id === run.id), decisions: this.store.list('decisions').filter((row) => row.run_id === run.id),
      state_ref: `tether://run/${run.id}/state`, budget_used: run.budget,
    };
  }

  response(run, decision, nextActions = [], updates = [], extra = {}) {
    return {
      run_id: run.id, operation: extra.operation ?? 'tether', decision, summary: bounded(run.summary, 1_024),
      claim_updates: updates, next_actions: nextActions, unresolved: unresolved(this.store, run.id), context_refs: refs(this.store, run.id),
      state_ref: `tether://run/${run.id}/state`, budget_used: run.budget, ...extra,
    };
  }
}

function normalizeCriteria(criteria) {
  return criteria.slice(0, 30).map((criterion) => typeof criterion === 'string' ? criterion.slice(0, 500) : { ...criterion });
}

// A caller-supplied excerpt is an assertion, not proof: hashing it only proves the caller said it.
// When the locator names a readable file, hash the file itself and record whether the excerpt is
// actually present in it. Evidence that fails that check is downgraded to an unattested claim so it
// cannot satisfy a policy minimum, which is what stops a model from inventing a plausible locator.
function attestLocator(projectRoot, uri, locator, excerpt) {
  const target = fileFromLocator(uri, locator);
  if (!target) return { attested: false, reason: 'no_file_locator' };
  const resolved = path.resolve(projectRoot, target);
  // Evidence must come from inside the workspace; a locator pointing outside it is not attestable.
  if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
    return { attested: false, reason: 'outside_workspace' };
  }
  let contents;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > 4_000_000) return { attested: false, reason: 'unreadable_locator' };
    contents = fs.readFileSync(resolved, 'utf8');
  } catch {
    return { attested: false, reason: 'missing_locator' };
  }
  const source_hash = `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`;
  if (excerpt && !contents.includes(excerpt.trim())) {
    return { attested: false, reason: 'excerpt_not_in_source', source_hash };
  }
  return { attested: true, reason: 'verified_against_source', source_hash };
}

function fileFromLocator(uri, locator) {
  const raw = typeof uri === 'string' && uri.startsWith('file://') ? uri.slice('file://'.length) : locator;
  if (typeof raw !== 'string' || !raw) return null;
  // Accept "path", "path:12", and "path:12-40"; anything else is not a file locator.
  const match = /^([^:]+?)(?::\d+(?:-\d+)?)?$/.exec(raw.trim());
  return match ? match[1] : null;
}

function normalizeEvidence(item, runId, store, projectRoot) {
  const excerpt = bounded(item.excerpt ?? item.summary ?? '', 2_000);
  const payload = excerpt ? store.putObject(excerpt) : null;
  const attestation = attestLocator(projectRoot, item.uri, item.locator, excerpt);
  const claimedTrust = item.trust_class ?? item.trustClass ?? 'tool';
  // Supplying no file locator is not a false claim, so it keeps its trust class and simply cannot
  // satisfy the repo minimum. Supplying one that does not resolve or does not contain the excerpt
  // IS a false claim, and is downgraded so it counts for nothing anywhere.
  const falsified = !attestation.attested && attestation.reason !== 'no_file_locator';
  return {
    id: item.id ?? crypto.randomUUID(), run_id: runId, claim_ids: item.claim_ids ?? item.claimIds ?? [], kind: item.kind ?? 'observation',
    uri: item.uri ?? null, locator: item.locator ?? null, version_or_commit: item.version_or_commit ?? item.versionOrCommit ?? null,
    content_hash: attestation.source_hash ?? item.content_hash ?? payload?.hash ?? null,
    retrieved_at: item.retrieved_at ?? new Date().toISOString(), observed_at: item.observed_at ?? new Date().toISOString(),
    // A falsified locator cannot claim tool-grade trust; it is downgraded, not rejected, so the
    // record survives for audit while being disqualified from every policy minimum.
    trust_class: falsified ? 'model_claim' : claimedTrust,
    attested: attestation.attested, attestation_reason: attestation.reason,
    freshness_policy: item.freshness_policy ?? 'event-only',
    invalidation_key: item.invalidation_key ?? item.invalidationKey ?? attestation.source_hash ?? null,
    supports_or_refutes: item.supports_or_refutes ?? 'supports', excerpt,
    payload_ref: payload?.payload_ref ?? null, security_labels: item.security_labels ?? [],
  };
}

function normalizeCheck(check, runId, store) {
  const output = bounded(check.output ?? '', 4_000);
  const payload = output ? store.putObject(output) : null;
  return {
    id: check.id ?? crypto.randomUUID(), run_id: runId, kind: check.kind ?? 'script', specification: check.specification ?? check.command ?? '',
    command: check.command ?? null, executor: check.executor ?? 'host', env_fingerprint: check.env_fingerprint ?? null,
    workspace_hash: check.workspace_hash ?? null, status: check.status ?? 'failed', exit_code: Number.isInteger(check.exit_code) ? check.exit_code : null,
    output_ref: payload?.payload_ref ?? check.output_ref ?? null, recorded_at: new Date().toISOString(),
  };
}

function normalizeFailure(failure) {
  const normalized = {
    observed_failure: bounded(failure.observed_failure ?? failure.observed ?? '', 2_000), expected_behavior: bounded(failure.expected_behavior ?? failure.expected ?? '', 2_000),
    error_fingerprint: bounded(failure.error_fingerprint ?? failure.fingerprint ?? '', 256), last_relevant_mutation: bounded(failure.last_relevant_mutation ?? '', 1_000),
    contradicting_evidence: failure.contradicting_evidence ?? [], likely_failure_class: failure.likely_failure_class ?? 'unknown',
    corrected_hypothesis: bounded(failure.corrected_hypothesis ?? '', 1_000), next_falsifying_check: bounded(failure.next_falsifying_check ?? '', 1_000),
  };
  if (!normalized.error_fingerprint) throw new Error('failure requires error_fingerprint');
  return normalized;
}

function unresolved(store, runId) {
  return store.list('claims').filter((claim) => claim.run_id === runId && ['open', 'stale'].includes(claim.status)).map((claim) => ({ id: claim.id, text: claim.text, status: claim.status }));
}
function refs(store, runId) {
  return store.list('evidence').filter((item) => item.run_id === runId).map((item) => item.id).slice(-30);
}
function bounded(value, maximum) { return String(value ?? '').slice(0, maximum); }

module.exports = { ReflectCore, decisions };
