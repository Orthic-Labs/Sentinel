// Live tasklist -> close round-trip against a freshly-spawned resident crypt-service.
// This is the runtime-activated + end-to-end tested column of workspace rule 6.6: the
// time_variance receipt on close must be produced by the real transaction, with the rhook-shaped
// duration_ms values coming from the service's own observable-event ledger, not from the model.
//
// The test uses a temp workspace symlink to the freshly-built crypt-service binary on a
// loopback port that has nothing else listening on it, so it never touches the production
// resident service on 47851. It also uses a temp Sentinel storeRoot so no real Sentinel state
// is written.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SentinelCore } = require('../lib/core.js');
const { createStore } = require('../lib/store.js');
const { resolveDefaultStoreRoot } = require('../lib/host.js');
const { actualActiveMinutes } = require('../lib/time-accounting.js');

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CRYPT_BIN = join(REPO_ROOT, 'membrane/engine/target/debug/crypt-service');
const ONNX_DYLIB = join(REPO_ROOT, 'tools/bin/libonnxruntime.dylib');

// Pick a loopback port unlikely to be in use. The test will fail with a clear error if the
// port is already bound, never silently fall back to the production resident.
function pickFreePort() {
  // 47853+ keeps us off the production 47851 and the one-off 47852 we used during smoke.
  return 47853 + Math.floor(Math.random() * 100);
}

function waitForHealth(port, token, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveFn, rejectFn) => {
    const attempt = () => {
      const req = require('node:http').get(
        {
          host: '127.0.0.1',
          port,
          path: '/health',
          headers: { Authorization: `Bearer ${token}` },
          timeout: 500,
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolveFn();
          if (Date.now() > deadline) return rejectFn(new Error(`/health ${res.statusCode}`));
          setTimeout(attempt, 100);
        },
      );
      req.on('error', () => {
        if (Date.now() > deadline) return rejectFn(new Error('health check timed out'));
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function postJson(port, token, urlPath, body) {
  return new Promise((resolveFn, rejectFn) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = require('node:http').request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolveFn({ status: res.statusCode, body: text ? JSON.parse(text) : {} });
          } catch (parseError) {
            rejectFn(parseError);
          }
        });
      },
    );
    req.on('error', rejectFn);
    req.write(payload);
    req.end();
  });
}

async function ingestEvents(port, token, installationId, sessionId, taskId, durations, timestamp) {
  // Service caps one event per (installation, session, turn, phase). Distinct turn_ids are
  // required; the test only cares about duration_ms summing, not turn semantics.
  const events = durations.map((durationMs, index) => ({
    schema: 'orthic.observable-event.v1',
    installation_id: installationId,
    client_id: 'claude_code',
    session_id: sessionId,
    task_id: taskId,
    turn_id: `e2e-turn-${index}`,
    trace_id: `e2e-trace-${index}`,
    event_id: `observable-${index.toString().padStart(24, '0')}`,
    event_type: 'tool_receipt',
    origin: 'tool',
    content_ref_or_digest: `sha256:${index.toString(16).padStart(64, '0')}`,
    timestamp: timestamp ?? new Date().toISOString(),
    completeness: { input: true, output: true, receipt: true },
    policy_snapshot_digest: 'sha256:000000000000000000000000000000000000000000000000000000000000beef',
    duration_ms: durationMs,
  }));
  const response = await postJson(port, token, '/v1/telemetry/observable-events:batch', { events });
  assert.equal(response.status, 201, `batch ingestion failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

function spawnCryptService(workspaceRoot, port) {
  const bin = join(workspaceRoot, 'tools/bin/crypt-service');
  // WORKSPACE_ROOT lets the binary resolve the symlink chain from a non-canonical location.
  const child = spawn(bin, [], {
    env: {
      ...process.env,
      WORKSPACE_ROOT: workspaceRoot,
      RUST_LOG: 'warn',
      HF_HUB_OFFLINE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  return child;
}

test('time-accounting e2e: live tasklist -> close round-trip against the resident service', async (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'sentinel-e2e-'));
  t.after(() => {
    try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // Build the tools/bin layout the binary expects: a symlink to the freshly-built binary
  // sitting next to a symlink to the onnxruntime dylib, with a runtime.json that identifies
  // the service as a crypt-local-v1 loopback instance on a non-47851 port.
  mkdirSync(join(workspaceRoot, 'tools/bin'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'tools/lib/memory'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'tools/.cache/memory'), { recursive: true });
  symlinkSync(CRYPT_BIN, join(workspaceRoot, 'tools/bin/crypt-service'));
  symlinkSync(ONNX_DYLIB, join(workspaceRoot, 'tools/bin/libonnxruntime.dylib'));

  const port = pickFreePort();
  writeFileSync(
    join(workspaceRoot, 'tools/lib/memory/runtime.json'),
    JSON.stringify({
      schemaVersion: 1,
      serviceId: 'crypt-local-v1',
      host: '127.0.0.1',
      port,
    }),
  );
  // Mirror runtime.json to the location the Sentinel time-accounting reader resolves by default,
  // so the round-trip uses the same identity the test asserted.
  const runtimeConfigPath = join(workspaceRoot, 'tools/lib/memory/runtime.json');

  const service = spawnCryptService(workspaceRoot, port);
  t.after(() => {
    if (service.exitCode === null) service.kill('SIGTERM');
  });
  service.stderr.on('data', (chunk) => process.stderr.write(`[crypt-service] ${chunk}`));

  // The service prints the token file path on first boot; poll for it instead of assuming timing.
  let token;
  const tokenDeadline = Date.now() + 5_000;
  while (Date.now() < tokenDeadline) {
    try {
      token = readFileSync(join(workspaceRoot, 'tools/.cache/memory/api-token'), 'utf8').trim();
      if (token) break;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(token, 'crypt-service did not write api-token within 5s');

  await waitForHealth(port, token);

  const installationId = JSON.parse(
    readFileSync(join(workspaceRoot, 'tools/.cache/memory/installation.json'), 'utf8'),
  ).installation_id;

  // Post a known batch of tool_receipt events with explicit duration_ms each. The receipts
  // sum to 5 * 30_000 = 150_000 ms = 2.5 minutes; that is the receipt the round-trip must
  // surface, not anything the test derives locally. Timestamps are anchored 1 second *after*
  // the run's created_at so the close-time `since` filter still includes them.
  const sessionId = 'sentinel-e2e-session';
  const taskId = 'sentinel-e2e-task';
  const perCallMs = 30_000;
  const eventCount = 5;
  // Sentinel run is created before the events so its created_at is older than the event
  // timestamps and the close() `since` filter does not exclude them.
  const sentinelRoot = mkdtempSync(join(tmpdir(), 'sentinel-store-'));
  t.after(() => {
    try { rmSync(sentinelRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  const store = createStore(sentinelRoot);
  const core = new SentinelCore({
    projectRoot: REPO_ROOT,
    storeRoot: sentinelRoot,
    store,
    authority: 'host',
    runtimeConfigPath: runtimeConfigPath,
  });

  const assess = core.assess({
    summary: 'e2e time-accounting round-trip',
    session_id: sessionId,
    task_id: taskId,
    acceptance_criteria: [{
      id: 'time-variance-receipt-correct',
      criterion: 'time_variance receipt is produced and correct',
      verification: [{ kind: 'script', specification: 'resident crypt-service returns a non-empty duration_ms sum for the session' }],
    }],
  });
  // Anchor the event timestamps to a known offset after the run creation so the close-time
  // `since` filter is a no-op for our events.
  const eventTimestamp = new Date(Date.now() + 1_000).toISOString();
  await ingestEvents(port, token, installationId, sessionId, taskId, Array(eventCount).fill(perCallMs), eventTimestamp);

  // Debug: probe the route directly to confirm the service returns the expected rows.
  const probe = await postJson(port, token, '/v1/telemetry/observable-events:query-sentinel-time', {
    sessionId,
    limit: 100,
  });
  assert.equal(probe.status, 200, `probe failed: ${JSON.stringify(probe.body)}`);
  assert.ok(probe.body.rows.length > 0, 'route returned no rows for the test session');

  // Planned budget = 2 minutes. Actual measured = 2.5 minutes. Variance = +25% -> overrun,
  // miss threshold (10%). That asymmetry is the proof: the receipt came from the service,
  // not from the model.
  const plannedMinutes = 2;
  const expectedActualMinutes = (eventCount * perCallMs) / 60_000;

  // Attach passing evidence + a host/operator-authored check so the signoff gate has
  // something to evaluate. The gate requires minimum passing checks and at least one
  // non-model-claim evidence item of each required kind; we satisfy both with a repo
  // evidence item, an observation evidence item, and a script check linked to the criterion.
  core.checkpoint({
    run_id: assess.run_id,
    evidence: [
      {
        kind: 'repo',
        excerpt: 'actualActiveMinutes',
        uri: `file://${join(REPO_ROOT, 'sentinel/lib/time-accounting.js')}`,
        locator: join(REPO_ROOT, 'sentinel/lib/time-accounting.js'),
        criterion_id: 'time-variance-receipt-correct',
        authority: 'host',
        receipt: JSON.stringify({ exit_status: 0 }),
      },
      {
        kind: 'observation',
        excerpt: 'actualActiveMinutes',
        uri: `file://${join(REPO_ROOT, 'sentinel/lib/time-accounting.js')}`,
        locator: join(REPO_ROOT, 'sentinel/lib/time-accounting.js'),
        criterion_id: 'time-variance-receipt-correct',
        authority: 'host',
        receipt: JSON.stringify({ exit_status: 0 }),
      },
    ],
    checks: [
      {
        kind: 'script',
        command: `${process.execPath} --version`,
        specification: 'resident crypt-service returns a non-empty duration_ms sum for the session',
        criterion_id: 'time-variance-receipt-correct',
        authority: 'host',
        receipt: JSON.stringify({ exit_status: 0 }),
      },
    ],
  });
  // Move the run through verify -> close. The plan requires only one rubric gate: the
  // gate-versioned signoff actually wired into the time-accounting branch.
  core.verify({ run_id: assess.run_id, gate: 'signoff' });
  const close = await core.close({
    run_id: assess.run_id,
    summary: 'closed with time receipt',
    time_receipt: { planned_minutes: plannedMinutes },
  });

  // The receipt must exist, must identify the receipt as an overrun, and must reflect the
  // exact durations posted to the service. None of these numbers are derived in the test --
  // they come from the service's row-by-row sum of duration_ms.
  assert.equal(close.decision, 'closed', JSON.stringify(close));
  assert.ok(close.time_variance, 'close() did not return a time_variance receipt');
  assert.equal(close.time_variance.planned_minutes, plannedMinutes);
  assert.equal(close.time_variance.actual_minutes, expectedActualMinutes);
  assert.equal(close.time_variance.variance_pct, 25);
  assert.equal(close.time_variance.miss, true);
  assert.equal(close.time_variance.direction, 'overrun');

  // The decision ledger must also persist the variance, so a later audit can confirm the
  // receipt was recorded alongside the close, not just emitted and lost.
  const decisions = store.list('decisions').filter((row) => row.run_id === assess.run_id);
  const closeDecision = decisions.find((row) => row.decision === 'closed');
  assert.ok(closeDecision, 'close decision row missing');
  assert.ok(closeDecision.time_variance, 'close decision row missing time_variance');
  assert.equal(closeDecision.time_variance.actual_minutes, expectedActualMinutes);
});

test('time-accounting e2e: planned budget slightly over actuals does not record a miss', async (t) => {
  // Same round-trip, but with event durations summing to 50_000 ms (~0.833 min) and a
  // planned budget of 1 minute. Variance = -16.67% -> overquote, still beyond the 10%
  // threshold so .miss must be true. This second case exists so the test cannot pass by
  // silently ignoring the threshold; the assertion is exercised on both sides.
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'sentinel-e2e-'));
  t.after(() => {
    try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  mkdirSync(join(workspaceRoot, 'tools/bin'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'tools/lib/memory'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'tools/.cache/memory'), { recursive: true });
  symlinkSync(CRYPT_BIN, join(workspaceRoot, 'tools/bin/crypt-service'));
  symlinkSync(ONNX_DYLIB, join(workspaceRoot, 'tools/bin/libonnxruntime.dylib'));

  const port = pickFreePort();
  writeFileSync(
    join(workspaceRoot, 'tools/lib/memory/runtime.json'),
    JSON.stringify({
      schemaVersion: 1,
      serviceId: 'crypt-local-v1',
      host: '127.0.0.1',
      port,
    }),
  );

  const service = spawnCryptService(workspaceRoot, port);
  t.after(() => {
    if (service.exitCode === null) service.kill('SIGTERM');
  });
  service.stderr.on('data', (chunk) => process.stderr.write(`[crypt-service] ${chunk}`));

  let token;
  const tokenDeadline = Date.now() + 5_000;
  while (Date.now() < tokenDeadline) {
    try {
      token = readFileSync(join(workspaceRoot, 'tools/.cache/memory/api-token'), 'utf8').trim();
      if (token) break;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(token, 'crypt-service did not write api-token within 5s');

  await waitForHealth(port, token);

  const installationId = JSON.parse(
    readFileSync(join(workspaceRoot, 'tools/.cache/memory/installation.json'), 'utf8'),
  ).installation_id;

  const sessionId = 'sentinel-e2e-session-overquote';
  const taskId = 'sentinel-e2e-task-overquote';
  // Sentinel run is created BEFORE the events so its created_at is older than the event
  // timestamps and the close-time `since` filter does not exclude them.
  const sentinelRoot = mkdtempSync(join(tmpdir(), 'sentinel-store-'));
  t.after(() => {
    try { rmSync(sentinelRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  const core = new SentinelCore({
    projectRoot: REPO_ROOT,
    storeRoot: sentinelRoot,
    store: createStore(sentinelRoot),
    authority: 'host',
    runtimeConfigPath: join(workspaceRoot, 'tools/lib/memory/runtime.json'),
  });

  const assess = core.assess({
    summary: 'e2e overquote case',
    session_id: sessionId,
    task_id: taskId,
    acceptance_criteria: [{
      id: 'overquote-receipt-symmetric',
      criterion: 'overquote receipt is symmetric with overrun',
      verification: [{ kind: 'script', specification: 'resident crypt-service returns a non-empty duration_ms sum for the session' }],
    }],
  });
  // 1 event at 50_000ms = 0.833 minutes actual. Plan 1 minute -> -16.67% overquote.
  const eventTimestampOverquote = new Date(Date.now() + 1_000).toISOString();
  await ingestEvents(port, token, installationId, sessionId, taskId, [50_000], eventTimestampOverquote);
  core.checkpoint({
    run_id: assess.run_id,
    evidence: [
      {
        kind: 'repo',
        excerpt: 'actualActiveMinutes',
        uri: `file://${join(REPO_ROOT, 'sentinel/lib/time-accounting.js')}`,
        locator: join(REPO_ROOT, 'sentinel/lib/time-accounting.js'),
        criterion_id: 'overquote-receipt-symmetric',
        authority: 'host',
        receipt: JSON.stringify({ exit_status: 0 }),
      },
      {
        kind: 'observation',
        excerpt: 'actualActiveMinutes',
        uri: `file://${join(REPO_ROOT, 'sentinel/lib/time-accounting.js')}`,
        locator: join(REPO_ROOT, 'sentinel/lib/time-accounting.js'),
        criterion_id: 'overquote-receipt-symmetric',
        authority: 'host',
        receipt: JSON.stringify({ exit_status: 0 }),
      },
    ],
    checks: [
      {
        kind: 'script',
        command: `${process.execPath} --version`,
        specification: 'resident crypt-service returns a non-empty duration_ms sum for the session',
        criterion_id: 'overquote-receipt-symmetric',
        authority: 'host',
        receipt: JSON.stringify({ exit_status: 0 }),
      },
    ],
  });
  core.verify({ run_id: assess.run_id, gate: 'signoff' });
  const close = await core.close({
    run_id: assess.run_id,
    summary: 'closed with overquote receipt',
    time_receipt: { planned_minutes: 1 },
  });

  assert.equal(close.decision, 'closed');
  assert.ok(close.time_variance);
  assert.equal(close.time_variance.direction, 'overquote');
  assert.equal(close.time_variance.miss, true);
  // 50_000 ms / 60 = 0.8333...; rounded to 2dp = 0.83.
  assert.equal(close.time_variance.actual_minutes, 0.83);
  // (0.8333 - 1) / 1 * 100 = -16.67 (rounded to 2dp).
  assert.equal(close.time_variance.variance_pct, -16.67);
});
