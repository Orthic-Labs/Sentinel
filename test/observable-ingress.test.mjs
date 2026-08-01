import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendObservableEvent } from '../hooks/observable-ingress.js';

test('observable ingress fsyncs one Membrane-owned content-free record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-ingress-'));
  const target = path.join(directory, 'events.jsonl');
  const previous = process.env.MEMRIGHT_TELEMETRY_INGRESS;
  process.env.MEMRIGHT_TELEMETRY_INGRESS = target;
  try {
    assert.deepEqual(appendObservableEvent({ schema: 'orthic.observable-event.v1', event_id: 'e1' }), { status: 'persisted', target: 'membrane_prompt_ingress' });
    const record = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(record.observable_events[0], { schema: 'orthic.observable-event.v1', event_id: 'e1' });
  } finally {
    if (previous === undefined) delete process.env.MEMRIGHT_TELEMETRY_INGRESS;
    else process.env.MEMRIGHT_TELEMETRY_INGRESS = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
