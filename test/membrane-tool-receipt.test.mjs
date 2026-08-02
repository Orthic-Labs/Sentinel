import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReceipt, defaultClient } from '../hooks/claude-code/tool-receipt.js';

test('Claude tool receipt derives ccx identity from gateway URL', () => {
  assert.equal(defaultClient({ ANTHROPIC_BASE_URL: 'http://localhost:8801' }), 'ccx');
  assert.equal(defaultClient({}), 'claude_code');
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

test('Claude tool-receipt hook main path emits failure event without runtime error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-tool-receipt-'));
  const ingress = join(dir, 'events.jsonl');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/claude-code/tool-receipt.js', import.meta.url))], {
    input: JSON.stringify({ hook_event_name: 'PostToolUseFailure', task_id: 'task-1', turn_id: 'turn-1', tool_call_id: 'call-1', tool_name: 'Bash', error: 'failed', cwd: dir }),
    encoding: 'utf8',
    env: { ...process.env, MEMRIGHT_TELEMETRY_INGRESS: ingress },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tool_receipt_failed/);
  assert.match(readFileSync(ingress, 'utf8'), /tool_receipt_failed/);
});
