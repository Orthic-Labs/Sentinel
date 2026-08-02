'use strict';

const crypto = require('node:crypto');

const policies = {
  bugfix: { min_evidence: { repo: 1, logs_or_docs: 1 }, min_passing_checks: 1, require_gate_for: ['signoff', 'high_risk'] },
  feature: { min_evidence: { repo: 1, logs_or_docs: 1 }, min_passing_checks: 1, require_gate_for: ['signoff'] },
  refactor: { min_evidence: { repo: 1 }, min_passing_checks: 1, require_gate_for: ['signoff'] },
  docs: { min_evidence: { logs_or_docs: 1 }, min_passing_checks: 1, require_gate_for: ['signoff'] },
  release: { min_evidence: { repo: 1, logs_or_docs: 1 }, min_passing_checks: 2, require_gate_for: ['signoff', 'high_risk'] },
  default: { min_evidence: { repo: 1, logs_or_docs: 1 }, min_passing_checks: 1, require_gate_for: ['signoff'] },
};

const trustedAuthorities = new Set(['operator', 'hook', 'host']);

const claimKindEvidence = {
  local_fact: ['repo', 'source', 'local_fact'],
  behavioral_fact: ['test', 'logs', 'observation'],
  versioned_api: ['repo', 'source', 'docs', 'official_doc'],
  current_external: ['docs', 'official_doc', 'tool'],
  stable_reference: ['docs', 'official_doc', 'repo', 'source'],
  inference: ['repo', 'docs', 'test', 'logs', 'observation'],
  preference: ['user', 'tool'],
  hypothesis: ['repo', 'docs', 'test', 'logs', 'observation'],
};

const BLUEPRINT_KINDS = new Set(['blueprint_orientation', 'blueprint', 'orientation']);

/**
 * Hook point for Blueprint P1 orientation receipts.
 * When Blueprint emits orientation evidence (kind blueprint_orientation / blueprint),
 * Sentinel accepts it as attested tool-class evidence under host/hook authority, or as
 * a provisional model_claim under model authority (still subject to gate minima).
 */
function acceptBlueprintOrientation(item = {}, authority = 'model') {
  const kind = item.kind ?? '';
  if (!BLUEPRINT_KINDS.has(kind)) return { accepted: false, reason: 'not_blueprint' };
  if (item.receipt || item.blueprint_receipt || item.orientation_hash || item.excerpt) {
    return {
      accepted: authority === 'hook' || authority === 'operator' || Boolean(item.receipt || item.blueprint_receipt),
      reason: 'blueprint_orientation_receipt',
    };
  }
  return { accepted: false, reason: 'blueprint_orientation_incomplete' };
}

/**
 * Process-tree / heavy preflight watchdog is intentionally out of core (P2 demotion).
 * Optional stub: when a criterion declares execution_contract.preflight, record a no-op pass.
 */
function runPreflightStub(rubric) {
  const contracts = (rubric?.criteria ?? [])
    .map((criterion) => criterion.execution_contract)
    .filter(Boolean);
  if (!contracts.length) return { ok: true, skipped: true, reason: 'no_execution_contract' };
  const requested = contracts.filter((contract) => contract.preflight === true);
  if (!requested.length) return { ok: true, skipped: true, reason: 'preflight_not_requested' };
  return {
    ok: true,
    stub: true,
    reason: 'preflight_stub_only_no_process_watchdog',
    contracts: requested.length,
  };
}

function criterionVerifications(criterion) {
  const base = criterion.verification ?? [];
  const contractSpecs = criterion.execution_contract?.check_specs
    ?? criterion.execution_contract?.checkSpecs
    ?? [];
  return [...base, ...contractSpecs].map(normalizeCheckSpec);
}

function normalizeCheckSpec(spec) {
  if (typeof spec === 'string') {
    const specification = spec.trim();
    if (!specification) throw new Error('CheckSpec specification must be nonempty');
    return { kind: null, specification };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('CheckSpec must be a string or object');
  const allowed = new Set(['kind', 'specification', 'command']);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) throw new Error(`unsupported CheckSpec property: ${key}`);
  const kind = typeof spec.kind === 'string' ? spec.kind.trim() : '';
  const specification = typeof spec.specification === 'string' ? spec.specification.trim() : '';
  const command = typeof spec.command === 'string' ? spec.command.trim() : '';
  // Canonical in-memory form for a legacy string verification. It is produced only
  // by this module, then may be loaded from a durable rubric on a later operation.
  if (spec.kind === null && specification && !command) return { kind: null, specification };
  if (!kind || !/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) throw new Error('CheckSpec kind must be a lowercase identifier');
  if ((specification ? 1 : 0) + (command ? 1 : 0) !== 1) throw new Error('CheckSpec requires exactly one of specification or command');
  return { kind, specification: specification || command };
}

function buildRubric(run, input = {}) {
  const criteria = input.criteria ?? run.acceptance_criteria ?? [];
  if (!Array.isArray(criteria)) throw new Error('rubric criteria must be an array');
  return {
    id: input.id ?? crypto.randomUUID(),
    run_id: run.id,
    criteria: criteria.map((criterion, index) => {
      if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) throw new Error('rubric criterion must be an object');
      const object = criterion;
      const text = typeof object.criterion === 'string' ? object.criterion.trim() : '';
      if (!text) throw new Error('rubric criterion requires criterion text');
      const severity = object.severity ?? 'critical';
      if (!['critical', 'material', 'useful', 'trivial'].includes(severity)) throw new Error(`unsupported rubric severity: ${severity}`);
      const verification = object.verification ?? [];
      if (!Array.isArray(verification)) throw new Error('rubric criterion verification must be an array');
      const executionContract = object.execution_contract ?? object.executionContract ?? null;
      if (executionContract !== null && (!executionContract || typeof executionContract !== 'object' || Array.isArray(executionContract))) {
        throw new Error('rubric execution_contract must be an object');
      }
      const rawSpecs = executionContract?.check_specs ?? executionContract?.checkSpecs ?? [];
      if (!Array.isArray(rawSpecs)) throw new Error('execution_contract check_specs must be an array');
      return {
        id: object.id ?? `criterion-${index}`,
        criterion: text,
        severity,
        verification: verification.map(normalizeCheckSpec),
        execution_contract: executionContract ? { ...executionContract, check_specs: rawSpecs.map(normalizeCheckSpec) } : null,
        required_evidence_kinds: object.required_evidence_kinds ?? [],
        claim_ids: object.claim_ids ?? [],
      };
    }),
    generated_at: new Date().toISOString(),
  };
}

function loadRubric(run, store) {
  const stored = store.latest('rubrics', (row) => row.run_id === run.id);
  return stored ?? buildRubric(run);
}

function criterionIds(check) {
  return [...new Set([check.criterion_id, ...(check.criterion_ids ?? [])].filter(Boolean))];
}

function evidenceKindMatches(required, evidence) {
  if (!required?.length) return true;
  const kind = evidence.kind;
  const trust = evidence.trust_class;
  return required.some((req) => {
    if (req === kind || req === trust) return true;
    if (req === 'repo' && ['repo', 'source', 'local_fact'].includes(kind)) return true;
    if (req === 'docs' && ['docs', 'official_doc', 'blueprint_orientation', 'blueprint'].includes(kind)) return true;
    if (req === 'logs' && ['logs', 'observation', 'test'].includes(kind)) return true;
    if (req === 'logs_or_docs' && ['logs', 'docs', 'observation', 'test', 'official_doc', 'blueprint_orientation', 'blueprint'].includes(kind)) return true;
    if (req === 'test' && kind === 'test') return true;
    if (req === 'blueprint' && BLUEPRINT_KINDS.has(kind)) return true;
    return false;
  });
}

function checkMatchesSpec(check, spec) {
  const normalized = normalizeCheckSpec(spec);
  if (normalized.kind && check.kind !== normalized.kind) return false;
  return check.specification === normalized.specification || check.command === normalized.specification;
}

function isQualifyingCheck(check, rubric) {
  if (check.status !== 'passed') return false;
  if (!trustedAuthorities.has(check.authority)) return false;
  if (check.executor === 'model_claim') return false;
  if (!rubric.criteria.length) return false;
  const linkedIds = criterionIds(check);
  if (!linkedIds.length) return false;
  for (const criterion of rubric.criteria) {
    if (!linkedIds.includes(criterion.id)) continue;
    const verifications = criterionVerifications(criterion);
    if (!verifications.length) return false;
    return verifications.some((spec) => checkMatchesSpec(check, spec));
  }
  return false;
}

function requiredKindsForClaim(claim, rubric) {
  if (claim.required_evidence_kinds?.length) return claim.required_evidence_kinds;
  for (const criterion of rubric.criteria) {
    if (criterion.claim_ids?.includes(claim.id) && criterion.required_evidence_kinds?.length) {
      return criterion.required_evidence_kinds;
    }
  }
  return claimKindEvidence[claim.kind] ?? ['repo', 'docs', 'test', 'logs', 'observation'];
}

function satisfiesRequiredKinds(required, linkedEvidence) {
  if (!required.length) return linkedEvidence.length > 0;
  return required.every((req) => linkedEvidence.some((item) => evidenceKindMatches([req], item)));
}

function evaluateCriterionDeficits(rubric, activeEvidence, checks) {
  const deficits = [];
  const trustedChecks = checks.filter((check) => check.status === 'passed' && trustedAuthorities.has(check.authority) && check.executor !== 'model_claim');
  for (const criterion of rubric.criteria) {
    if (criterion.severity !== 'critical') continue;
    for (const spec of criterionVerifications(criterion)) {
      const typedSpec = normalizeCheckSpec(spec);
      const specText = typedSpec.specification;
      const matched = trustedChecks.some((check) => criterionIds(check).includes(criterion.id) && checkMatchesSpec(check, spec));
      if (!matched) deficits.push({ code: 'criterion_check_unmet', criterion_id: criterion.id, specification: specText || (typeof spec === 'object' ? spec.kind : '') || 'check' });
    }
    const requiredKinds = criterion.required_evidence_kinds ?? [];
    if (requiredKinds.length) {
      const criterionEvidence = activeEvidence.filter((item) => {
        const ids = [...(item.criterion_ids ?? []), item.criterion_id].filter(Boolean);
        return ids.includes(criterion.id) && evidenceKindMatches(requiredKinds, item);
      });
      if (!criterionEvidence.length) {
        deficits.push({ code: 'criterion_evidence_unmet', criterion_id: criterion.id, required: requiredKinds });
      }
    }
  }
  return deficits;
}

function evaluateGate(run, store, gate = 'signoff') {
  const policy = policies[run.task_kind] ?? policies.default;
  const rubric = loadRubric(run, store);
  const claims = store.list('claims').filter((claim) => claim.run_id === run.id);
  const evidence = store.list('evidence').filter((item) => item.run_id === run.id);
  const checks = store.list('checks').filter((check) => check.run_id === run.id);
  const deficits = [];
  if (gate === 'signoff' && rubric.criteria.length === 0) {
    deficits.push({ code: 'empty_signoff_rubric' });
  }
  const criticalOpen = claims.filter((claim) => ['critical', 'material'].includes(claim.materiality) && ['open', 'stale'].includes(claim.status));
  if (criticalOpen.length) deficits.push({ code: 'open_critical_claims', ids: criticalOpen.map((claim) => claim.id) });
  const passing = checks.filter((check) => isQualifyingCheck(check, rubric));
  if (passing.length < policy.min_passing_checks) {
    deficits.push({ code: 'insufficient_passing_checks', required: policy.min_passing_checks, actual: passing.length });
  }
  if (gate === 'high_risk' && !run.intent_restatement) deficits.push({ code: 'missing_intent_restatement' });
  if (gate === 'high_risk' && !run.blast_radius) deficits.push({ code: 'missing_blast_radius' });
  if (gate === 'high_risk' && !run.why_safe) deficits.push({ code: 'missing_safety_case' });
  const activeEvidence = evidence.filter((item) => item.stale !== true && item.trust_class !== 'model_claim');
  const staleEvidence = evidence.filter((item) => item.stale === true);
  if (staleEvidence.length) deficits.push({ code: 'stale_evidence', ids: staleEvidence.map((item) => item.id) });
  const repoEvidence = activeEvidence.filter((item) => ['repo', 'source', 'local_fact'].includes(item.kind) && item.attested === true).length;
  const logOrDocEvidence = activeEvidence.filter((item) => (
    ['official_doc', 'tool', 'verifier', 'user'].includes(item.trust_class)
    && ['logs', 'docs', 'observation', 'test', 'blueprint_orientation', 'blueprint'].includes(item.kind)
  )).length;
  if (policy.min_evidence.repo && repoEvidence < policy.min_evidence.repo) deficits.push({ code: 'insufficient_repo_evidence', required: policy.min_evidence.repo, actual: repoEvidence });
  if (policy.min_evidence.logs_or_docs && logOrDocEvidence < policy.min_evidence.logs_or_docs) {
    deficits.push({ code: 'insufficient_evidence', required: policy.min_evidence.logs_or_docs });
  }
  deficits.push(...evaluateCriterionDeficits(rubric, activeEvidence, checks));
  const supportedMaterial = claims.filter((claim) => ['critical', 'material'].includes(claim.materiality) && claim.status === 'supported');
  const unsupported = supportedMaterial.filter((claim) => {
    const linked = activeEvidence.filter((item) => Array.isArray(item.claim_ids) && item.claim_ids.includes(claim.id));
    if (!linked.length) return true;
    const required = requiredKindsForClaim(claim, rubric);
    const criterion = rubric.criteria.find((row) => row.claim_ids?.includes(claim.id) && row.required_evidence_kinds?.length);
    if (criterion) return !satisfiesRequiredKinds(required, linked);
    return !linked.some((item) => evidenceKindMatches(required, item));
  });
  if (unsupported.length) {
    deficits.push({ code: 'supported_claim_without_matching_evidence', ids: unsupported.map((claim) => claim.id) });
  }
  return { ok: deficits.length === 0, gate, deficits, rubric_id: rubric.id, counts: { claims: claims.length, evidence: evidence.length, checks: checks.length, passing_checks: passing.length } };
}

module.exports = {
  policies,
  buildRubric,
  evaluateGate,
  loadRubric,
  isQualifyingCheck,
  evidenceKindMatches,
  checkMatchesSpec,
  normalizeCheckSpec,
  runPreflightStub,
  acceptBlueprintOrientation,
  criterionVerifications,
  BLUEPRINT_KINDS,
};
