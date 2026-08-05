'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createStore, hashValue } = require('./store');
const { normalizeClaim, applyClaimUpdate } = require('./claims');
const { clampBudget, consumeRetry, triggerScore, buildRetryFingerprint } = require('./budget');
const { buildRubric, evaluateGate, runPreflightStub, acceptCortexOrientation } = require('./verify');
const { resolveDefaultStoreRoot, canonicalizePath } = require('./host');
const { actualActiveMinutes, evaluateVariance } = require('./time-accounting');

const decisions = new Set(['proceed', 'proceed_with_change', 'blocked', 'escalate', 'stop_reflecting', 'closed', 'skip']);

class ForgeCore {
  constructor(options = {}) {
    // Canonicalize so a project root supplied in-process (a literal string) and one re-derived
    // from a spawned child's process.cwd() (OS-realpath-resolved, e.g. macOS /var -> /private/var)
    // land on the identical string. Divergence here is Defect 0: it silently buckets the same
    // project into two different store roots, so a session/task binding written by one process
    // becomes invisible to a sibling process (the hook's spawned `cli.js resolve-session`).
    this.projectRoot = canonicalizePath(options.projectRoot ?? process.cwd());
    this.store = options.store ?? createStore(options.storeRoot ?? resolveDefaultStoreRoot(this.projectRoot));
    this.authority = options.authority ?? 'model';
    // Tests and alternative runtime configurations pass an explicit runtime config path so the
    // time-accounting reader can target a resident crypt service other than the one declared
    // by the workspace's default `tools/lib/memory/runtime.json`. The default behaviour is
    // unchanged: omit the option and the reader uses the canonical workspace config.
    this.runtimeConfigPath = options.runtimeConfigPath ?? null;
  }

  assess(input = {}, authority = this.authority) {
    const summary = bounded(input.summary ?? input.task ?? '', 2_000);
    if (!summary) throw new Error('assess requires summary');
    const claims = Array.isArray(input.claims) ? input.claims : [];
    const requestedRunId = input.run_id ?? input.runId;
    if (requestedRunId && this.store.get('runs', requestedRunId)) throw new Error(`run_id already exists: ${requestedRunId}`);
    const runId = requestedRunId ?? crypto.randomUUID();
    // Validate every claim before writing the run. A malformed claim must not leave a
    // ghost run that makes a corrected retry fail with "run_id already exists".
    const normalizedClaims = claims.map((claim) => normalizeClaim(claim, runId, authority));
    const suppliedFlags = input.trigger_flags ?? input.triggerFlags ?? {};
    const triggerFlags = {
      ...suppliedFlags,
      // Material claims are a deterministic trigger even when a weak caller omits the flag.
      openMaterialClaims: suppliedFlags.openMaterialClaims ?? normalizedClaims.some((claim) => ['material', 'critical'].includes(claim.materiality)),
    };
    const taskId = input.task_id ?? input.taskId ?? null;
    const sessionId = input.session_id ?? input.sessionId ?? null;
    const workspaceHash = input.workspace_hash ?? input.workspaceHash ?? null;
    const run = this.store.append('runs', {
      id: runId, summary,
      task_kind: input.task_kind ?? input.taskKind ?? 'default',
      acceptance_criteria: normalizeCriteria(input.acceptance_criteria ?? input.acceptanceCriteria ?? []),
      authority, profile: input.profile ?? 'strong', status: 'open',
      trigger_flags: triggerFlags,
      trigger_score: triggerScore(triggerFlags), budget: clampBudget(input.budget),
      created_at: new Date().toISOString(),
      workspace_hash: workspaceHash,
      task_id: taskId,
      session_id: sessionId,
    });
    for (const claim of normalizedClaims) this.store.append('claims', claim);
    if (sessionId) this.bindIdentity({ session_id: sessionId, run_id: runId, task_id: taskId, workspace_hash: workspaceHash });
    else if (taskId) this.bindIdentity({ task_id: taskId, run_id: runId, workspace_hash: workspaceHash });
    const score = run.trigger_score;
    const decision = score < 2 ? 'skip' : score >= 6 ? 'proceed_with_change' : 'proceed';
    return this.response(run, decision, score >= 6 ? ['Run verify before signoff.'] : [], [], { trigger_score: score, authority });
  }

  checkpoint(input = {}, authority = this.authority) {
    const run = this.requireOpenRun(input);
    if (authority === 'model' && input.waiver) throw new Error('model authority cannot waive claims or gates');
    for (const key of input.invalidated_keys ?? input.invalidatedKeys ?? []) {
      for (const claim of this.store.list('claims').filter((item) => item.run_id === run.id && item.invalidation_key === key && ['supported', 'refuted'].includes(item.status))) {
        this.store.append('claims', { ...claim, status: 'stale', stale_reason: `invalidation key changed: ${key}` });
      }
      for (const item of this.store.list('evidence').filter((row) => row.run_id === run.id && row.invalidation_key === key && !row.stale)) {
        this.store.append('evidence', { ...item, stale: true, stale_reason: `invalidation key changed: ${key}`, trust_class: 'model_claim' });
      }
    }
    const updates = Array.isArray(input.claim_updates) ? input.claim_updates : (Array.isArray(input.claimUpdates) ? input.claimUpdates : []);
    for (const update of updates) {
      const current = this.store.get('claims', update.id);
      if (!current || current.run_id !== run.id) throw new Error(`unknown claim for run: ${update.id}`);
      this.store.append('claims', applyClaimUpdate(current, { ...update, run_id: run.id }, authority));
    }
    const evidence = Array.isArray(input.evidence) ? input.evidence : [];
    for (const item of evidence.slice(0, 30)) {
      this.store.append('evidence', normalizeEvidence(item, run.id, this.store, this.projectRoot, authority));
    }
    const checks = Array.isArray(input.checks) ? input.checks : [];
    for (const check of checks.slice(0, 20)) {
      this.store.append('checks', normalizeCheck(check, run.id, this.store, authority));
    }
    let retry = null;
    if (input.failure) {
      const failure = normalizeFailure(input.failure, input);
      retry = consumeRetry(this.store, run.id, failure.error_fingerprint, input.max_retries ?? 2);
      this.store.append('failures', { run_id: run.id, ...failure, retry_remaining: retry.remaining });
    }
    const decision = retry?.blocked ? 'blocked' : input.decision && decisions.has(input.decision) ? input.decision : 'proceed_with_change';
    const next = retry?.blocked ? ['Produce new evidence or escalate; identical retry budget is exhausted.'] : [];
    return this.response(run, decision, next, updates.map((update) => ({ id: update.id, status: update.status ?? 'updated' })), { retry, authority });
  }

  verify(input = {}, authority = this.authority) {
    let run = this.requireOpenRun(input);
    if (input.gate === 'high_risk') {
      run = this.store.append('runs', {
        ...run,
        intent_restatement: bounded(input.intent_restatement ?? '', 2_000),
        blast_radius: bounded(input.blast_radius ?? '', 2_000),
        why_safe: bounded(input.why_safe ?? '', 2_000),
      });
    }
    const rubric = buildRubric(run, input.rubric ?? input);
    const rubricVersion = hashValue(rubric);
    this.store.append('rubrics', { ...rubric, version: rubricVersion });
    run = this.store.append('runs', {
      ...run,
      verified_rubric_id: rubric.id,
      verified_rubric_version: rubricVersion,
      verified_at: new Date().toISOString(),
    });
    const preflight = runPreflightStub(rubric);
    const checks = Array.isArray(input.checks) ? input.checks : (input.check ? [input.check] : []);
    for (const check of checks) this.store.append('checks', normalizeCheck(check, run.id, this.store, authority));
    if (input.workspace_hash ?? input.workspaceHash) {
      run = this.store.append('runs', { ...run, verified_workspace_hash: input.workspace_hash ?? input.workspaceHash });
    }
    const gate = input.gate ?? null;
    if (gate) this.refreshAttestations(run.id);
    const gateResult = gate ? evaluateGate(run, this.store, gate) : null;
    const decision = gateResult ? (gateResult.ok ? 'proceed' : 'blocked') : 'proceed';
    if (gateResult && !gateResult.ok) this.store.append('decisions', { run_id: run.id, decision: 'blocked', gate, deficits: gateResult.deficits, authority });
    return this.response(run, decision, gateResult?.deficits ?? [], [], { rubric_id: rubric.id, rubric_version: rubricVersion, gate: gateResult, preflight, authority });
  }

  async close(input = {}, authority = this.authority) {
    if (Object.hasOwn(input, 'rubric')) throw new Error('rubric belongs to verify');
    const run = this.requireRun(input);
    if (!run.verified_rubric_id || !run.verified_rubric_version || !run.verified_at) {
      return this.response(run, 'blocked', ['Run verify before close.'], [], { code: 'unverified_run', authority });
    }
    const verifiedRubric = this.store.get('rubrics', run.verified_rubric_id);
    if (!verifiedRubric || verifiedRubric.version !== run.verified_rubric_version) {
      return this.response(run, 'blocked', ['Verified rubric version is unavailable; run verify again.'], [], { code: 'rubric_version_mismatch', authority });
    }
    if (authority === 'model' && input.waiver) throw new Error('model authority cannot waive claims or gates');
    if (run.status === 'closed' && run.close_ledger_hash === this.ledgerHash(run.id)) {
      return this.response(run, 'closed', [], [], { idempotent: true, authority });
    }
    this.refreshAttestations(run.id);
    const gate = evaluateGate(run, this.store, 'signoff');
    if (!gate.ok) {
      this.store.append('decisions', { run_id: run.id, decision: 'blocked', gate: 'signoff', deficits: gate.deficits, authority });
      return this.response(run, 'blocked', gate.deficits.map((deficit) => `Signoff deficit: ${deficit.code}`), [], { gate, authority });
    }
    const workspaceHash = input.workspace_hash ?? input.workspaceHash ?? run.workspace_hash;
    if (run.verified_workspace_hash && workspaceHash && run.verified_workspace_hash !== workspaceHash) {
      return this.response(run, 'blocked', ['Workspace changed after verification; run verify again.'], [], { code: 'workspace_changed', authority });
    }
    // Time-accounting (workspace rule 6.6): recorded only, never blocking, never force-closing.
    // Requires the caller to supply a planned budget and the run to carry a session_id -- absent
    // either, this is silently skipped rather than treated as a miss.
    const timeReceipt = input.time_receipt ?? input.timeReceipt;
    const plannedMinutes = Number(timeReceipt?.planned_minutes ?? timeReceipt?.plannedMinutes);
    let timeVariance = null;
    if (Number.isFinite(plannedMinutes) && plannedMinutes > 0 && run.session_id) {
      const measured = await actualActiveMinutes({
        sessionId: run.session_id,
        sinceIso: run.created_at,
        configPath: this.runtimeConfigPath ?? undefined,
      });
      if (measured) timeVariance = evaluateVariance(plannedMinutes, measured.minutes);
    }
    const ledgerHash = this.ledgerHash(run.id);
    const closeTransactionId = crypto.randomUUID();
    const entries = [{
      table: 'decisions',
      value: { run_id: run.id, decision: 'closed', summary: bounded(input.summary ?? run.summary, 1_024), ledger_hash: ledgerHash, authority, close_transaction_id: closeTransactionId, ...(timeVariance ? { time_variance: timeVariance } : {}) },
    }];
    for (const candidate of (input.memory_candidates ?? input.memoryCandidates ?? [])) {
      entries.push({ table: 'memory_candidates', value: { run_id: run.id, ...candidate, status: 'pending', authority: 'quarantine', close_transaction_id: closeTransactionId } });
    }
    entries.push({ table: 'runs', value: { ...run, status: 'closed', close_ledger_hash: ledgerHash, closed_at: new Date().toISOString(), close_transaction_id: closeTransactionId } });
    const rows = this.store.appendBatch(entries);
    const closed = rows.at(-1);
    return this.response(closed, 'closed', [], [], { gate, ledger_hash: ledgerHash, authority, ...(timeVariance ? { time_variance: timeVariance } : {}) });
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

  /**
   * Bind session/task/workspace identity to a run. Never invent a binding from
   * "the sole open run" — that heuristic is retired.
   */
  resolveSession(input = {}) {
    const sessionId = input.session_id ?? input.sessionId;
    const taskId = input.task_id ?? input.taskId ?? null;
    const workspaceHash = input.workspace_hash ?? input.workspaceHash ?? null;
    const requestedRunId = input.run_id ?? input.runId ?? null;

    if (taskId) {
      const taskBinding = this.store.get('task_bindings', taskId);
      const taskRun = taskBinding ? this.store.get('runs', taskBinding.run_id) : null;
      if (taskRun && taskRun.status !== 'closed') {
        if (workspaceHash && taskRun.workspace_hash && taskRun.workspace_hash !== workspaceHash) {
          return { run_id: null, status: 'workspace_mismatch' };
        }
        if (sessionId) this.bindIdentity({ session_id: sessionId, run_id: taskRun.id, task_id: taskId, workspace_hash: workspaceHash ?? taskRun.workspace_hash });
        return { run_id: taskRun.id, status: 'existing', via: 'task' };
      }
    }

    if (typeof sessionId === 'string' && sessionId && sessionId.length <= 256) {
      const existing = this.store.get('session_bindings', sessionId);
      const existingRun = existing ? this.store.get('runs', existing.run_id) : null;
      if (existingRun && existingRun.status !== 'closed') {
        if (workspaceHash && existingRun.workspace_hash && existingRun.workspace_hash !== workspaceHash) {
          return { run_id: null, status: 'workspace_mismatch' };
        }
        return { run_id: existingRun.id, status: 'existing', via: 'session' };
      }
      if (existing && existingRun?.status === 'closed') {
        return { run_id: null, status: 'closed', via: 'session' };
      }
    } else if (sessionId != null && sessionId !== '') {
      throw new Error('resolve-session requires session_id');
    }

    if (!requestedRunId) {
      return { run_id: null, status: 'unbound', reason: 'explicit_run_id_required' };
    }
    if (!sessionId && !taskId) {
      throw new Error('resolve-session requires session_id or task_id');
    }

    const run = this.store.get('runs', requestedRunId);
    if (!run || run.status === 'closed') {
      return { run_id: null, status: 'none' };
    }
    if (workspaceHash && run.workspace_hash && run.workspace_hash !== workspaceHash) {
      return { run_id: null, status: 'workspace_mismatch' };
    }
    this.bindIdentity({
      session_id: sessionId || undefined,
      task_id: taskId || undefined,
      run_id: run.id,
      workspace_hash: workspaceHash ?? run.workspace_hash,
    });
    return { run_id: run.id, status: 'bound' };
  }

  bindIdentity({ session_id, task_id, run_id, workspace_hash } = {}) {
    if (!run_id) throw new Error('bindIdentity requires run_id');
    if (session_id) {
      this.store.append('session_bindings', {
        id: session_id, session_id, run_id, project_root: this.projectRoot,
        workspace_hash: workspace_hash ?? null, task_id: task_id ?? null,
      });
    }
    if (task_id) {
      this.store.append('task_bindings', {
        id: task_id, task_id, run_id, project_root: this.projectRoot,
        workspace_hash: workspace_hash ?? null, session_id: session_id ?? null,
      });
    }
  }

  purge(runId) {
    if (!runId) throw new Error('purge requires run_id');
    this.store.purge((row) => row.run_id === runId || row.id === runId);
    return { purged: runId };
  }

  requireRun(input) {
    const runId = input.run_id ?? input.runId;
    if (typeof runId !== 'string' || !runId) throw new Error('operation requires run_id');
    const run = this.store.get('runs', runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    return run;
  }

  requireOpenRun(input) {
    const run = this.requireRun(input);
    if (run.status === 'closed') throw new Error(`cannot mutate closed run: ${run.id}`);
    return run;
  }

  refreshAttestations(runId) {
    for (const item of this.store.list('evidence').filter((row) => row.run_id === runId && row.locator && row.attested === true && !row.stale)) {
      const attestation = attestLocator(this.projectRoot, item.uri, item.locator, item.excerpt);
      if (!attestation.attested || attestation.source_hash !== item.content_hash) {
        this.store.append('evidence', {
          ...item,
          attested: false,
          stale: true,
          stale_reason: attestation.attested ? 'source_hash_changed' : attestation.reason,
          attestation_reason: attestation.reason,
          current_content_hash: attestation.source_hash ?? null,
          trust_class: 'model_claim',
        });
      }
    }
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
      state_ref: `forge://run/${run.id}/state`, budget_used: run.budget,
    };
  }

  response(run, decision, nextActions = [], updates = [], extra = {}) {
    return {
      run_id: run.id, operation: extra.operation ?? 'forge', decision, summary: bounded(run.summary, 1_024),
      claim_updates: updates, next_actions: nextActions, unresolved: unresolved(this.store, run.id), context_refs: refs(this.store, run.id),
      state_ref: `forge://run/${run.id}/state`, budget_used: run.budget, ...extra,
    };
  }
}

// Canonicalize to the {id, criterion} shape buildRubric requires, so a malformed
// criterion fails here — where the caller can still fix it — not at signoff.
function normalizeCriteria(criteria) {
  return criteria.slice(0, 30).map((entry, index) => {
    const source = typeof entry === 'string' ? { criterion: entry } : entry;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`acceptance criterion ${index} must be a string or an object`);
    }
    const text = [source.criterion, source.text].find((value) => typeof value === 'string' && value.trim());
    if (!text) throw new Error(`acceptance criterion ${index} requires criterion text in "criterion" or "text"`);
    return {
      ...source,
      id: source.id ?? `criterion-${index}`,
      criterion: text.trim().slice(0, 500),
      execution_contract: source.execution_contract ?? source.executionContract ?? null,
    };
  });
}

/**
 * Parse file locators without treating Windows drive letters as line separators.
 * Accepts: path, path:12, path:12-40, C:\\dir\\file.js:10-20, path#symbol, path:12#symbol.
 */
function parseLocator(uri, locator) {
  let raw = typeof uri === 'string' && uri.startsWith('file://') ? uri.slice('file://'.length) : locator;
  if (typeof raw !== 'string' || !raw) return null;
  raw = raw.trim();
  if (raw.startsWith('file://')) raw = raw.slice('file://'.length);

  let symbol = null;
  const hashIndex = raw.lastIndexOf('#');
  if (hashIndex > 0) {
    symbol = raw.slice(hashIndex + 1) || null;
    raw = raw.slice(0, hashIndex);
  }

  let startLine = null;
  let endLine = null;
  let file = raw;
  const rangeMatch = /:(\d+)(?:-(\d+))?$/.exec(raw);
  if (rangeMatch) {
    const before = raw.slice(0, rangeMatch.index);
    // "C" alone before :digits is a drive letter, not a path with a line range.
    const windowsDriveOnly = /^[A-Za-z]$/.test(before);
    if (!windowsDriveOnly) {
      startLine = Number(rangeMatch[1]);
      endLine = rangeMatch[2] ? Number(rangeMatch[2]) : startLine;
      file = before;
    }
  }
  if (!file) return null;
  return { file, startLine, endLine, symbol };
}

function fileFromLocator(uri, locator) {
  return parseLocator(uri, locator)?.file ?? null;
}

function hashRegion(contents, { startLine, endLine, symbol } = {}) {
  let region = contents;
  if (startLine != null) {
    const lines = contents.split(/\r?\n/);
    const start = Math.max(1, startLine) - 1;
    const end = Math.min(lines.length, endLine ?? startLine);
    region = lines.slice(start, end).join('\n');
  }
  if (symbol) {
    // Minimal symbol binding: require the symbol token in the region (or whole file when no range).
    if (!region.includes(symbol) && !contents.includes(symbol)) {
      return { ok: false, reason: 'symbol_not_in_source' };
    }
    region = `symbol:${symbol}\n${region}`;
  }
  return {
    ok: true,
    source_hash: `sha256:${crypto.createHash('sha256').update(region).digest('hex')}`,
    region_bytes: Buffer.byteLength(region),
  };
}

// A caller-supplied excerpt is an assertion, not proof: hashing it only proves the caller said it.
// When the locator names a readable file, hash the file (or ranged region / symbol slice) itself.
function attestLocator(projectRoot, uri, locator, excerpt) {
  const parsed = parseLocator(uri, locator);
  if (!parsed?.file) return { attested: false, reason: 'no_file_locator' };
  const resolved = path.resolve(projectRoot, parsed.file);
  let realProjectRoot;
  let realResolved;
  try {
    realProjectRoot = fs.realpathSync(projectRoot);
    realResolved = fs.realpathSync(resolved);
  } catch {
    return { attested: false, reason: 'missing_locator' };
  }
  // Evidence must come from inside the workspace; a locator pointing outside it is not attestable.
  if (realResolved !== realProjectRoot && !realResolved.startsWith(realProjectRoot + path.sep)) {
    return { attested: false, reason: 'outside_workspace' };
  }
  let contents;
  try {
    const stat = fs.statSync(realResolved);
    if (!stat.isFile() || stat.size > 4_000_000) return { attested: false, reason: 'unreadable_locator' };
    contents = fs.readFileSync(realResolved, 'utf8');
  } catch {
    return { attested: false, reason: 'missing_locator' };
  }
  const hashed = hashRegion(contents, parsed);
  if (!hashed.ok) return { attested: false, reason: hashed.reason };
  if (excerpt) {
    const needle = excerpt.trim();
    const lines = contents.split(/\r?\n/);
    const region = parsed.startLine != null
      ? lines.slice(Math.max(1, parsed.startLine) - 1, Math.min(lines.length, parsed.endLine ?? parsed.startLine)).join('\n')
      : contents;
    if (!contents.includes(needle) && !region.includes(needle)) {
      return { attested: false, reason: 'excerpt_not_in_source', source_hash: hashed.source_hash };
    }
  }
  return {
    attested: true,
    reason: parsed.startLine != null || parsed.symbol ? 'verified_region_against_source' : 'verified_against_source',
    source_hash: hashed.source_hash,
    start_line: parsed.startLine,
    end_line: parsed.endLine,
    symbol: parsed.symbol,
  };
}

function normalizeEvidence(item, runId, store, projectRoot, authority = 'model') {
  const excerpt = bounded(item.excerpt ?? item.summary ?? '', 2_000);
  const payload = excerpt ? store.putObject(excerpt) : null;
  const kind = item.kind ?? 'observation';
  const attestation = attestLocator(projectRoot, item.uri, item.locator, excerpt);
  const cortex = acceptCortexOrientation(item, authority);

  // trust_class is issuer-derived for model callers; host/operator may declare a class.
  const hostReceipt = authority === 'host' && typeof item.receipt === 'string' && item.receipt.length > 0;
  let trustClass;
  if (authority === 'model') {
    if (cortex.accepted) trustClass = 'tool';
    else if (attestation.attested) trustClass = 'tool';
    else trustClass = 'model_claim';
  } else if (hostReceipt) {
    trustClass = 'tool';
  } else {
    trustClass = item.trust_class ?? item.trustClass ?? (attestation.attested || cortex.accepted ? 'tool' : 'model_claim');
  }

  const falsified = !attestation.attested && attestation.reason !== 'no_file_locator' && !cortex.accepted;
  if (falsified) trustClass = 'model_claim';

  return {
    id: item.id ?? crypto.randomUUID(), run_id: runId, claim_ids: item.claim_ids ?? item.claimIds ?? [], kind,
    uri: item.uri ?? null, locator: item.locator ?? null, version_or_commit: item.version_or_commit ?? item.versionOrCommit ?? null,
    content_hash: attestation.source_hash ?? item.content_hash ?? payload?.hash ?? null,
    retrieved_at: item.retrieved_at ?? new Date().toISOString(), observed_at: item.observed_at ?? new Date().toISOString(),
    trust_class: trustClass,
    attested: hostReceipt || attestation.attested || cortex.accepted,
    attestation_reason: hostReceipt ? 'host_receipt' : (cortex.accepted ? cortex.reason : attestation.reason),
    start_line: attestation.start_line ?? null,
    end_line: attestation.end_line ?? null,
    symbol: attestation.symbol ?? null,
    stale: false,
    freshness_policy: item.freshness_policy ?? 'event-only',
    invalidation_key: item.invalidation_key ?? item.invalidationKey ?? attestation.source_hash ?? null,
    supports_or_refutes: item.supports_or_refutes ?? 'supports', excerpt,
    criterion_id: item.criterion_id ?? item.criterionId ?? null,
    criterion_ids: item.criterion_ids ?? item.criterionIds ?? [],
    payload_ref: payload?.payload_ref ?? null, security_labels: item.security_labels ?? [],
    cortex_orientation: cortex.accepted,
  };
}

function normalizeCheck(check, runId, store, authority = 'model') {
  const output = bounded(check.output ?? '', 4_000);
  const payload = output ? store.putObject(output) : null;
  const callerAuthority = authority === 'operator'
    ? 'operator'
    : authority === 'hook'
      ? 'hook'
      : authority === 'host'
        ? 'host'
        : 'model';
  // executor/status are issuer-derived — model cannot self-certify a passing check.
  const executor = callerAuthority === 'model' ? 'model_claim' : (check.executor ?? callerAuthority);
  let receiptExitStatus = null;
  if (callerAuthority === 'host' && typeof check.receipt === 'string') {
    try { receiptExitStatus = JSON.parse(check.receipt).exit_status; } catch { receiptExitStatus = null; }
  }
  const status = callerAuthority === 'model'
    ? 'failed'
    : (check.status ?? (receiptExitStatus === 0 ? 'passed' : 'failed'));
  return {
    id: check.id ?? crypto.randomUUID(), run_id: runId, kind: check.kind ?? 'script',
    specification: check.specification ?? check.command ?? '',
    command: check.command ?? null,
    criterion_id: check.criterion_id ?? check.criterionId ?? null,
    criterion_ids: check.criterion_ids ?? check.criterionIds ?? [],
    executor, authority: callerAuthority, env_fingerprint: check.env_fingerprint ?? null,
    workspace_hash: check.workspace_hash ?? null, status, exit_code: Number.isInteger(check.exit_code) ? check.exit_code : null,
    output_ref: payload?.payload_ref ?? check.output_ref ?? null, recorded_at: new Date().toISOString(),
  };
}

function normalizeFailure(failure, context = {}) {
  const fingerprint = buildRetryFingerprint(failure, context);
  const normalized = {
    observed_failure: bounded(failure.observed_failure ?? failure.observed ?? failure.error ?? '', 2_000),
    expected_behavior: bounded(failure.expected_behavior ?? failure.expected ?? '', 2_000),
    error_fingerprint: bounded(fingerprint, 256),
    last_relevant_mutation: bounded(failure.last_relevant_mutation ?? '', 1_000),
    contradicting_evidence: failure.contradicting_evidence ?? [],
    likely_failure_class: failure.likely_failure_class ?? classifyFromFingerprint(fingerprint),
    corrected_hypothesis: bounded(failure.corrected_hypothesis ?? '', 1_000),
    next_falsifying_check: bounded(failure.next_falsifying_check ?? '', 1_000),
    command: failure.command ?? context.command ?? null,
  };
  if (!normalized.error_fingerprint) throw new Error('failure requires error_fingerprint');
  return normalized;
}

function classifyFromFingerprint(fp) {
  if (typeof fp !== 'string') return 'unknown';
  if (fp.includes('assertion')) return 'assertion';
  if (fp.includes('timeout')) return 'timeout';
  return 'unknown';
}

function unresolved(store, runId) {
  return store.list('claims').filter((claim) => claim.run_id === runId && ['open', 'stale'].includes(claim.status)).map((claim) => ({ id: claim.id, text: claim.text, status: claim.status }));
}
function refs(store, runId) {
  return store.list('evidence').filter((item) => item.run_id === runId).map((item) => item.id).slice(-30);
}
function bounded(value, maximum) { return String(value ?? '').slice(0, maximum); }

module.exports = {
  ForgeCore,
  decisions,
  parseLocator,
  fileFromLocator,
  attestLocator,
  hashRegion,
};
