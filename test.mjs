import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const directory = dirname(fileURLToPath(import.meta.url));
const requests = [];
const api = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requests.push(url);
  if (url.pathname === '/api/v2/libs/search') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      results: [{
        id: '/test/library',
        title: 'Test Library',
        description: 'Fixture documentation',
        versions: ['v1'],
        totalSnippets: 12,
        trustScore: 10,
        benchmarkScore: 99,
      }],
    }));
    return;
  }
  if (url.pathname === '/api/v2/context') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Current fixture documentation');
    return;
  }
  response.writeHead(404);
  response.end();
});

api.listen(0, '127.0.0.1');
await once(api, 'listening');
const address = api.address();
const child = spawn(process.execPath, [join(directory, 'server.js')], {
  env: {
    ...process.env,
    CONTEXT7_API_BASE_URL: `http://127.0.0.1:${address.port}/api/v2`,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

const pending = new Map();
let requestId = 0;
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  }
});

function request(method, params = {}) {
  requestId += 1;
  const id = requestId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. ${stderr}`));
    }, 5_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'reflect-test', version: '1.0.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'reflect');

  const listed = await request('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['sequentialthinking', 'resolve-library-id', 'query-docs'],
  );

  const thought = await request('tools/call', {
    name: 'sequentialthinking',
    arguments: {
      thought: 'Test thought',
      nextThoughtNeeded: false,
      thoughtNumber: 1,
      totalThoughts: 1,
    },
  });
  assert.equal(JSON.parse(thought.result.content[0].text).thoughtsStored, 1);

  // Relational fields are validated server-side; the host does not enforce inputSchema for us.
  const branchTracked = await request('tools/call', {
    name: 'sequentialthinking',
    arguments: {
      thought: 'Branch thought',
      nextThoughtNeeded: false,
      thoughtNumber: 2,
      totalThoughts: 2,
      branchFromThought: 1,
      branchId: 'alt',
      isRevision: true,
      revisesThought: 1,
    },
  });
  const branchState = JSON.parse(branchTracked.result.content[0].text);
  assert.deepEqual(branchState.openBranches, ['alt']);
  assert.deepEqual(branchState.revisedThoughts, [1]);

  // Grounding gate: unsourced steps and open assumptions stay visible; needsContext routes to retrieval.
  const gated = await request('tools/call', {
    name: 'sequentialthinking',
    arguments: {
      thought: 'Grounded step',
      nextThoughtNeeded: true,
      thoughtNumber: 3,
      totalThoughts: 4,
      sourceChecked: 'mcps/reflect/server.js:153',
      assumptionsUnverified: ['host enforces inputSchema'],
      contradictsMemory: 'legacy-tool-id',
      needsContext: true,
    },
  });
  const gateState = JSON.parse(gated.result.content[0].text);
  assert.deepEqual(gateState.openAssumptions, ['host enforces inputSchema']);
  assert.deepEqual(gateState.contradictedMemories, ['legacy-tool-id']);
  assert.deepEqual(gateState.ungroundedThoughts, [1, 2]);
  assert.match(gateState.directive, /missing facts, not missing reasoning/);

  for (const [label, bad] of [
    ['future reference', { branchFromThought: 9, branchId: 'x' }],
    ['revision without target', { isRevision: true }],
    ['branch without id', { branchFromThought: 1 }],
    ['unknown property', { nonsense: true }],
    ['empty sourceChecked', { sourceChecked: '  ' }],
    ['non-array assumptions', { assumptionsUnverified: 'nope' }],
    ['empty assumption entry', { assumptionsUnverified: [''] }],
  ]) {
    const rejected = await request('tools/call', {
      name: 'sequentialthinking',
      arguments: { thought: 'bad', nextThoughtNeeded: false, thoughtNumber: 2, totalThoughts: 2, ...bad },
    });
    assert.equal(rejected.error?.code, -32602, `expected rejection for ${label}`);
  }

  const resolved = await request('tools/call', {
    name: 'resolve-library-id',
    arguments: { libraryName: 'Test Library', query: 'current API' },
  });
  assert.equal(JSON.parse(resolved.result.content[0].text).selectedLibraryId, '/test/library');

  const documentation = await request('tools/call', {
    name: 'query-docs',
    arguments: { libraryId: '/test/library', query: 'current API' },
  });
  assert.equal(documentation.result.content[0].text, 'Current fixture documentation');
  assert.equal(requests[0].searchParams.get('libraryName'), 'Test Library');
  assert.equal(requests[1].searchParams.get('libraryId'), '/test/library');
  process.stdout.write('reflect tests passed\n');
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
  api.close();
}
