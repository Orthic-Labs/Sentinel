import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const directory = dirname(fileURLToPath(import.meta.url));
const telemetryDirectory = mkdtempSync(join(tmpdir(), 'reflect-telemetry-test-'));
const telemetryPath = join(telemetryDirectory, 'main.jsonl');
const teardownTelemetryPath = join(telemetryDirectory, 'teardown.jsonl');
const requests = [];
let slowRequestSeenResolve;
const slowRequestSeen = new Promise((resolve) => {
  slowRequestSeenResolve = resolve;
});
const documentationFixture = {
  codeSnippets: [
    {
      codeTitle: 'Create a client',
      codeDescription: 'CLIENT-DESCRIPTION '.repeat(20),
      codeLanguage: 'javascript',
      pageTitle: 'Client API',
      codeList: [{ language: 'javascript', code: `const CLIENT_MARKER = true;\n${'client.configure();\n'.repeat(28)}${'`'.repeat(3)} FENCE_MARKER\nconst CLIENT_TAIL = true;` }],
    },
    {
      codeTitle: 'Handle a response',
      codeDescription: 'RESPONSE-DESCRIPTION '.repeat(20),
      codeLanguage: 'javascript',
      pageTitle: 'Response API',
      codeList: [{ language: 'javascript', code: `const RESPONSE_MARKER = true;\n${'response.consume();\n'.repeat(28)}const RESPONSE_TAIL = true;` }],
    },
  ],
  infoSnippets: [
    {
      breadcrumb: 'Guides > Configuration',
      content: `CONFIGURATION_MARKER\n\n${'Configuration reference paragraph. '.repeat(35)} CONFIGURATION_TAIL`,
    },
    {
      breadcrumb: 'Guides > Migration',
      content: `MIGRATION_MARKER\n\n${'Migration reference paragraph. '.repeat(35)} MIGRATION_TAIL`,
    },
  ],
};
const api = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requests.push(url);
  if (url.pathname === '/api/v2/libs/search') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      results: [{
        id: '/test/library',
        title: 'Test Library',
        description: 'Fixture documentation '.repeat(80),
        versions: Array.from({ length: 40 }, (_, index) => `v${index}-${'x'.repeat(90)}`),
        totalSnippets: 12,
        trustScore: 10,
        benchmarkScore: 99,
      }],
    }));
    return;
  }
  if (url.pathname === '/api/v2/context') {
    if (['slow request', 'timeout request', 'concurrency request'].includes(url.searchParams.get('query'))) {
      if (url.searchParams.get('query') === 'slow request') {
        slowRequestSeenResolve();
      }
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(documentationFixture));
        }
      }, 300);
      return;
    }
    if (url.searchParams.get('query') === 'oversized body') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ infoSnippets: [{ breadcrumb: 'Large', content: 'x'.repeat(30_000) }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(documentationFixture));
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
    CONTEXT7_MAX_RESPONSE_CHARS: '1200',
    CONTEXT7_MAX_BODY_BYTES: '20000',
    CONTEXT7_TIMEOUT_MS: '100',
    REFLECT_TELEMETRY_PATH: telemetryPath,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

const pending = new Map();
const receivedMessages = [];
let requestId = 0;
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  receivedMessages.push(message);
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  }
});

function startRequest(message) {
  requestId += 1;
  const id = requestId;
  const payload = { ...message, id };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  let timeout;
  const promise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${message.method ?? 'invalid request'}. ${stderr}`));
    }, 5_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
  return {
    id,
    promise,
    abandon() {
      clearTimeout(timeout);
      pending.delete(id);
    },
  };
}

function requestMessage(message) {
  return startRequest(message).promise;
}

function request(method, params = {}) {
  return requestMessage({ jsonrpc: '2.0', method, params });
}

function readTelemetry(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'reflect-test', version: '1.0.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'reflect');
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.match(initialized.result.instructions, /Automatically call sequentialthinking before/);
  assert.match(initialized.result.instructions, /retrieve context before continuing/);

  const invalidInitialize = await request('initialize', {
    protocolVersion: 42,
    capabilities: {},
    clientInfo: { name: 'reflect-test', version: '1.0.0' },
  });
  assert.equal(invalidInitialize.error?.code, -32602);

  const ping = await request('ping');
  assert.deepEqual(ping.result, {});

  for (const invalidEnvelope of [
    { jsonrpc: '1.0', method: 'ping', params: {} },
    { jsonrpc: '2.0', params: {} },
  ]) {
    const rejected = await requestMessage(invalidEnvelope);
    assert.equal(rejected.error?.code, -32600);
  }

  const listed = await request('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['sequentialthinking', 'resolve-library-id', 'query-docs'],
  );
  for (const tool of listed.result.tools) {
    assert.equal(typeof tool.title, 'string');
    assert.equal(typeof tool.outputSchema, 'object');
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
  }
  const thinkingTool = listed.result.tools.find((tool) => tool.name === 'sequentialthinking');
  assert.match(thinkingTool.description, /Automatically use before multi-file changes/);
  assert.match(thinkingTool.description, /Keep each checkpoint concise/);

  const thought = await request('tools/call', {
    name: 'sequentialthinking',
    arguments: {
      chainId: 'main-test',
      thought: 'Test thought',
      nextThoughtNeeded: false,
      thoughtNumber: 1,
      totalThoughts: 1,
    },
  });
  const thoughtState = JSON.parse(thought.result.content[0].text);
  assert.equal(thoughtState.thoughtsStored, 1);
  assert.equal(thoughtState.nextAction, 'finish');

  // Relational fields are validated server-side; the host does not enforce inputSchema for us.
  const branchTracked = await request('tools/call', {
    name: 'sequentialthinking',
    arguments: {
      chainId: 'main-test',
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
      chainId: 'main-test',
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
  assert.equal(gateState.nextAction, 'retrieve-context');
  assert.deepEqual(gateState.retrievalOptions, [
    'query-docs', 'workspace-read', 'web-search', 'memory-retrieval',
  ]);

  const closed = await request('tools/call', {
    name: 'sequentialthinking',
    arguments: {
      chainId: 'main-test',
      thought: 'Close resolved state',
      nextThoughtNeeded: false,
      thoughtNumber: 4,
      totalThoughts: 4,
      sourceChecked: 'mcps/reflect/test.mjs',
      assumptionsResolved: ['host enforces inputSchema'],
      branchesClosed: ['alt'],
    },
  });
  const closedState = JSON.parse(closed.result.content[0].text);
  assert.deepEqual(closedState.openAssumptions, []);
  assert.deepEqual(closedState.openBranches, []);

  const isolated = await request('tools/call', {
    name: 'sequentialthinking',
    arguments: {
      chainId: 'isolated-test',
      thought: 'Independent chain',
      nextThoughtNeeded: false,
      thoughtNumber: 1,
      totalThoughts: 1,
    },
  });
  assert.equal(JSON.parse(isolated.result.content[0].text).thoughtsStored, 1);

  for (const [label, bad] of [
    ['future reference', { branchFromThought: 9, branchId: 'x' }],
    ['self reference', { branchFromThought: 2, branchId: 'x' }],
    ['revision without target', { isRevision: true }],
    ['branch without id', { branchFromThought: 1 }],
    ['unknown property', { nonsense: true }],
    ['empty sourceChecked', { sourceChecked: '  ' }],
    ['non-array assumptions', { assumptionsUnverified: 'nope' }],
    ['empty assumption entry', { assumptionsUnverified: [''] }],
  ]) {
    const rejected = await request('tools/call', {
      name: 'sequentialthinking',
      arguments: { chainId: 'bad-test', thought: 'bad', nextThoughtNeeded: false, thoughtNumber: 2, totalThoughts: 2, ...bad },
    });
    assert.equal(rejected.result?.isError, true, `expected tool error for ${label}`);
  }

  const extraContextArgument = await request('tools/call', {
    name: 'resolve-library-id',
    arguments: { libraryName: 'Test Library', query: 'current API', privatePrompt: 'must not leave process' },
  });
  assert.equal(extraContextArgument.result?.isError, true);
  assert.equal(requests.length, 0);

  const resolved = await request('tools/call', {
    name: 'resolve-library-id',
    arguments: { libraryName: 'Test Library', query: 'current API' },
  });
  const resolvedValue = JSON.parse(resolved.result.content[0].text);
  assert.equal(resolvedValue.selectedLibraryId, '/test/library');
  assert.deepEqual(resolved.result.structuredContent, resolvedValue);
  assert.ok(resolved.result.content[0].text.length <= 1200);

  const documentationPages = [];
  let continuationToken;
  do {
    const documentation = await request('tools/call', {
      name: 'query-docs',
      arguments: {
        libraryId: '/test/library',
        query: 'current API',
        ...(continuationToken ? { continuationToken } : {}),
      },
    });
    assert.ok(documentation.result.content[0].text.length <= 1200);
    assert.match(documentation.result.content[0].text, /untrusted documentation/i);
    documentationPages.push(documentation.result.content[0].text);
    continuationToken = documentation.result.structuredContent.continuationToken;
  } while (continuationToken);
  const completeDocumentation = documentationPages.join('\n');
  for (const marker of [
    'CLIENT_MARKER', 'FENCE_MARKER', 'CLIENT_TAIL', 'RESPONSE_MARKER', 'RESPONSE_TAIL',
    'CONFIGURATION_MARKER', 'CONFIGURATION_TAIL', 'MIGRATION_MARKER', 'MIGRATION_TAIL',
  ]) {
    assert.match(completeDocumentation, new RegExp(marker));
  }
  assert.doesNotMatch(completeDocumentation, /\[truncated/i);
  assert.match(completeDocumentation, /~~~javascript/);
  assert.equal(requests[0].searchParams.get('libraryName'), 'Test Library');
  assert.equal(requests[1].searchParams.get('libraryId'), '/test/library');
  assert.equal(requests[1].searchParams.get('type'), 'json');
  assert.equal(requests.filter((url) => url.pathname.endsWith('/context')).length, 1);

  const oversizedBody = await request('tools/call', {
    name: 'query-docs',
    arguments: { libraryId: '/test/library', query: 'oversized body' },
  });
  assert.equal(oversizedBody.result?.isError, true);
  assert.match(oversizedBody.result.content[0].text, /exceeded 20000 bytes/);

  const slowCall = startRequest({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'query-docs',
      arguments: { libraryId: '/test/library', query: 'slow request' },
    },
  });
  await slowRequestSeen;
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: slowCall.id, reason: 'test cancellation' },
  })}\n`);
  const cancellationOutcome = await Promise.race([
    slowCall.promise.then(() => 'responded'),
    new Promise((resolve) => setTimeout(() => resolve('silent'), 150)),
  ]);
  slowCall.abandon();
  assert.equal(cancellationOutcome, 'silent');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(receivedMessages.some((message) => message.id === slowCall.id), false);
  assert.deepEqual((await request('ping')).result, {});

  const timedOut = await request('tools/call', {
    name: 'query-docs',
    arguments: { libraryId: '/test/library', query: 'timeout request' },
  });
  assert.equal(timedOut.result?.isError, true);
  assert.match(timedOut.result.content[0].text, /timed out after 100ms/);

  child.stdin.write('null\n');
  const malformedOutcome = await Promise.race([
    once(child, 'exit').then(([code]) => `exited:${code}`),
    new Promise((resolve) => setTimeout(() => resolve('alive'), 100)),
  ]);
  assert.equal(malformedOutcome, 'alive');
  assert.deepEqual((await request('ping')).result, {});

  let telemetryRows = [];
  const telemetryDeadline = Date.now() + 2_000;
  while (Date.now() < telemetryDeadline) {
    telemetryRows = readTelemetry(telemetryPath);
    const outcomes = new Set(telemetryRows
      .filter((row) => row.event === 'reflect.tool_completed')
      .map((row) => `${row.outcome}:${row.reason ?? ''}`));
    if (outcomes.has('delivered:')
      && outcomes.has('failed:invalid_arguments')
      && outcomes.has('failed:response_body_limit')
      && outcomes.has('failed:timeout')
      && outcomes.has('cancelled:cancelled_by_client')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(telemetryRows.some((row) => row.event === 'reflect.process_started'));
  assert.ok(telemetryRows.some((row) => row.event === 'reflect.tool_called'
    && row.tool === 'sequentialthinking'));
  assert.ok(telemetryRows.some((row) => row.event === 'reflect.tool_completed'
    && row.tool === 'sequentialthinking'
    && row.outcome === 'delivered'
    && row.delivery_state === 'stdio_flushed'));
  for (const [outcome, reason] of [
    ['failed', 'invalid_arguments'],
    ['failed', 'response_body_limit'],
    ['failed', 'timeout'],
    ['cancelled', 'cancelled_by_client'],
  ]) {
    assert.ok(telemetryRows.some((row) => row.event === 'reflect.tool_completed'
      && row.outcome === outcome && row.reason === reason));
  }
  for (const row of telemetryRows) {
    assert.equal(typeof row.timestamp, 'string');
    assert.equal(typeof row.ts, 'number');
    assert.equal(typeof row.session_id, 'string');
    assert.equal(Object.hasOwn(row, 'request_id'), false);
  }
  const rawTelemetry = readFileSync(telemetryPath, 'utf8');
  for (const privateValue of [
    'Test thought', 'current API', '/test/library', 'slow request', 'privatePrompt', 'oversized body',
  ]) {
    assert.doesNotMatch(rawTelemetry, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const limitedChild = spawn(process.execPath, [join(directory, 'server.js')], {
    env: { ...process.env, REFLECT_MAX_LINE_CHARS: '100', REFLECT_TELEMETRY_ENABLED: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const limitedLines = createInterface({ input: limitedChild.stdout });
  const limitedMessages = [];
  limitedLines.on('line', (line) => limitedMessages.push(JSON.parse(line)));
  limitedChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', padding: 'x'.repeat(200) })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
  const limitedDeadline = Date.now() + 2_000;
  while (!limitedMessages.some((message) => message.id === 2) && Date.now() < limitedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(limitedMessages.some((message) => message.error?.code === -32700), true);
  assert.deepEqual(limitedMessages.find((message) => message.id === 2)?.result, {});
  limitedLines.close();
  limitedChild.stdin.end();
  limitedChild.kill();

  const teardownChild = spawn(process.execPath, [join(directory, 'server.js')], {
    env: { ...process.env, REFLECT_TELEMETRY_PATH: teardownTelemetryPath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let teardownStderr = '';
  teardownChild.stderr.setEncoding('utf8');
  teardownChild.stderr.on('data', (chunk) => {
    teardownStderr += chunk;
  });
  teardownChild.stdin.on('error', () => {});
  teardownChild.stdout.destroy();
  teardownChild.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'teardown-test', version: '1.0.0' },
    },
  })}\n`);
  for (let id = 2; id <= 51; id += 1) {
    teardownChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })}\n`);
  }
  const teardownOutcome = await Promise.race([
    once(teardownChild, 'exit').then(([code]) => ({ code })),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2_000)),
  ]);
  if (teardownOutcome.timeout) {
    teardownChild.kill();
  }
  assert.deepEqual(teardownOutcome, { code: 0 });
  assert.equal(teardownStderr, '');
  const teardownTelemetry = readTelemetry(teardownTelemetryPath);
  assert.ok(teardownTelemetry.some((row) => row.event === 'reflect.process_started'));
  assert.ok(teardownTelemetry.some((row) => row.event === 'reflect.process_stopped'
    && row.reason === 'transport_closed' && row.exit_code === 0));

  const boundedTelemetryPath = join(telemetryDirectory, 'bounded.jsonl');
  writeFileSync(boundedTelemetryPath, `${JSON.stringify({ existing: 'x'.repeat(700) })}\n`);
  const boundedChild = spawn(process.execPath, [join(directory, 'server.js')], {
    env: {
      ...process.env,
      REFLECT_TELEMETRY_PATH: boundedTelemetryPath,
      REFLECT_TELEMETRY_MAX_BYTES: '1500',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const boundedLines = createInterface({ input: boundedChild.stdout });
  const boundedMessages = [];
  boundedLines.on('line', (line) => boundedMessages.push(JSON.parse(line)));
  try {
    boundedChild.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'bounded-telemetry-test', version: '1.0.0' },
      },
    })}\n`);
    for (let id = 2; id <= 25; id += 1) {
      boundedChild.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'sequentialthinking',
          arguments: {
            chainId: 'bounded-test',
            thought: `private bounded thought ${id}`,
            thoughtNumber: id - 1,
            totalThoughts: 24,
            nextThoughtNeeded: false,
          },
        },
      })}\n`);
    }
    const boundedDeadline = Date.now() + 2_000;
    while (!boundedMessages.some((message) => message.id === 25) && Date.now() < boundedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(boundedMessages.find((message) => message.id === 25)?.result?.isError, undefined);
    assert.ok(statSync(boundedTelemetryPath).size <= 1500);
    assert.doesNotMatch(readFileSync(boundedTelemetryPath, 'utf8'), /private bounded thought/);
  } finally {
    boundedLines.close();
    boundedChild.stdin.end();
    boundedChild.kill();
  }

  const backpressurePreload = `
    const originalWrite = process.stdout.write.bind(process.stdout);
    let firstWrite = true;
    process.stdout.write = function (...args) {
      const accepted = originalWrite(...args);
      if (firstWrite) {
        firstWrite = false;
        setTimeout(() => process.stdout.emit('drain'), 150);
        return false;
      }
      return accepted;
    };
    require(${JSON.stringify(join(directory, 'server.js'))});
  `;
  const backpressureChild = spawn(process.execPath, ['-e', backpressurePreload], {
    env: { ...process.env, REFLECT_TELEMETRY_ENABLED: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const backpressureLines = createInterface({ input: backpressureChild.stdout });
  const backpressureMessages = [];
  backpressureLines.on('line', (line) => {
    backpressureMessages.push({ message: JSON.parse(line), receivedAt: Date.now() });
  });
  try {
    backpressureChild.stdin.write([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'backpressure-test', version: '1.0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }),
    ].join('\n') + '\n');
    const backpressureDeadline = Date.now() + 2_000;
    while (backpressureMessages.length < 2 && Date.now() < backpressureDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(backpressureMessages.length, 2);
    assert.ok(
      backpressureMessages[1].receivedAt - backpressureMessages[0].receivedAt >= 100,
      'the next input line must wait until stdout drains',
    );
  } finally {
    backpressureLines.close();
    backpressureChild.stdin.end();
    backpressureChild.kill();
  }

  const concurrencyChild = spawn(process.execPath, [join(directory, 'server.js')], {
    env: {
      ...process.env,
      CONTEXT7_API_BASE_URL: `http://127.0.0.1:${address.port}/api/v2`,
      CONTEXT7_MAX_CONCURRENT_REQUESTS: '1',
      REFLECT_TELEMETRY_ENABLED: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const concurrencyLines = createInterface({ input: concurrencyChild.stdout });
  const concurrencyMessages = [];
  concurrencyLines.on('line', (line) => concurrencyMessages.push(JSON.parse(line)));
  try {
    concurrencyChild.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'concurrency-test', version: '1.0.0' },
      },
    })}\n`);
    const initializeDeadline = Date.now() + 2_000;
    while (!concurrencyMessages.some((message) => message.id === 1) && Date.now() < initializeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    concurrencyChild.stdin.write([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'query-docs',
          arguments: { libraryId: '/test/library', query: 'concurrency request' },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'query-docs',
          arguments: { libraryId: '/test/library', query: 'concurrency request' },
        },
      }),
    ].join('\n') + '\n');
    const concurrencyDeadline = Date.now() + 2_000;
    while (!concurrencyMessages.some((message) => message.id === 3) && Date.now() < concurrencyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rejectedConcurrentRequest = concurrencyMessages.find((message) => message.id === 3);
    assert.equal(rejectedConcurrentRequest?.result?.isError, true);
    assert.match(rejectedConcurrentRequest.result.content[0].text, /concurrent Context7 request limit of 1/);
    const firstRequestDeadline = Date.now() + 2_000;
    while (!concurrencyMessages.some((message) => message.id === 2) && Date.now() < firstRequestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(concurrencyMessages.find((message) => message.id === 2)?.result?.isError, undefined);
    concurrencyChild.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'query-docs',
        arguments: { libraryId: '/test/library', query: 'current API' },
      },
    })}\n`);
    const recoveredDeadline = Date.now() + 2_000;
    while (!concurrencyMessages.some((message) => message.id === 4) && Date.now() < recoveredDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(concurrencyMessages.find((message) => message.id === 4)?.result?.isError, undefined);
  } finally {
    concurrencyLines.close();
    concurrencyChild.stdin.end();
    concurrencyChild.kill();
  }

  const invalidEnvironment = spawnSync(process.execPath, [join(directory, 'server.js')], {
    env: { ...process.env, REFLECT_MAX_THOUGHTS: '500oops', REFLECT_TELEMETRY_ENABLED: '0' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(invalidEnvironment.status, 0);
  assert.match(invalidEnvironment.stderr, /positive integers/);
  process.stdout.write('reflect tests passed\n');
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
  api.close();
  rmSync(telemetryDirectory, { recursive: true, force: true });
}
