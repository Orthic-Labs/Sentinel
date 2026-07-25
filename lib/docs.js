'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const maxFileBytes = 200_000;
const sourceExtensions = new Set(['.md', '.mdx', '.d.ts', '.ts', '.js', '.mjs', '.cjs', '.rs', '.txt']);

function resolveDocs(input = {}, options = {}) {
  const projectRoot = path.resolve(input.path ?? options.projectRoot ?? process.cwd());
  const library = input.library ?? inferLibrary(projectRoot);
  if (!library) throw new Error('docs requires library or a lockfile with one dependency');
  const packageInfo = resolvePackage(projectRoot, library, input.version ?? 'auto');
  if (!packageInfo) throw new Error(`Could not resolve an exact installed version for ${library}; result is unverified`);
  const query = String(input.query ?? '').trim();
  if (!query || query.length > 2_000) throw new Error('docs query must be 1-2000 characters');
  const files = candidateFiles(packageInfo.root);
  const terms = query.toLowerCase().split(/[^a-z0-9_.$-]+/).filter((term) => term.length > 1);
  const items = [];
  for (const file of files) {
    const text = redact(fs.readFileSync(file, 'utf8'));
    const score = lexicalScore(text, terms);
    if (score === 0) continue;
    const excerpt = excerptFor(text, terms);
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    items.push({
      package: library, version: packageInfo.version, source: 'installed_source', locator: path.relative(projectRoot, file),
      hash: `sha256:${hash}`, retrieved_at: new Date().toISOString(), trust_class: 'tool', score,
      excerpt: untrustedFrame(excerpt, library, path.relative(projectRoot, file), hash),
      security_labels: injectionLabels(excerpt),
    });
  }
  items.sort((a, b) => b.score - a.score || a.locator.localeCompare(b.locator));
  const pageSize = Math.max(1, Math.min(8, Number.isInteger(input.limit) ? input.limit : 6));
  const page = items.slice(0, pageSize);
  const continuationToken = items.length > pageSize ? Buffer.from(JSON.stringify({ library, version: packageInfo.version, query, offset: pageSize })).toString('base64url') : undefined;
  if (options.store) {
    for (const item of page) {
      const payload = options.store.putObject(item.excerpt);
      options.store.append('evidence', { run_id: input.run_id ?? null, claim_ids: input.claim_ids ?? [], ...item, kind: 'docs', payload_ref: payload.payload_ref, payload_hash: payload.hash });
    }
  }
  return { library, version: packageInfo.version, provider: 'installed_source', items: page, blocksReturned: page.length, blocksTotal: items.length, continuationToken };
}

function resolvePackage(projectRoot, library, requestedVersion) {
  const manifest = readJson(path.join(projectRoot, 'package.json'));
  const lock = readJson(path.join(projectRoot, 'package-lock.json'));
  const packageLockEntry = lock?.packages?.[`node_modules/${library}`];
  const manifestVersion = manifest?.dependencies?.[library] ?? manifest?.devDependencies?.[library];
  const version = requestedVersion !== 'auto' ? requestedVersion : packageLockEntry?.version ?? parsePnpmVersion(projectRoot, library) ?? cleanVersion(manifestVersion);
  const root = safePackagePath(projectRoot, library);
  const packageJson = root ? readJson(path.join(root, 'package.json')) : null;
  if (!root || !packageJson?.version || (requestedVersion !== 'auto' && packageJson.version !== requestedVersion)) return resolveCargo(projectRoot, library, requestedVersion);
  if (version && packageJson.version !== version && requestedVersion === 'auto') return null;
  return { version: packageJson.version, root };
}

function resolveCargo(projectRoot, library, requestedVersion) {
  const lock = fs.existsSync(path.join(projectRoot, 'Cargo.lock')) ? fs.readFileSync(path.join(projectRoot, 'Cargo.lock'), 'utf8') : '';
  const match = new RegExp(`name\\s*=\\s*"${escapeRegExp(library)}"[\\s\\S]{0,300}?version\\s*=\\s*"([^"]+)"`).exec(lock);
  const version = requestedVersion !== 'auto' ? requestedVersion : match?.[1];
  if (!version) return null;
  const cargoHome = process.env.CARGO_HOME ?? path.join(require('node:os').homedir(), '.cargo');
  const roots = [];
  if (fs.existsSync(path.join(cargoHome, 'registry', 'src'))) {
    for (const registry of fs.readdirSync(path.join(cargoHome, 'registry', 'src'))) roots.push(path.join(cargoHome, 'registry', 'src', registry, `${library}-${version}`));
  }
  const root = roots.find((candidate) => fs.existsSync(candidate));
  return root ? { version, root } : null;
}

function safePackagePath(projectRoot, library) {
  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(library)) return null;
  const candidate = path.resolve(projectRoot, 'node_modules', library);
  try {
    const real = fs.realpathSync(candidate);
    const allowed = fs.realpathSync(path.resolve(projectRoot, 'node_modules'));
    return real === allowed || real.startsWith(`${allowed}${path.sep}`) ? real : null;
  } catch { return null; }
}

function candidateFiles(root) {
  const result = [];
  const queue = [root];
  while (queue.length && result.length < 200) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (sourceExtensions.has(path.extname(entry.name)) && fs.statSync(full).size <= maxFileBytes) result.push(full);
    }
  }
  return result;
}

function excerptFor(text, terms) {
  const lines = text.split(/\r?\n/);
  const first = Math.max(0, lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term))));
  return lines.slice(first, first + 8).join('\n').slice(0, 1_200);
}

function lexicalScore(text, terms) {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + (lower.match(new RegExp(escapeRegExp(term), 'g')) ?? []).length, 0);
}

function untrustedFrame(excerpt, library, locator, hash) {
  return `[UNTRUSTED EVIDENCE package=${library} locator=${locator} hash=sha256:${hash}]\n${excerpt}\n[END UNTRUSTED EVIDENCE]`;
}

function injectionLabels(text) {
  return /ignore (all|previous)|system message|developer instruction|reveal (the )?prompt/i.test(text) ? ['prompt_injection_suspected'] : [];
}

function redact(text) {
  return text.replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function inferLibrary(projectRoot) {
  const manifest = readJson(path.join(projectRoot, 'package.json'));
  return Object.keys({ ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) })[0] ?? null;
}

function parsePnpmVersion(projectRoot, library) {
  const lock = path.join(projectRoot, 'pnpm-lock.yaml');
  if (!fs.existsSync(lock)) return null;
  const text = fs.readFileSync(lock, 'utf8');
  const match = new RegExp(`(?:^|\\n)\\s*[/']?${escapeRegExp(library)}@([^:/'\\s]+)`, 'm').exec(text);
  return match?.[1] ?? null;
}

function cleanVersion(value) {
  const match = typeof value === 'string' ? value.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/) : null;
  return match?.[0] ?? null;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { resolveDocs, injectionLabels, redact };
