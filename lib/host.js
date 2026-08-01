'use strict';

const crypto = require('node:crypto');
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
  const expected = readHostToken();
  if (!expected) {
    throw new Error('trusted host caller requires initialized host token; invoke a sentinel/tether hook or run sentinel-cli init');
  }
  const presented = envFirst('SENTINEL_HOST_TOKEN', 'TETHER_HOST_TOKEN', 'BEACON_HOST_TOKEN');
  if (!presented || presented !== expected) {
    throw new Error(`--${hook ? 'hook' : 'operator'} requires trusted host caller`);
  }
  return { ok: true, authority: hook ? 'hook' : 'operator' };
}

function projectStoreKey(projectRoot) {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

function resolveDefaultStoreRoot(projectRoot) {
  const override = envFirst('SENTINEL_STORE_ROOT', 'TETHER_STORE_ROOT', 'BEACON_STORE_ROOT');
  if (override) return path.resolve(override);
  const resolvedProject = path.resolve(projectRoot);
  const legacy = path.join(resolvedProject, '.tether');
  const legacyBeacon = path.join(resolvedProject, '.beacon');
  const hostStore = path.join(resolveHostDataDir(), 'stores', projectStoreKey(resolvedProject));
  const legacyEvents = path.join(legacy, 'events.jsonl');
  const legacyBeaconEvents = path.join(legacyBeacon, 'events.jsonl');
  const hostEvents = path.join(hostStore, 'events.jsonl');
  if (fs.existsSync(legacyEvents) && !fs.existsSync(hostEvents)) return legacy;
  if (fs.existsSync(legacyBeaconEvents) && !fs.existsSync(hostEvents)) return legacyBeacon;
  return hostStore;
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
};
