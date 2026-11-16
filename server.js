#!/usr/bin/env node
'use strict';
/*
 * orchestrator — local dispatch board for Prateek's agent team.
 * Zero dependencies. Serves the UI, queues tasks in state.json, and runs
 * each task through a headless `claude -p --agent <name>` process.
 *
 * The board name and the agent roster live in config.json (seeded on first
 * run) and are editable from the UI's "teams" dialog: renaming an agent also
 * renames its definition in ~/.claude/agents/.
 *
 * Env: ORCH_PORT (7171) · ORCH_CONCURRENCY (3) · ORCH_TIMEOUT_MIN (45) ·
 *      ORCH_IDLE_TIMEOUT_MIN (8) · ORCH_KEEP_DAYS (7)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { parseAsk } = require('./ask');

const PORT = parseInt(process.env.ORCH_PORT || '7171', 10);
const HOST = '127.0.0.1';
const CONCURRENCY = Math.max(1, parseInt(process.env.ORCH_CONCURRENCY || '3', 10));
const TIMEOUT_MS = Math.max(1, parseInt(process.env.ORCH_TIMEOUT_MIN || '45', 10)) * 60 * 1000;
// A task that is still streaming is alive — only silence counts against the
// idle limit, so a busy 45-min run is never killed while a hung one dies fast.
const IDLE_MS = Math.max(2, parseInt(process.env.ORCH_IDLE_TIMEOUT_MIN || '8', 10)) * 60 * 1000;
// Finished tasks fall out of state.json after this long (tasks.md keeps the
// permanent record; contexts/<id>.md files get 14 days).
const KEEP_DAYS = Math.max(1, parseInt(process.env.ORCH_KEEP_DAYS || '7', 10));
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;
const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'state.json');
const CONFIG_FILE = path.join(DIR, 'config.json');
const PID_FILE = path.join(DIR, 'server.pid');
const LOG_FILE = path.join(DIR, 'server.log');
const PUBLIC_DIR = path.join(DIR, 'public');
const ORCH_DIR = process.env.ORCH_DIR || path.join(os.homedir(), '.claude', 'orchestrator');
// Continuity with the setup from 2026-11-02: the markdown log stays the single log.
const TASKS_MD = path.join(ORCH_DIR, 'tasks.md');
// Lossless per-task context: parent task + full results, referenced from the
// prompt by path instead of being truncated into it.
const CONTEXTS_DIR = path.join(ORCH_DIR, 'contexts');
const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
const HOME = os.homedir();

// Same colors the UI has always used for these agents (CSS var names, so the
// seeded roster looks identical to the pre-config board).
const COLOR_VARS = ['--dev', '--plan', '--arch', '--qa', '--doc'];

const DEFAULT_BOARD_NAME = 'orchestrator';
const DEFAULT_AGENTS = [
  { name: 'developer',     color: '--dev',  defModel: 'anthropic.Polaris.Model.Smart.High' },
  { name: 'planner',       color: '--plan', defModel: 'anthropic.Claude.Sonnet' },
  { name: 'architect',     color: '--arch', defModel: 'anthropic.Claude.Sonnet' },
  { name: 'qa',            color: '--qa',   defModel: 'anthropic.Polaris.Model.Smart.High' },
  { name: 'documentation', color: '--doc',  defModel: 'anthropic.Claude.Sonnet' },
];

function loadModels() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
    if (Array.isArray(s.availableModels) && s.availableModels.length) return s.availableModels;
  } catch (e) { /* fall through */ }
  return ['anthropic.Polaris.Model.Smart.High', 'anthropic.Claude.Sonnet', 'anthropic.Claude.Haiku'];
}
const MODELS = loadModels();

// ------------------------------------------------------------- config -----

let config = { boardName: DEFAULT_BOARD_NAME, agents: [] };
let configSaveTimer = null;

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof raw.boardName === 'string') config.boardName = raw.boardName;
    if (Array.isArray(raw.agents)) {
      config.agents = raw.agents
        .filter(a => a && typeof a.name === 'string' && a.name.trim())
        .map(a => ({
          name: a.name.trim(),
          color: typeof a.color === 'string' && COLOR_VARS.includes(a.color) ? a.color : COLOR_VARS[0],
          defModel: typeof a.defModel === 'string' && a.defModel.trim() ? a.defModel.trim() : MODELS[0],
        }));
    }
  } catch (e) {
    if (fs.existsSync(CONFIG_FILE)) {
      try { fs.renameSync(CONFIG_FILE, CONFIG_FILE + '.bak'); } catch (e2) { /* ignore */ }
      log('config.json was invalid — backed up, seeding defaults');
    }
  }
  if (!config.agents.length) {
    config.agents = DEFAULT_AGENTS.map(a => ({ ...a }));
    saveConfigNow();
  }
}

function saveConfigNow() {
  const tmp = CONFIG_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ boardName: config.boardName, agents: config.agents }, null, 1));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    log('config save failed: ' + e.message);
  }
}

function saveConfig() {
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(saveConfigNow, 150);
}

// Agent names double as lane ids, CSS hooks, `claude --agent` names and
// ~/.claude/agents/<name>.md files — keep them strict.
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

function getAgent(name) {
  return config.agents.find(a => a.name === name) || null;
}

// A task that is queued or running pins its agent in place: the runner needs
// the exact name for `claude --agent`, and lanes are keyed by agent name.
// `waiting` intentionally does NOT count — a forgotten question must never
// lock rename/remove forever (the answer leg re-resolves the agent instead).
function agentBusy(name) {
  return state.tasks.some(t => t.agent === name && ['queued', 'running'].includes(t.status));
}

// ------------------------------------------------- agent definitions ------
// Each agent's real definition is ~/.claude/agents/<name>.md; the roster in
// config.json only carries name, color and default model.

function agentMdPath(name) { return path.join(AGENTS_DIR, name + '.md'); }
function agentFileExists(name) {
  try { return fs.statSync(agentMdPath(name)).isFile(); } catch (e) { return false; }
}
function readAgentFile(name) {
  try { return fs.readFileSync(agentMdPath(name), 'utf8'); } catch (e) { return null; }
}
function writeAgentFile(name, md) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(agentMdPath(name), md);
}

// Replace (or insert) the `name:` line in the file's frontmatter so
// `claude --agent <new>` keeps resolving after a rename.
function setAgentFileName(md, newName) {
  const lines = md.split('\n');
  if (lines[0].trim() === '---') {
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      if (/^name:\s*/.test(lines[i])) { lines[i] = `name: ${newName}`; return lines.join('\n'); }
    }
    lines.splice(1, 0, `name: ${newName}`);
    return lines.join('\n');
  }
  return md;
}

function mdDescription(name) {
  const md = readAgentFile(name);
  if (!md) return null;
  const m = md.match(/^description:\s*(.+)\s*$/m);
  return m ? m[1].trim() : null;
}

// Set the description line in the frontmatter (single-line, replacement done
// via function so `$`-patterns in the text stay literal).
function setAgentFileDescription(md, description) {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  if (/^description:\s*.*$/m.test(md)) return md.replace(/^description:\s*.*$/m, () => `description: ${oneLine}`);
  const lines = md.split('\n');
  if (lines[0].trim() === '---') { lines.splice(1, 0, `description: ${oneLine}`); return lines.join('\n'); }
  return md;
}

function stubAgentMd(name, description, model) {
  return [
    '---',
    `name: ${name}`,
    `description: ${(description || `Team agent ${name} on Prateek's orchestrator board.`).replace(/\s+/g, ' ').trim()}`,
    `model: ${model}`,
    '---',
    '',
    `You are the **${name}** agent on Prateek's team. The orchestrator hands you a scoped task with a repo path and any context from earlier tasks.`,
    '',
    '## Job',
    '- Do exactly what the task asks; stay inside the named repo and scope.',
    "- Follow the repo's own conventions (CLAUDE.md, code style, test framework).",
    '- Run the relevant tests/linters and report results honestly (failures included).',
    '',
    '## Report format',
    '1. Files changed and why',
    '2. Test/lint results',
    '3. Open questions',
    '- Do not spawn other agents yourself. If the task needs another agent, end your final message with a handoff line:',
    '  DISPATCH: <agent> | <exactly what they should do>',
    '  (optional third segment: `| model <model>; repo <path>`). The orchestrator board turns this into a real tracked task with your result as its context.',
    '',
  ].join('\n');
}

function nextFreeColor() {
  const used = new Set(config.agents.map(a => a.color));
  return COLOR_VARS.find(c => !used.has(c)) || COLOR_VARS[0];
}

// Live roster names, injected into every prompt so the DISPATCH protocol
// never drifts when agents are renamed (the "Valid agents:" line inside the
// definition files used to go stale).
function rosterNames() {
  return config.agents.map(a => a.name).join(', ');
}

// --------------------------------------------------- roster mutations -----

function addAgent(spec) {
  const name = String(spec.name || '').trim();
  if (!NAME_RE.test(name)) return { error: 'agent names are lowercase letters, digits and dashes — start with a letter, max 32 chars' };
  if (getAgent(name)) return { error: `an agent named "${name}" already exists` };
  const agent = {
    name,
    color: COLOR_VARS.includes(spec.color) ? spec.color : nextFreeColor(),
    defModel: String(spec.defModel || MODELS[0]).trim() || MODELS[0],
  };
  config.agents.push(agent);
  // Adopt a hand-written definition if one exists; otherwise seed a stub so
  // `claude --agent <name>` works immediately.
  if (!agentFileExists(name)) {
    try {
      writeAgentFile(name, stubAgentMd(name, spec.description, agent.defModel));
    } catch (e) {
      config.agents.pop();
      return { error: 'could not write the agent definition: ' + e.message };
    }
  }
  log(`added agent ${name} (model ${agent.defModel})`);
  return { agent };
}

function patchAgent(oldName, patch) {
  const a = getAgent(oldName);
  if (!a) return { error: `unknown agent "${oldName}"` };

  // Validate everything before mutating anything, so a rejected patch can't
  // leave the roster half-changed.
  const newName = patch.name !== undefined ? String(patch.name).trim() : oldName;
  if (newName !== oldName) {
    if (!NAME_RE.test(newName)) return { error: 'agent names are lowercase letters, digits and dashes — start with a letter, max 32 chars' };
    if (getAgent(newName)) return { error: `an agent named "${newName}" already exists` };
    if (agentBusy(oldName)) return { error: `"${oldName}" has queued or running tasks — cancel or wait for them before renaming` };
  }
  if (patch.color !== undefined && !COLOR_VARS.includes(patch.color)) {
    return { error: `color must be one of: ${COLOR_VARS.join(', ')}` };
  }
  if (patch.defModel !== undefined && !String(patch.defModel).trim()) {
    return { error: 'default model cannot be empty' };
  }

  if (newName !== oldName) {
    if (agentFileExists(oldName)) {
      try {
        writeAgentFile(newName, setAgentFileName(readAgentFile(oldName), newName));
        fs.unlinkSync(agentMdPath(oldName));
      } catch (e) {
        // Roll back a half-done file move so the roster and disk don't diverge.
        try { if (agentFileExists(newName)) fs.unlinkSync(agentMdPath(newName)); } catch (e2) { /* ignore */ }
        return { error: 'rename failed: ' + e.message };
      }
    }
    a.name = newName;
    log(`renamed agent ${oldName} → ${newName}`);
  }

  if (patch.color !== undefined) a.color = patch.color;
  if (patch.defModel !== undefined) a.defModel = String(patch.defModel).trim();
  let warning = null;
  if (patch.description !== undefined && agentFileExists(a.name)) {
    const md = readAgentFile(a.name);
    if (md !== null) {
      try { writeAgentFile(a.name, setAgentFileDescription(md, String(patch.description))); }
      catch (e) {
        // The roster change itself is done — report it, but say what failed.
        log(`description update failed for ${a.name}: ${e.message}`);
        warning = 'saved, but updating the description in the definition file failed: ' + e.message;
      }
    }
  }
  saveConfig();
  return warning ? { agent: a, warning } : { agent: a };
}

function removeAgent(name) {
  const a = getAgent(name);
  if (!a) return { error: `unknown agent "${name}"` };
  if (agentBusy(name)) return { error: `"${name}" has queued or running tasks — cancel or wait for them before removing` };
  if (config.agents.length <= 1) return { error: 'the board needs at least one agent — add another before removing this one' };
  config.agents = config.agents.filter(x => x.name !== name);
  // Only delete the definition file if it really belongs to this agent —
  // never a hand-written file whose frontmatter names something else.
  let fileNote = 'no definition file';
  const md = readAgentFile(name);
  if (md !== null) {
    const m = md.match(/^name:\s*(.+)\s*$/m);
    if (m && m[1].trim() !== name) fileNote = `kept — file frontmatter says "${m[1].trim()}"`;
    else {
      try { fs.unlinkSync(agentMdPath(name)); fileNote = 'deleted'; }
      catch (e) { fileNote = 'delete failed: ' + e.message; }
    }
  }
  saveConfig();
  log(`removed agent ${name} (definition: ${fileNote})`);
  return { removed: name, definition: fileNote };
}

// ---------------------------------------------------------------- state ----

let state = { tasks: [] };
let saveTimer = null;

// Drop finished tasks older than KEEP_DAYS so state.json stops growing
// forever (42 tasks · 748 KB and climbing before this existed). tasks.md is
// the permanent log; context files get their own longer window below.
function pruneOldTasks() {
  const cutoff = Date.now() - KEEP_MS;
  const before = state.tasks.length;
  state.tasks = state.tasks.filter(t =>
    ['queued', 'running', 'waiting'].includes(t.status) || (t.finishedAt || t.createdAt || 0) >= cutoff);
  const removed = before - state.tasks.length;
  if (removed) log(`pruned ${removed} finished task(s) older than ${KEEP_DAYS} days`);
  return removed;
}

function pruneContexts() {
  try {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(CONTEXTS_DIR)) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(CONTEXTS_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) { /* gone */ }
    }
  } catch (e) { /* no dir yet */ }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(raw.tasks)) state.tasks = raw.tasks;
  } catch (e) {
    if (fs.existsSync(STATE_FILE)) {
      try { fs.renameSync(STATE_FILE, STATE_FILE + '.bak'); } catch (e2) { /* ignore */ }
    }
    state.tasks = [];
  }
  // Tasks left "running" by a previous server life did not survive it.
  for (const t of state.tasks) {
    if (t.status === 'running') {
      t.status = 'failed';
      t.finishedAt = Date.now();
      t.error = 'server restarted mid-task';
      addActivity(t, 'sys', 'marked failed — server restarted while this was running');
    }
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      log('state save failed: ' + e.message);
    }
  }, 200);
}

function flushState() {
  clearTimeout(saveTimer);
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { /* best effort on shutdown */ }
}

function newId() { return 't-' + crypto.randomBytes(4).toString('hex'); }

function getTask(id) { return state.tasks.find(t => t.id === id) || null; }

function addActivity(task, kind, text, tool) {
  task.activity.push({ kind, tool: tool || null, text: String(text).slice(0, 500), at: Date.now() });
  if (task.activity.length > 60) task.activity.splice(0, task.activity.length - 60);
}

// ------------------------------------------------------------ SSE hub -----

const sseClients = new Set();
let broadcastTimer = null;

function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = null;
  if (!sseClients.size) return;
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}
function broadcastSoon() {
  if (!broadcastTimer) broadcastTimer = setTimeout(broadcast, 150);
}

function publicState() {
  return {
    now: Date.now(),
    concurrency: CONCURRENCY,
    boardName: config.boardName,
    agents: config.agents.map(a => ({
      ...a,
      busy: agentBusy(a.name),
      description: agentDescription(a.name),
    })),
    colors: COLOR_VARS,
    models: MODELS,
    tasks: state.tasks,
  };
}

// Descriptions come from the definition files; cache by mtime so broadcasts
// don't re-read them, but hand-edits still show up.
const descCache = new Map();
function agentDescription(name) {
  try {
    const st = fs.statSync(agentMdPath(name));
    const hit = descCache.get(name);
    if (hit && hit.mtime === st.mtimeMs) return hit.desc;
    const desc = mdDescription(name);
    descCache.set(name, { mtime: st.mtimeMs, desc });
    return desc;
  } catch (e) { return null; }
}

// ------------------------------------------------------------ dispatch ----

let claudeBin = null;
function findClaude() {
  if (claudeBin) return claudeBin;
  const dirs = (process.env.PATH || '').split(':');
  for (const extra of [path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (!dirs.includes(extra)) dirs.push(extra);
  }
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, 'claude');
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { claudeBin = p; return p; } } catch (e) { /* keep looking */ }
  }
  return null;
}

const running = new Map();   // id -> child process
const cancelling = new Set();

// Priority picks first (user-flagged tasks jump the line), then FIFO.
// Within a lane the global FIFO order is kept so follow-up chains still run
// ahead of unrelated later work.
function dispatchLoop() {
  while (running.size < CONCURRENCY) {
    const queued = state.tasks.filter(t => t.status === 'queued');
    if (!queued.length) break;
    const next = queued
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.createdAt - b.createdAt)[0];
    startTask(next);
  }
}

function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description', 'skill', 'subagent_type', 'repo_path'];
  for (const k of keys) {
    if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim().slice(0, 140);
  }
  try { return JSON.stringify(input).slice(0, 100); } catch (e) { return ''; }
}

function failNow(task, msg) {
  task.status = 'failed';
  task.finishedAt = Date.now();
  task.error = msg;
  addActivity(task, 'sys', msg);
  log(`failed ${task.id}: ${msg}`);
  saveState(); broadcastSoon(); appendTasksMd(task);
}

// Run `git` in a repo without ever throwing; resolves to trimmed stdout or ''.
function gitSnapshot(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10 * 1000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

// What the agent actually did to the repo, attached to the finished card:
// dirty files and the recent commits. Cheap, and turns "done $1.51" into
// "done — 2 modified, 1 new, branch timing-analysis, 3 commits".
async function attachGitSnapshot(task, cwd) {
  const isRepo = await gitSnapshot(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (isRepo !== 'true') return;
  const [status, branch, logLine] = await Promise.all([
    gitSnapshot(cwd, ['status', '--porcelain']),
    gitSnapshot(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitSnapshot(cwd, ['log', '--oneline', '-5']),
  ]);
  const changes = status ? status.split('\n').filter(Boolean).length : 0;
  const parts = [];
  if (branch && branch !== 'HEAD') parts.push(`branch ${branch}`);
  parts.push(changes ? `${changes} uncommitted file${changes === 1 ? '' : 's'}` : 'clean tree');
  if (logLine) parts.push(`last: ${logLine.split('\n')[0].slice(0, 60)}`);
  task.git = parts.join(' · ');
  addActivity(task, 'sys', `git: ${task.git}`);
}

// Plans/decisions/demos the agent wrote to the shared orchestrator dirs are
// invisible to the board — link them on the card so the result is one click
// away. Match by repo slug prefix; the file must have been touched after the
// task started (minus an hour of slack).
function findArtifacts(task, startedAt) {
  const slug = projectName(task.repo);
  if (!slug) return;
  const dirs = [
    ['plan', path.join(ORCH_DIR, 'plans')],
    ['design', path.join(ORCH_DIR, 'decisions')],
    ['demo', path.join(ORCH_DIR, 'demos')],
  ];
  const out = [];
  const cutoff = startedAt - 60 * 60 * 1000;
  for (const [label, dir] of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of entries) {
      if (!f.startsWith(slug) || (!f.endsWith('.html') && !f.endsWith('.md'))) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) continue; } catch (e) { continue; }
      out.push({ label, path: p, file: f });
      if (out.length >= 4) break;
    }
    if (out.length >= 4) break;
  }
  if (out.length) task.artifacts = out;
}

function startTask(task) {
  task.status = 'running';
  task.startedAt = Date.now();
  task.activity = [];
  task.result = null;
  task.error = null;
  task.git = null;
  // Per-leg resets: a stale isError from a previous leg would mislabel this
  // leg's close; a resumed leg clears the live question it is answering.
  task.isError = false;
  task.ask = null;

  const claude = findClaude();
  if (!claude) { failNow(task, 'claude CLI not found in PATH'); return; }
  if (!getAgent(task.agent)) { failNow(task, `agent "${task.agent}" no longer exists on the board`); return; }

  let cwd = HOME;
  if (task.repo) {
    const expanded = task.repo.startsWith('~') ? path.join(HOME, task.repo.slice(1)) : task.repo;
    if (fs.existsSync(expanded)) cwd = expanded;
    else addActivity(task, 'sys', `repo not found: ${task.repo} — running in home instead`);
  }
  task.cwd = cwd;

  // Resume keeps the agent's full memory of a previous run in this repo —
  // only valid when the session transcript still exists on disk. Follow-ups
  // (followTo) resume that session; a retry resumes its own last session.
  let resumeId = null;
  if (task.followTo || task.retryOf) {
    const src = getTask(task.followTo || task.retryOf);
    if (src && src.sessionId && sessionTranscriptExists(src.sessionId, src.cwd)) {
      resumeId = src.sessionId;
      task.resumeSessionId = resumeId;
    } else {
      addActivity(task, 'sys', 'original session transcript not found — running fresh with a context file instead');
    }
  }

  // Fresh runs carry the lossless context file when one was written for them.
  const promptParts = [];
  if (!resumeId && task.contextFile) promptParts.push(`Read ${task.contextFile} first — it has the full task background (parent task and complete result). Then:`);
  if (task.repo) promptParts.push(`Repo: ${task.repo}`);
  promptParts.push(task.task);
  // Roster is injected live so DISPATCH handoffs never reference stale names.
  promptParts.push(`[Board agents: ${rosterNames()} — hand off with a final line "DISPATCH: <agent> | <what to do>"]`);

  const args = [
    ...(resumeId ? ['--resume', resumeId] : []),
    '-p', promptParts.join('\n\n'),
    '--agent', task.agent,
    '--model', task.model,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', task.autoApprove ? 'bypassPermissions' : 'acceptEdits',
  ];

  log(`dispatch ${task.id} agent=${task.agent} model=${task.model} cwd=${cwd}${resumeId ? ` resume=${resumeId.slice(0, 8)}` : ''}`);
  addActivity(task, 'sys', `dispatched to ${task.agent} (${task.model})${task.autoApprove ? ' · tools auto-approved' : ''}${resumeId ? ' · resuming session ' + resumeId.slice(0, 8) : ''}`);

  let child;
  try {
    child = spawn(claude, args, { cwd, env: process.env, detached: true });
  } catch (e) { failNow(task, 'spawn failed: ' + e.message); return; }

  running.set(task.id, child);

  const killTree = (sig) => {
    try { process.kill(-child.pid, sig); } catch (e) { try { child.kill(sig); } catch (e2) { /* gone */ } }
  };

  // Two-tier timeout: a hard ceiling for the whole run, plus an idle limit
  // that only counts since the last stream event — a task that is still
  // producing output is never killed (before this, active 45-min builds died
  // at the wall clock with all their work lost). Timers live in a Map, not on
  // the task — Timeout handles are circular and would corrupt state.json.
  const timers = { hard: null, idle: null };
  let idleKilled = false;
  const armIdle = () => {
    clearTimeout(timers.idle);
    timers.idle = setTimeout(() => {
      if (running.has(task.id)) {
        idleKilled = true;
        task.error = `idle ${Math.round(IDLE_MS / 60000)} min — no output, killed`;
        addActivity(task, 'sys', task.error);
        killTree('SIGKILL');
      }
    }, IDLE_MS);
  };
  timers.hard = setTimeout(() => {
    if (running.has(task.id)) {
      task.error = `timed out after ${Math.round(TIMEOUT_MS / 60000)} min`;
      addActivity(task, 'sys', task.error);
      killTree('SIGKILL');
    }
  }, TIMEOUT_MS);
  armIdle();

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    armIdle();
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      // session_id rides on every event — capture it as soon as it appears so
      // even a killed/timed-out run stays resumable.
      if (ev.session_id && !task.sessionId) {
        task.sessionId = ev.session_id;
        saveState();
      }
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            addActivity(task, 'say', block.text.trim());
            scanForHandoff(task, block.text);
          } else if (block.type === 'tool_use' && block.name) {
            addActivity(task, 'tool', toolDetail(block.input), block.name);
          }
        }
        broadcastSoon();
      } else if (ev.type === 'result') {
        task.result = typeof ev.result === 'string' ? ev.result.slice(0, 8000) : null;
        task.isError = !!ev.is_error;
        if (typeof ev.total_cost_usd === 'number') task.costUsd = ev.total_cost_usd;
        if (typeof ev.duration_ms === 'number') task.durationMs = ev.duration_ms;
        if (ev.is_error && !task.error && typeof ev.result === 'string') task.error = ev.result.slice(0, 300);
      }
    }
  });

  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, idx).trim();
      stderrBuf = stderrBuf.slice(idx + 1);
      if (line) addActivity(task, 'log', line.slice(0, 300));
    }
  });

  child.on('close', async (code, signal) => {
    clearTimeout(timers.hard); clearTimeout(timers.idle);
    running.delete(task.id);

    if (cancelling.has(task.id)) {
      task.finishedAt = Date.now();
      task.status = 'cancelled';
      addActivity(task, 'sys', 'cancelled');
    } else if (idleKilled) {
      task.finishedAt = Date.now();
      task.status = 'failed';
    } else if (task.error && task.error.startsWith('timed out')) {
      task.finishedAt = Date.now();
      task.status = 'failed';
    } else if (task.isError) {
      task.finishedAt = Date.now();
      task.status = 'failed';
      if (!task.error) task.error = task.result || `agent reported an error (exit ${code})`;
    } else if (code === 0 || code === null) {
      // Clean close: an ASK line in the final result pauses the task instead
      // of finishing it — detection is result-only (never mid-run text), so
      // an agent quoting the protocol in prose can't trip it.
      const ask = task.result ? parseAsk(task.result) : null;
      if (ask) {
        // Waiting is a pause, not a finish — no finishedAt.
        task.status = 'waiting';
        task.ask = { question: ask.question, options: ask.options, askedAt: Date.now() };
        task.qa = task.qa || [];
        addActivity(task, 'sys', 'waiting for Prateek: ' + ask.question);
        log(`waiting ${task.id}: ${ask.question}`);
      } else {
        task.finishedAt = Date.now();
        task.status = 'done';
      }
    } else {
      task.finishedAt = Date.now();
      task.status = 'failed';
      if (!task.error) task.error = `exited with code ${code}${signal ? ` (${signal})` : ''}`;
    }
    if (!task.durationMs) task.durationMs = task.finishedAt - task.startedAt;

    if (task.status === 'done' && cwd) await attachGitSnapshot(task, cwd);
    if (task.status === 'done') findArtifacts(task, task.startedAt);
    log(`finished ${task.id} status=${task.status} cost=${task.costUsd || 0}${task.git ? ' git=' + task.git : ''}`);
    saveState(); broadcastSoon();
    // The ledger line and handoff queueing belong to terminal `done` only —
    // a waiting task has not finished its work yet.
    if (task.status === 'done') {
      appendTasksMd(task);
      queueHandoffs(task);
    }
    dispatchLoop();
  });

  saveState(); broadcastSoon();
}

// Handoff protocol: an agent line like `DISPATCH: hawkeye | verify the dark mode
// toggle against the acceptance criteria` collects a follow-up that is queued
// as a real board task when the dispatching task finishes. Agent names may
// contain dashes (tony-stark, dr-strange) — this regex dropped them until
// 2026-11-11, silently killing every dev/QA handoff. Same repo by default;
// marker options segment: `model <m>; repo <path>`.
function scanForHandoff(task, text) {
  if (task.status !== 'running') return;
  const re = /^DISPATCH:\s*([a-z][a-z0-9-]*)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\s*$/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const agent = m[1].trim();
    const what = m[2].trim();
    const opts = (m[3] || '').trim();
    if (!getAgent(agent)) {
      addActivity(task, 'sys', `handoff ignored: unknown agent "${agent}" (roster: ${rosterNames()})`);
      continue;
    }
    if (!what) continue;
    let model = getAgent(agent).defModel;
    let repo = task.repo || '';
    for (const part of opts.split(';').map(s => s.trim()).filter(Boolean)) {
      const mm = part.match(/^(model|repo)\s+(.+)$/);
      if (mm) {
        if (mm[1] === 'model') model = mm[2].trim();
        if (mm[1] === 'repo') repo = expandRepo(mm[2].trim());
      }
    }
    task.handoffs = task.handoffs || [];
    task.handoffs.push({ agent, repo, task: what, model });
    addActivity(task, 'sys', `handoff registered: will queue ${agent} when this task finishes`);
    log(`handoff registered ${task.id} → ${agent}`);
  }
}

// A resume is only attempted when the source session's transcript still
// exists — claude keeps them under ~/.claude/projects/<munged-cwd>/. The cwd
// is realpath-resolved first because claude munges the resolved path (e.g.
// /tmp is a symlink to /private/tmp on macOS).
function sessionTranscriptExists(sessionId, cwd) {
  if (!sessionId || !cwd) return false;
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch (e) { /* keep as-is */ }
  const munged = real.replace(/[^a-zA-Z0-9]/g, '-');
  try { return fs.existsSync(path.join(HOME, '.claude', 'projects', munged, sessionId + '.jsonl')); } catch (e) { return false; }
}

// Lossless handoff context: the parent's full task + complete result go to a
// file the follow-up reads from disk, instead of a 1500-char truncation
// stuffed into the prompt (the old prefix also nested on follow-up chains —
// the ledger's "[Follow-up to [Follow-up to …]]" lines).
function writeContextFile(task, parent) {
  try {
    fs.mkdirSync(CONTEXTS_DIR, { recursive: true });
    const lines = [
      `# Context: ${task.id} (follow-up to ${parent.id})`,
      '',
      `## Parent task ${parent.id} — ${parent.agent} (${parent.model})`,
      `Repo: ${parent.repo || '(none)'} · Finished: ${new Date(parent.finishedAt || Date.now()).toISOString()}`,
      '',
      '### Full parent task',
      parent.task,
      '',
      '### Full parent result',
      parent.result || '(no result captured)',
    ];
    const file = path.join(CONTEXTS_DIR, task.id + '.md');
    fs.writeFileSync(file, lines.join('\n'));
    return file;
  } catch (e) {
    log(`context file write failed for ${task.id}: ${e.message}`);
    return null;
  }
}

function queueHandoffs(task) {
  if (!Array.isArray(task.handoffs) || !task.handoffs.length) return;
  for (const h of task.handoffs) {
    const nt = queueTask({
      agent: h.agent,
      repo: h.repo,
      task: h.task,
      model: h.model,
      autoApprove: task.autoApprove,
      parentId: task.id,
      followTo: task.id,
    });
    addActivity(task, 'sys', `queued ${h.agent} follow-up ${nt.id}`);
  }
  task.handoffs = [];
}

function cancelTask(task) {
  // Waiting holds no process — cancel directly, exactly like queued.
  if (task.status === 'queued' || task.status === 'waiting') {
    task.status = 'cancelled';
    task.finishedAt = Date.now();
    saveState(); broadcast(); appendTasksMd(task);
    return true;
  }
  if (task.status === 'running') {
    cancelling.add(task.id);
    const child = running.get(task.id);
    if (child) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { try { child.kill('SIGTERM'); } catch (e2) { /* gone */ } }
      setTimeout(() => {
        if (running.has(task.id)) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* gone */ } }
        }
      }, 5000);
    }
    broadcastSoon();
    return true;
  }
  return false;
}

function queueTask(spec) {
  const task = {
    id: newId(),
    agent: spec.agent,
    repo: spec.repo || '',
    task: spec.task,
    model: spec.model,
    autoApprove: spec.autoApprove === undefined ? true : !!spec.autoApprove,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null, finishedAt: null,
    activity: [], result: null, error: null,
    costUsd: null, durationMs: null, isError: false,
    parentId: spec.parentId || null,
    followTo: spec.followTo || null,
    retryOf: spec.retryOf || null,
    ask: null, qa: [],
    contextFile: null,
    sessionId: null, resumeSessionId: null,
    git: null, priority: spec.priority ? 1 : 0,
  };
  // Handoffs/follow-ups get a lossless context file; retries reuse the
  // original task's context file if it had one.
  const ctxParent = spec.followTo ? getTask(spec.followTo) : null;
  if (ctxParent) task.contextFile = writeContextFile(task, ctxParent);
  else if (spec.contextFile) task.contextFile = spec.contextFile;
  state.tasks.push(task);
  saveState(); broadcast();
  dispatchLoop();
  return task;
}

function retryTask(task) {
  return queueTask({
    agent: task.agent,
    repo: task.repo,
    task: task.task,
    model: task.model,
    autoApprove: !!task.autoApprove,
    retryOf: task.id,
    contextFile: task.contextFile,
    priority: task.priority,
  });
}

// ------------------------------------------------------- tasks.md log -----

// Project name for the ledger: the last path segment of the repo, so
// `/Users/pdesai/Coding/Self/leeway-web/leeway` reads as `leeway`.
function projectName(repo) {
  if (!repo || typeof repo !== 'string') return '';
  const segs = repo.trim().replace(/\/+$/, '').split('/');
  return segs[segs.length - 1] || '';
}

function appendTasksMd(task) {
  try {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const summary = task.task.replace(/\s+/g, ' ').trim().slice(0, 110) || '(no description)';
    const outcome = task.status === 'done'
      ? 'done'
      : task.status === 'cancelled'
        ? 'cancelled'
        : `failed: ${(task.error || 'see ledger').replace(/\s+/g, ' ').slice(0, 90)}`;
    const cost = task.costUsd ? ` $${task.costUsd.toFixed(2)}` : '';
    const project = projectName(task.repo);
    const parent = task.parentId ? ` ↳${task.parentId}` : '';
    // Date lives in the `## YYYY-MM-DD` heading; each line carries the time,
    // the project (repo basename) and, for follow-ups, the parent id only —
    // task text and context live in the ledger/context file, not nested here.
    const line = `- [board] ${now}${project ? ` · ${project}` : ''}${parent} · ${summary} — ${task.agent} (${task.model}) → ${outcome}${cost}`;

    const md = fs.existsSync(TASKS_MD) ? fs.readFileSync(TASKS_MD, 'utf8')
      : '# Orchestrator — daily task log\n\nNewest day first.\n';
    const lines = md.split('\n');

    const dayIdx = lines.findIndex(l => l.trim() === `## ${today}`);
    if (dayIdx === -1) {
      const firstDay = lines.findIndex(l => /^##\s/.test(l));
      const block = [`## ${today}`, '', '### Open', '- (none yet)', '', '### Done', line, ''];
      if (firstDay === -1) lines.push('', ...block);
      else lines.splice(firstDay, 0, ...block, '');
    } else {
      let end = dayIdx + 1;
      while (end < lines.length && !/^##\s/.test(lines[end])) end++;
      let doneIdx = -1;
      for (let i = dayIdx; i < end; i++) if (lines[i].trim() === '### Done') { doneIdx = i; break; }
      if (doneIdx === -1) {
        lines.splice(end, 0, '', '### Done', line);
      } else {
        let at = end;
        while (at > doneIdx + 1 && lines[at - 1].trim() === '') at--;
        lines.splice(at, 0, line);
      }
    }
    fs.writeFileSync(TASKS_MD, lines.join('\n'));
  } catch (e) {
    log('tasks.md append failed: ' + e.message);
  }
}

// ---------------------------------------------------------------- http ----

function log(msg) {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  console.log(`[${ts}] ${msg}`);
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJSON(res, code, obj) { send(res, code, JSON.stringify(obj)); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 512 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function expandRepo(p) {
  if (!p || typeof p !== 'string') return '';
  const t = p.trim();
  if (!t) return '';
  if (t === '~') return HOME;
  if (t.startsWith('~/')) return path.join(HOME, t.slice(2));
  return path.resolve(t);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && MIME[path.extname(p)]) {
      const file = path.normalize(path.join(PUBLIC_DIR, p));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) { sendJSON(res, 403, { error: 'forbidden' }); return; }
      try {
        send(res, 200, fs.readFileSync(file), MIME[path.extname(p)]);
      } catch (e) {
        sendJSON(res, 404, { error: 'not found' });
      }
      return;
    }
    // Serve an artifact (plan/design/demo) by its exact file name — the UI
    // can't link file:// from an http page, so files are streamed from the
    // three shared dirs. Only basenames resolve; no path traversal.
    if (req.method === 'GET' && p === '/api/artifact') {
      const name = path.basename(url.searchParams.get('f') || '');
      if (!name || !/\.(html|md)$/.test(name)) { sendJSON(res, 400, { error: 'bad artifact name' }); return; }
      for (const dir of ['plans', 'decisions', 'demos']) {
        const full = path.join(ORCH_DIR, dir, name);
        try {
          if (fs.statSync(full).isFile()) {
            send(res, 200, fs.readFileSync(full), name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
            return;
          }
        } catch (e) { /* try next dir */ }
      }
      sendJSON(res, 404, { error: 'no such artifact' });
      return;
    }
    if (req.method === 'GET' && p === '/health') {
      sendJSON(res, 200, { ok: true, pid: process.pid, uptime: process.uptime(), concurrency: CONCURRENCY });
      return;
    }
    if (req.method === 'GET' && p === '/api/state') {
      sendJSON(res, 200, publicState());
      return;
    }
    // Repo autocomplete: repos actually dispatched to (history first) plus
    // git repos found up to depth 2 under the two identity trees. Queried as
    // the user types; q filters by substring (matched against the ~/ form).
    if (req.method === 'GET' && p === '/api/repos') {
      const qRaw = url.searchParams.get('q') || '';
      // Stats per repo path: last use + use count, so history ranks above
      // plain directory listings.
      const stats = new Map();   // ~/path -> { last: ts, uses: n }
      for (const t of state.tasks) {
        if (!t.repo) continue;
        const homeForm = t.repo.startsWith(HOME) ? '~' + t.repo.slice(HOME.length) : t.repo;
        const cur = stats.get(homeForm) || { last: 0, uses: 0 };
        cur.last = Math.max(cur.last, t.createdAt || 0);
        cur.uses += 1;
        stats.set(homeForm, cur);
      }
      const isRepoDir = (abs) => {
        try { return fs.statSync(path.join(abs, '.git')).isDirectory() || fs.statSync(path.join(abs, '.git')).isFile(); }
        catch (e) { return false; }
      };
      for (const base of ['Coding/Self', 'Coding/Work']) {
        const baseAbs = path.join(HOME, base);
        let level1 = [];
        try { level1 = fs.readdirSync(baseAbs, { withFileTypes: true }); } catch (e) { continue; }
        for (const e1 of level1) {
          if (!e1.isDirectory() || e1.name.startsWith('.')) continue;
          const abs1 = path.join(baseAbs, e1.name);
          const home1 = `~/${base}/${e1.name}`;
          if (isRepoDir(abs1) && !stats.has(home1)) stats.set(home1, { last: 0, uses: 0 });
          let level2 = [];
          try { level2 = fs.readdirSync(abs1, { withFileTypes: true }); } catch (e) { continue; }
          for (const e2 of level2) {
            if (!e2.isDirectory() || e2.name.startsWith('.')) continue;
            const abs2 = path.join(abs1, e2.name);
            const home2 = `~/${base}/${e1.name}/${e2.name}`;
            if (isRepoDir(abs2) && !stats.has(home2)) stats.set(home2, { last: 0, uses: 0 });
          }
        }
      }
      // Compare queries in the same ~/ form as the candidates, so pasting an
      // absolute path still matches (e.g. /Users/pdesai/Coding/Work/web_sdk).
      let qNorm = qRaw.trim();
      if (qNorm.startsWith('~')) qNorm = path.join(HOME, qNorm.slice(1));
      if (qNorm.startsWith(HOME)) qNorm = '~' + qNorm.slice(HOME.length);
      const qLower = qNorm.toLowerCase();
      const repos = [...stats.entries()]
        .filter(([homeForm]) => !qLower || homeForm.toLowerCase().includes(qLower))
        .sort((a, b) => (b[1].last - a[1].last) || (b[1].uses - a[1].uses) || a[0].localeCompare(b[0]))
        .map(([homeForm]) => homeForm);
      sendJSON(res, 200, { repos: repos.slice(0, 8) });
      return;
    }
    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && p === '/api/tasks') {
      const body = await readBody(req);
      const agent = String(body.agent || '').trim();
      const text = String(body.task || '').trim();
      const ag = getAgent(agent);
      if (!ag) { sendJSON(res, 400, { error: `unknown agent "${agent}" — use one of: ${config.agents.map(a => a.name).join(', ')}` }); return; }
      if (!text) { sendJSON(res, 400, { error: 'task text is required' }); return; }
      if (text.length > 20000) { sendJSON(res, 400, { error: 'task text too long (max 20000 chars)' }); return; }
      // A waiting task's session must not get a second writer — answer it
      // instead of following up.
      if (body.followTo && getTask(body.followTo)?.status === 'waiting') {
        sendJSON(res, 409, { error: `${body.followTo} is waiting for an answer — answer it instead of following up` });
        return;
      }
      const model = String(body.model || ag.defModel).trim() || ag.defModel;
      const task = queueTask({
        agent,
        repo: expandRepo(body.repo),
        task: text,
        model,
        autoApprove: body.autoApprove,
        parentId: body.parentId || null,
        followTo: body.followTo || null,
        priority: !!body.priority,
      });
      log(`queued ${task.id} agent=${agent} repo=${task.repo || '-'}${body.priority ? ' priority' : ''}${body.followTo ? ` followTo=${body.followTo}` : ''}`);
      sendJSON(res, 201, task);
      return;
    }
    const m = p.match(/^\/api\/tasks\/(t-[0-9a-f]+)\/(cancel|retry)$/);
    if (req.method === 'POST' && m) {
      const task = getTask(m[1]);
      if (!task) { sendJSON(res, 404, { error: 'no such task' }); return; }
      if (m[2] === 'cancel') {
        if (!cancelTask(task)) { sendJSON(res, 409, { error: `cannot cancel a ${task.status} task` }); return; }
        sendJSON(res, 200, task);
      } else {
        if (!['done', 'failed', 'cancelled'].includes(task.status)) { sendJSON(res, 409, { error: `cannot retry a ${task.status} task` }); return; }
        if (!getAgent(task.agent)) { sendJSON(res, 400, { error: `agent "${task.agent}" no longer exists — rename the task's agent in teams, or dispatch fresh` }); return; }
        sendJSON(res, 201, retryTask(task));
      }
      return;
    }
    if (req.method === 'DELETE' && p === '/api/tasks/finished') {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter(t => ['queued', 'running', 'waiting'].includes(t.status));
      const removed = before - state.tasks.length;
      saveState(); broadcast();
      log(`cleared ${removed} finished tasks`);
      sendJSON(res, 200, { removed });
      return;
    }

    // ------------------------------------------------- board + agents -----
    // The board name and the agent roster are editable from the UI's
    // "teams" dialog; renames also rename ~/.claude/agents/<name>.md.

    if (req.method === 'PATCH' && p === '/api/board') {
      const body = await readBody(req);
      if (body.boardName !== undefined) {
        const n = String(body.boardName).trim();
        if (!n || n.length > 40) { sendJSON(res, 400, { error: 'board name must be 1-40 characters' }); return; }
        config.boardName = n;
        saveConfig();
        log(`board renamed to "${n}"`);
      }
      broadcast();
      sendJSON(res, 200, { boardName: config.boardName });
      return;
    }

    if (req.method === 'POST' && p === '/api/agents') {
      const body = await readBody(req);
      const r = addAgent(body);
      if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
      saveConfig(); broadcast();
      sendJSON(res, 201, r.agent);
      return;
    }

    const mAgent = p.match(/^\/api\/agents\/([a-z0-9-]+)$/);
    if (req.method === 'PATCH' && mAgent) {
      const body = await readBody(req);
      const r = patchAgent(mAgent[1], body);
      if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
      broadcast();
      sendJSON(res, 200, r.agent);
      return;
    }
    if (req.method === 'DELETE' && mAgent) {
      const r = removeAgent(mAgent[1]);
      if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
      broadcast();
      sendJSON(res, 200, r);
      return;
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} already in use — is the server already running? (orch status)`);
    process.exit(1);
  }
  throw e;
});

// ------------------------------------------------------------- startup ----

loadState();
pruneOldTasks();
pruneContexts();
loadConfig();
fs.writeFileSync(PID_FILE, String(process.pid));
server.listen(PORT, HOST, () => {
  log(`orchestrator on http://${HOST}:${PORT} — concurrency ${CONCURRENCY}, timeout ${Math.round(TIMEOUT_MS / 60000)} min (idle ${Math.round(IDLE_MS / 60000)}), agents: ${config.agents.map(a => a.name).join(', ')}`);
  dispatchLoop();
  setInterval(() => {
    for (const res of sseClients) { try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); } }
  }, 15000);
  // Daily housekeeping: state + context files fall off after their windows.
  setInterval(() => { if (pruneOldTasks()) { saveState(); broadcast(); } pruneContexts(); }, 6 * 60 * 60 * 1000);
});

function shutdown() {
  // Kill tracked agent processes so a server restart never leaves orphans
  // quietly working in a repo with their output going nowhere.
  for (const [id, child] of running) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* already gone */ }
  }
  setTimeout(() => {
    for (const [, child] of running) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }
    flushState();
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    process.exit(0);
  }, 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
