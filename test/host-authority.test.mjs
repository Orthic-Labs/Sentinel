import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

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

test("host token turns CodeRight receipts into trusted signoff evidence", async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "sentinel-host-authority-"));
  const session = startServer(storeRoot);
  try {
    const initialized = await session.request(1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "coderight-host", version: "test" },
    });
    assert.equal(initialized.result.serverInfo.name, "sentinel");
    session.notify("notifications/initialized", {});
    const assess = await session.request(2, "tools/call", {
      name: "sentinel", arguments: { operation: "assess", summary: "host task", host_token: "host-secret" },
    });
    const assessed = assess.result.structuredContent;
    assert.equal(assessed.decision, "skip");
    const receipt = JSON.stringify({ schema: "orthic.tool-receipt.v1", exit_status: 0, tool_call_id: "call-1" });
    const checkpoint = await session.request(3, "tools/call", {
      name: "sentinel",
      arguments: {
        operation: "checkpoint", run_id: assessed.run_id, host_token: "host-secret", summary: "tool receipt",
        checks: [{ kind: "shell", specification: "test", receipt }],
        evidence: [{ kind: "repo", receipt }, { kind: "test", receipt }],
      },
    });
    assert.equal(checkpoint.result.structuredContent.decision, "proceed_with_change");
    const verified = await session.request(4, "tools/call", {
      name: "sentinel", arguments: { operation: "verify", run_id: assessed.run_id, gate: "signoff", host_token: "host-secret" },
    });
    assert.equal(verified.result.structuredContent.decision, "proceed", JSON.stringify(verified.result.structuredContent));
    const closed = await session.request(5, "tools/call", {
      name: "sentinel", arguments: { operation: "close", run_id: assessed.run_id, summary: "done", host_token: "host-secret" },
    });
    assert.equal(closed.result.structuredContent.decision, "closed");
  } finally {
    session.child.kill();
    session.lines.close();
    rmSync(storeRoot, { recursive: true, force: true });
  }
});
