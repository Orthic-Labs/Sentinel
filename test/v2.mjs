import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ReflectCore } from '../lib/core.js';
import { createStore } from '../lib/store.js';
import { resolveDocs } from '../lib/docs.js';

const root = mkdtempSync(join(tmpdir(), 'tether-v2-'));
const project = join(root, 'project');
mkdirSync(join(project, 'node_modules', 'demo-lib'), { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { 'demo-lib': '1.2.3' }}));
writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/demo-lib': { version: '1.2.3' } }}));
writeFileSync(join(project, 'node_modules', 'demo-lib', 'package.json'), JSON.stringify({ name: 'demo-lib', version: '1.2.3' }));
writeFileSync(join(project, 'node_modules', 'demo-lib', 'README.md'), '# Client\nUse configure client middleware.\n');

const store = createStore(join(project, '.tether'));
const core = new ReflectCore({ projectRoot: project, store });
const assessed = core.assess({ summary: 'Fix client middleware', task_kind: 'feature', claims: [{ text: 'configure is the installed API', kind: 'versioned_api', materiality: 'critical' }] });
assert.equal(assessed.decision, 'proceed');
const sessionBinding = core.resolveSession({ session_id: 'claude-session-1' });
assert.deepEqual(sessionBinding, { run_id: assessed.run_id, status: 'bound' });
assert.equal(store.get('session_bindings', 'claude-session-1').run_id, assessed.run_id);
const enforcedHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'claude-session-2', tool_input: { command: 'rm -rf build-output' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(enforcedHook.status, 1, enforcedHook.stderr);
assert.equal(JSON.parse(enforcedHook.stdout).action, 'block');
const failureHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'claude-session-3', tool_name: 'shell', error: 'command failed' }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(failureHook.status, 0, failureHook.stderr);
assert.equal(JSON.parse(failureHook.stdout).action, 'continue');
const codexHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'codex', 'hook.js')], {
  cwd: project,
  env: { ...process.env, CODEX_SESSION_ID: 'codex-session-1', TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'rm -rf build-output' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(codexHook.status, 0, codexHook.stderr);
assert.equal(JSON.parse(codexHook.stdout).hookSpecificOutput.permissionDecision, 'deny');
const claudeHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'claude-code', 'hook.js')], {
  cwd: project,
  env: { ...process.env, CLAUDE_SESSION_ID: 'claude-session-4', TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'rm -rf build-output' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(claudeHook.status, 0, claudeHook.stderr);
assert.equal(JSON.parse(claudeHook.stdout).hookSpecificOutput.permissionDecision, 'deny');
const claim = store.list('claims')[0];
const blocked = core.checkpoint({ run_id: assessed.run_id, failure: { error_fingerprint: 'same-failure', observed_failure: 'bad result' } });
assert.equal(blocked.decision, 'proceed_with_change');
core.checkpoint({ run_id: assessed.run_id, failure: { error_fingerprint: 'same-failure', observed_failure: 'bad result' } });
const exhausted = core.checkpoint({ run_id: assessed.run_id, failure: { error_fingerprint: 'same-failure', observed_failure: 'bad result' } });
assert.equal(exhausted.decision, 'blocked');
const docs = resolveDocs({ library: 'demo-lib', query: 'configure middleware', path: project }, { projectRoot: project, store });
assert.equal(docs.version, '1.2.3');
assert.equal(docs.provider, 'installed_source');
assert.match(docs.items[0].excerpt, /UNTRUSTED EVIDENCE/);
assert.equal(store.readObject(store.list('evidence')[0].payload_hash).length > 0, true);
// A locator the core cannot read is an assertion, not evidence: it must be downgraded to
// model_claim and must not satisfy the repo minimum, or a model could invent its way past the gate.
const fabricated = core.checkpoint({
  run_id: assessed.run_id,
  evidence: [{ kind: 'repo', trust_class: 'tool', locator: 'src/does-not-exist.ts:42', excerpt: 'the function validates input' }],
});
const forged = store.list('evidence').find((row) => row.locator === 'src/does-not-exist.ts:42');
assert.equal(forged.attested, false);
assert.equal(forged.trust_class, 'model_claim');
assert.equal(forged.attestation_reason, 'missing_locator');
assert.equal(fabricated.decision, 'proceed_with_change');
// An excerpt that does not appear in the real file is rejected the same way.
const mismatched = core.checkpoint({
  run_id: assessed.run_id,
  evidence: [{ kind: 'repo', trust_class: 'tool', locator: 'package.json', excerpt: 'this text is not in the manifest' }],
});
assert.equal(store.list('evidence').find((row) => row.excerpt === 'this text is not in the manifest').attestation_reason, 'excerpt_not_in_source');
assert.equal(mismatched.decision, 'proceed_with_change');
// Unattested evidence alone must leave the signoff gate closed.
core.verify({ run_id: assessed.run_id, checks: [{ kind: 'test', specification: 'v2 smoke', executor: 'host', status: 'passed', output: 'ok' }] });
const blockedClose = core.close({ run_id: assessed.run_id });
assert.equal(blockedClose.decision, 'blocked');
assert.ok(blockedClose.gate.deficits.some((deficit) => deficit.code === 'insufficient_repo_evidence'));

// Real evidence: the locator resolves, the excerpt is present, so the core hashes the source itself.
core.checkpoint({ run_id: assessed.run_id, claim_updates: [{ id: claim.id, status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', excerpt: 'installed source supports configure' }, { kind: 'repo', trust_class: 'tool', locator: 'package.json', excerpt: 'demo-lib' }] });
const attested = store.list('evidence').find((row) => row.attested === true);
assert.equal(attested.attestation_reason, 'verified_against_source');
assert.match(attested.content_hash, /^sha256:[0-9a-f]{64}$/);
// The source hash doubles as the invalidation key, so editing the file stales the evidence.
assert.equal(attested.invalidation_key, attested.content_hash);
const closed = core.close({ run_id: assessed.run_id });
assert.equal(closed.decision, 'closed');
assert.equal(core.close({ run_id: assessed.run_id }).idempotent, true);
assert.ok(existsSync(join(project, '.tether', 'events.jsonl')));

const cli = spawnSync(process.execPath, ['cli.js', 'assess', '--operator', '--json', '--store', join(root, 'cli-store')], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify({ summary: 'CLI smoke' }), encoding: 'utf8',
});
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(cli.stdout).decision, 'skip');
assert.equal(JSON.parse(readFileSync(join(root, 'cli-store', 'events.jsonl'), 'utf8').split('\n')[0]).table, 'runs');

console.log('tether v2 tests passed');
