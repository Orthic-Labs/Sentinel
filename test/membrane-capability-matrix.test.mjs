import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('host manifests implement declared H1 capability levels', () => {
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'hooks/membrane-capability-matrix.json'), 'utf8'));
  const claude = JSON.parse(fs.readFileSync(path.join(root, 'hooks/claude-code/settings.json'), 'utf8')).hooks;
  const codex = JSON.parse(fs.readFileSync(path.join(root, 'hooks/codex/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(matrix.hosts.claude_code.injection, ['SessionStart', 'UserPromptSubmit']);
  assert.match(claude.SessionStart[0].hooks[0].command, /dispatcher\.js/);
  assert.match(claude.UserPromptSubmit[0].hooks[0].command, /dispatcher\.js/);
  assert.ok(codex.SessionStart?.length);
  assert.ok(codex.UserPromptSubmit?.length);
  assert.ok(fs.existsSync(path.join(root, 'hooks/codex/context.js')));
  assert.equal(matrix.hosts.ccx.inherits, 'claude_code');
  assert.equal(matrix.hosts.generic_mcp.max_honest_level, 'L0');
  assert.deepEqual(matrix.support_tiers.tier_1, ['macOS', 'Windows']);
});
