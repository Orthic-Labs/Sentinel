import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { SentinelCore } from "../lib/core.js";
import { doctor, isTrustedHostTransport, projectStoreKey, resolveDefaultStoreRoot } from "../lib/host.js";

const sentinelRoot = fileURLToPath(new URL("..", import.meta.url));
const server = join(sentinelRoot, "server.js");

function startServer(storeRoot) {
  const child = spawn(process.execPath, [server], {
    cwd: sentinelRoot,
    env: { ...process.env, SENTINEL_HOST_DATA: storeRoot },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  const nextResponse = () => new Promise((resolve, reject) => {
    const onLine = (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    lines.once("line", onLine);
    child.once("exit", (code) => reject(new Error(`Sentinel exited: ${code}`)));
  });
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return nextResponse();
  };
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { child, lines, request, notify };
}

test("same-user bearer token cannot mint host authority", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "sentinel-host-authority-"));
  const session = startServer(storeRoot);
  try {
    const initialized = await session.request(1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "coderight-host", version: "test" },
    });
    assert.equal(initialized.result.serverInfo.name, "sentinel");
    session.notify("notifications/initialized", {});
    const assess = await session.request(2, "tools/call", {
      name: "sentinel", arguments: {
        operation: "assess", summary: "host task", host_token: "host-secret",
        acceptance_criteria: [{ id: "host-receipt", criterion: "host receipt passes", verification: ["test"] }],
      },
    });
    assert.equal(assess.result.isError, true);
    assert.match(assess.result.content[0].text, /Unknown property: host_token/);
  } finally {
    session.child.kill();
    session.lines.close();
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('responses expose current caller authority without inheriting run authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-response-authority-'));
  try {
    const core = new SentinelCore({ projectRoot: root, storeRoot: join(root, 'store') });
    const assessed = core.assess({ summary: 'trusted host task' }, 'host');
    const checkpointed = core.checkpoint({ run_id: assessed.run_id }, 'model');
    assert.equal(assessed.authority, 'host');
    assert.equal(checkpointed.authority, 'model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host stdio requires CodeRight parent identity", () => {
  const trusted = {
    platform: 'darwin',
    readParentExecutable: () => "/Applications/CodeRight.app/Contents/Resources/coderight-engine/coderight",
    verifySignature: () => 'TeamIdentifier=6KLGD3LLKF',
  };
  const forged = {
    platform: 'darwin',
    readParentExecutable: () => "/tmp/CodeRight.app/Contents/MacOS/CodeRight",
    verifySignature: () => 'TeamIdentifier=forged',
  };
  const shell = { readParentExecutable: () => "/bin/zsh" };
  assert.equal(isTrustedHostTransport(["--host-stdio"], trusted), true);
  assert.equal(isTrustedHostTransport(["--host-stdio"], forged), false);
  assert.equal(isTrustedHostTransport(["--host-stdio"], shell), false);
  assert.equal(isTrustedHostTransport([], trusted), false);
});

test('Windows host stdio requires valid Authenticode CodeRight identity', () => {
  const trusted = {
    platform: 'win32',
    localAppData: 'C:\\Users\\Adrian\\AppData\\Local',
    readParentExecutable: () => 'C:\\Users\\Adrian\\AppData\\Local\\CodeRight\\coderight-engine\\coderight.exe',
    verifyAuthenticode: () => ({ status: 'Valid', subject: 'CN=Damned Ventures LLC, O=Damned Ventures LLC' }),
  };
  const forgedName = {
    platform: 'win32',
    localAppData: 'C:\\Users\\Adrian\\AppData\\Local',
    readParentExecutable: () => 'C:\\Temp\\CodeRight.exe',
    verifyAuthenticode: () => ({ status: 'Valid', subject: 'CN=Untrusted Publisher' }),
  };
  const unsignedShell = {
    platform: 'win32',
    localAppData: 'C:\\Users\\Adrian\\AppData\\Local',
    readParentExecutable: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    verifyAuthenticode: () => ({ status: 'Valid', subject: 'CN=Damned Ventures LLC' }),
  };
  const wrongPublisher = {
    ...trusted,
    verifyAuthenticode: () => ({ status: 'Valid', subject: 'CN=Adrian D\'souza' }),
  };
  assert.equal(isTrustedHostTransport(['--host-stdio'], trusted), true);
  assert.equal(isTrustedHostTransport(['--host-stdio'], forgedName), false);
  assert.equal(isTrustedHostTransport(['--host-stdio'], unsignedShell), false);
  assert.equal(isTrustedHostTransport(['--host-stdio'], wrongPublisher), false);
});

test("default authority ledger never falls back to an agent-writable repository path", () => {
  const root = mkdtempSync(join(tmpdir(), "sentinel-host-store-"));
  const project = join(root, "project");
  const host = join(root, "host");
  mkdirSync(join(project, ".sentinel"), { recursive: true });
  writeFileSync(join(project, ".sentinel", "events.jsonl"), "{}\n");
  const previous = process.env.SENTINEL_HOST_DATA;
  process.env.SENTINEL_HOST_DATA = host;
  try {
    assert.equal(resolveDefaultStoreRoot(project), join(host, "stores", projectStoreKey(project)));
  } finally {
    if (previous === undefined) delete process.env.SENTINEL_HOST_DATA;
    else process.env.SENTINEL_HOST_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor never initializes a host store', () => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-doctor-'));
  const project = join(root, 'project');
  const host = join(root, 'host');
  mkdirSync(project);
  const previous = process.env.SENTINEL_HOST_DATA;
  process.env.SENTINEL_HOST_DATA = host;
  try {
    const result = doctor(project);
    assert.equal(result.ok, true);
    assert.equal(result.store_writable, false);
    assert.ok(result.findings.some((row) => row.code === 'store_uninitialized'));
    assert.equal(existsSync(host), false);
  } finally {
    if (previous === undefined) delete process.env.SENTINEL_HOST_DATA;
    else process.env.SENTINEL_HOST_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
