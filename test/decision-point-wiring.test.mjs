// Plan 2.6: the Forge PreToolUse hook must wire Membrane's decision-point
// router into the live host path. The library (decision-points.mjs) was already
// implemented; this test proves the hook actually calls it — the
// "implemented != wired" failure mode the plan was written to close.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluate } = require('../hooks/generic/hook.js');

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

test('PreToolUse: a broad discovery grep gets a non-blocking membrane_context suggestion', () => {
  const result = evaluate(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'where is the entry point of the pipeline' },
    },
    { root: REPO_ROOT, projectRoot: REPO_ROOT },
  );
  // Never blocks — a suggestion is advisory.
  assert.notEqual(result.action, 'block');
  assert.ok(result.suggestion, 'plan 2.6: a broad discovery call must surface a suggestion');
  assert.match(result.suggestion, /membrane_context/);
});

test('PreToolUse: an exact file target passes with no suggestion', () => {
  const result = evaluate(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'src/index.ts' },
    },
    { root: REPO_ROOT, projectRoot: REPO_ROOT },
  );
  assert.notEqual(result.action, 'block');
  assert.ok(!result.suggestion, 'plan 2.6: an exact target must not get a discovery suggestion');
});

test('PreToolUse: a non-discovery tool passes untouched', () => {
  const result = evaluate(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    },
    { root: REPO_ROOT, projectRoot: REPO_ROOT },
  );
  assert.notEqual(result.action, 'block');
  assert.ok(!result.suggestion, 'plan 2.6: a non-discovery tool must not get a suggestion');
});
