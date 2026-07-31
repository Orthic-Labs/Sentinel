import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
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
assert.throws(
  () => core.assess({ run_id: 'invalid-claim-run', summary: 'Reject malformed claim', claims: ['not-an-object'] }),
  /claim must be an object/,
);
assert.equal(store.get('runs', 'invalid-claim-run'), null);

const mcpPayload = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'schema-test', version: '1' } } }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
].join('\n') + '\n';
const mcpSchema = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'server.js')], {
  cwd: project, input: mcpPayload, encoding: 'utf8', windowsHide: true,
});
assert.equal(mcpSchema.status, 0, mcpSchema.stderr);
const mcpResponses = mcpSchema.stdout.trim().split('\n').map((line) => JSON.parse(line));
const tetherSchema = mcpResponses.find((response) => response.id === 2).result.tools.find((tool) => tool.name === 'tether').inputSchema;
assert.equal(tetherSchema.properties.claims.items.type, 'object');
assert.equal(tetherSchema.properties.evidence.items.type, 'object');
assert.equal(tetherSchema.properties.checks.items.type, 'object');
assert.deepEqual(tetherSchema.allOf[0].then.required, ['summary']);
assert.deepEqual(tetherSchema.allOf[0].else.required, ['run_id']);

const unassessedRiskStore = join(root, 'unassessed-risk-store');
const unassessedRiskHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: unassessedRiskStore },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'unassessed-session', tool_input: { command: 'git push --force origin main' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(unassessedRiskHook.status, 1, unassessedRiskHook.stderr);
assert.deepEqual(JSON.parse(unassessedRiskHook.stdout), {
  action: 'block',
  reason: 'high-risk command requires Tether assess before execution',
});
const unassessedSuccessHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: unassessedRiskStore },
  input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: 'node --version' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(unassessedSuccessHook.status, 0, unassessedSuccessHook.stderr);
assert.deepEqual(JSON.parse(unassessedSuccessHook.stdout), {
  action: 'noop',
  reason: 'no active tether run',
});

const ambiguousStoreRoot = join(root, 'ambiguous-store');
const ambiguousStore = createStore(ambiguousStoreRoot);
const ambiguousCore = new ReflectCore({ projectRoot: project, store: ambiguousStore });
ambiguousCore.assess({ summary: 'First unrelated task' });
ambiguousCore.assess({ summary: 'Second unrelated task' });
const recursiveAmbiguousStop = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: ambiguousStoreRoot },
  input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'recursive-session', stop_hook_active: true }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(recursiveAmbiguousStop.status, 0, recursiveAmbiguousStop.stderr);
assert.deepEqual(JSON.parse(recursiveAmbiguousStop.stdout), {
  action: 'noop',
  reason: 'stop_hook_active',
});
const idleAmbiguousStop = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: ambiguousStoreRoot },
  input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'idle-session' }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(idleAmbiguousStop.status, 0, idleAmbiguousStop.stderr);
assert.deepEqual(JSON.parse(idleAmbiguousStop.stdout), {
  action: 'noop',
  reason: 'no active tether run',
});
const riskyAmbiguousUse = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: ambiguousStoreRoot },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'risky-session', tool_input: { command: 'git push --force origin main' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(riskyAmbiguousUse.status, 1, riskyAmbiguousUse.stderr);
assert.equal(JSON.parse(riskyAmbiguousUse.stdout).action, 'block');

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
const enforcedHookResult = JSON.parse(enforcedHook.stdout);
assert.equal(enforcedHookResult.action, 'block');
const inProcessGenericHook = spawnSync(process.execPath, ['-e', `const { evaluate } = require(${JSON.stringify(join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js'))}); process.stdout.write(JSON.stringify(evaluate(${JSON.stringify({ hook_event_name: 'PreToolUse', run_id: assessed.run_id, tool_input: { command: 'rm -rf build-output' } })})));`], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: join(project, '.tether') },
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(inProcessGenericHook.status, 0, inProcessGenericHook.stderr);
const inProcessGenericHookResult = JSON.parse(inProcessGenericHook.stdout);
assert.deepEqual(
  {
    action: inProcessGenericHookResult.action,
    reason: inProcessGenericHookResult.reason,
    decision: inProcessGenericHookResult.result.decision,
    gate: inProcessGenericHookResult.result.gate,
  },
  {
    action: enforcedHookResult.action,
    reason: enforcedHookResult.reason,
    decision: enforcedHookResult.result.decision,
    gate: enforcedHookResult.result.gate,
  },
);
const failureHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'claude-session-3', tool_name: 'shell', error: 'command failed' }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(failureHook.status, 0, failureHook.stderr);
assert.equal(JSON.parse(failureHook.stdout).action, 'continue');
const successfulHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({
    hook_event_name: 'PostToolUse',
    run_id: assessed.run_id,
    tool_name: 'shell',
    tool_input: { command: 'node --version' },
    tool_response: { exit_code: 0, stdout: 'v24.0.0' },
  }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(successfulHook.status, 0, successfulHook.stderr);
assert.equal(JSON.parse(successfulHook.stdout).action, 'continue');
const trustedHookCheck = store.list('checks').find((row) => row.command === 'node --version');
assert.equal(trustedHookCheck.authority, 'hook');
assert.equal(trustedHookCheck.executor, 'hook');
assert.equal(trustedHookCheck.status, 'passed');
const spoofedHookCli = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'cli.js'), 'verify', '--hook', '--json'], {
  cwd: project,
  input: JSON.stringify({ run_id: assessed.run_id, checks: [{ kind: 'test', status: 'passed' }] }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.notEqual(spoofedHookCli.status, 0);
assert.match(spoofedHookCli.stderr, /trusted host caller/);
const codexHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'codex', 'hook.js')], {
  cwd: project,
  env: { ...process.env, CODEX_SESSION_ID: 'codex-session-1', TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'rm -rf build-output' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(codexHook.status, 0, codexHook.stderr);
assert.deepEqual(JSON.parse(codexHook.stdout), {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'high-risk gate unmet',
  },
});
const claudeHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'claude-code', 'hook.js')], {
  cwd: project,
  env: { ...process.env, CLAUDE_SESSION_ID: 'claude-session-4', TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'rm -rf build-output' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(claudeHook.status, 0, claudeHook.stderr);
assert.deepEqual(JSON.parse(claudeHook.stdout), {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'high-risk gate unmet',
  },
});
assert.doesNotMatch(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'adapter.js'), 'utf8'), /(?:child_process|spawnSync)/);
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
core.verify({ run_id: assessed.run_id, checks: [{ kind: 'test', specification: 'v2 smoke', executor: 'host', status: 'passed', output: 'ok' }] }, 'operator');
const blockedClose = core.close({ run_id: assessed.run_id });
assert.equal(blockedClose.decision, 'blocked');
assert.ok(blockedClose.gate.deficits.some((deficit) => deficit.code === 'insufficient_repo_evidence'));

// Real evidence: the locator resolves, the excerpt is present, so the core hashes the source itself.
core.checkpoint({ run_id: assessed.run_id, claim_updates: [{ id: claim.id, status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', claim_ids: [claim.id], excerpt: 'installed source supports configure' }, { kind: 'repo', trust_class: 'tool', claim_ids: [claim.id], locator: 'package.json', excerpt: 'demo-lib' }] });
const attested = store.list('evidence').find((row) => row.attested === true);
assert.equal(attested.attestation_reason, 'verified_against_source');
assert.match(attested.content_hash, /^sha256:[0-9a-f]{64}$/);
// The source hash doubles as the invalidation key, so editing the file stales the evidence.
assert.equal(attested.invalidation_key, attested.content_hash);
const closed = core.close({ run_id: assessed.run_id });
assert.equal(closed.decision, 'closed');
assert.equal(core.close({ run_id: assessed.run_id }).idempotent, true);
assert.ok(existsSync(join(project, '.tether', 'events.jsonl')));
assert.throws(() => core.checkpoint({ run_id: assessed.run_id, evidence: [{ kind: 'docs', trust_class: 'tool', excerpt: 'late mutation' }] }), /closed run/);

const spoofed = core.assess({ summary: 'Reject spoofed check', task_kind: 'feature', claims: [{ id: 'spoofed-claim', text: 'package is present', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({ run_id: spoofed.run_id, claim_updates: [{ id: 'spoofed-claim', status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', claim_ids: ['spoofed-claim'], excerpt: 'package docs exist' }, { kind: 'repo', trust_class: 'tool', claim_ids: ['spoofed-claim'], locator: 'package.json', excerpt: 'demo-lib' }] });
core.verify({ run_id: spoofed.run_id, checks: [{ kind: 'test', specification: 'spoofed', executor: 'host', status: 'passed', output: 'model said ok' }] }, 'model');
const spoofedClose = core.close({ run_id: spoofed.run_id });
assert.equal(spoofedClose.decision, 'blocked');
assert.ok(spoofedClose.gate.deficits.some((deficit) => deficit.code === 'insufficient_passing_checks'));

const unlinked = core.assess({ summary: 'Reject unlinked evidence', task_kind: 'feature', claims: [{ id: 'unlinked-claim', text: 'claim needs its own proof', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({ run_id: unlinked.run_id, claim_updates: [{ id: 'unlinked-claim', status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', excerpt: 'generic docs exist' }, { kind: 'repo', trust_class: 'tool', locator: 'package.json', excerpt: 'demo-lib' }] });
core.verify({ run_id: unlinked.run_id, checks: [{ kind: 'test', specification: 'real', executor: 'host', status: 'passed', output: 'ok' }] }, 'operator');
const unlinkedClose = core.close({ run_id: unlinked.run_id });
assert.equal(unlinkedClose.decision, 'blocked');
assert.ok(unlinkedClose.gate.deficits.some((deficit) => deficit.code === 'supported_claim_without_evidence'));

const liveFile = join(project, 'live.js');
writeFileSync(liveFile, 'export const value = "before";\n');
const stale = core.assess({ summary: 'Reject stale source evidence', task_kind: 'feature', claims: [{ id: 'stale-claim', text: 'live value is before', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({ run_id: stale.run_id, claim_updates: [{ id: 'stale-claim', status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', claim_ids: ['stale-claim'], excerpt: 'runtime docs exist' }, { kind: 'repo', trust_class: 'tool', claim_ids: ['stale-claim'], locator: 'live.js', excerpt: 'before' }] });
core.verify({ run_id: stale.run_id, checks: [{ kind: 'test', specification: 'real', executor: 'host', status: 'passed', output: 'ok' }] }, 'operator');
writeFileSync(liveFile, 'export const value = "after";\n');
const staleClose = core.close({ run_id: stale.run_id });
assert.equal(staleClose.decision, 'blocked');
assert.ok(staleClose.gate.deficits.some((deficit) => deficit.code === 'stale_evidence'));

const waiverRun = core.assess({ summary: 'Reject model waiver', claims: [{ id: 'waiver-claim', text: 'cannot self waive', kind: 'hypothesis', materiality: 'critical' }] });
assert.throws(() => core.checkpoint({ run_id: waiverRun.run_id, claim_updates: [{ id: 'waiver-claim', status: 'waived', waiver: { reason: 'model says so' } }] }), /model authority cannot waive/);
assert.throws(() => core.checkpoint({ run_id: waiverRun.run_id, claim_updates: [{ id: 'waiver-claim', materiality: 'trivial' }] }), /cannot change claim materiality/);

const outside = join(root, 'outside.txt');
writeFileSync(outside, 'outside secret\n');
symlinkSync(outside, join(project, 'outside-link.txt'));
const linkRun = core.assess({ summary: 'Reject symlink escape', claims: [{ id: 'link-claim', text: 'link is local', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({ run_id: linkRun.run_id, evidence: [{ kind: 'repo', trust_class: 'tool', claim_ids: ['link-claim'], locator: 'outside-link.txt', excerpt: 'outside secret' }] });
const linkedEvidence = store.list('evidence').find((row) => row.locator === 'outside-link.txt');
assert.equal(linkedEvidence.attested, false);
assert.equal(linkedEvidence.attestation_reason, 'outside_workspace');

assert.throws(() => core.assess({ run_id: assessed.run_id, summary: 'replay old proof' }), /run_id already exists/);
const purgeA = core.assess({ run_id: 'purge-a', summary: 'purge a' });
const purgeB = core.assess({ run_id: 'purge-b', summary: 'purge b' });
core.purge(purgeA.run_id);
assert.equal(store.get('runs', purgeA.run_id), null);
assert.equal(store.get('runs', purgeB.run_id).summary, 'purge b');

writeFileSync(join(project, 'node_modules', 'demo-lib', 'MORE.md'), 'configure alpha\nconfigure beta\nconfigure gamma\n');
const firstDocsPage = resolveDocs({ library: 'demo-lib', query: 'configure', path: project, limit: 1 }, { projectRoot: project, store });
const secondDocsPage = resolveDocs({ continuationToken: firstDocsPage.continuationToken, path: project, limit: 1 }, { projectRoot: project, store });
assert.notEqual(secondDocsPage.items[0].locator, firstDocsPage.items[0].locator);

const riskyHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: { ...process.env, TETHER_ROOT: fileURLToPath(new URL('..', import.meta.url)), TETHER_STORE_ROOT: join(project, '.tether') },
  input: JSON.stringify({ hook_event_name: 'PreToolUse', run_id: waiverRun.run_id, tool_input: { command: 'git push -f origin main' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(riskyHook.status, 1, riskyHook.stderr);
assert.equal(JSON.parse(riskyHook.stdout).action, 'block');

const rejectedOperator = spawnSync(process.execPath, ['cli.js', 'assess', '--operator', '--json', '--store', join(root, 'cli-store-rejected')], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify({ summary: 'CLI operator spoof' }), encoding: 'utf8',
});
assert.equal(rejectedOperator.status, 1);
assert.match(rejectedOperator.stderr, /trusted host caller/);
const cli = spawnSync(process.execPath, ['cli.js', 'assess', '--operator', '--json', '--store', join(root, 'cli-store')], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TETHER_TRUSTED_CALLER: 'hook' }, input: JSON.stringify({ summary: 'CLI smoke' }), encoding: 'utf8',
});
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(cli.stdout).decision, 'skip');
assert.equal(JSON.parse(readFileSync(join(root, 'cli-store', 'events.jsonl'), 'utf8').split('\n')[0]).table, 'runs');

console.log('tether v2 tests passed');
