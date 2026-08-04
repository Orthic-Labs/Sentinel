'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_HANDLER_BUDGET_MS = 1_500;
const DEFAULT_TOTAL_BUDGET_MS = 3_000;
const CONTEXT_EVENTS = new Set(['SessionStart', 'session_start', 'UserPromptSubmit', 'user_prompt_submit']);
const TOOL_EVENTS = new Set(['PreToolUse', 'pre_tool_use', 'PostToolUse', 'post_tool_use', 'PostToolUseFailure', 'post_tool_use_failure']);

function handlersFor(eventName, host) {
  if (CONTEXT_EVENTS.has(eventName)) return [{ name: 'context', file: path.join(__dirname, host, 'context.js'), verifier: true }];
  const handlers = [{ name: 'gate', file: path.join(__dirname, host, 'hook.js'), verifier: true }];
  if (TOOL_EVENTS.has(eventName)) handlers.push({ name: 'tool_receipt', file: path.join(__dirname, 'claude-code', 'tool-receipt.js'), verifier: false });
  return handlers;
}

function dispatch(event = {}, options = {}) {
  const host = options.host ?? process.env.SENTINEL_HOST ?? 'claude-code';
  const eventName = event.hook_event_name ?? event.event ?? event.type ?? '';
  const handlerBudgetMs = options.handlerBudgetMs ?? (Number(process.env.SENTINEL_HANDLER_BUDGET_MS) || DEFAULT_HANDLER_BUDGET_MS);
  const totalBudgetMs = options.totalBudgetMs ?? (Number(process.env.SENTINEL_TOTAL_BUDGET_MS) || DEFAULT_TOTAL_BUDGET_MS);
  const started = Date.now();
  const records = [];
  const outputs = [];

  for (const handler of handlersFor(eventName, host)) {
    const elapsed = Date.now() - started;
    if (elapsed >= totalBudgetMs) {
      records.push({ handler: handler.name, latency_ms: 0, status: 'bypassed_total_budget' });
      continue;
    }
    const before = Date.now();
    const result = (options.runHandler ?? runHandler)(handler, event, Math.min(handlerBudgetMs, totalBudgetMs - elapsed), host);
    const latency = Date.now() - before;
    const timedOut = result?.timedOut || result?.error?.code === 'ETIMEDOUT';
    records.push({ handler: handler.name, latency_ms: latency, status: timedOut ? 'bypassed_delayed_verifier' : (result?.status === 0 ? 'ok' : 'failed') });
    if (!timedOut && result?.stdout) outputs.push(result.stdout.trim());
  }
  return { event: eventName, host, handlers: records, total_latency_ms: Date.now() - started, outputs };
}

function runHandler(handler, event, timeout, host) {
  return spawnSync(process.execPath, [handler.file], {
    input: JSON.stringify(event), encoding: 'utf8', windowsHide: true, timeout,
    env: { ...process.env, MEMBRANE_CLIENT: host === 'codex' ? 'codex' : 'claude_code' },
  });
}

function main() {
  let event = {};
  try { event = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); } catch { event = {}; }
  const result = dispatch(event);
  const payloads = result.outputs.map((value) => { try { return JSON.parse(value); } catch { return null; } }).filter(Boolean);
  const blocking = payloads.find((value) => value.decision === 'block' || value?.hookSpecificOutput?.permissionDecision === 'deny');
  if (blocking) process.stdout.write(`${JSON.stringify(blocking)}\n`);
  else {
    const contexts = payloads.map((value) => value?.hookSpecificOutput?.additionalContext).filter(Boolean);
    contexts.push(`Sentinel dispatcher: ${JSON.stringify({ handlers: result.handlers, total_latency_ms: result.total_latency_ms })}`);
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: result.event, additionalContext: contexts.join('\n') } })}\n`);
  }
}

if (require.main === module) main();
module.exports = { dispatch, handlersFor, main, DEFAULT_HANDLER_BUDGET_MS, DEFAULT_TOTAL_BUDGET_MS };
