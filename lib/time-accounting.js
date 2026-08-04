'use strict';

// Sentinel side of workspace rule 6.6 (time-accounting loop): tasklist declares a planned
// minute budget, the host's tool-receipt hook already stamps real started_at/completed_at per
// tool call into Membrane's telemetry ledger, and close() reads the sum back through Sentinel's
// own scoped read path (query_observable_events_for_sentinel, tool-origin only) to score
// plan-vs-actual variance. This never blocks close -- see workspace rule: "never force-close,
// only report."
//
// Correlation key is session_id, not task_id: the host's tool-receipt events key on the actual
// session id threaded through every hook call (visible in every PostToolUse receipt this
// session), while a Sentinel run's task_id is caller-supplied and has no guaranteed relationship
// to that. session_id is the identifier both sides already share.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const RUNTIME_CONFIG_PATH = path.join(__dirname, '..', '..', 'tools', 'lib', 'memory', 'runtime.json');
const VARIANCE_THRESHOLD_PCT = 10;
const REQUEST_TIMEOUT_MS = 2_000;

// Mirrors membrane/hooks/observable-ingress.js::resolveRuntimeConfigIdentity: trust the runtime
// config only when it identifies itself as the real crypt-local-v1 service and stays
// loopback-only. A throw here means "unavailable", never "assume a default port".
function resolveRuntimeConfigIdentity(configPath = RUNTIME_CONFIG_PATH) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.schemaVersion !== 1 || config.serviceId !== 'crypt-local-v1') {
    throw new Error('invalid crypt runtime config identity');
  }
  if (config.host !== '127.0.0.1') {
    throw new Error('crypt runtime host must remain loopback-only');
  }
  return config;
}

function postJson(host, port, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request(
      {
        host, port, path: urlPath, method: 'POST', timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode, body: text ? JSON.parse(text) : {} });
          } catch (parseError) {
            reject(parseError);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('membrane telemetry request timed out')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

/**
 * Sum tool-origin duration_ms for a session via Sentinel's scoped Membrane read path
 * (:query-sentinel-time -> query_observable_events_for_sentinel, tool-origin only). Returns null
 * -- never throws -- when the resident service is unavailable, unconfigured, or errors: time
 * accounting is a reported miss when present, never a dependency close can be blocked on.
 */
async function actualActiveMinutes({ sessionId, sinceIso, configPath, limit = 1_000 } = {}) {
  if (!sessionId) return null;
  let config;
  try {
    config = resolveRuntimeConfigIdentity(configPath);
  } catch {
    return null;
  }
  try {
    const { status, body } = await postJson(
      config.host,
      config.port,
      '/v1/telemetry/observable-events:query-sentinel-time',
      { sessionId, since: sinceIso, limit },
      REQUEST_TIMEOUT_MS,
    );
    if (status !== 200 || !Array.isArray(body?.rows)) return null;
    const totalMs = body.rows.reduce(
      (sum, row) => sum + (typeof row.duration_ms === 'number' ? row.duration_ms : 0),
      0,
    );
    return { minutes: totalMs / 60_000, rowCount: body.rows.length, truncated: Boolean(body.truncated) };
  } catch {
    return null;
  }
}

/**
 * Symmetric plan-vs-actual variance per workspace rule 6.6: a miss beyond
 * +-VARIANCE_THRESHOLD_PCT in either direction (overquote or overrun) is recorded, never a gate
 * block. Returns null when there is nothing to compare (no positive planned minutes, or no
 * actual-minutes measurement).
 */
function evaluateVariance(plannedMinutes, actualMinutes) {
  if (!(plannedMinutes > 0) || !(actualMinutes >= 0)) return null;
  const variancePct = ((actualMinutes - plannedMinutes) / plannedMinutes) * 100;
  return {
    planned_minutes: plannedMinutes,
    actual_minutes: Math.round(actualMinutes * 100) / 100,
    variance_pct: Math.round(variancePct * 100) / 100,
    miss: Math.abs(variancePct) > VARIANCE_THRESHOLD_PCT,
    direction: variancePct > 0 ? 'overrun' : variancePct < 0 ? 'overquote' : 'exact',
  };
}

module.exports = {
  VARIANCE_THRESHOLD_PCT,
  RUNTIME_CONFIG_PATH,
  resolveRuntimeConfigIdentity,
  actualActiveMinutes,
  evaluateVariance,
};
