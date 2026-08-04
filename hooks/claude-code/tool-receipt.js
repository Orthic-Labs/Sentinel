#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { appendObservableEvent } = require('../observable-ingress.js');
const { buildObservableEvent } = require('../observable-event.js');

const digest = (value) => `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
const now = () => new Date().toISOString();

// Plan convention 3: one typed client identity everywhere. Kept in sync with
// hooks/membrane-context.js — telemetry and the rules capability split must
// agree on the same string, or receipts attribute to a client that the
// federation layer does not recognize.
const CLIENT_IDENTITIES = Object.freeze(['claude_code', 'codex', 'mcp', 'api_worker', 'other']);

function defaultClient(env = process.env) {
  if (env.MEMBRANE_CLIENT) {
    return CLIENT_IDENTITIES.includes(env.MEMBRANE_CLIENT) ? env.MEMBRANE_CLIENT : 'other';
  }
  // This is the Claude Code hook set; the loopback ANTHROPIC_BASE_URL probe
  // that used to yield 'ccx' described a gateway deployment, not a client.
  return 'claude_code';
}

function first(event, keys, fallback = '') {
  for (const key of keys) if (event[key] !== undefined && event[key] !== null) return event[key];
  return fallback;
}

function activeTrace(event, env = process.env, nowMs = Date.now()) {
  const sessionId = String(first(event, ['session_id', 'sessionId'], '')).trim();
  if (!sessionId) return null;
  const root = env.MEMBRANE_ACTIVE_TRACE_DIR
    || path.join(String(env.WORKSPACE_ROOT || first(event, ['cwd', 'working_directory'], process.cwd())), 'tools', '.cache', 'memory', 'active-traces');
  const key = crypto.createHash('sha256').update(sessionId).digest('hex');
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, `${key}.json`), 'utf8'));
    const ageMs = nowMs - Number(value.updated_at_ms);
    if (value.schema !== 'membrane.active-trace.v1'
      || value.session_id !== sessionId
      || typeof value.trace_id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.trace_id)
      || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 5 * 60_000) return null;
    return value.trace_id;
  } catch {
    return null;
  }
}

function buildReceipt(event) {
  const startedAt = String(first(event, ['started_at', 'startedAt'], now()));
  const completedAt = String(first(event, ['completed_at', 'completedAt'], now()));
  const taskId = String(first(event, ['task_id', 'taskId'], 'host-task'));
  const turnId = String(first(event, ['turn_id', 'turnId'], `${taskId}:turn`));
  const callId = String(first(event, ['tool_call_id', 'toolCallId', 'tool_use_id', 'toolUseId', 'id'], `tool-${process.pid}`));
  const input = first(event, ['tool_input', 'input', 'command'], '');
  const output = first(event, ['tool_response', 'tool_output', 'output', 'error'], '');
  const failed = event.failure !== undefined || event.error !== undefined || event.tool_error !== undefined || event.hook_event_name === 'PostToolUseFailure';
  const source = String(first(event, ['source_generation_id', 'sourceGenerationId', 'source_generation'], 'unknown'));
  const receipt = {
    schema: 'orthic.tool-receipt.v1',
    task_id: taskId,
    turn_id: turnId,
    tool_call_id: callId,
    issuer_id: 'sentinel-claude-hook',
    issuer_capability_digest: digest('sentinel-claude-hook:v1'),
    tool_class: String(first(event, ['tool_name', 'toolName'], 'unknown-tool')),
    operation: String(first(event, ['operation'], 'execute')),
    scope: [String(first(event, ['cwd', 'working_directory'], process.cwd()))],
    input_digest: digest(input),
    output_digest: digest(output),
    exit_status: Number.isInteger(event.exit_code) ? event.exit_code : (failed ? 1 : 0),
    started_at: startedAt,
    completed_at: completedAt,
    source_generation_id: digest(source),
  };
  receipt.signature_or_mac = `hook:${digest(receipt)}`;
  return receipt;
}

function main() {
  let event = {};
  try { event = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); } catch { event = {}; }
  const eventName = event.hook_event_name || event.event || event.type || '';
  if (!['PreToolUse', 'pre_tool_use', 'PostToolUse', 'post_tool_use', 'PostToolUseFailure', 'post_tool_use_failure'].includes(eventName)) return;
  const receipt = buildReceipt(event);
  const failed = receipt.exit_status !== 0;
  const traceId = String(first(event, ['trace_id', 'traceId'], activeTrace(event) || receipt.tool_call_id));
  const observable = buildObservableEvent({
    installationId: String(first(event, ['installation_id', 'installationId'], 'host-installation')),
    clientId: defaultClient(), sessionId: String(first(event, ['session_id', 'sessionId'], 'host-session')),
    taskId: receipt.task_id, turnId: receipt.turn_id, traceId,
    eventType: failed ? 'tool_receipt_failed' : 'tool_receipt', origin: 'tool', content: receipt,
    completeness: { input: true, output: !event.output_omitted, receipt: true },
    policyDigest: receipt.issuer_capability_digest, timestamp: receipt.completed_at,
  });
  const eventStore = appendObservableEvent(observable);
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: `Sentinel: tool_receipt\nevent_store: ${eventStore.status}\n<sentinel-tool-receipt>${JSON.stringify({ receipt, observable, eventStore, dataOnly: true })}</sentinel-tool-receipt>` } })}\n`);
}

if (require.main === module) main();
module.exports = { activeTrace, buildReceipt, defaultClient, digest, main };
