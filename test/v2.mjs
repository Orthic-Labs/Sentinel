import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReflectCore } from '../lib/core.js';
import { createStore } from '../lib/store.js';
import { resolveDocs } from '../lib/docs.js';

const root = mkdtempSync(join(tmpdir(), 'reflect-v2-'));
const project = join(root, 'project');
mkdirSync(join(project, 'node_modules', 'demo-lib'), { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { 'demo-lib': '1.2.3' }}));
writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/demo-lib': { version: '1.2.3' } }}));
writeFileSync(join(project, 'node_modules', 'demo-lib', 'package.json'), JSON.stringify({ name: 'demo-lib', version: '1.2.3' }));
writeFileSync(join(project, 'node_modules', 'demo-lib', 'README.md'), '# Client\nUse configure client middleware.\n');

const store = createStore(join(project, '.reflect'));
const core = new ReflectCore({ projectRoot: project, store });
const assessed = core.assess({ summary: 'Fix client middleware', task_kind: 'feature', claims: [{ text: 'configure is the installed API', kind: 'versioned_api', materiality: 'critical' }] });
assert.equal(assessed.decision, 'proceed');
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
core.checkpoint({ run_id: assessed.run_id, claim_updates: [{ id: claim.id, status: 'supported' }], evidence: [{ kind: 'docs', trust_class: 'tool', excerpt: 'installed source supports configure' }, { kind: 'repo', trust_class: 'tool', excerpt: 'worktree contains the package fixture' }] });
core.verify({ run_id: assessed.run_id, checks: [{ kind: 'test', specification: 'v2 smoke', executor: 'host', status: 'passed', output: 'ok' }] });
const closed = core.close({ run_id: assessed.run_id });
assert.equal(closed.decision, 'closed');
assert.equal(core.close({ run_id: assessed.run_id }).idempotent, true);
assert.ok(existsSync(join(project, '.reflect', 'events.jsonl')));

const cli = spawnSync(process.execPath, ['cli.js', 'assess', '--operator', '--json', '--store', join(root, 'cli-store')], {
  cwd: new URL('..', import.meta.url).pathname, input: JSON.stringify({ summary: 'CLI smoke' }), encoding: 'utf8',
});
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(cli.stdout).decision, 'skip');
assert.equal(JSON.parse(readFileSync(join(root, 'cli-store', 'events.jsonl'), 'utf8').split('\n')[0]).table, 'runs');

console.log('reflect v2 tests passed');
