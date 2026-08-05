import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lockedDomain = require('../lib/locked-domain.js');
const { evaluate } = require('../hooks/generic/hook.js');

function isolatedHost() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-locked-'));
  process.env.FORGE_HOST_DATA = dir;
  return dir;
}

function project() {
  const root = mkdtempSync(join(tmpdir(), 'forge-locked-proj-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('a locked path is recognised through any path-bearing field, read or write', () => {
  isolatedHost();
  assert.equal(lockedDomain.domainFor('crates/kws/src/sherpa_kws.rs'), 'kws-wake');
  assert.equal(lockedDomain.domainFor('src/worker_sections/decode.rs'), 'kws-wake');
  assert.equal(lockedDomain.domainFor('tests/wake_word/realworld_gate/run.py'), 'kws-wake');
  assert.equal(lockedDomain.domainFor('src/unrelated/main.rs'), null);
});

test('Windows-style separators match the same patterns', () => {
  isolatedHost();
  assert.equal(lockedDomain.domainFor('D:\\Claude\\crates\\kws\\src\\sherpa_kws.rs'), 'kws-wake');
});

test('arming is sticky: a later unrelated turn cannot disarm the session', () => {
  isolatedHost();
  const root = project();
  lockedDomain.observe({ tool_input: { file_path: 'src/sherpa_kws.rs' } }, 'sess-sticky', root);
  // Many later turns touching nothing locked — the exact shape of a long debugging session.
  for (let i = 0; i < 5; i += 1) {
    lockedDomain.observe({ tool_input: { file_path: 'README.md' } }, 'sess-sticky', root);
  }
  assert.deepEqual(lockedDomain.armedDomains('sess-sticky', root), ['kws-wake']);
});

test('arming is idempotent and scoped to its own session', () => {
  isolatedHost();
  const root = project();
  lockedDomain.observe({ tool_input: { file_path: 'src/sherpa_kws.rs' } }, 'sess-a', root);
  lockedDomain.observe({ tool_input: { file_path: 'src/sherpa_kws.rs' } }, 'sess-a', root);
  assert.deepEqual(lockedDomain.armedDomains('sess-a', root), ['kws-wake']);
  assert.deepEqual(lockedDomain.armedDomains('sess-b', root), []);
});

test('THE REGRESSION: a session that touched a locked path cannot conclude with no Forge run', () => {
  isolatedHost();
  const root = project();
  // Turn 1 — reading the file while "running an eval". No Forge run is ever opened.
  const reading = evaluate(
    { hook_event_name: 'PostToolUse', session_id: 'sess-7h', tool_input: { file_path: 'crates/kws/src/sherpa_kws.rs' } },
    { projectRoot: root },
  );
  assert.notEqual(reading.action, 'block', 'reading a locked path must not block mid-session');

  // Final turn — the agent tries to sign off with a confident causal claim and no evidence.
  const signoff = evaluate(
    { hook_event_name: 'Stop', session_id: 'sess-7h', completion_intent: true },
    { projectRoot: root },
  );
  assert.equal(signoff.action, 'block');
  assert.match(signoff.reason, /locked domain requires an active Forge run/);
  assert.deepEqual(signoff.locked_domains, ['kws-wake']);
});

test('an untouched session still reaches the ordinary degraded path, not the locked block', () => {
  isolatedHost();
  const root = project();
  const result = evaluate(
    { hook_event_name: 'Stop', session_id: 'sess-clean', completion_intent: true },
    { projectRoot: root },
  );
  assert.equal(result.action, 'enforcement_degraded');
  assert.equal(result.reason, 'no active forge run');
});

test('a conversational stop is still not a completion, even in an armed session', () => {
  isolatedHost();
  const root = project();
  lockedDomain.observe({ tool_input: { file_path: 'src/sherpa_kws.rs' } }, 'sess-chat', root);
  const result = evaluate({ hook_event_name: 'Stop', session_id: 'sess-chat' }, { projectRoot: root });
  // Without completion intent this must not become a hard block on ordinary conversation.
  assert.notEqual(result.reason, 'locked domain requires an active Forge run before completion');
});

test('the domain list is operator-editable without a code change', () => {
  const dir = isolatedHost();
  writeFileSync(
    join(dir, 'locked-domains.json'),
    JSON.stringify({ domains: [{ id: 'billing', patterns: ['src/billing/'] }] }),
  );
  const domains = lockedDomain.loadDomains();
  assert.equal(lockedDomain.domainFor('src/billing/charge.ts', domains), 'billing');
  assert.equal(lockedDomain.domainFor('src/sherpa_kws.rs', domains), null, 'operator config replaces defaults');
});

test('a malformed config falls back to the shipped defaults rather than disabling enforcement', () => {
  const dir = isolatedHost();
  writeFileSync(join(dir, 'locked-domains.json'), '{ not json');
  assert.equal(lockedDomain.domainFor('src/sherpa_kws.rs', lockedDomain.loadDomains()), 'kws-wake');
});
