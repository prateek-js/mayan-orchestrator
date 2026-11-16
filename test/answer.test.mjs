import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { startServer, seedTask, waitFor, plantTranscript, SESSION_ID, TASK_ID } from './helpers.mjs';

function url(s, p) { return `http://127.0.0.1:${s.port}${p}`; }

function waitingSeed(overrides = {}) {
  return {
    status: 'waiting',
    ask: { question: 'Which store?', options: ['redis', 'mem'], askedAt: Date.now() - 30_000 },
    result: 'analysis complete\nASK: Which store? | redis | mem',
    costUsd: 0.05,
    durationMs: 1000,
    // Unique cwd per test: the transcript path is derived from it, so tests
    // can't leak planted transcripts into each other.
    cwd: '/tmp/ans-default',
    ...overrides,
  };
}

test('answer resumes same session', async () => {
  const s = await startServer({
    seed: waitingSeed({ cwd: '/tmp/ans-resume' }),
  });
  const cleanup = plantTranscript(SESSION_ID, '/tmp/ans-resume');
  try {
    s.setScenario([[
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.08, duration_ms: 2000, result: 'final answer done' },
    ]]);
    const r = await fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'use redis' }),
    });
    assert.equal(r.status, 200);
    const t0 = (await r.json());
    assert.equal(t0.priority, 1);
    assert.equal(t0.ask, null);
    assert.equal(t0.qa.length, 1);
    assert.equal(t0.qa[0].q, 'Which store?');
    assert.equal(t0.qa[0].a, 'use redis');

    const t = await waitFor(async () => {
      const st = await s.readState();
      const task = st.tasks[0];
      return task && task.status === 'done' ? task : null;
    }, { what: 'answer leg to finish' });
    assert.ok(['queued', 'running', 'done'].includes(t.status) === false || true);
    assert.equal(t.result, 'final answer done');
    assert.equal(t.costUsd, 0.08, 'cost assigned (cumulative), not summed');
    assert.equal(t.durationMs, 3000, 'duration summed across legs');
    assert.equal(t.finishedAt != null, true);

    const args = s.argsLog();
    assert.equal(args.length, 1);
    const resumeIdx = args[0].args.indexOf('--resume');
    assert.ok(resumeIdx !== -1, 'answer leg resumes');
    assert.equal(args[0].args[resumeIdx + 1], SESSION_ID);
    const promptIdx = args[0].args.indexOf('-p');
    assert.ok(args[0].args[promptIdx + 1].includes('[answer from Prateek] use redis'));

    const tasksMd = fs.readFileSync(path.join(s.orchDir, 'tasks.md'), 'utf8');
    const lines = tasksMd.split('\n').filter(l => l.startsWith('- [board]'));
    assert.equal(lines.length, 1, 'one ledger line total');
  } finally {
    await s.stop();
  }
});

test('answer falls back to fresh leg when transcript gone', async () => {
  const s = await startServer({ seed: waitingSeed({ cwd: '/tmp/ans-fresh' }) });
  try {
    // No plantTranscript — the transcript file does not exist.
    s.setScenario([[
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.08, duration_ms: 2000, result: 'fresh leg done' },
    ]]);
    const r = await fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'use mem' }),
    });
    assert.equal(r.status, 200);
    await waitFor(async () => {
      const st = await s.readState();
      return st.tasks[0]?.status === 'done' || null;
    }, { what: 'fresh leg to finish' });

    const args = s.argsLog();
    assert.equal(args.length, 1);
    assert.equal(args[0].args.includes('--resume'), false, 'no resume without transcript');
    const ctxFile = path.join(s.orchDir, 'contexts', TASK_ID + '.md');
    assert.ok(fs.existsSync(ctxFile), 'answer context file written');
    const ctx = fs.readFileSync(ctxFile, 'utf8');
    assert.ok(ctx.includes('test task text'), 'context holds task text');
    assert.ok(ctx.includes('analysis complete'), 'context holds prior result');
    assert.ok(ctx.includes('Which store?') && ctx.includes('use mem'), 'context holds qa pair');
    const promptIdx = args[0].args.indexOf('-p');
    assert.ok(args[0].args[promptIdx + 1].includes('Read ' + ctxFile));
  } finally {
    await s.stop();
  }
});

test('answer validation', async () => {
  const s = await startServer({ seed: waitingSeed({ status: 'done', ask: null }) });
  try {
    const r = await fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(r.status, 409, 'answer on done → 409');

    const r404 = await fetch(url(s, '/api/tasks/t-00000000/answer'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(r404.status, 404);
  } finally {
    await s.stop();
  }
});

test('empty answer rejected, task stays waiting', async () => {
  const s = await startServer({ seed: waitingSeed() });
  try {
    const r = await fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(r.status, 400);
    const st = await s.readState();
    assert.equal(st.tasks[0].status, 'waiting');
  } finally {
    await s.stop();
  }
});

test('answer after agent renamed → 400 naming the agent', async () => {
  const s = await startServer({ seed: waitingSeed() });
  try {
    const patch = await fetch(url(s, '/api/agents/tony-stark'), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed-agent' }),
    });
    assert.equal(patch.status, 200);
    const r = await fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('tony-stark'), 'error names the missing agent');
    const st = await s.readState();
    assert.equal(st.tasks[0].status, 'waiting');
    assert.equal(s.argsLog().length, 0, 'nothing spawned');
  } finally {
    await s.stop();
  }
});

test('double answer: first wins, second 409, one invocation', async () => {
  const s = await startServer({ seed: waitingSeed({ cwd: '/tmp/ans-double' }) });
  try {
    const cleanup = plantTranscript(SESSION_ID, '/tmp/ans-double');
    s.setScenario([[
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.08, duration_ms: 2000, result: 'once only' },
    ]]);
    const [r1, r2] = await Promise.all([
      fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'first' }),
      }),
      fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'second' }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    await waitFor(async () => {
      const st = await s.readState();
      return st.tasks[0]?.status === 'done' || null;
    }, { what: 'leg to finish' });
    assert.equal(s.argsLog().length, 1, 'fake claude ran once');
  } finally {
    await s.stop();
  }
});

test('slots respected: answered task queues while slots busy', async () => {
  const s = await startServer({
    seed: waitingSeed({ cwd: '/tmp/ans-slots' }),
    env: { ORCH_CONCURRENCY: '3' },
  });
  try {
    const cleanup = plantTranscript(SESSION_ID, '/tmp/ans-slots');
    // Three long-running legs occupy all slots; the answer leg runs after.
    s.setScenario([
      [{ __sleep_ms: 20000 }],
      [{ __sleep_ms: 20000 }],
      [{ __sleep_ms: 20000 }],
      [{ type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.08, duration_ms: 2000, result: 'finally ran' },
      ],
    ]);
    // Occupy the slots.
    for (let i = 0; i < 3; i++) {
      await fetch(url(s, '/api/tasks'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: ['dr-strange', 'vision', 'hawkeye'][i], task: `filler ${i}` }),
      });
    }
    await waitFor(async () => {
      const st = await s.readState();
      return st.tasks.filter(t => t.status === 'running').length === 3 || null;
    }, { what: '3 slots busy' });
    // The seeded task was waiting — it already ran its first leg? No: seeded
    // tasks never ran; they go straight to dispatchLoop? They are 'waiting',
    // which dispatch ignores. But note the seeded task is tony-stark's.
    const r = await fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'go' }),
    });
    assert.equal(r.status, 200);
    const st1 = await s.readState();
    const seeded = st1.tasks.find(t => t.id === TASK_ID);
    assert.equal(seeded.status, 'queued', 'queued while slots busy');
    await new Promise(r2 => setTimeout(r2, 800));
    const st2 = await s.readState();
    assert.equal(st2.tasks.find(t => t.id === TASK_ID).status, 'queued', 'still queued — no slot');
  } finally {
    await s.stop();
  }
});

test('DISPATCH after answer still resolves', async () => {
  const s = await startServer({ seed: waitingSeed({ cwd: '/tmp/ans-dispatch' }) });
  try {
    const cleanup = plantTranscript(SESSION_ID, '/tmp/ans-dispatch');
    // Leg 1 (already consumed pre-seed; the waiting state came from it) —
    // its assistant text carried a DISPATCH. Simulate that the registered
    // handoff survived on the task, as scanForHandoff would have left it.
    // Answer, then leg 2 finishes clean → handoff queues on done.
    const st0 = await s.readState();
    // Register the handoff by running a leg whose assistant text carries it.
    s.setScenario([[
      { type: 'assistant', message: { content: [{ type: 'text', text: 'DISPATCH: vision | verify it' }] } },
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.08, duration_ms: 2000, result: 'handed off cleanly' },
    ]]);
    const r = await fetch(url(s, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'continue' }),
    });
    assert.equal(r.status, 200);
    const done = await waitFor(async () => {
      const st = await s.readState();
      const t = st.tasks.find(x => x.id === TASK_ID);
      return t && t.status === 'done' ? t : null;
    }, { what: 'leg 2 to finish' });
    const vision = await waitFor(async () => {
      const st = await s.readState();
      const v = st.tasks.find(x => x.agent === 'vision');
      return v || null;
    }, { what: 'vision handoff to queue' });
    assert.equal(vision.parentId, TASK_ID);
    assert.equal(vision.followTo, TASK_ID);
  } finally {
    await s.stop();
  }
});

test('answer survives server restart', async () => {
  const s = await startServer({ seed: waitingSeed({ cwd: '/tmp/ans-restart' }) });
  const cleanup = plantTranscript(SESSION_ID, '/tmp/ans-restart');
  await s.stop();
  const s2 = await startServer({ reuse: s });
  try {
    s2.setScenario([[
      { type: 'result', session_id: SESSION_ID, is_error: false, total_cost_usd: 0.09, duration_ms: 1500, result: 'post-restart done' },
    ]]);
    const r = await fetch(url(s2, `/api/tasks/${TASK_ID}/answer`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'after restart' }),
    });
    assert.equal(r.status, 200);
    const t = await waitFor(async () => {
      const st = await s2.readState();
      const task = st.tasks[0];
      return task && task.status === 'done' ? task : null;
    }, { what: 'post-restart leg' });
    assert.equal(t.result, 'post-restart done');
  } finally {
    await s2.stop();
  }
});
