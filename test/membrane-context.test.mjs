import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import path from 'node:path';

const require = createRequire(import.meta.url);
const adapter = require('../hooks/membrane-context.js');
const fakeClient = fileURLToPath(new URL('./fixtures/membrane-client.mjs', import.meta.url));

test('host adapter emits bounded data-only delivery heartbeat for canonical request', { concurrency: false }, () => {
  const root = path.resolve('/tmp');
  const request = adapter.buildRequest({ event: 'UserPromptSubmit', prompt: 'inspect current graph', session_id: 'session-1', turn_id: 'turn-1' }, root);
  assert.equal(request.taskEnvelope.schema, 'orthic.task-envelope.v1');
  assert.equal(request.turnEnvelope.schema, 'orthic.turn-envelope.v1');
  const result = adapter.runClient(request, root, { client: fakeClient });
  assert.equal(result.state, 'context_enforced');
  const rendered = adapter.render(result);
  assert.match(rendered, /Membrane: context_enforced/);
  assert.match(rendered, /packet_delivered/);
  assert.match(rendered, /dataOnly/);
});

test('host adapter renders visible degraded state when client is unavailable', { concurrency: false }, () => {
  const prior = process.env.MEMBRANE_CONTEXT_CLIENT;
  process.env.MEMBRANE_CONTEXT_CLIENT = '/missing/membrane-client.mjs';
  try {
    const result = adapter.runClient(adapter.buildRequest({ task: 'x' }, '/tmp'), '/tmp');
    assert.equal(result.state, 'degraded');
    assert.match(adapter.render(result), /Membrane: degraded/);
  } finally {
    if (prior === undefined) delete process.env.MEMBRANE_CONTEXT_CLIENT;
    else process.env.MEMBRANE_CONTEXT_CLIENT = prior;
  }
});

test('ccx context stays bound to this installed workspace when profile cwd drifts', { concurrency: false }, () => {
  assert.equal(adapter.resolveWorkspaceRoot({ cwd: '/Users/adrdsouza/ClaudeProfiles/claudecodex-profile' }), '/Volumes/D/claude');
});
