import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { ForgeCore } from "../lib/core.js";
import { doctor, isTrustedHostTransport, projectStoreKey, resolveDefaultStoreRoot } from "../lib/host.js";

const forgeRoot = fileURLToPath(new URL("..", import.meta.url));
const server = join(forgeRoot, "server.js");

function startServer(storeRoot) {
  const child = spawn(process.execPath, [server], {
    cwd: forgeRoot,
    env: { ...process.env, FORGE_HOST_DATA: storeRoot },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  const nextResponse = () => new Promise((resolve, reject) => {
    const onLine = (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    lines.once("line", onLine);
    child.once("exit", (code) => reject(new Error(`Forge exited: ${code}`)));
  });
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return nextResponse();
  };
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { child, lines, request, notify };
}

test("same-user bearer token cannot mint host authority", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "forge-host-authority-"));
  const session = startServer(storeRoot);
  try {
    const initialized = await session.request(1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "workspace-host", version: "test" },
    });
    assert.equal(initialized.result.serverInfo.name, "forge");
    session.notify("notifications/initialized", {});
    const assess = await session.request(2, "tools/call", {
      name: "forge", arguments: {
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

test("a plain shell/process invocation cannot obtain host authority even with --host-stdio (real, unmocked parent-identity check)", async () => {
  // Every other host-authority test injects a fake readParentExecutable/verifySignature to prove
  // the *logic* is sound. This test proves the *real* code path holds: no injected options, no
  // mocked identity — the actual /bin/ps + codesign inspection on darwin (or the win32
  // equivalent) runs against this test's REAL parent process, which is plain `node` (or the
  // shell that launched `node --test`), not a codesign-verified workspace host. F15's premise
  // ("any shell the agent can run can mint host authority") must be false end-to-end, not just
  // false when the caller supplies trustworthy mocks.
  const storeRoot = mkdtempSync(join(tmpdir(), "forge-host-real-parent-"));
  const child = spawn(process.execPath, [server, "--host-stdio"], {
    cwd: forgeRoot,
    env: { ...process.env, FORGE_HOST_DATA: storeRoot },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  const nextResponse = () => new Promise((resolve, reject) => {
    const onLine = (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    lines.once("line", onLine);
    child.once("exit", (code) => reject(new Error(`Forge exited: ${code}`)));
  });
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return nextResponse();
  };
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "plain-shell", version: "test" },
    });
    assert.equal(initialized.result.serverInfo.name, "forge");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const assess = await request(2, "tools/call", {
      name: "forge",
      arguments: { operation: "assess", summary: "unsigned parent attempts to claim host authority" },
    });
    assert.equal(assess.result.isError, undefined);
    const value = JSON.parse(assess.result.content[0].text);
    assert.equal(value.authority, "model");
  } finally {
    child.kill();
    lines.close();
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('responses expose current caller authority without inheriting run authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-response-authority-'));
  try {
    const core = new ForgeCore({ projectRoot: root, storeRoot: join(root, 'store') });
    const assessed = core.assess({ summary: 'trusted host task' }, 'host');
    const checkpointed = core.checkpoint({ run_id: assessed.run_id }, 'model');
    assert.equal(assessed.authority, 'host');
    assert.equal(checkpointed.authority, 'model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host stdio requires signed workspace host parent identity", () => {
  const trusted = {
    platform: 'darwin',
    readParentExecutable: () => "/Applications/ForgeHost.app/Contents/Resources/rhook/rhook",
    verifySignature: () => 'TeamIdentifier=6KLGD3LLKF',
  };
  const forged = {
    platform: 'darwin',
    readParentExecutable: () => "/tmp/ForgeHost.app/Contents/MacOS/ForgeHost",
    verifySignature: () => 'TeamIdentifier=forged',
  };
  const shell = { readParentExecutable: () => "/bin/zsh" };
  assert.equal(isTrustedHostTransport(["--host-stdio"], trusted), true);
  assert.equal(isTrustedHostTransport(["--host-stdio"], forged), false);
  assert.equal(isTrustedHostTransport(["--host-stdio"], shell), false);
  assert.equal(isTrustedHostTransport([], trusted), false);
});

test('Windows host stdio requires valid signed workspace host identity', () => {
  const trusted = {
    platform: 'win32',
    localAppData: 'C:\\Users\\Adrian\\AppData\\Local',
    readParentExecutable: () => 'C:\\Users\\Adrian\\AppData\\Local\\ForgeHost\\rhook\\rhook.exe',
    verifyAuthenticode: () => ({ status: 'Valid', subject: 'CN=Damned Ventures LLC, O=Damned Ventures LLC' }),
  };
  const forgedName = {
    platform: 'win32',
    localAppData: 'C:\\Users\\Adrian\\AppData\\Local',
    readParentExecutable: () => 'C:\\Temp\\ForgeHost.exe',
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
  const root = mkdtempSync(join(tmpdir(), "forge-host-store-"));
  const project = join(root, "project");
  const host = join(root, "host");
  mkdirSync(join(project, ".forge"), { recursive: true });
  writeFileSync(join(project, ".forge", "events.jsonl"), "{}\n");
  const previous = process.env.FORGE_HOST_DATA;
  process.env.FORGE_HOST_DATA = host;
  try {
    assert.equal(resolveDefaultStoreRoot(project), join(host, "stores", projectStoreKey(project)));
  } finally {
    if (previous === undefined) delete process.env.FORGE_HOST_DATA;
    else process.env.FORGE_HOST_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent-controlled FORGE_HOST_DATA pointing inside the project workspace is rejected loudly, not silently downgraded", () => {
  // FORGE_HOST_DATA is read from the environment, and the environment is exactly what a
  // shell the agent runs can set (`export FORGE_HOST_DATA=...`). If Forge silently accepted
  // an override that resolves inside the project it is guarding, the "authoritative" ledger would
  // be exactly as agent-writable as the code under review — the same class of hole F16 flags for
  // the on-disk store. The fix must fail loudly (throw), never fall through to a downgraded but
  // silently-accepted store.
  const root = mkdtempSync(join(tmpdir(), "forge-host-forged-"));
  const project = join(root, "project");
  mkdirSync(join(project, "subdir"), { recursive: true });
  const previous = process.env.FORGE_HOST_DATA;
  try {
    // Case 1: the agent points the ledger AT the project root itself.
    process.env.FORGE_HOST_DATA = project;
    assert.throws(() => resolveDefaultStoreRoot(project), /agent-writable/);
    // Case 2: the agent points the ledger at a subdirectory it can freely create/write.
    process.env.FORGE_HOST_DATA = join(project, "subdir");
    assert.throws(() => resolveDefaultStoreRoot(project), /agent-writable/);
    // A sibling directory under the same parent is NOT inside the project and must still work —
    // this is exactly the shape the "never falls back" test above already relies on.
    process.env.FORGE_HOST_DATA = join(root, "legit-host");
    assert.doesNotThrow(() => resolveDefaultStoreRoot(project));
  } finally {
    if (previous === undefined) delete process.env.FORGE_HOST_DATA;
    else process.env.FORGE_HOST_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports an agent-writable FORGE_HOST_DATA as a loud error finding instead of crashing", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-doctor-forged-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const previous = process.env.FORGE_HOST_DATA;
  process.env.FORGE_HOST_DATA = project;
  try {
    const result = doctor(project);
    assert.equal(result.ok, false);
    assert.equal(result.store_root, null);
    assert.ok(result.findings.some((row) => row.level === "error" && row.code === "host_data_agent_writable"));
  } finally {
    if (previous === undefined) delete process.env.FORGE_HOST_DATA;
    else process.env.FORGE_HOST_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor never initializes a host store', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-doctor-'));
  const project = join(root, 'project');
  const host = join(root, 'host');
  mkdirSync(project);
  const previous = process.env.FORGE_HOST_DATA;
  process.env.FORGE_HOST_DATA = host;
  try {
    const result = doctor(project);
    assert.equal(result.ok, true);
    assert.equal(result.store_writable, false);
    assert.ok(result.findings.some((row) => row.code === 'store_uninitialized'));
    assert.equal(existsSync(host), false);
  } finally {
    if (previous === undefined) delete process.env.FORGE_HOST_DATA;
    else process.env.FORGE_HOST_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
