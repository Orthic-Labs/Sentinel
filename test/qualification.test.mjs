import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('per-host installation qualification matrix is executable', () => {
  for (const [host, file] of [['claude-code', 'hooks/claude-code/settings.json'], ['codex', 'hooks/codex/hooks.json']]) {
    const settings = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.ok(settings.hooks[event]?.length, `${host} ${event} discoverable`);
    for (const [event, entries] of Object.entries(settings.hooks)) {
      const count = entries.reduce((sum, entry) => sum + (entry.hooks?.length ?? 0), 0);
      assert.equal(count, 1, `${host} ${event} has one dispatcher`);
      assert.match(entries[0].hooks[0].command, /dispatcher\.js/);
    }
  }
});
