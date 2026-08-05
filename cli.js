#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { ForgeCore } = require('./lib/core');
const { resolveDocs } = require('./lib/docs');
const { validateTrustedCaller, doctor } = require('./lib/host');

async function main(argv = process.argv.slice(2), inputText = readStdin()) {
  const { command, flags } = parseArgs(argv);
  const input = inputText ? JSON.parse(inputText) : {};
  if (command === 'doctor') {
    const value = doctor(flags.project ?? process.cwd());
    process.stdout.write(`${JSON.stringify(value)}\n`);
    if (!value.ok) process.exitCode = 1;
    return;
  }
  const trusted = validateTrustedCaller({ hook: flags.hook, operator: flags.operator });
  const authority = trusted.authority;
  const core = new ForgeCore({ authority, projectRoot: flags.project ?? process.cwd(), storeRoot: flags.store });
  let value;
  if (command === 'docs') value = resolveDocs({ ...input, path: input.path ?? flags.project }, { projectRoot: flags.project ?? process.cwd(), store: core.store });
  else if (command === 'show') value = core.show(input.run_id ?? input.runId ?? flags.run);
  else if (command === 'resolve-session') value = core.resolveSession({ ...input, ...(flags.run ? { run_id: flags.run } : {}) });
  else if (command === 'audit') value = core.audit();
  else if (command === 'purge') value = core.purge(input.run_id ?? input.runId ?? flags.run);
  else if (command === 'forge') value = await core[input.operation ?? 'assess'](input, authority);
  else if (['assess', 'checkpoint', 'verify', 'close'].includes(command)) value = await core[command]({ ...input, ...(flags.gate ? { gate: flags.gate } : {}) }, authority);
  else throw new Error(`Unknown forge command: ${command}`);
  const rendered = JSON.stringify(value);
  process.stdout.write(`${rendered}\n`);
  if (value.decision === 'blocked' || value.ok === false) process.exitCode = 1;
}

function parseArgs(argv) {
  const flags = {};
  let command = 'forge';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') && command === 'forge') { command = arg; continue; }
    if (arg === '--operator') { flags.operator = true; continue; }
    if (arg === '--hook') { flags.hook = true; continue; }
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
  process.stderr.write(`forge-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

module.exports = { ForgeCore };
