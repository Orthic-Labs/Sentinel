#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { evaluate } = require('./generic/hook');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let event = {};
  try { event = JSON.parse(raw); } catch { /* Generic hook safely handles malformed host events. */ }
  const root = path.resolve(__dirname, '..');
  let result = { action: 'noop', reason: 'tether hook unavailable' };
  try { result = evaluate(event, { root }); } catch { /* Fail open when Tether cannot evaluate its own result. */ }
  if (result.action !== 'block') return;
  const eventName = event.hook_event_name ?? event.event ?? event.type ?? '';
  const reason = String(result.reason ?? 'tether gate unmet').slice(0, 500);
  if (eventName === 'PreToolUse' || eventName === 'pre_tool_use') {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
      },
    })}\n`);
    return;
  }
  if (eventName === 'Stop' || eventName === 'stop') {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName || 'PostToolUse', additionalContext: reason },
  })}\n`);
}

if (require.main === module) main();
module.exports = { main };
