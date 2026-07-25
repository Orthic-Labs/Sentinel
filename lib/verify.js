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

function buildRubric(run, input = {}) {
  const criteria = input.criteria ?? run.acceptance_criteria ?? [];
  return {
    id: input.id ?? crypto.randomUUID(), run_id: run.id, criteria: criteria.map((criterion) => ({
      criterion: typeof criterion === 'string' ? criterion : criterion.criterion,
      severity: typeof criterion === 'object' ? criterion.severity ?? 'critical' : 'critical',
      verification: typeof criterion === 'object' ? criterion.verification ?? [] : [],
      required_evidence_kinds: typeof criterion === 'object' ? criterion.required_evidence_kinds ?? [] : [],
    })),
    generated_at: new Date().toISOString(),
  };
}

function evaluateGate(run, store, gate = 'signoff') {
  const policy = policies[run.task_kind] ?? policies.default;
  const claims = store.list('claims').filter((claim) => claim.run_id === run.id);
  const evidence = store.list('evidence').filter((item) => item.run_id === run.id);
  const checks = store.list('checks').filter((check) => check.run_id === run.id);
  const deficits = [];
  const criticalOpen = claims.filter((claim) => ['critical', 'material'].includes(claim.materiality) && ['open', 'stale'].includes(claim.status));
  if (criticalOpen.length) deficits.push({ code: 'open_critical_claims', ids: criticalOpen.map((claim) => claim.id) });
  const passing = checks.filter((check) => check.status === 'passed' && check.executor !== 'model_claim');
  if (passing.length < policy.min_passing_checks) deficits.push({ code: 'insufficient_passing_checks', required: policy.min_passing_checks, actual: passing.length });
  if (gate === 'high_risk' && !run.intent_restatement) deficits.push({ code: 'missing_intent_restatement' });
  if (gate === 'high_risk' && !run.blast_radius) deficits.push({ code: 'missing_blast_radius' });
  if (gate === 'high_risk' && !run.why_safe) deficits.push({ code: 'missing_safety_case' });
  // Repository evidence counts only when the core actually read and hashed the locator. An excerpt
  // the caller merely asserted is indistinguishable from an invented one, so it satisfies no minimum.
  const repoEvidence = evidence.filter((item) => ['repo', 'source', 'local_fact'].includes(item.kind) && item.attested === true).length;
  const logOrDocEvidence = evidence.filter((item) => ['official_doc', 'tool', 'verifier', 'user'].includes(item.trust_class) && ['logs', 'docs', 'observation', 'test'].includes(item.kind)).length;
  if (policy.min_evidence.repo && repoEvidence < policy.min_evidence.repo) deficits.push({ code: 'insufficient_repo_evidence', required: policy.min_evidence.repo, actual: repoEvidence });
  if (policy.min_evidence.logs_or_docs && logOrDocEvidence < policy.min_evidence.logs_or_docs) {
    deficits.push({ code: 'insufficient_evidence', required: policy.min_evidence.logs_or_docs });
  }
  return { ok: deficits.length === 0, gate, deficits, counts: { claims: claims.length, evidence: evidence.length, checks: checks.length, passing_checks: passing.length } };
}

module.exports = { policies, buildRubric, evaluateGate };
