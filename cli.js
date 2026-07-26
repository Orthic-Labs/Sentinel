#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { ReflectCore } = require('./lib/core');
const { resolveDocs } = require('./lib/docs');

async function main(argv = process.argv.slice(2), inputText = readStdin()) {
  const { command, flags } = parseArgs(argv);
  const input = inputText ? JSON.parse(inputText) : {};
  if (flags.operator && process.env.TETHER_TRUSTED_CALLER !== 'hook') throw new Error('--operator requires trusted host caller');
  const authority = flags.operator ? 'operator' : 'model';
  const core = new ReflectCore({ authority, projectRoot: flags.project ?? process.cwd(), storeRoot: flags.store });
  let value;
  if (command === 'docs') value = resolveDocs({ ...input, path: input.path ?? flags.project }, { projectRoot: flags.project ?? process.cwd(), store: core.store });
  else if (command === 'show') value = core.show(input.run_id ?? input.runId ?? flags.run);
  else if (command === 'resolve-session') value = core.resolveSession({ ...input, ...(flags.run ? { run_id: flags.run } : {}) });
  else if (command === 'audit') value = core.audit();
  else if (command === 'purge') value = core.purge(input.run_id ?? input.runId ?? flags.run);
  else if (command === 'tether') value = core[input.operation ?? 'assess'](input, authority);
  else if (['assess', 'checkpoint', 'verify', 'close'].includes(command)) value = core[command]({ ...input, ...(flags.gate ? { gate: flags.gate } : {}) }, authority);
  else throw new Error(`Unknown tether command: ${command}`);
  const rendered = JSON.stringify(value);
  process.stdout.write(`${rendered}\n`);
  if (value.decision === 'blocked' || value.ok === false) process.exitCode = 1;
}

function parseArgs(argv) {
  const flags = {};
  let command = 'tether';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') && command === 'tether') { command = arg; continue; }
    if (arg === '--operator') { flags.operator = true; continue; }
    if (arg === '--json') { flags.json = true; continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    flags[key.replaceAll('-', '_')] = inline ?? argv[++index];
  }
  return { command, flags };
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8').trim(); } catch { return ''; }
}

main().catch((error) => {
  process.stderr.write(`tether-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
