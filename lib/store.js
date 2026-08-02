'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Tables that must survive crash at write time. */
const DURABLE_TABLES = new Set([
  'runs', 'claims', 'evidence', 'checks', 'decisions',
  'session_bindings', 'task_bindings', 'rubrics', 'memory_candidates',
]);

/** Low-value / high-churn tables may defer fsync (batched). */
const DEFERRED_FSYNC_BATCH = 32;

// The store deliberately uses only Node built-ins. A reflection ledger should remain usable
// from npx, hooks, CI, and older Node installations without a native database dependency.
function createStore(root = path.resolve(process.cwd(), '.sentinel')) {
  const storeRoot = path.resolve(root);
  const objectRoot = path.join(storeRoot, 'objects', 'sha256');
  const eventPath = path.join(storeRoot, 'events.jsonl');
  const lockPath = path.join(storeRoot, '.lock');
  fs.mkdirSync(objectRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(storeRoot, 0o700);
  fs.chmodSync(path.join(storeRoot, 'objects'), 0o700);

  const records = new Map();
  let readOffset = 0;
  let pendingTail = '';
  let deferredSinceFsync = 0;
  let failNextBatch = false;

  loadEvents();

  return {
    root: storeRoot,
    append(table, value, options = {}) {
      if (typeof table !== 'string' || !/^[a-z][a-z0-9_]*$/.test(table)) {
        throw new Error('Store table names must be lowercase identifiers');
      }
      const row = { ...value, id: value.id ?? crypto.randomUUID(), table, stored_at: new Date().toISOString() };
      const durable = options.durable ?? DURABLE_TABLES.has(table);
      withStoreLock(() => {
        loadEvents();
        const line = `${JSON.stringify(row)}\n`;
        const fd = fs.openSync(eventPath, 'a', 0o600);
        try {
          fs.writeSync(fd, line, null, 'utf8');
          if (durable) {
            fs.fsyncSync(fd);
            deferredSinceFsync = 0;
          } else {
            deferredSinceFsync += 1;
            if (deferredSinceFsync >= DEFERRED_FSYNC_BATCH) {
              fs.fsyncSync(fd);
              deferredSinceFsync = 0;
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        fs.chmodSync(eventPath, 0o600);
        // Advance the projection cursor past our own write so we do not reparse it.
        readOffset = fs.statSync(eventPath).size;
        pendingTail = '';
        index(row);
      });
      return row;
    },
    appendBatch(entries) {
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('Store batch requires entries');
      const rows = entries.map(({ table, value }) => {
        if (typeof table !== 'string' || !/^[a-z][a-z0-9_]*$/.test(table)) {
          throw new Error('Store table names must be lowercase identifiers');
        }
        return { ...value, id: value.id ?? crypto.randomUUID(), table, stored_at: new Date().toISOString() };
      });
      withStoreLock(() => {
        loadEvents();
        if (failNextBatch) {
          failNextBatch = false;
          throw new Error('injected batch failure');
        }
        const current = fs.existsSync(eventPath) ? fs.readFileSync(eventPath) : Buffer.alloc(0);
        const added = Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
        const temporary = `${eventPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(temporary, 'w', 0o600);
        try {
          if (current.length) fs.writeSync(fd, current);
          fs.writeSync(fd, added);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, eventPath);
        fs.chmodSync(eventPath, 0o600);
        readOffset = current.length + added.length;
        pendingTail = '';
        deferredSinceFsync = 0;
        for (const row of rows) index(row);
      });
      return rows;
    },
    failNextBatchForTest() {
      failNextBatch = true;
    },
    get(table, id) {
      loadEvents();
      return records.get(table)?.get(id) ?? null;
    },
    list(table) {
      loadEvents();
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
      if (typeof reference !== 'string') return null;
      if (!reference.startsWith('sha256:')) {
        const file = path.resolve(storeRoot, reference);
        if (file !== storeRoot && file.startsWith(`${storeRoot}${path.sep}`) && fs.existsSync(file)) return fs.readFileSync(file);
        return null;
      }
      const hash = reference.slice('sha256:'.length);
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const file = path.join(objectRoot, hash.slice(0, 2), hash.slice(2));
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
    snapshot() {
      loadEvents();
      return Object.fromEntries([...records].map(([table, values]) => [table, [...values.values()]]));
    },
    flush() {
      withStoreLock(() => {
        if (!fs.existsSync(eventPath) || deferredSinceFsync === 0) return;
        const fd = fs.openSync(eventPath, 'r+');
        try {
          fs.fsyncSync(fd);
          deferredSinceFsync = 0;
        } finally {
          fs.closeSync(fd);
        }
      });
    },
    purge(predicate) {
      withStoreLock(() => {
        loadEvents();
        const kept = [];
        for (const rows of records.values()) {
          for (const row of rows.values()) if (!predicate(row)) kept.push(row);
        }
        const temporary = `${eventPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(temporary, 'w', 0o600);
        try {
          fs.writeSync(fd, kept.map((row) => `${JSON.stringify(row)}\n`).join(''), null, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, eventPath);
        records.clear();
        readOffset = 0;
        pendingTail = '';
        deferredSinceFsync = 0;
        for (const row of kept) index(row);
        readOffset = fs.existsSync(eventPath) ? fs.statSync(eventPath).size : 0;
      });
    },
  };

  /** Incremental projection: only parse bytes appended since the last cursor. */
  function loadEvents() {
    if (!fs.existsSync(eventPath)) {
      readOffset = 0;
      pendingTail = '';
      return;
    }
    const size = fs.statSync(eventPath).size;
    if (size < readOffset) {
      // File was rewritten (purge/truncate) — rebuild the in-memory projection.
      records.clear();
      readOffset = 0;
      pendingTail = '';
    }
    if (size === readOffset && !pendingTail) return;

    const fd = fs.openSync(eventPath, 'r');
    try {
      const length = size - readOffset;
      let chunk = pendingTail;
      if (length > 0) {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, readOffset);
        chunk += buf.toString('utf8');
        readOffset = size;
      }
      const lines = chunk.split(/\r?\n/);
      if (chunk.endsWith('\n')) {
        pendingTail = '';
        if (lines.at(-1) === '') lines.pop();
      } else {
        pendingTail = lines.pop() ?? '';
      }
      for (const line of lines) {
        if (!line) continue;
        try { index(JSON.parse(line)); } catch { /* Ignore a torn final line; valid events remain usable. */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  function index(row) {
    if (!row.table || !row.id) return;
    if (!records.has(row.table)) records.set(row.table, new Map());
    const table = records.get(row.table);
    if (table.has(row.id)) table.delete(row.id);
    table.set(row.id, row);
  }

  function withStoreLock(fn) {
    const deadline = Date.now() + 2_000;
    while (true) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || Date.now() > deadline) throw new Error('sentinel store lock unavailable');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

module.exports = { createStore, hashValue, DURABLE_TABLES };
