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
  const override = envFirst('SENTINEL_HOST_DATA', 'TETHER_HOST_DATA', 'BEACON_HOST_DATA');
  if (override) return path.resolve(override);
  const beaconDir = platformDataRoot('beacon');
  const tetherDir = platformDataRoot('tether');
  // Prefer legacy tether host data when it already exists and beacon has not been initialized.
  if (fs.existsSync(tetherDir) && !fs.existsSync(beaconDir)) return tetherDir;
  return beaconDir;
}

function tokenPath(hostDataDir = resolveHostDataDir()) {
  return path.join(hostDataDir, 'host.token');
}

function ensureHostToken(hostDataDir = resolveHostDataDir()) {
  fs.mkdirSync(hostDataDir, { recursive: true, mode: 0o700 });
  const file = tokenPath(hostDataDir);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function readHostToken(hostDataDir = resolveHostDataDir()) {
  const file = tokenPath(hostDataDir);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim();
}

function validateTrustedCaller({ hook = false, operator = false } = {}) {
  if (!hook && !operator) return { ok: true, authority: 'model' };
  throw new Error(`--${hook ? 'hook' : 'operator'} cannot mint trusted authority; use CodeRight host transport`);
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

function isTrustedHostTransport(argv = process.argv.slice(2), options = {}) {
  if (!argv.includes('--host-stdio')) return false;
  const executable = (options.readParentExecutable ?? readParentExecutable)(options.parentPid ?? process.ppid);
  const name = path.basename(String(executable)).toLowerCase();
  return new Set(['coderight', 'coderight.exe', 'coderight-driver-host', 'coderight-driver-host.exe']).has(name);
}

function projectStoreKey(projectRoot) {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

function resolveDefaultStoreRoot(projectRoot) {
  const override = envFirst('SENTINEL_STORE_ROOT', 'TETHER_STORE_ROOT', 'BEACON_STORE_ROOT');
  if (override) return path.resolve(override);
  const resolvedProject = path.resolve(projectRoot);
  return path.join(resolveHostDataDir(), 'stores', projectStoreKey(resolvedProject));
}

function doctor(projectRoot = process.cwd()) {
  const hostData = resolveHostDataDir();
  const tokenFile = tokenPath(hostData);
  const storeRoot = resolveDefaultStoreRoot(projectRoot);
  const pluginRoot = envFirst('CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'SENTINEL_PLUGIN_ROOT', 'BEACON_PLUGIN_ROOT');
  const findings = [];
  const tokenOk = fs.existsSync(tokenFile);
  if (!tokenOk) findings.push({ level: 'warn', code: 'missing_host_token', message: 'run sentinel-cli init (or tether-cli host-init)' });
  let storeWritable = false;
  try {
    fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
    const probe = path.join(storeRoot, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
    storeWritable = true;
  } catch (error) {
    findings.push({ level: 'error', code: 'store_not_writable', message: error.message });
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
    aliases: ['tether'],
    host_data: hostData,
    host_token: tokenOk,
    store_root: storeRoot,
    store_writable: storeWritable,
    plugin_root: pluginRoot ?? null,
    node: process.versions.node,
    findings,
  };
}

module.exports = {
  resolveHostDataDir,
  ensureHostToken,
  readHostToken,
  validateTrustedCaller,
  resolveDefaultStoreRoot,
  projectStoreKey,
  tokenPath,
  doctor,
  envFirst,
  readParentExecutable,
  isTrustedHostTransport,
};
