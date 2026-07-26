'use strict';

const crypto = require('node:crypto');

const kinds = new Set([
  'local_fact', 'behavioral_fact', 'versioned_api', 'current_external',
  'stable_reference', 'inference', 'preference', 'hypothesis',
]);
const materialities = new Set(['trivial', 'useful', 'material', 'critical']);
const statuses = new Set(['open', 'supported', 'refuted', 'stale', 'waived']);

function normalizeClaim(input, runId, authority = 'model') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('claim must be an object');
  const text = String(input.text ?? input.claim ?? '').trim();
  if (!text || text.length > 2_000) throw new Error('claim text must be 1-2000 characters');
  const kind = input.kind ?? 'hypothesis';
  const materiality = input.materiality ?? 'material';
  if (!kinds.has(kind)) throw new Error(`unsupported claim kind: ${kind}`);
  if (!materialities.has(materiality)) throw new Error(`unsupported claim materiality: ${materiality}`);
  const status = input.status ?? 'open';
  if (!statuses.has(status)) throw new Error(`unsupported claim status: ${status}`);
  if (authority === 'model' && status !== 'open') throw new Error('model authority can only open claims');
  if (status === 'waived' && !input.waiver) throw new Error('waived claims require an authority-backed waiver');
  if (status === 'waived' && authority === 'model') throw new Error('model authority cannot waive claims');
  return {
    id: input.id ?? crypto.randomUUID(), run_id: runId, text, kind, materiality,
    status, invalidation_key: input.invalidation_key ?? input.invalidationKey ?? null,
    confidence: Number.isFinite(input.confidence) ? input.confidence : null,
  };
}

function applyClaimUpdate(claim, update, authority = 'model') {
  if (update.status !== undefined && !statuses.has(update.status)) throw new Error(`unsupported claim status: ${update.status}`);
  if (update.materiality !== undefined && update.materiality !== claim.materiality) throw new Error('cannot change claim materiality after assess');
  if (update.kind !== undefined && update.kind !== claim.kind) throw new Error('cannot change claim kind after assess');
  if (update.text !== undefined && update.text !== claim.text) throw new Error('cannot change claim text after assess');
  if (update.run_id !== undefined && update.run_id !== claim.run_id) throw new Error('cannot move claim between runs');
  if (authority === 'model' && (update.status === 'waived' || update.waiver)) throw new Error('model authority cannot waive claims');
  if (update.status === 'waived' && !update.waiver) throw new Error('waived claims require an authority-backed waiver');
  const next = { ...claim };
  for (const field of ['status', 'invalidation_key', 'confidence', 'waiver']) {
    if (update[field] !== undefined) next[field] = update[field];
  }
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
