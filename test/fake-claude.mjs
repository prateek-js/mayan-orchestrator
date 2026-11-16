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
try {
  const all = JSON.parse(fs.readFileSync(scenFile, 'utf8'));
  events = Array.isArray(all) && Array.isArray(all[0]) ? all.shift() : [];
  fs.writeFileSync(scenFile, JSON.stringify(all));
} catch (e) { /* no scenarios left — emit nothing, exit 0 */ }

const out = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
if (out) process.stdout.write(out);
process.exit(0);
