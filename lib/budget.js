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

/** Collapse whitespace and strip volatile hex/uuid-like tokens so retries share a stable key. */
function normalizeCommand(command) {
  return String(command ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d{10,}\b/g, '<n>')
    .slice(0, 500);
}

function classifyError(message) {
  const text = String(message ?? '').toLowerCase();
  if (!text) return 'empty';
  if (/\b(enoent|not found|no such file)\b/.test(text)) return 'not_found';
  if (/\b(eacces|eperm|permission denied)\b/.test(text)) return 'permission';
  if (/\b(etimedout|timeout|timed out)\b/.test(text)) return 'timeout';
  if (/\b(econnrefused|econnreset|network)\b/.test(text)) return 'network';
  if (/\b(syntax|parse error|unexpected token)\b/.test(text)) return 'syntax';
  if (/\b(assert|expect|failed assertions?)\b/.test(text)) return 'assertion';
  if (/\b(typeerror|referenceerror)\b/.test(text)) return 'runtime_type';
  const first = text.split(/\r?\n/)[0].replace(/\d+/g, 'N').replace(/[A-Za-z]:\\[^\s]+/g, '<path>').replace(/\/[^\s]+/g, '<path>');
  return `generic:${first.slice(0, 80)}`;
}

/**
 * Retry fingerprint from structured failure signals — not a raw command hash alone.
 * Callers may still supply an explicit fingerprint string for tests / host policy.
 */
function buildRetryFingerprint(failure = {}, context = {}) {
  if (typeof failure.error_fingerprint === 'string' && failure.error_fingerprint.trim()) {
    return failure.error_fingerprint.trim().slice(0, 256);
  }
  if (typeof failure.fingerprint === 'string' && failure.fingerprint.trim()) {
    return failure.fingerprint.trim().slice(0, 256);
  }
  const command = normalizeCommand(failure.command ?? context.command ?? context.tool_input?.command ?? '');
  const tool = String(failure.tool ?? context.tool_name ?? context.tool ?? '').slice(0, 80);
  const observed = failure.observed_failure ?? failure.observed ?? failure.error ?? context.error ?? '';
  const exitCode = Number.isInteger(failure.exit_code)
    ? failure.exit_code
    : (Number.isInteger(context.exit_code) ? context.exit_code : null);
  const mutation = String(failure.last_relevant_mutation ?? context.last_relevant_mutation ?? '').slice(0, 200);
  return fingerprint({
    v: 2,
    tool,
    command_norm: command,
    error_class: classifyError(observed),
    exit_code: exitCode,
    mutation_norm: normalizeCommand(mutation),
  });
}

function consumeRetry(store, runId, value, maxRetries = 2) {
  const fp = typeof value === 'string' && value && !value.startsWith('{')
    ? value
    : (typeof value === 'string' ? value : buildRetryFingerprint(value ?? {}));
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

module.exports = {
  ceilings,
  clampBudget,
  fingerprint,
  consumeRetry,
  triggerScore,
  buildRetryFingerprint,
  normalizeCommand,
  classifyError,
};
