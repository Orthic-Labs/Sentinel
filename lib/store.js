'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The store deliberately uses only Node built-ins. A reflection ledger should remain usable
// from npx, hooks, CI, and older Node installations without a native database dependency.
function createStore(root = path.resolve(process.cwd(), '.reflect')) {
  const storeRoot = path.resolve(root);
  const objectRoot = path.join(storeRoot, 'objects', 'sha256');
  const eventPath = path.join(storeRoot, 'events.jsonl');
  fs.mkdirSync(objectRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(storeRoot, 0o700);
  fs.chmodSync(path.join(storeRoot, 'objects'), 0o700);

  const records = new Map();
  loadEvents();

  return {
    root: storeRoot,
    append(table, value) {
      if (typeof table !== 'string' || !/^[a-z][a-z0-9_]*$/.test(table)) {
        throw new Error('Store table names must be lowercase identifiers');
      }
      const row = { ...value, id: value.id ?? crypto.randomUUID(), table, stored_at: new Date().toISOString() };
      const line = `${JSON.stringify(row)}\n`;
      fs.appendFileSync(eventPath, line, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(eventPath, 0o600);
      index(row);
      return row;
    },
    get(table, id) {
      return records.get(table)?.get(id) ?? null;
    },
    list(table) {
      return [...(records.get(table)?.values() ?? [])];
    },
    latest(table, predicate = () => true) {
      const rows = this.list(table).filter(predicate);
      return rows.at(-1) ?? null;
    },
    putObject(value) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      const relative = path.join('objects', 'sha256', hash.slice(0, 2), hash.slice(2));
      const target = path.join(storeRoot, relative);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, bytes, { mode: 0o600 });
        fs.renameSync(temporary, target);
        fs.chmodSync(target, 0o600);
      }
      return { hash: `sha256:${hash}`, payload_ref: relative, bytes: bytes.length };
    },
    readObject(reference) {
      if (typeof reference !== 'string' || !reference.startsWith('sha256:')) return null;
      const hash = reference.slice('sha256:'.length);
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const file = path.join(objectRoot, hash.slice(0, 2), hash.slice(2));
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
    snapshot() {
      return Object.fromEntries([...records].map(([table, values]) => [table, [...values.values()]]));
    },
    purge(predicate) {
      const kept = [];
      for (const rows of records.values()) {
        for (const row of rows.values()) if (!predicate(row)) kept.push(row);
      }
      const temporary = `${eventPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, kept.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
      fs.renameSync(temporary, eventPath);
      records.clear();
      for (const row of kept) index(row);
    },
  };

  function loadEvents() {
    if (!fs.existsSync(eventPath)) return;
    for (const line of fs.readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { index(JSON.parse(line)); } catch { /* Ignore a torn final line; valid events remain usable. */ }
    }
  }

  function index(row) {
    if (!row.table || !row.id) return;
    if (!records.has(row.table)) records.set(row.table, new Map());
    records.get(row.table).set(row.id, row);
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

module.exports = { createStore, hashValue };
