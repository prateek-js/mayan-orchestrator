#!/usr/bin/env node
'use strict';
/*
 * fake-claude — stands in for the real `claude` CLI in tests.
 *
 * Contract (see test/helpers.mjs): each invocation appends
 * {"args":[...],"cwd":"..."} to FAKE_ARGS_LOG, shifts the next scenario
 * (a JSON array of stream-json events) off the FAKE_SCENARIOS file,
 * writes its events to stdout one per line, and exits 0.
 */

import fs from 'fs';

const [scenFile, argsLogFile] = [process.env.FAKE_SCENARIOS, process.env.FAKE_ARGS_LOG];
if (!scenFile || !argsLogFile) {
  console.error('fake-claude: FAKE_SCENARIOS and FAKE_ARGS_LOG must be set');
  process.exit(3);
}

fs.appendFileSync(argsLogFile, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');

let events = [];
let sleepMs = 0;
try {
  const all = JSON.parse(fs.readFileSync(scenFile, 'utf8'));
  events = Array.isArray(all) && Array.isArray(all[0]) ? all.shift() : [];
  fs.writeFileSync(scenFile, JSON.stringify(all));
  // A scenario may open with {__sleep_ms: N} to hold the slot without
  // finishing — the slots-respected test uses this to keep 3 slots busy.
  if (events.length && events[0] && events[0].__sleep_ms) {
    sleepMs = events[0].__sleep_ms;
    events = events.slice(1);
  }
} catch (e) { /* no scenarios left — emit nothing, exit 0 */ }

const out = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
// Synchronous write: process.exit() discards pending async stdout writes, so
// a large result event would be truncated to an unparseable line.
if (out) {
  try { fs.writeSync(1, out); } catch (e) { /* reader gone */ }
}
if (sleepMs) {
  setTimeout(() => process.exit(0), sleepMs);
} else {
  process.exit(0);
}
