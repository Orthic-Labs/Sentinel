'use strict';

const fs = require('node:fs');

const MAX_RECORD_BYTES = 256 * 1024;

function appendObservableEvent(event) {
  const target = process.env.MEMRIGHT_TELEMETRY_INGRESS;
  if (!target) return { status: 'unavailable', reason: 'telemetry_ingress_unconfigured' };
  const record = Buffer.from(`${JSON.stringify({ observable_events: [event] })}\n`, 'utf8');
  if (record.length > MAX_RECORD_BYTES) return { status: 'unavailable', reason: 'telemetry_record_too_large' };
  try {
    const fd = fs.openSync(target, 'a', 0o600);
    try {
      fs.writeSync(fd, record);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { status: 'persisted', target: 'membrane_prompt_ingress' };
  } catch {
    return { status: 'unavailable', reason: 'telemetry_ingress_unavailable' };
  }
}

module.exports = { appendObservableEvent };
