'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function envFirst(...keys) {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return undefined;
}

function platformDataRoot(product) {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', product);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, product);
  }
  return path.join(home, '.local', 'share', product);
}

function resolveHostDataDir() {
  const override = envFirst('SENTINEL_HOST_DATA');
  if (override) return path.resolve(override);
  return platformDataRoot('sentinel');
}

function validateTrustedCaller({ hook = false, operator = false } = {}) {
  if (!hook && !operator) return { ok: true, authority: 'model' };
  throw new Error(`--${hook ? 'hook' : 'operator'} cannot mint trusted authority; use signed host transport`);
}

function readParentExecutable(parentPid = process.ppid, platform = process.platform) {
  if (!Number.isInteger(parentPid) || parentPid < 1) return '';
  if (platform === 'linux') {
    try { return fs.readlinkSync(`/proc/${parentPid}/exe`); } catch { return ''; }
  }
  if (platform === 'darwin') {
    try {
      return childProcess.execFileSync('/bin/ps', ['-p', String(parentPid), '-o', 'comm='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return ''; }
  }
  if (platform === 'win32') {
    try {
      return childProcess.execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${parentPid}\").ExecutablePath`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch { return ''; }
  }
  return '';
}

const WORKSPACE_HOST_TEAM_ID = '6KLGD3LLKF';
const WORKSPACE_HOST_WINDOWS_SUBJECT = 'CN=Damned Ventures LLC';

function isTrustedWorkspaceHostExecutable(executable, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  // macOS paths are posix-shaped even when this check runs on a Windows host
  // (e.g. in a unit test), so normalize with posix.resolve, not the host default.
  const normalized = path.posix.resolve(String(executable).replace(/\\/g, '/'));
  const allowedSuffixes = [
    '/SentinelHost.app/Contents/MacOS/SentinelHost',
    '/SentinelHost.app/Contents/Resources/rhook/rhook',
  ];
  if (!allowedSuffixes.some((suffix) => normalized.endsWith(suffix))) return false;
  try {
    const verify = options.verifySignature ?? ((file) => {
      childProcess.execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', file], { stdio: 'ignore' });
      const inspected = childProcess.spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', file], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (inspected.status !== 0) throw new Error('codesign inspection failed');
      return `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`;
    });
    const details = String(verify(normalized));
    return details.includes(`TeamIdentifier=${WORKSPACE_HOST_TEAM_ID}`);
  } catch {
    return false;
  }
}

function isTrustedWindowsWorkspaceHostExecutable(executable, options = {}) {
  const normalized = String(executable ?? '').trim();
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) return false;
  const expected = [
    path.win32.resolve(localAppData, 'SentinelHost', 'rhook.exe'),
    path.win32.resolve(localAppData, 'SentinelHost', 'rhook', 'rhook.exe'),
  ].map((file) => file.toLowerCase());
  if (!expected.includes(path.win32.resolve(normalized).toLowerCase())) return false;
  try {
    const verify = options.verifyAuthenticode ?? ((file) => {
      const script = [
        '$signature = Get-AuthenticodeSignature -LiteralPath $args[0]',
        '@{ status = [string]$signature.Status; subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
      ].join('; ');
      const output = childProcess.execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', script, file,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      return JSON.parse(output);
    });
    const signature = verify(normalized);
    const subject = String(signature?.subject ?? '');
    return signature?.status === 'Valid'
      && subject.split(/,\s*/).includes(WORKSPACE_HOST_WINDOWS_SUBJECT);
  } catch {
    return false;
  }
}

function isTrustedHostTransport(argv = process.argv.slice(2), options = {}) {
  if (!argv.includes('--host-stdio')) return false;
  const executable = (options.readParentExecutable ?? readParentExecutable)(options.parentPid ?? process.ppid);
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return isTrustedWorkspaceHostExecutable(executable, options);
  if (platform === 'win32') return isTrustedWindowsWorkspaceHostExecutable(executable, options);
  return false;
}

// Canonicalize to the OS realpath when the target exists (resolves symlink components such
// as macOS's /var -> /private/var or /tmp -> /private/tmp), falling back to a plain absolute
// path otherwise. Two processes given the "same" project root as different string
// representations (one literal, one re-derived from a spawned child's process.cwd(), which the
// OS always returns realpath-resolved) MUST land on the same canonical form here — otherwise
// they hash to different store buckets and a persisted binding written by one process becomes
// invisible to the other. This mirrors the realpath pattern lib/core.js#attestLocator already
// uses for evidence-locator containment checks.
function canonicalizePath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function projectStoreKey(projectRoot) {
  return crypto.createHash('sha256').update(canonicalizePath(projectRoot)).digest('hex').slice(0, 16);
}

function resolveDefaultStoreRoot(projectRoot) {
  const resolvedProject = canonicalizePath(projectRoot);
  const hostDataDir = resolveHostDataDir();
  const resolvedHostDataDir = canonicalizePath(hostDataDir);
  // The authority ledger is authoritative only because it lives somewhere the agent's own shell
  // cannot write. SENTINEL_HOST_DATA is agent-controllable (any Bash call can export it), so if it
  // resolves inside the project workspace the ledger is exactly as writable as the code being
  // reviewed — reject loudly instead of silently trusting a self-issued store.
  if (resolvedHostDataDir === resolvedProject || resolvedHostDataDir.startsWith(resolvedProject + path.sep)) {
    throw new Error(
      `sentinel: refusing agent-writable authority ledger — SENTINEL_HOST_DATA (${hostDataDir}) resolves inside the project workspace (${resolvedProject}); `
      + 'the ledger must live outside any directory the agent can write to. Unset SENTINEL_HOST_DATA or point it at a host-owned directory.',
    );
  }
  return path.join(hostDataDir, 'stores', projectStoreKey(resolvedProject));
}

function doctor(projectRoot = process.cwd()) {
  const hostData = resolveHostDataDir();
  const pluginRoot = envFirst('CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'SENTINEL_PLUGIN_ROOT');
  const findings = [];
  let storeRoot = null;
  let storeWritable = false;
  try {
    storeRoot = resolveDefaultStoreRoot(projectRoot);
  } catch (error) {
    findings.push({ level: 'error', code: 'host_data_agent_writable', message: error.message });
  }
  if (storeRoot === null) {
    // Nothing else to check: an agent-writable ledger location is disqualifying on its own.
  } else if (!fs.existsSync(storeRoot)) {
    findings.push({ level: 'info', code: 'store_uninitialized', message: 'store is created only by a normal Sentinel operation' });
  } else {
    try {
      fs.accessSync(storeRoot, fs.constants.R_OK | fs.constants.W_OK);
      storeWritable = true;
    } catch (error) {
      findings.push({ level: 'error', code: 'store_not_writable', message: error.message });
    }
  }
  if (!pluginRoot) {
    findings.push({
      level: 'info',
      code: 'plugin_root_unset',
      message: 'CODEX_PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT unset; Codex hooks resolve via script dirname when invoked directly',
    });
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) findings.push({ level: 'error', code: 'node_too_old', message: `Node ${process.versions.node}; need >=20` });
  const ok = !findings.some((row) => row.level === 'error');
  return {
    ok,
    product: 'sentinel',
    aliases: ['sentinel'],
    host_data: hostData,
    store_root: storeRoot,
    store_writable: storeWritable,
    plugin_root: pluginRoot ?? null,
    node: process.versions.node,
    findings,
  };
}

module.exports = {
  resolveHostDataDir,
  validateTrustedCaller,
  resolveDefaultStoreRoot,
  projectStoreKey,
  canonicalizePath,
  doctor,
  envFirst,
  readParentExecutable,
  isTrustedHostTransport,
  isTrustedWorkspaceHostExecutable,
  isTrustedWindowsWorkspaceHostExecutable,
};
