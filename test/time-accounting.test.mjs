import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VARIANCE_THRESHOLD_PCT,
  resolveRuntimeConfigIdentity,
  actualActiveMinutes,
  evaluateVariance,
} from '../lib/time-accounting.js';

function writeConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-time-'));
  const file = join(dir, 'runtime.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

test('evaluateVariance: within threshold is not a miss', () => {
  const result = evaluateVariance(60, 65);
  assert.equal(result.miss, false);
  assert.equal(result.direction, 'overrun');
  assert.equal(result.variance_pct, Math.round(((65 - 60) / 60) * 100 * 100) / 100);
});

test('evaluateVariance: overrun beyond threshold is a miss', () => {
  const result = evaluateVariance(10, 20);
  assert.equal(result.miss, true);
  assert.equal(result.direction, 'overrun');
  assert.ok(result.variance_pct > VARIANCE_THRESHOLD_PCT);
});

test('evaluateVariance: overquote beyond threshold is a miss, same as overrun', () => {
  // Workspace rule 6.6: quoting 10 and finishing in 1 is scored the same as quoting 5 and taking 10.
  const overquote = evaluateVariance(10, 1);
  assert.equal(overquote.miss, true);
  assert.equal(overquote.direction, 'overquote');
});

test('evaluateVariance: returns null when there is nothing to compare', () => {
  assert.equal(evaluateVariance(0, 5), null);
  assert.equal(evaluateVariance(-5, 5), null);
  assert.equal(evaluateVariance(10, undefined), null);
});

test('resolveRuntimeConfigIdentity: rejects a config that does not identify as crypt-local-v1', () => {
  const file = writeConfig({ schemaVersion: 1, serviceId: 'something-else', host: '127.0.0.1', port: 1 });
  assert.throws(() => resolveRuntimeConfigIdentity(file), /invalid crypt runtime config identity/);
});

test('resolveRuntimeConfigIdentity: rejects a non-loopback host', () => {
  const file = writeConfig({ schemaVersion: 1, serviceId: 'crypt-local-v1', host: '0.0.0.0', port: 1 });
  assert.throws(() => resolveRuntimeConfigIdentity(file), /loopback-only/);
});

test('actualActiveMinutes: returns null (never throws) without a sessionId', async () => {
  assert.equal(await actualActiveMinutes({}), null);
});

test('actualActiveMinutes: returns null (never throws) when the config is untrusted', async () => {
  const file = writeConfig({ schemaVersion: 1, serviceId: 'wrong', host: '127.0.0.1', port: 1 });
  assert.equal(await actualActiveMinutes({ sessionId: 's-1', configPath: file }), null);
});

test('actualActiveMinutes: returns null (never throws) when the service is unreachable', async () => {
  // Port 1 is a privileged, essentially-never-listening port -- connection refused is expected.
  const file = writeConfig({ schemaVersion: 1, serviceId: 'crypt-local-v1', host: '127.0.0.1', port: 1 });
  assert.equal(await actualActiveMinutes({ sessionId: 's-1', configPath: file }), null);
});
