'use strict';

const crypto = require('node:crypto');

const EVENT_TYPES = new Set([
  'user', 'assistant', 'model', 'packet_delivered', 'tool_receipt', 'tool_receipt_failed',
  'git', 'file', 'test', 'error', 'retry', 'gate', 'delegation', 'cost', 'correction',
]);
const ORIGINS = new Set(['host', 'user', 'assistant', 'tool', 'repository', 'service']);
const digest = (value) => `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

function buildObservableEvent({ installationId, clientId, sessionId, taskId, turnId, traceId, eventType, origin, content = '', completeness = {}, policyDigest = 'membrane-policy-v1', timestamp = new Date().toISOString() }) {
  if (!EVENT_TYPES.has(eventType)) throw new Error(`unsupported observable event type: ${eventType}`);
  if (!ORIGINS.has(origin)) throw new Error(`unsupported observable event origin: ${origin}`);
  const lineage = [installationId, clientId, sessionId, taskId, turnId, traceId, eventType].map(String).join(':');
  return {
    schema: 'orthic.observable-event.v1',
    installation_id: String(installationId), client_id: String(clientId), session_id: String(sessionId),
    task_id: String(taskId), turn_id: String(turnId), trace_id: String(traceId),
    event_id: `observable-${digest(lineage).slice(7, 31)}`, event_type: eventType, origin,
    content_ref_or_digest: digest(content), timestamp,
    completeness: Object.fromEntries(Object.entries(completeness).map(([key, value]) => [key, Boolean(value)])),
    policy_snapshot_digest: digest(policyDigest),
  };
}

module.exports = { EVENT_TYPES: [...EVENT_TYPES], buildObservableEvent, digest };
