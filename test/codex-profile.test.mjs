import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Codex L2 profile documents bounded adapter and honest native limits', async () => {
  const agents = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /Membrane Codex L2 profile/);
  assert.match(agents, /no native context-injection or response-gate lifecycle/);
});
