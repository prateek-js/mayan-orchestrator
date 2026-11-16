import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { startServer, seedTask, waitFor, SESSION_ID } from './helpers.mjs';

const BASE = `http://127.0.0.1:PORT`;

function url(s, p) { return `http://127.0.0.1:${s.port}${p}`; }

const RESULT_WITH_ASK = 'analysis complete\nASK: Which store? | redis | mem';

test('clean close with ASK result → waiting', async () => {
  const s = await startServer();
  try {
    s.setScenario([[
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.02, duration_ms: 800, result: RESULT_WITH_ASK },
    ]]);
    await fetch(url(s, '/api/tasks'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'tony-stark', task: 'pick the store' }),
    });
    const t = await waitFor(async () => {
      const st = await s.readState();
      const task = st.tasks[0];
      return task && task.status === 'waiting' ? task : null;
    }, { what: 'task to reach waiting' });
    assert.equal(t.ask.question, 'Which store?');
    assert.deepEqual(t.ask.options, ['redis', 'mem']);
    assert.deepEqual(t.qa, []);
    assert.equal(t.finishedAt, null);
    assert.equal(t.git, null);
    const tasksMd = path.join(s.orchDir, 'tasks.md');
    assert.equal(fs.existsSync(tasksMd), false, 'waiting must not write the ledger');
  } finally {
    await s.stop();
  }
});

test('mid-prose ASK ignored', async () => {
  const s = await startServer();
  try {
    s.setScenario([[
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.01, duration_ms: 500, result: 'We could do A. Earlier I wrote: ASK: fake | x' },
    ]]);
    await fetch(url(s, '/api/tasks'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'tony-stark', task: 'prose task' }),
    });
    const t = await waitFor(async () => {
      const st = await s.readState();
      const task = st.tasks[0];
      return task && task.status === 'done' ? task : null;
    }, { what: 'task to finish done' });
    assert.equal(t.ask, null);
  } finally {
    await s.stop();
  }
});

test('waiting survives restart', async () => {
  const s = await startServer();
  try {
    s.setScenario([[
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.01, duration_ms: 500, result: RESULT_WITH_ASK },
    ]]);
    await fetch(url(s, '/api/tasks'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'tony-stark', task: 'pick the store' }),
    });
    await waitFor(async () => {
      const st = await s.readState();
      return st.tasks[0]?.status === 'waiting' || null;
    }, { what: 'waiting' });
    await s.stop();

    // New server, same tmpDir/state (fresh orchestrator boot on the same files).
    const s2 = await startServer({ reuse: s });
    try {
      const st = await s2.readState();
      assert.equal(st.tasks[0].status, 'waiting');
    } finally {
      await s2.stop();
    }
  } catch (e) {
    await s.stop();
    throw e;
  }
});

test('waiting preserved by prune + clear-finished', async () => {
  const s = await startServer();
  await s.stop();
  const old = 8 * 24 * 60 * 60 * 1000;
  // Two tasks written directly into state.json while no server runs: an old
  // waiting task (must survive boot prune) and an old done one (must prune).
  const t = seedTask(s.stateFile, {
    status: 'waiting',
    createdAt: Date.now() - old,
    ask: { question: 'old question?', options: [], askedAt: Date.now() - old },
    finishedAt: null,
  });
  const raw = JSON.parse(fs.readFileSync(s.stateFile, 'utf8'));
  raw.tasks.push({ ...t, id: 't-01d1fed1', status: 'done', finishedAt: Date.now() - old, ask: null });
  fs.writeFileSync(s.stateFile, JSON.stringify(raw, null, 1));
  // Reboot on the same state: boot-time prune must keep the waiting task
  // while an equally old done task falls out.
  const s2 = await startServer({ reuse: s });
  try {
    try {
      let st = await s2.readState();
      const waiting = st.tasks.find(t => t.status === 'waiting');
      assert.ok(waiting, 'waiting task survives boot prune');
      const done8d = st.tasks.find(t => t.status === 'done' && t.finishedAt < Date.now() - old);
      assert.equal(done8d, undefined, 'old done task pruned at boot');

      const del = await fetch(url(s2, '/api/tasks/finished'), { method: 'DELETE' });
      assert.ok(del.ok);
      st = await s2.readState();
      assert.ok(st.tasks.find(t => t.status === 'waiting'), 'waiting survives clear-finished');
    } finally {
      await s2.stop();
    }
  } finally {
    await s.stop();
  }
});

test('waiting not busy — agent editable while a question waits', async () => {
  const s2 = await startServer({
    seed: { status: 'waiting', ask: { question: 'q?', options: [], askedAt: Date.now() } },
  });
  try {
    const r = await fetch(url(s2, '/api/agents/tony-stark'), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '--plan' }),
    });
    assert.equal(r.status, 200);
  } finally {
    await s2.stop();
  }
});

test('cancel from waiting works', async () => {
  const s2 = await startServer({
    seed: { status: 'waiting', ask: { question: 'q?', options: [], askedAt: Date.now() } },
  });
  try {
    const r = await fetch(url(s2, '/api/tasks/t-7e57fed1/cancel'), { method: 'POST' });
    assert.equal(r.status, 200);
    const st = await s2.readState();
    const t = st.tasks.find(x => x.id === 't-7e57fed1');
    assert.equal(t.status, 'cancelled');
    assert.ok(t.finishedAt, 'cancelled task gets finishedAt');
    const tasksMd = fs.readFileSync(path.join(s2.orchDir, 'tasks.md'), 'utf8');
    assert.match(tasksMd, /test task text/);
  } finally {
    await s2.stop();
  }
});

test('retry and followTo rejected on waiting', async () => {
  const s2 = await startServer({
    seed: { status: 'waiting', ask: { question: 'q?', options: [], askedAt: Date.now() } },
  });
  try {
    const retry = await fetch(url(s2, '/api/tasks/t-7e57fed1/retry'), { method: 'POST' });
    assert.equal(retry.status, 409);
    const follow = await fetch(url(s2, '/api/tasks'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'vision', task: 'sneaky follow-up', followTo: 't-7e57fed1' }),
    });
    assert.equal(follow.status, 409);
  } finally {
    await s2.stop();
  }
});

test('handoff + ask same message: waiting now, handoff queued only on done', async () => {
  const s = await startServer();
  try {
    s.setScenario([[
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Dispatching follow work.\nDISPATCH: vision | do X' }] } },
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.01, duration_ms: 500, result: 'Registered the handoff.\nASK: proceed? | yes | no' },
    ]]);
    await fetch(url(s, '/api/tasks'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'tony-stark', task: 'chain test' }),
    });
    const t = await waitFor(async () => {
      const st = await s.readState();
      const task = st.tasks.find(x => x.agent === 'tony-stark');
      return task && task.status === 'waiting' ? task : null;
    }, { what: 'waiting' });
    assert.ok(t.activity.some(a => a.text.includes('handoff registered')));
    const st = await s.readState();
    assert.equal(st.tasks.filter(x => x.agent === 'vision').length, 0, 'no vision task while waiting');
  } finally {
    await s.stop();
  }
});

test('new agent stub teaches the ASK protocol', async () => {
  const s = await startServer();
  try {
    const r = await fetch(url(s, '/api/agents'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'temp-ask-probe', defModel: 'test-model', description: 'temporary' }),
    });
    assert.equal(r.status, 201);
    const md = fs.readFileSync(path.join(s.agentsDir, 'temp-ask-probe.md'), 'utf8');
    assert.ok(md.includes('ASK:'), 'stub definition carries the ASK protocol');
    const del = await fetch(url(s, '/api/agents/temp-ask-probe'), { method: 'DELETE' });
    assert.equal(del.status, 200);
  } finally {
    await s.stop();
  }
});
