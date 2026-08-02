#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHostDataDir, resolveDefaultStoreRoot, envFirst } = require('../../lib/host');
const { buildRetryFingerprint } = require('../../lib/budget');

function main() {
  const result = evaluate(readJson());
  emit(result);
  if (result.action === 'block') process.exitCode = 1;
}

function evaluate(event, { root = envFirst('SENTINEL_ROOT', 'TETHER_ROOT', 'BEACON_ROOT') ?? path.resolve(__dirname, '../..'), projectRoot = process.cwd() } = {}) {
  const cli = path.join(root, 'cli.js');
  const name = event.hook_event_name ?? event.event ?? event.type ?? '';
  let runId = event.run_id ?? event.runId;
  let bindingStatus = null;
  const sessionId = event.session_id ?? event.sessionId ?? process.env.CODEX_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
  const taskId = event.task_id ?? event.taskId ?? null;
  const workspaceHash = event.workspace_hash ?? event.workspaceHash ?? null;

  if (name === 'Stop' && (event.stop_hook_active === true || event.stopHookActive === true)) {
    return { action: 'noop', reason: 'stop_hook_active' };
  }

  if (!runId && (sessionId || taskId)) {
    const binding = invoke(cli, 'resolve-session', {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      ...(workspaceHash ? { workspace_hash: workspaceHash } : {}),
      ...(event.bind_run_id || event.bindRunId ? { run_id: event.bind_run_id ?? event.bindRunId } : {}),
    }, projectRoot);
    runId = binding.run_id;
    bindingStatus = binding.status ?? null;
  }

  if (!runId && (name === 'PreToolUse' || name === 'pre_tool_use')) {
    const command = String(event.command ?? event.tool_input?.command ?? '');
    if (isRisky(command)) return { action: 'block', reason: 'high-risk command requires Beacon assess before execution' };
    return { action: 'noop', reason: 'routine tool use without active beacon run' };
  }

  const validationEvents = ['Stop', 'stop', 'PostToolUse', 'post_tool_use', 'PostToolUseFailure', 'post_tool_use_failure'];
  if (!runId && validationEvents.includes(name)) {
    if ((name === 'Stop' || name === 'stop') && bindingStatus === 'closed' && !isCompletionIntent(event)) {
      return { action: 'noop', reason: 'conversational_stop' };
    }
    return degraded('no active beacon run');
  }

  const isFailureEvent = name === 'PostToolUseFailure' || name === 'post_tool_use_failure'
    || ((name === 'PostToolUse' || name === 'post_tool_use') && Boolean(event.failure ?? event.error ?? event.tool_error));

  if (isFailureEvent) {
    const failure = event.failure ?? {};
    const fingerprint = buildRetryFingerprint(failure, {
      tool_name: event.tool_name,
      command: event.command ?? event.tool_input?.command,
      error: event.error ?? event.tool_error,
      exit_code: event.exit_code ?? event.tool_response?.exit_code,
      last_relevant_mutation: failure.last_relevant_mutation,
    });
    const result = invoke(cli, 'checkpoint', {
      run_id: runId,
      summary: 'Tool failure captured by enforcement hook',
      failure: { ...failure, error_fingerprint: fingerprint, command: event.command ?? event.tool_input?.command },
    }, projectRoot);
    return result.decision === 'blocked' ? { action: 'block', reason: 'identical failure retry budget exhausted', result } : { action: 'continue', result };
  }

  if (name === 'PostToolUse' || name === 'post_tool_use') {
    return { action: 'continue', reason: 'tool success is not auto-recorded as a passing check' };
  }

  if (name === 'PreToolUse' || name === 'pre_tool_use') {
    const command = String(event.command ?? event.tool_input?.command ?? '');
    if (!isRisky(command)) return { action: 'noop', reason: 'routine tool use' };
    const result = invoke(cli, 'verify', {
      run_id: runId, gate: 'high_risk',
      intent_restatement: event.intent_restatement, blast_radius: event.blast_radius, why_safe: event.why_safe,
    }, projectRoot);
    return result.decision === 'blocked' ? { action: 'block', reason: 'high-risk gate unmet', result } : { action: 'allow', result };
  }

  if (name === 'Stop' || name === 'stop') {
    // Conversational Stop is not completion. Only act on explicit completion intent.
    if (!isCompletionIntent(event)) {
      return { action: 'noop', reason: 'conversational_stop' };
    }
    const verifyResult = invoke(cli, 'verify', { run_id: runId, gate: 'signoff' }, projectRoot);
    if (verifyResult.decision === 'blocked') {
      return { action: 'block', reason: 'signoff gate unmet', result: verifyResult };
    }
    const closeResult = invoke(cli, 'close', {
      run_id: runId,
      summary: event.summary ?? verifyResult.summary,
      workspace_hash: workspaceHash,
    }, projectRoot);
    if (closeResult.decision === 'blocked') {
      return { action: 'block', reason: 'close gate unmet', result: closeResult };
    }
    return { action: 'allow', result: closeResult, closed: true };
  }

  return { action: 'noop', reason: 'unsupported or low-signal event' };
}

function isCompletionIntent(event) {
  if (event.completion_intent === true || event.completionIntent === true) return true;
  if (event.task_complete === true || event.taskComplete === true) return true;
  if (event.close === true || event.operation === 'close') return true;
  const reason = event.stop_reason ?? event.stopReason ?? event.reason ?? '';
  return ['completion', 'task_complete', 'end_turn_complete', 'signoff'].includes(String(reason));
}

function invoke(cli, command, input, projectRoot = process.cwd()) {
  const hostDataDir = envFirst('SENTINEL_HOST_DATA', 'TETHER_HOST_DATA', 'BEACON_HOST_DATA') ?? resolveHostDataDir();
  const storeRoot = envFirst('SENTINEL_STORE_ROOT', 'TETHER_STORE_ROOT', 'BEACON_STORE_ROOT') ?? resolveDefaultStoreRoot(projectRoot);
  const child = spawnSync(process.execPath, [cli, command, '--json'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: true,
    cwd: projectRoot,
    env: {
      ...process.env,
      SENTINEL_HOST_DATA: hostDataDir,
      TETHER_HOST_DATA: hostDataDir,
      SENTINEL_STORE_ROOT: storeRoot,
      TETHER_STORE_ROOT: storeRoot,
    },
  });
  if (child.error) return { decision: 'blocked', error: child.error.message };
  try { return JSON.parse(child.stdout); } catch { return { decision: 'blocked', error: child.stderr || 'beacon-cli returned invalid JSON' }; }
}

function degraded(reason) {
  return { action: 'enforcement_degraded', reason };
}

function isRisky(command) {
  return /\brm\s+-(?:[^\s-]*r[^\s-]*f|[^\s-]*f[^\s-]*r)\b|git\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f\b)|drop\s+(database|table)|\bcurl\b[^\n|]*\|\s*(sh|bash)|wrangler\s+(deploy|delete)|terraform\s+(apply|destroy)/i.test(command);
}

function readJson() { try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; } }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

if (require.main === module) main();
module.exports = { evaluate, main, degraded, isCompletionIntent };
