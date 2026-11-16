'use strict';
/*
 * helpers.mjs — isolated-server test harness for the orchestrator.
 *
 * Every test runs its own copy of the server on a random port with
 * ORCH_DIR pointed at a temp dir and a fake `claude` first on PATH —
 * the live board (7171) is never touched.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_CLAUDE_SRC = path.join(REPO, 'test', 'fake-claude.mjs');
const SESSION_ID = 'sess-test-0001';
// Task ids must match the server's route regex (t-<hex>), so seeds use hex too.
const TASK_ID = 't-7e57fed1';

let portCounter = 7500 + Math.floor(Math.random() * 400);

function freePort() { return portCounter++; }

function healthOk(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 400 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function startServer({ reuse = null, seed = null, env = {} } = {}) {
  // Guard: never test the live board by accident. ORCH_TEST_ALLOW_7171=1
  // opts out for machines where the real board always runs — the guard's
  // point is catching *accidental* 7171 contact, not forbidding coexistence.
  if (!process.env.ORCH_TEST_ALLOW_7171 && await healthOk(7171)) {
    throw new Error('refusing to run tests against the live board on 7171 — helpers always isolate');
  }

  // reuse: a previous session object — restart on the SAME tmpDir/state
  // (orchestrator boots and crashes; state.json must survive).
  const tmpDir = reuse ? reuse.tmpDir : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  const orchDir = path.join(tmpDir, 'orch');
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(orchDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Copy the server + parser + public assets into isolation.
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(tmpDir, 'server.js'));
  fs.copyFileSync(path.join(REPO, 'ask.js'), path.join(tmpDir, 'ask.js'));
  fs.cpSync(path.join(REPO, 'public'), path.join(tmpDir, 'public'), { recursive: true });
  if (!reuse) {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      boardName: 'test-board',
      agents: ['tony-stark', 'dr-strange', 'vision', 'hawkeye', 'spiderman'].map((name, i) => ({
        name, color: ['--dev', '--plan', '--arch', '--qa', '--doc'][i], defModel: 'test-model',
      })),
    }, null, 1));
  }

  // Install the fake claude.
  const fakeBin = path.join(binDir, 'claude');
  fs.copyFileSync(FAKE_CLAUDE_SRC, fakeBin);
  fs.chmodSync(fakeBin, 0o755);

  const argsLogFile = path.join(tmpDir, 'fake-claude-args.log');
  if (!reuse) fs.writeFileSync(argsLogFile, '');
  const scenFile = path.join(tmpDir, 'fake-claude-scenarios.json');
  if (!reuse) fs.writeFileSync(scenFile, '[]');

  // Seed state.json AFTER any previous server is stopped and BEFORE this one
  // boots — a running server's flushState() on SIGTERM would clobber a
  // pre-existing file with its own in-memory (empty) state.
  if (seed) {
    seedTask(path.join(tmpDir, 'state.json'), seed);
  }

  const port = freePort();
  const child = spawn(process.execPath, [path.join(tmpDir, 'server.js')], {
    cwd: tmpDir,
    env: {
      ...process.env,
      ORCH_PORT: String(port),
      ORCH_DIR: orchDir,
      ORCH_CONCURRENCY: env.ORCH_CONCURRENCY || process.env.ORCH_CONCURRENCY || '3',
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_SCENARIOS: scenFile,
      FAKE_ARGS_LOG: argsLogFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverLog = '';
  child.stderr.on('data', (c) => { serverLog += c.toString(); });

  for (let i = 0; i < 25; i++) {
    if (await healthOk(port)) {
      return {
        port, tmpDir, orchDir, stateFile: path.join(tmpDir, 'state.json'),
        child, argsLogFile, scenFile,
        serverLog: () => serverLog,
        setScenario(invocations) {
          fs.writeFileSync(scenFile, JSON.stringify(invocations));
        },
        argsLog() {
          return fs.readFileSync(argsLogFile, 'utf8').split('\n').filter(Boolean)
            .map(l => JSON.parse(l));
        },
        async readState() {
          const res = await fetch(`http://127.0.0.1:${port}/api/state`);
          return res.json();
        },
        async stop() {
          if (child.exitCode !== null) return;
          child.kill('SIGTERM');
          await new Promise((resolve) => {
            const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 2000);
            child.on('close', () => { clearTimeout(t); resolve(); });
          });
        },
      };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server did not come up on ${port} — log:\n${serverLog}`);
}

// One task shaped exactly like queueTask() produces. Merge overrides.
export function seedTask(stateFile, overrides = {}) {
  const t = {
    id: TASK_ID,
    agent: 'tony-stark',
    repo: '',
    task: 'test task text',
    model: 'test-model',
    autoApprove: true,
    status: 'waiting',
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    finishedAt: null,
    activity: [],
    result: null,
    error: null,
    costUsd: null,
    durationMs: null,
    isError: false,
    parentId: null,
    followTo: null,
    retryOf: null,
    contextFile: null,
    sessionId: SESSION_ID,
    resumeSessionId: null,
    git: null,
    priority: 0,
    ask: null,
    qa: [],
    ...overrides,
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [t] }, null, 1));
  return t;
}

// Create a transcript file where sessionTranscriptExists() looks for it.
export function plantTranscript(sessionId, cwd) {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* keep as-is */ }
  const munged = real.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', munged);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, '{"type":"user","message":{"role":"user","content":"seed"}}\n');
  return () => { try { fs.unlinkSync(file); } catch { /* gone */ } };
}

export { SESSION_ID, TASK_ID };

// Poll until fn() returns truthy (or timeout) and return its value.
export async function waitFor(fn, { timeout = 8000, step = 150, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, step));
  }
}
