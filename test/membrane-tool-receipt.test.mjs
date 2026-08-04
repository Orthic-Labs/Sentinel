import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { activeTrace, buildReceipt, defaultClient } from '../hooks/claude-code/tool-receipt.js';

test('Claude tool receipt emits a typed client identity', () => {
  // Plan convention 3: receipts must attribute to the same typed identity the
  // federation layer keys on. The gateway-URL probe that produced 'ccx' made
  // telemetry and rules delivery disagree about who the client was.
  assert.equal(defaultClient({ ANTHROPIC_BASE_URL: 'http://localhost:8801' }), 'claude_code');
  assert.equal(defaultClient({}), 'claude_code');
  assert.equal(defaultClient({ MEMBRANE_CLIENT: 'api_worker' }), 'api_worker');
  assert.equal(defaultClient({ MEMBRANE_CLIENT: 'ccx' }), 'other');
});

test('Claude tool receipt is hook-issued, typed, and content-free', () => {
  const receipt = buildReceipt({
    hook_event_name: 'PostToolUse', task_id: 'task-1', turn_id: 'turn-1', tool_call_id: 'call-1',
    tool_name: 'Bash', tool_input: { command: 'printf secret' }, tool_response: { exit_code: 0 },
    cwd: '/workspace', started_at: '2026-08-01T00:00:00Z', completed_at: '2026-08-01T00:00:01Z',
  });
  assert.equal(receipt.schema, 'orthic.tool-receipt.v1');
  assert.equal(receipt.issuer_id, 'sentinel-claude-hook');
  assert.match(receipt.issuer_capability_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.input_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.output_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.source_generation_id, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(receipt), /secret/);
});

test('Claude tool receipt reuses fresh prompt trace for same session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-active-trace-'));
  const sessionId = 'dace5c62-31e7-4c35-a08d-ab7f00f0b027';
  const key = createHash('sha256').update(sessionId).digest('hex');
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({
    schema: 'membrane.active-trace.v1', session_id: sessionId,
    trace_id: '6f6bca60-9373-48a3-b98f-a7ee68d5430b', updated_at_ms: 1_000,
  }));
  assert.equal(activeTrace({ session_id: sessionId }, { MEMBRANE_ACTIVE_TRACE_DIR: dir }, 1_100), '6f6bca60-9373-48a3-b98f-a7ee68d5430b');
  assert.equal(activeTrace({ session_id: sessionId }, { MEMBRANE_ACTIVE_TRACE_DIR: dir }, 301_001), null);
});

test('Claude tool-receipt hook main path emits failure event without runtime error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-tool-receipt-'));
  const ingress = join(dir, 'events.jsonl');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/claude-code/tool-receipt.js', import.meta.url))], {
    input: JSON.stringify({ hook_event_name: 'PostToolUseFailure', task_id: 'task-1', turn_id: 'turn-1', tool_call_id: 'call-1', tool_name: 'Bash', error: 'failed', cwd: dir }),
    encoding: 'utf8',
    env: { ...process.env, CRYPT_TELEMETRY_INGRESS: ingress },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tool_receipt_failed/);
  assert.match(readFileSync(ingress, 'utf8'), /tool_receipt_failed/);
});
