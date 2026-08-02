import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { isTrustedHostTransport, projectStoreKey, resolveDefaultStoreRoot } from "../lib/host.js";

const sentinelRoot = fileURLToPath(new URL("..", import.meta.url));
const server = join(sentinelRoot, "server.js");

function startServer(storeRoot) {
  const child = spawn(process.execPath, [server], {
    cwd: sentinelRoot,
    env: { ...process.env, BEACON_HOST_TOKEN: "host-secret", BEACON_STORE_ROOT: storeRoot },
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

test("host stdio requires CodeRight parent identity", () => {
  const trusted = { readParentExecutable: () => "/Applications/CodeRight.app/Contents/MacOS/CodeRight" };
  const shell = { readParentExecutable: () => "/bin/zsh" };
  assert.equal(isTrustedHostTransport(["--host-stdio"], trusted), true);
  assert.equal(isTrustedHostTransport(["--host-stdio"], shell), false);
  assert.equal(isTrustedHostTransport([], trusted), false);
});

test("default authority ledger never falls back to an agent-writable repository path", () => {
  const root = mkdtempSync(join(tmpdir(), "sentinel-host-store-"));
  const project = join(root, "project");
  const host = join(root, "host");
  mkdirSync(join(project, ".tether"), { recursive: true });
  writeFileSync(join(project, ".tether", "events.jsonl"), "{}\n");
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
