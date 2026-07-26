#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function main() {
  const result = evaluate(readJson());
  emit(result);
  if (result.action === 'block') process.exitCode = 1;
}

function evaluate(event, { root = process.env.TETHER_ROOT ?? path.resolve(__dirname, '../..') } = {}) {
  const cli = path.join(root, 'cli.js');
  const name = event.hook_event_name ?? event.event ?? event.type ?? '';
  let runId = event.run_id;
  const sessionId = event.session_id ?? event.sessionId ?? process.env.CODEX_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;

  if (!runId && sessionId) {
    const binding = invoke(cli, 'resolve-session', { session_id: sessionId });
    runId = binding.run_id;
    if (!runId) return { action: 'noop', reason: binding.status === 'ambiguous' ? 'ambiguous active tether runs' : 'no active tether run' };
  }

  // A host can emit lifecycle events before the model has assessed a task. Enforcement cannot
  // infer a run without inventing state, so those events are deliberately inert.
  if (!runId && ['Stop', 'stop', 'PreToolUse', 'pre_tool_use', 'PostToolUseFailure', 'post_tool_use_failure'].includes(name)) {
    return { action: 'noop', reason: 'no active tether run' };
  }

  if (name === 'Stop' && (event.stop_hook_active === true || event.stopHookActive === true)) {
    return { action: 'noop', reason: 'stop_hook_active' };
  }

  const isFailureEvent = name === 'PostToolUseFailure' || name === 'post_tool_use_failure'
    || ((name === 'PostToolUse' || name === 'post_tool_use') && Boolean(event.failure ?? event.error ?? event.tool_error));

  if (isFailureEvent) {
    const failure = event.failure ?? {};
    const fingerprint = failure.error_fingerprint ?? failure.fingerprint ?? crypto.createHash('sha256').update(JSON.stringify({ tool: event.tool_name, command: event.command, error: event.error })).digest('hex');
    const result = invoke(cli, 'checkpoint', {
      run_id: runId,
      summary: 'Tool failure captured by enforcement hook',
      failure: { ...failure, error_fingerprint: fingerprint },
    });
    return result.decision === 'blocked' ? { action: 'block', reason: 'identical failure retry budget exhausted', result } : { action: 'continue', result };
  }

  if (name === 'PreToolUse' || name === 'pre_tool_use') {
    const command = String(event.command ?? event.tool_input?.command ?? '');
    if (!isRisky(command)) return { action: 'noop', reason: 'routine tool use' };
    const result = invoke(cli, 'verify', {
      run_id: runId, gate: 'high_risk',
      intent_restatement: event.intent_restatement, blast_radius: event.blast_radius, why_safe: event.why_safe,
    });
    return result.decision === 'blocked' ? { action: 'block', reason: 'high-risk gate unmet', result } : { action: 'allow', result };
  }

  if (name === 'Stop' || name === 'stop') {
    const result = invoke(cli, 'verify', { run_id: runId, gate: 'signoff' });
    return result.decision === 'blocked' ? { action: 'block', reason: 'signoff gate unmet', result } : { action: 'allow', result };
  }

  return { action: 'noop', reason: 'unsupported or low-signal event' };
}

function invoke(cli, command, input) {
  const child = spawnSync(process.execPath, [cli, command, '--operator', '--json'], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: { ...process.env, TETHER_TRUSTED_CALLER: 'hook' } });
  if (child.error) return { decision: 'blocked', error: child.error.message };
  try { return JSON.parse(child.stdout); } catch { return { decision: 'blocked', error: child.stderr || 'tether-cli returned invalid JSON' }; }
}

function isRisky(command) {
  return /\brm\s+-(?:[^\s-]*r[^\s-]*f|[^\s-]*f[^\s-]*r)\b|git\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f\b)|drop\s+(database|table)|\bcurl\b[^\n|]*\|\s*(sh|bash)|wrangler\s+(deploy|delete)|terraform\s+(apply|destroy)/i.test(command);
}

function readJson() { try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; } }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

if (require.main === module) main();
module.exports = { evaluate, main };
