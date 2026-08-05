#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHostDataDir, envFirst } = require('../../lib/host');
const { buildRetryFingerprint } = require('../../lib/budget');
const lockedDomain = require('../../lib/locked-domain');
// Plan 2.6: decision-point routing for discovery tool calls. The logic lives in
// Membrane's CJS module (single source of truth); the Forge PreToolUse hook
// wires it into the live host path so a broad discovery grep gets a
// membrane_context suggestion at the moment the agent is about to search,
// rather than only as a passive session-start instruction.
let decisionPoints = null;
function loadDecisionPoints(root) {
  if (decisionPoints) return decisionPoints;
  // Resolve the membrane submodule relative to the forge repo.
  const candidates = [
    path.join(root, '..', 'membrane', 'mcp', 'decision-points-lib.cjs'),
    path.resolve(__dirname, '..', '..', '..', 'membrane', 'mcp', 'decision-points-lib.cjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      decisionPoints = require(candidate);
      return decisionPoints;
    }
  }
  return null;
}

function main() {
  const result = evaluate(readJson());
  emit(result);
  if (result.action === 'block') process.exitCode = 1;
}

function evaluate(event, { root = envFirst('FORGE_ROOT') ?? path.resolve(__dirname, '../..'), projectRoot = process.cwd() } = {}) {
  const cli = path.join(root, 'cli.js');
  const name = event.hook_event_name ?? event.event ?? event.type ?? '';
  let runId = event.run_id ?? event.runId;
  let bindingStatus = null;
  const sessionId = event.session_id ?? event.sessionId ?? process.env.CODEX_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
  const taskId = event.task_id ?? event.taskId ?? null;
  const workspaceHash = event.workspace_hash ?? event.workspaceHash ?? null;
  // Arm on evidence, before any branch can return: a locked path reached by ANY event in the
  // session makes Forge mandatory for the rest of it, including the closing turn.
  let armedDomains = [];
  try {
    armedDomains = lockedDomain.observe(event, sessionId, projectRoot);
  } catch {
    // A trigger that cannot record must not take the session down; the Stop gate below degrades
    // explicitly rather than silently passing.
  }

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
    if (isRisky(command)) return { action: 'block', reason: 'high-risk command requires Forge assess before execution' };
    // Plan 2.6: even without an active Forge run, a broad discovery tool
    // call gets a non-blocking membrane_context suggestion. The agent may
    // still proceed — this never blocks, it only advises at the decision point.
    const suggestion = discoverySuggestion(event, root);
    if (suggestion) return { action: 'noop', reason: 'routine tool use without active forge run', suggestion };
    return { action: 'noop', reason: 'routine tool use without active forge run' };
  }

  const validationEvents = ['Stop', 'stop', 'PostToolUse', 'post_tool_use', 'PostToolUseFailure', 'post_tool_use_failure'];
  if (!runId && validationEvents.includes(name)) {
    if ((name === 'Stop' || name === 'stop') && isCompletionIntent(event)
      && lockedDomain.completionRequiresReceipt(event) && !event.verification_receipt && !event.verificationReceipt) {
      return { action: 'block', reason: 'verification receipt required for verified completion claim' };
    }
    if ((name === 'Stop' || name === 'stop') && bindingStatus === 'closed' && !isCompletionIntent(event)) {
      return { action: 'noop', reason: 'conversational_stop' };
    }
    // The locked-domain case is the one this trigger exists for: the session touched a locked path
    // and is now trying to conclude with NO Forge run at all. Blocking here is what forces the
    // claim to be recorded and evidenced instead of asserted in a closing sentence.
    if ((name === 'Stop' || name === 'stop') && armedDomains.length > 0 && isCompletionIntent(event)) {
      return {
        action: 'block',
        reason: 'locked domain requires an active Forge run before completion',
        locked_domains: armedDomains,
      };
    }
    return degraded('no active forge run');
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
    if (!isRisky(command)) {
      // Plan 2.6: a non-risky tool call may still be a broad discovery sweep.
      // Surface the membrane_context suggestion (non-blocking) before allowing.
      const suggestion = discoverySuggestion(event, root);
      if (suggestion) return { action: 'allow', reason: 'routine tool use', suggestion };
      return { action: 'noop', reason: 'routine tool use' };
    }
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
    // Degradation is explicit and carries the armed domains, never a silent pass. When the ledger
    // or CLI is unavailable this surfaces as enforcement_degraded with a reason — an outage must be
    // visible, because an invisible one becomes a bypass habit.
    if (armedDomains.length > 0 && verifyResult.error) {
      return {
        action: 'enforcement_degraded',
        reason: 'locked domain gate could not be evaluated',
        locked_domains: armedDomains,
        error: verifyResult.error,
      };
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
  const hostDataDir = envFirst('FORGE_HOST_DATA') ?? resolveHostDataDir();
  const child = spawnSync(process.execPath, [cli, command, '--json'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: true,
    cwd: projectRoot,
    env: {
      ...process.env,
      FORGE_HOST_DATA: hostDataDir,
    },
  });
  if (child.error) return { decision: 'blocked', error: child.error.message };
  try { return JSON.parse(child.stdout); } catch { return { decision: 'blocked', error: child.stderr || 'forge-cli returned invalid JSON' }; }
}

function degraded(reason) {
  return { action: 'enforcement_degraded', reason };
}

function isRisky(command) {
  return /\brm\s+-(?:[^\s-]*r[^\s-]*f|[^\s-]*f[^\s-]*r)\b|git\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f\b)|drop\s+(database|table)|\bcurl\b[^\n|]*\|\s*(sh|bash)|wrangler\s+(deploy|delete)|terraform\s+(apply|destroy)/i.test(command);
}

// Plan 2.6: classify a tool call through Membrane's decision-point router and
// return its suggestion when the call is a broad or cross-repo discovery. The
// routing never blocks — a SUGGEST/ROUTE decision is returned as advisory text
// the host can surface; PASS decisions return null so nothing is emitted.
function discoverySuggestion(event, root) {
  const lib = loadDecisionPoints(root);
  if (!lib) return null;
  try {
    const decision = lib.routeToolCall(event);
    if (decision && (decision.decision === lib.SUGGEST || decision.decision === lib.ROUTE)) {
      return decision.suggestion || null;
    }
  } catch {
    // A classification error must never block the tool call.
  }
  return null;
}

function readJson() { try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; } }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

if (require.main === module) main();
module.exports = { evaluate, main, degraded, isCompletionIntent };
