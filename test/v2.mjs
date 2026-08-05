import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SentinelCore, parseLocator } from '../lib/core.js';
import { createStore } from '../lib/store.js';
import { resolveDocs } from '../lib/docs.js';
import { doctor, projectStoreKey } from '../lib/host.js';
import { checkMatchesSpec } from '../lib/verify.js';
import { buildRetryFingerprint } from '../lib/budget.js';

const hostDataDir = mkdtempSync(join(tmpdir(), 'sentinel-host-'));
function hookEnv(extra = {}) {
  return {
    ...process.env,
    SENTINEL_HOST_DATA: hostDataDir,
    ...extra,
  };
}

const root = mkdtempSync(join(tmpdir(), 'sentinel-v2-'));
const project = join(root, 'project');
mkdirSync(join(project, 'node_modules', 'demo-lib'), { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { 'demo-lib': '1.2.3' }}));
writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/demo-lib': { version: '1.2.3' } }}));
writeFileSync(join(project, 'node_modules', 'demo-lib', 'package.json'), JSON.stringify({ name: 'demo-lib', version: '1.2.3' }));
writeFileSync(join(project, 'node_modules', 'demo-lib', 'README.md'), '# Client\nUse configure client middleware.\n');

const store = createStore(join(hostDataDir, 'stores', projectStoreKey(project)));
const core = new SentinelCore({ projectRoot: project, store });
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
const sentinelSchema = mcpResponses.find((response) => response.id === 2).result.tools.find((tool) => tool.name === 'sentinel').inputSchema;
assert.equal(sentinelSchema.properties.claims.items.type, 'object');
assert.equal(sentinelSchema.properties.evidence.items.type, 'object');
assert.equal(sentinelSchema.properties.checks.items.type, 'object');
assert.equal(sentinelSchema.properties.evidence.items.properties.trust_class, undefined);
assert.equal(sentinelSchema.properties.checks.items.properties.executor, undefined);
assert.equal(sentinelSchema.properties.checks.items.properties.status, undefined);
assert.deepEqual(sentinelSchema.allOf[0].then.required, ['summary']);
assert.deepEqual(sentinelSchema.allOf[0].else.required, ['run_id']);

const unassessedRiskHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'unassessed-session', tool_input: { command: 'git push --force origin main' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(unassessedRiskHook.status, 1, unassessedRiskHook.stderr);
assert.deepEqual(JSON.parse(unassessedRiskHook.stdout), {
  action: 'block',
  reason: 'high-risk command requires Sentinel assess before execution',
});
const unassessedSuccessHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: 'node --version' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(unassessedSuccessHook.status, 0, unassessedSuccessHook.stderr);
assert.deepEqual(JSON.parse(unassessedSuccessHook.stdout), {
  action: 'enforcement_degraded',
  reason: 'no active sentinel run',
});

const recursiveAmbiguousStop = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
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
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'idle-session' }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(idleAmbiguousStop.status, 0, idleAmbiguousStop.stderr);
assert.deepEqual(JSON.parse(idleAmbiguousStop.stdout), {
  action: 'enforcement_degraded',
  reason: 'no active sentinel run',
});
const riskyAmbiguousUse = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'risky-session', tool_input: { command: 'git push --force origin main' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(riskyAmbiguousUse.status, 1, riskyAmbiguousUse.stderr);
assert.equal(JSON.parse(riskyAmbiguousUse.stdout).action, 'block');

const assessed = core.assess({ summary: 'Fix client middleware', task_kind: 'feature', claims: [{ text: 'configure is the installed API', kind: 'versioned_api', materiality: 'critical' }] });
assert.equal(assessed.decision, 'proceed');
assert.deepEqual(core.resolveSession({ session_id: 'claude-session-1' }), { run_id: null, status: 'unbound', reason: 'explicit_run_id_required' });
const sessionBinding = core.resolveSession({ session_id: 'claude-session-1', run_id: assessed.run_id });
assert.deepEqual(sessionBinding, { run_id: assessed.run_id, status: 'bound' });
assert.equal(store.get('session_bindings', 'claude-session-1').run_id, assessed.run_id);
const enforcedHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'claude-session-1', tool_input: { command: 'rm -rf build-output' } }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(enforcedHook.status, 1, enforcedHook.stderr);
const enforcedHookResult = JSON.parse(enforcedHook.stdout);
assert.equal(enforcedHookResult.action, 'block');
assert.equal(enforcedHookResult.reason, 'high-risk gate unmet');
const inProcessGenericHook = spawnSync(process.execPath, ['-e', `const { evaluate } = require(${JSON.stringify(join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js'))}); process.stdout.write(JSON.stringify(evaluate(${JSON.stringify({ hook_event_name: 'PreToolUse', run_id: assessed.run_id, tool_input: { command: 'rm -rf build-output' } })})));`], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
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
    gate_ok: inProcessGenericHookResult.result.gate?.ok,
    deficits: inProcessGenericHookResult.result.gate?.deficits,
  },
  {
    action: enforcedHookResult.action,
    reason: enforcedHookResult.reason,
    decision: enforcedHookResult.result.decision,
    gate_ok: enforcedHookResult.result.gate?.ok,
    deficits: enforcedHookResult.result.gate?.deficits,
  },
);
const failureHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'PostToolUse', run_id: assessed.run_id, tool_name: 'shell', error: 'command failed' }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(failureHook.status, 0, failureHook.stderr);
assert.equal(JSON.parse(failureHook.stdout).action, 'continue');
const successfulHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
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
assert.deepEqual(JSON.parse(successfulHook.stdout), {
  action: 'continue',
  reason: 'tool success is not auto-recorded as a passing check',
});
assert.equal(store.list('checks').some((row) => row.command === 'node --version'), false);
const spoofedHookCli = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'cli.js'), 'verify', '--hook', '--json'], {
  cwd: project,
  input: JSON.stringify({ run_id: assessed.run_id, checks: [{ kind: 'test', status: 'passed' }] }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.notEqual(spoofedHookCli.status, 0);
assert.match(spoofedHookCli.stderr, /cannot mint trusted authority/);
core.resolveSession({ session_id: 'codex-session-1', run_id: assessed.run_id });
core.resolveSession({ session_id: 'claude-session-4', run_id: assessed.run_id });
const codexHook = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'codex', 'hook.js')], {
  cwd: project,
  env: hookEnv({ CODEX_SESSION_ID: 'codex-session-1' }),
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
  env: hookEnv({ CLAUDE_SESSION_ID: 'claude-session-4' }),
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
core.verify({
  run_id: assessed.run_id,
  rubric: { criteria: [{ id: 'v2-smoke', criterion: 'v2 smoke passes', verification: ['v2 smoke'], required_evidence_kinds: ['repo'] }] },
  checks: [{ kind: 'test', specification: 'v2 smoke', criterion_id: 'v2-smoke', executor: 'host', status: 'passed', output: 'ok' }],
}, 'operator');
const blockedClose = await core.close({ run_id: assessed.run_id });
assert.equal(blockedClose.decision, 'blocked');
assert.ok(blockedClose.gate.deficits.some((deficit) => deficit.code === 'insufficient_repo_evidence'));

// Real evidence: the locator resolves, the excerpt is present, so the core hashes the source itself.
core.checkpoint({ run_id: assessed.run_id, claim_updates: [{ id: claim.id, status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', claim_ids: [claim.id], excerpt: 'installed source supports configure' }, { kind: 'repo', trust_class: 'tool', claim_ids: [claim.id], criterion_id: 'v2-smoke', locator: 'package.json', excerpt: 'demo-lib' }] }, 'operator');
const attested = store.list('evidence').find((row) => row.attested === true);
assert.equal(attested.attestation_reason, 'verified_against_source');
assert.match(attested.content_hash, /^sha256:[0-9a-f]{64}$/);
// The source hash doubles as the invalidation key, so editing the file stales the evidence.
assert.equal(attested.invalidation_key, attested.content_hash);
const closed = await core.close({ run_id: assessed.run_id });
assert.equal(closed.decision, 'closed');
assert.equal((await core.close({ run_id: assessed.run_id })).idempotent, true);
assert.ok(existsSync(join(store.root, 'events.jsonl')));
assert.throws(() => core.checkpoint({ run_id: assessed.run_id, evidence: [{ kind: 'docs', trust_class: 'tool', excerpt: 'late mutation' }] }), /closed run/);

const spoofed = core.assess({ summary: 'Reject spoofed check', task_kind: 'feature', claims: [{ id: 'spoofed-claim', text: 'package is present', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({ run_id: spoofed.run_id, claim_updates: [{ id: 'spoofed-claim', status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', claim_ids: ['spoofed-claim'], excerpt: 'package docs exist' }, { kind: 'repo', trust_class: 'tool', claim_ids: ['spoofed-claim'], locator: 'package.json', excerpt: 'demo-lib' }] }, 'operator');
core.verify({ run_id: spoofed.run_id, checks: [{ kind: 'test', specification: 'spoofed', executor: 'host', status: 'passed', output: 'model said ok' }] }, 'model');
const spoofedClose = await core.close({ run_id: spoofed.run_id });
assert.equal(spoofedClose.decision, 'blocked');
assert.ok(spoofedClose.gate.deficits.some((deficit) => deficit.code === 'insufficient_passing_checks'));

const unlinked = core.assess({ summary: 'Reject unlinked evidence', task_kind: 'feature', claims: [{ id: 'unlinked-claim', text: 'claim needs its own proof', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({ run_id: unlinked.run_id, claim_updates: [{ id: 'unlinked-claim', status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', excerpt: 'generic docs exist' }, { kind: 'repo', trust_class: 'tool', locator: 'package.json', excerpt: 'demo-lib' }] }, 'operator');
core.verify({ run_id: unlinked.run_id, checks: [{ kind: 'test', specification: 'real', executor: 'host', status: 'passed', output: 'ok' }] }, 'operator');
const unlinkedClose = await core.close({ run_id: unlinked.run_id });
assert.equal(unlinkedClose.decision, 'blocked');
assert.ok(unlinkedClose.gate.deficits.some((deficit) => deficit.code === 'supported_claim_without_matching_evidence'));

const liveFile = join(project, 'live.js');
writeFileSync(liveFile, 'export const value = "before";\n');
const stale = core.assess({ summary: 'Reject stale source evidence', task_kind: 'feature', claims: [{ id: 'stale-claim', text: 'live value is before', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({ run_id: stale.run_id, claim_updates: [{ id: 'stale-claim', status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', claim_ids: ['stale-claim'], excerpt: 'runtime docs exist' }, { kind: 'repo', trust_class: 'tool', claim_ids: ['stale-claim'], locator: 'live.js', excerpt: 'before' }] }, 'operator');
core.verify({ run_id: stale.run_id, checks: [{ kind: 'test', specification: 'real', executor: 'host', status: 'passed', output: 'ok' }] }, 'operator');
writeFileSync(liveFile, 'export const value = "after";\n');
const staleClose = await core.close({ run_id: stale.run_id });
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
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
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
assert.match(rejectedOperator.stderr, /cannot mint trusted authority/);
const cli = spawnSync(process.execPath, ['cli.js', 'assess', '--json', '--store', join(root, 'cli-store')], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), env: hookEnv(), input: JSON.stringify({ summary: 'CLI smoke' }), encoding: 'utf8',
});
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(cli.stdout).decision, 'skip');
assert.equal(JSON.parse(readFileSync(join(root, 'cli-store', 'events.jsonl'), 'utf8').split('\n')[0]).table, 'runs');

// A criterion given as a bare string or with "text" must canonicalize at intake,
// not survive assess and then fail the rubric at signoff.
for (const [label, entry] of [['string', 'tests pass'], ['text alias', { id: 'aliased', text: 'tests pass' }]]) {
  const aliasRun = core.assess({ summary: `Criterion shape: ${label}`, task_kind: 'feature', acceptance_criteria: [entry] });
  const stored = core.store.get('runs', aliasRun.run_id).acceptance_criteria[0];
  assert.equal(stored.criterion, 'tests pass', `${label} criterion text`);
  assert.ok(stored.id, `${label} criterion id`);
  assert.doesNotThrow(() => core.verify({ run_id: aliasRun.run_id }), `${label} rubric builds`);
}
assert.throws(
  () => core.assess({ summary: 'Malformed criterion', task_kind: 'feature', acceptance_criteria: [{ id: 'nope' }] }),
  /acceptance criterion 0 requires criterion text/,
);

const criterionRun = core.assess({
  summary: 'Criterion-gated feature',
  task_kind: 'feature',
  acceptance_criteria: [{ criterion: 'tests pass', verification: ['npm test'], required_evidence_kinds: ['repo'] }],
  claims: [{ id: 'criterion-claim', text: 'tests are green', kind: 'behavioral_fact', materiality: 'critical' }],
});
core.checkpoint({
  run_id: criterionRun.run_id,
  claim_updates: [{ id: 'criterion-claim', status: 'supported' }],
  evidence: [{ kind: 'repo', trust_class: 'tool', claim_ids: ['criterion-claim'], criterion_id: 'criterion-0', locator: 'package.json', excerpt: 'demo-lib' }],
}, 'operator');
core.verify({ run_id: criterionRun.run_id, checks: [{ kind: 'test', specification: 'npm test', criterion_id: 'criterion-0', executor: 'host', status: 'passed', output: 'ok' }] }, 'operator');
const criterionBlocked = await core.close({ run_id: criterionRun.run_id });
assert.equal(criterionBlocked.decision, 'blocked');
assert.ok(criterionBlocked.gate.deficits.some((deficit) => deficit.code === 'supported_claim_without_matching_evidence'));
core.checkpoint({
  run_id: criterionRun.run_id,
  evidence: [{ kind: 'test', trust_class: 'tool', claim_ids: ['criterion-claim'], excerpt: 'all tests passed' }],
}, 'operator');
const criterionClosed = await core.close({ run_id: criterionRun.run_id });
assert.equal(criterionClosed.decision, 'closed');

const wrongClassRun = core.assess({
  summary: 'Reject wrong evidence class',
  claims: [{ id: 'wrong-class-claim', text: 'file contains marker', kind: 'local_fact', materiality: 'critical' }],
});
core.checkpoint({
  run_id: wrongClassRun.run_id,
  claim_updates: [{ id: 'wrong-class-claim', status: 'supported' }],
  evidence: [{ kind: 'docs', trust_class: 'tool', claim_ids: ['wrong-class-claim'], excerpt: 'only docs, no repo proof' }],
}, 'operator');
core.verify({ run_id: wrongClassRun.run_id, checks: [{ kind: 'test', specification: 'smoke', executor: 'host', status: 'passed', output: 'ok' }] }, 'operator');
const wrongClassClose = await core.close({ run_id: wrongClassRun.run_id });
assert.equal(wrongClassClose.decision, 'blocked');
assert.ok(wrongClassClose.gate.deficits.some((deficit) => deficit.code === 'supported_claim_without_matching_evidence'));

// --- P1/P2 additions ---

// Region hash + Windows-safe locator parser
writeFileSync(join(project, 'region.js'), 'line1\nTARGET_REGION\nline3\n');
const winLocator = parseLocator(null, 'C:\\Users\\demo\\project\\region.js:2-2');
assert.equal(winLocator.file, 'C:\\Users\\demo\\project\\region.js');
assert.equal(winLocator.startLine, 2);
assert.equal(winLocator.endLine, 2);
const ranged = core.assess({ summary: 'Region hash', claims: [{ id: 'region-claim', text: 'region marker', kind: 'local_fact', materiality: 'critical' }] });
core.checkpoint({
  run_id: ranged.run_id,
  evidence: [{ kind: 'repo', locator: 'region.js:2-2', excerpt: 'TARGET_REGION' }],
});
const rangedEv = store.list('evidence').find((row) => row.locator === 'region.js:2-2');
assert.equal(rangedEv.attested, true);
assert.equal(rangedEv.attestation_reason, 'verified_region_against_source');
assert.match(rangedEv.content_hash, /^sha256:[0-9a-f]{64}$/);

// Improved retry fingerprint: same command with different error class ≠ same fingerprint
const fpA = buildRetryFingerprint({ command: 'npm test', observed_failure: 'AssertionError: expected true' });
const fpB = buildRetryFingerprint({ command: 'npm test', observed_failure: 'ENOENT: no such file' });
assert.notEqual(fpA, fpB);
assert.match(fpA, /^sha256:/);

// Conversational Stop ≠ completion
const convStop = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'claude-session-1' }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(convStop.status, 0, convStop.stderr);
assert.deepEqual(JSON.parse(convStop.stdout), { action: 'noop', reason: 'conversational_stop' });

// Execution contract CheckSpec matching
assert.equal(checkMatchesSpec(
  { specification: 'npm test -- contract --extra' },
  'npm test -- contract',
), false, 'a longer command must not satisfy an exact CheckSpec');
assert.equal(checkMatchesSpec(
  { kind: 'test', specification: 'npm test -- contract' },
  { kind: 'command', specification: 'npm test -- contract' },
), false, 'a check kind must exactly match typed CheckSpec kind');
assert.throws(
  () => checkMatchesSpec({ kind: 'test', specification: 'npm test' }, { kind: 'test' }),
  /exactly one/,
);

const contractRun = core.assess({
  summary: 'Contract-bound criterion',
  task_kind: 'feature',
  acceptance_criteria: [{
    criterion: 'contract tests',
    execution_contract: { check_specs: ['npm test -- contract'], preflight: true },
    required_evidence_kinds: ['repo'],
  }],
  claims: [{ id: 'contract-claim', text: 'contract holds', kind: 'behavioral_fact', materiality: 'critical' }],
});
core.checkpoint({
  run_id: contractRun.run_id,
  claim_updates: [{ id: 'contract-claim', status: 'supported' }],
  evidence: [
    { kind: 'repo', claim_ids: ['contract-claim'], criterion_id: 'criterion-0', locator: 'package.json', excerpt: 'demo-lib' },
    { kind: 'test', trust_class: 'tool', claim_ids: ['contract-claim'], excerpt: 'contract ok' },
  ],
}, 'operator');
const contractVerify = core.verify({
  run_id: contractRun.run_id,
  checks: [{ kind: 'test', specification: 'npm test -- contract', criterion_id: 'criterion-0', executor: 'host', status: 'passed', output: 'ok' }],
}, 'operator');
assert.equal(contractVerify.preflight.stub, true);
const contractClosed = await core.close({ run_id: contractRun.run_id });
assert.equal(contractClosed.decision, 'closed');

// Signoff must never qualify against an empty rubric.
const emptyRubricRun = core.assess({
  summary: 'Empty rubric cannot close',
  task_kind: 'feature',
  claims: [{ id: 'empty-rubric-claim', text: 'done', kind: 'local_fact', materiality: 'useful' }],
});
core.verify({
  run_id: emptyRubricRun.run_id,
  checks: [{ kind: 'test', specification: 'anything', executor: 'host', status: 'passed', output: 'ok' }],
}, 'operator');
const emptyRubricClose = await core.close({ run_id: emptyRubricRun.run_id }, 'operator');
assert.equal(emptyRubricClose.decision, 'blocked');
assert.ok(emptyRubricClose.gate.deficits.some((row) => row.code === 'empty_signoff_rubric'));

// One failed close batch leaves every close row unapplied.
const atomicStore = createStore(join(root, 'atomic-close-store'));
const atomicCore = new SentinelCore({ projectRoot: project, store: atomicStore });
const atomicRun = atomicCore.assess({
  summary: 'Atomic close',
  task_kind: 'feature',
  acceptance_criteria: [{
    criterion: 'atomic close passes',
    verification: ['atomic-check'],
    required_evidence_kinds: ['repo'],
  }],
  claims: [{ id: 'atomic-claim', text: 'atomic', kind: 'local_fact', materiality: 'critical' }],
});
atomicCore.checkpoint({
  run_id: atomicRun.run_id,
  claim_updates: [{ id: 'atomic-claim', status: 'supported' }],
  evidence: [
    { kind: 'repo', claim_ids: ['atomic-claim'], criterion_id: 'criterion-0', locator: 'package.json', excerpt: 'demo-lib' },
    { kind: 'test', trust_class: 'tool', claim_ids: ['atomic-claim'], excerpt: 'ok' },
  ],
}, 'operator');
atomicCore.verify({
  run_id: atomicRun.run_id,
  checks: [{ kind: 'test', specification: 'atomic-check', criterion_id: 'criterion-0', executor: 'host', status: 'passed', output: 'ok' }],
}, 'operator');
atomicStore.failNextBatchForTest?.();
await assert.rejects(() => atomicCore.close({ run_id: atomicRun.run_id }, 'operator'), /injected batch failure/);
assert.notEqual(atomicStore.get('runs', atomicRun.run_id).status, 'closed');
assert.equal(atomicStore.list('decisions').filter((row) => row.run_id === atomicRun.run_id && row.decision === 'closed').length, 0);

// Cortex orientation hook point
const bpRun = core.assess({ summary: 'Cortex orientation', claims: [{ id: 'bp-claim', text: 'oriented', kind: 'local_fact', materiality: 'useful' }] });
core.checkpoint({
  run_id: bpRun.run_id,
  evidence: [{ kind: 'cortex_orientation', cortex_receipt: 'orient-1', excerpt: 'flows mapped' }],
}, 'hook');
assert.equal(store.list('evidence').find((row) => row.kind === 'cortex_orientation').cortex_orientation, true);

// Incremental store projection still reads appended events
const incrRoot = join(root, 'incr-store');
const incrStore = createStore(incrRoot);
incrStore.append('runs', { id: 'incr-1', summary: 'a', status: 'open' });
incrStore.append('retry_budget', { id: 'rb-1', run_id: 'incr-1', fingerprint: 'x', count: 1 });
assert.equal(incrStore.get('runs', 'incr-1').summary, 'a');
assert.equal(incrStore.list('retry_budget').length, 1);

// doctor does not initialize a host token.
const doctorResult = doctor(project);
assert.equal(doctorResult.product, 'sentinel');
assert.equal(doctorResult.ok, true);

// E2E lifecycle: assess → evidence → verify → completion-intent Stop closes
const e2eStore = store;
const e2eCore = new SentinelCore({ projectRoot: project, store: e2eStore });
const e2e = e2eCore.assess({
  summary: 'E2E lifecycle',
  task_kind: 'feature',
  session_id: 'e2e-session',
  task_id: 'e2e-task',
  acceptance_criteria: [{ id: 'e2e-check', criterion: 'e2e lifecycle passes', verification: ['e2e'], required_evidence_kinds: ['repo'] }],
  claims: [{ id: 'e2e-claim', text: 'package present', kind: 'local_fact', materiality: 'critical' }],
});
e2eCore.checkpoint({
  run_id: e2e.run_id,
  claim_updates: [{ id: 'e2e-claim', status: 'supported' }],
  evidence: [
    { kind: 'docs', claim_ids: ['e2e-claim'], locator: 'package.json', excerpt: 'demo-lib' },
    { kind: 'repo', claim_ids: ['e2e-claim'], criterion_id: 'e2e-check', locator: 'package.json', excerpt: 'demo-lib' },
  ],
}, 'operator');
e2eCore.verify({
  run_id: e2e.run_id,
  checks: [{ kind: 'test', specification: 'e2e', criterion_id: 'e2e-check', executor: 'host', status: 'passed', output: 'ok' }],
}, 'operator');
const e2eStop = spawnSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'generic', 'hook.js')], {
  cwd: project,
  env: hookEnv({ SENTINEL_ROOT: fileURLToPath(new URL('..', import.meta.url)) }),
  input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e-session', completion_intent: true }),
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(e2eStop.status, 0, e2eStop.stderr);
const e2eStopResult = JSON.parse(e2eStop.stdout);
assert.equal(e2eStopResult.action, 'allow');
assert.equal(e2eStopResult.closed, true);
assert.equal(e2eStore.get('runs', e2e.run_id).status, 'closed');

console.log('sentinel v2 tests passed');
