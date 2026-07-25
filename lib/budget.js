'use strict';

const { hashValue } = require('./store');

const ceilings = { max_return_tokens: 4_000, max_evidence_items: 30, max_external_requests: 20, max_verifier_calls: 5 };

function clampBudget(input = {}) {
  return Object.fromEntries(Object.entries(ceilings).map(([key, ceiling]) => [
    key, Math.max(0, Math.min(ceiling, Number.isInteger(input[key]) ? input[key] : ceiling)),
  ]));
}

function fingerprint(value) {
  return `sha256:${hashValue(value)}`;
}

function consumeRetry(store, runId, value, maxRetries = 2) {
  const fp = typeof value === 'string' ? value : fingerprint(value);
  const prior = store.list('retry_budget').find((row) => row.run_id === runId && row.fingerprint === fp);
  const count = (prior?.count ?? 0) + 1;
  store.append('retry_budget', { id: prior?.id ?? undefined, run_id: runId, fingerprint: fp, count, max_retries: maxRetries });
  return { fingerprint: fp, count, remaining: Math.max(0, maxRetries - count), blocked: count > maxRetries };
}

function triggerScore(input = {}) {
  let score = 0;
  if (input.risk || input.irreversible || input.external || input.security) score += 3;
  if (input.openMaterialClaims || input.versionSensitive || input.currentExternal) score += 2;
  if (input.unexpectedFailure) score += 2;
  if (input.repeatedAttempt) score += 2;
  if (input.contextPressure) score += 2;
  if (input.multiSubsystem || input.ambiguousAcceptance) score += 1;
  if (input.memoryPromotion) score += 1;
  if (input.simpleDeterministic) score -= 2;
  if (input.cachedEvidence) score -= 2;
  return score;
}

module.exports = { ceilings, clampBudget, fingerprint, consumeRetry, triggerScore };
