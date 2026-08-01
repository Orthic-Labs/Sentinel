#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { appendObservableEvent } = require('./observable-ingress.js');
const { buildObservableEvent } = require('./observable-event.js');

const MAX_PACKET_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 1500;

function findClient(start) {
  if (process.env.MEMBRANE_CONTEXT_CLIENT) return process.env.MEMBRANE_CONTEXT_CLIENT;
  let current = path.resolve(start || process.cwd());
  while (true) {
    const candidate = path.join(current, 'membrane', 'mcp', 'client.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveWorkspaceRoot(event = {}) {
  const requested = path.resolve(event.cwd || event.working_directory || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const hookWorkspace = path.resolve(__dirname, '..', '..');
  const hookClient = findClient(hookWorkspace);
  return hookClient && findClient(requested) !== hookClient ? hookWorkspace : requested;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
}

function taskId(event, session) {
  return event.task_id || event.taskId || digest(`${session}:${event.prompt || event.user_prompt || event.task || ''}`).slice(7, 31);
}

function buildRequest(event, root) {
  const session = String(event.session_id || event.sessionId || process.env.CODEX_SESSION_ID || process.env.CLAUDE_SESSION_ID || `host-${process.pid}`);
  const task = String(event.prompt || event.user_prompt || event.task || 'orient current task').trim();
  const id = taskId(event, session);
  return {
    task,
    repo: root,
    session,
    client: event.client || process.env.MEMBRANE_CLIENT || 'host-adapter',
    maxTokens: Number.isInteger(event.max_tokens) ? event.max_tokens : 6420,
    anchors: Array.isArray(event.anchors) ? event.anchors.join(',') : String(event.anchors || ''),
    taskEnvelope: {
      schema: 'orthic.task-envelope.v1', task_id: id, session_id: session,
      repository_scope: [root], requested_deliverable: task,
    },
    turnEnvelope: {
      schema: 'orthic.turn-envelope.v1', task_id: id, turn_id: String(event.turn_id || event.turnId || `${id}:turn`),
      session_id: session, user_prompt_digest: digest(task),
    },
  };
}

function runClient(request, root, options = {}) {
  const client = options.client || findClient(root);
  if (!client) return { state: 'degraded', reason: 'membrane_client_missing', request };
  const result = childProcess.spawnSync(process.execPath, [client, '--input', '-'], {
    cwd: root,
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    timeout: REQUEST_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, WORKSPACE_ROOT: root },
  });
  if (result.error || result.status !== 0) return { state: 'degraded', reason: result.error?.code === 'ETIMEDOUT' ? 'context_timeout' : 'context_unavailable', request };
  try {
    const payload = JSON.parse(result.stdout.trim());
    if (!payload.ok || !payload.packet) return { state: 'degraded', reason: payload.degradationReason || 'packet_unavailable', request, payload };
    return { state: 'context_enforced', request, payload };
  } catch {
    return { state: 'degraded', reason: 'malformed_context_response', request };
  }
}

function render(result) {
  const payload = result.payload || {};
  const packet = result.state === 'context_enforced' ? payload.packet : null;
  const serialized = JSON.stringify({ packet, providerStatus: payload.providerStatus || 'unavailable', omissions: payload.degradationReason && payload.degradationReason !== 'none' ? [payload.degradationReason] : [], receipt: digest(payload.receipts || []), event: 'packet_delivered', dataOnly: true });
  const bounded = Buffer.from(serialized, 'utf8').subarray(0, MAX_PACKET_BYTES).toString('utf8');
  return `Membrane: ${result.state}\nevent_store: ${result.eventStore?.status || 'unavailable'}\nrepos: ${result.state === 'context_enforced' ? 'current' : 'unknown'}\npacket: ${packet ? Buffer.byteLength(bounded, 'utf8') : 0} bytes\nomissions: ${result.reason || payload.degradationReason || 'none'}\nreceipt: ${digest(bounded)}\n<membrane-context-data>${bounded}</membrane-context-data>`;
}

function main() {
  let event = {};
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { event = {}; }
  const eventName = event.hook_event_name || event.event || event.type || '';
  if (!['SessionStart', 'session_start', 'UserPromptSubmit', 'user_prompt_submit'].includes(eventName)) return;
  const root = resolveWorkspaceRoot(event);
  const result = runClient(buildRequest(event, root), root);
  const request = result.request;
  result.eventStore = appendObservableEvent(buildObservableEvent({
    installationId: process.env.MEMBRANE_INSTALLATION_ID || 'host-installation', clientId: request.client,
    sessionId: request.session, taskId: request.taskEnvelope.task_id, turnId: request.turnEnvelope.turn_id,
    traceId: request.turnEnvelope.task_id, eventType: 'packet_delivered', origin: 'host',
    content: result.payload?.packet || result.reason || 'degraded',
    completeness: { packet: result.state === 'context_enforced', receipt: true },
    policyDigest: process.env.MEMBRANE_POLICY_VERSION || 'membrane-policy-v1',
  }));
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: render(result) } })}\n`);
}

if (require.main === module) main();
module.exports = { buildRequest, findClient, render, resolveWorkspaceRoot, runClient, main };
