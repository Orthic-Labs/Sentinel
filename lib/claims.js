'use strict';

const crypto = require('node:crypto');

const kinds = new Set([
  'local_fact', 'behavioral_fact', 'versioned_api', 'current_external',
  'stable_reference', 'inference', 'preference', 'hypothesis',
]);
const materialities = new Set(['trivial', 'useful', 'material', 'critical']);
const statuses = new Set(['open', 'supported', 'refuted', 'stale', 'waived']);

function normalizeClaim(input, runId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('claim must be an object');
  const text = String(input.text ?? input.claim ?? '').trim();
  if (!text || text.length > 2_000) throw new Error('claim text must be 1-2000 characters');
  const kind = input.kind ?? 'hypothesis';
  const materiality = input.materiality ?? 'material';
  if (!kinds.has(kind)) throw new Error(`unsupported claim kind: ${kind}`);
  if (!materialities.has(materiality)) throw new Error(`unsupported claim materiality: ${materiality}`);
  const status = input.status ?? 'open';
  if (!statuses.has(status)) throw new Error(`unsupported claim status: ${status}`);
  return {
    id: input.id ?? crypto.randomUUID(), run_id: runId, text, kind, materiality,
    status, invalidation_key: input.invalidation_key ?? input.invalidationKey ?? null,
    confidence: Number.isFinite(input.confidence) ? input.confidence : null,
  };
}

function applyClaimUpdate(claim, update) {
  const next = { ...claim, ...update };
  if (update.status !== undefined && !statuses.has(update.status)) throw new Error(`unsupported claim status: ${update.status}`);
  if (update.status === 'waived' && !update.waiver) throw new Error('waived claims require an authority-backed waiver');
  return next;
}

function sourceForKind(kind) {
  return {
    local_fact: 'live local state', behavioral_fact: 'executed check', versioned_api: 'lockfile and installed source',
    current_external: 'official current documentation', stable_reference: 'authoritative standard',
    inference: 'supporting evidence and falsifying check', preference: 'explicit user decision', hypothesis: 'experiment',
  }[kind] ?? 'authoritative evidence';
}

module.exports = { kinds, materialities, statuses, normalizeClaim, applyClaimUpdate, sourceForKind };
