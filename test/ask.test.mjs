import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, seedTask, waitFor } from './helpers.mjs';

const { parseAsk } = await import('../ask.js');

test('simple ask with two options', () => {
  const r = parseAsk('Some intro text.\nASK: Which store should back the limiter? | redis | in-memory');
  assert.ok(r);
  assert.equal(r.question, 'Which store should back the limiter?');
  assert.deepEqual(r.options, ['redis', 'in-memory']);
});

test('no options — question alone', () => {
  const r = parseAsk('Done with the analysis.\nASK: Should I also update the changelog?');
  assert.ok(r);
  assert.equal(r.question, 'Should I also update the changelog?');
  assert.deepEqual(r.options, []);
});

test('first ASK wins when two line-anchored ASKs exist', () => {
  const text = 'ASK: first question? | a\nASK: second question? | b';
  const r = parseAsk(text);
  assert.ok(r);
  assert.equal(r.question, 'first question?');
});

test('mid-prose ASK (not line-start) returns null', () => {
  const text = 'Earlier I considered saying ASK: fake | x but did not.';
  assert.equal(parseAsk(text), null);
});

test('lowercase ask: returns null', () => {
  assert.equal(parseAsk('ask: lowercase | a'), null);
});

test('more than 4 options keeps first 4', () => {
  const r = parseAsk('ASK: pick? | a | b | c | d | e | f');
  assert.ok(r);
  assert.deepEqual(r.options, ['a', 'b', 'c', 'd']);
});

test('empty question returns null', () => {
  assert.equal(parseAsk('ASK: | a | b'), null);
});

test('leading whitespace before ASK on its own line is accepted', () => {
  const r = parseAsk('intro\n   ASK: spaced? | yes');
  assert.ok(r);
  assert.equal(r.question, 'spaced?');
  assert.deepEqual(r.options, ['yes']);
});

test('CRLF line endings tolerated', () => {
  const r = parseAsk('intro\r\nASK: crlf? | one | two\r\n');
  assert.ok(r);
  assert.equal(r.question, 'crlf?');
  assert.deepEqual(r.options, ['one', 'two']);
});

test('non-string input returns null', () => {
  assert.equal(parseAsk(null), null);
  assert.equal(parseAsk(undefined), null);
  assert.equal(parseAsk(''), null);
});

test('harness smoke: dispatch → fake claude → result captured', async () => {
  const s = await startServer();
  try {
    s.setScenario([[
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working…' } ] } },
      { type: 'result', session_id: 'sess-test-0001', is_error: false, total_cost_usd: 0.01, duration_ms: 500, result: 'thinking\nASK: red or blue? | red | blue' },
    ]]);
    await fetch(`http://127.0.0.1:${s.port}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'tony-stark', task: 'pick a color' }),
    });
    const t = await waitFor(async () => {
      const st = await s.readState();
      const task = st.tasks.find(x => x.agent === 'tony-stark');
      return task && ['done', 'failed', 'cancelled', 'waiting'].includes(task.status) ? task : null;
    }, { what: 'task to finish' });
    assert.equal(t.status, 'waiting'); // Task 2 shipped the conversion
    assert.equal(t.result, 'thinking\nASK: red or blue? | red | blue');
    assert.equal(t.sessionId, 'sess-test-0001');
  } finally {
    await s.stop();
  }
});
