/* orchestrator board — live state over SSE, dispatch + detail drawer + teams */
'use strict';

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

const FALLBACK_COLORS = ['--dev', '--plan', '--arch', '--qa', '--doc'];
const MODEL_SHORT = (m) => m
  .replace('anthropic.Polaris.Model.Smart.', 'polaris·')
  .replace('anthropic.Claude.', 'claude·')
  .replace('anthropic.OpenAI.', 'openai·')
  .replace('anthropic.Zai.', 'zai·')
  .replace('Smart.', '');

let S = { tasks: [], models: [], concurrency: 3, agents: [], colors: FALLBACK_COLORS, boardName: 'orchestrator' };
let selectedAgent = null;
let drawerId = null;
let teamsOpen = false;
let renderedLaneKey = null;

// ---------------------------------------------------------------- helpers --

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtClock(ts) {
  const d = new Date(ts);
  return {
    hm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    s: String(d.getSeconds()).padStart(2, '0'),
  };
}
function fmtDur(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}
function shortRepo(p) {
  const m = p.match(/([^/]+)/g);
  return m ? m.slice(-1)[0] : p;
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function agentColor(name) {
  const a = S.agents.find(x => x.name === name);
  return a ? `var(${a.color})` : 'var(--faint)';
}
function agentExists(name) { return S.agents.some(x => x.name === name); }
function colors() { return Array.isArray(S.colors) && S.colors.length ? S.colors : FALLBACK_COLORS; }

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ------------------------------------------------------------------ clock --

setInterval(() => {
  const { hm, s } = fmtClock(Date.now());
  $('#clock').innerHTML = `${hm}<span class="secs">:${s}</span>`;
}, 1000);

// ------------------------------------------------------------------- sse ---

let es = null;
function connectSSE() {
  es = new EventSource('/events');
  es.onopen = () => $('#sse').className = 'sse on';
  es.onerror = () => $('#sse').className = 'sse off';
  es.onmessage = (ev) => {
    try { applyState(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
  };
}

// ----------------------------------------------------------------- state ---

function applyState(next) {
  // Tolerate a server that predates teams support (agents as a map, no
  // boardName/colors) so a refresh against the old process still works.
  if (!Array.isArray(next.agents)) {
    next.agents = Object.entries(next.agents || {}).map(([name, v], i) => ({
      name, color: FALLBACK_COLORS[i % FALLBACK_COLORS.length], defModel: v.defModel,
    }));
  }
  S = next;
  // The selected agent may have been renamed or removed — re-anchor.
  if (!selectedAgent || !agentExists(selectedAgent)) {
    selectedAgent = S.agents.length ? S.agents[0].name : null;
  }
  $('#board-name').textContent = S.boardName || 'orchestrator';
  document.title = S.boardName || 'orchestrator';
  render();
}

function tasksForLane(agent) {
  return S.tasks
    .filter(t => t.agent === agent && ['queued', 'running'].includes(t.status))
    .sort((a, b) => b.createdAt - a.createdAt);
}
function finishedTasks() {
  return S.tasks
    .filter(t => !['queued', 'running', 'waiting'].includes(t.status))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
}

// -------------------------------------------------------------- waiting ----
// Waiting tasks live in their own strip above the lanes, never inside an
// agent lane — questions are the one thing on the board that need Prateek,
// and a renamed/removed agent must never hide one.

function waitingTasks() {
  return S.tasks
    .filter(t => t.status === 'waiting')
    .sort((a, b) => (a.ask?.askedAt || 0) - (b.ask?.askedAt || 0));
}

function answerTask(t, text) {
  api('POST', `/api/tasks/${t.id}/answer`, { text })
    .catch(e => {
      // Stash the error so re-renders keep it visible — a rebuild every
      // second would otherwise flash it away before anyone reads it.
      const strip = $('#waiting-strip');
      if (strip) {
        strip.dataset.error = `answer failed: ${e.message}`;
        renderWaiting();
      }
    });
}

function renderWaiting() {
  const strip = $('#waiting-strip');
  const list = waitingTasks();
  strip.hidden = list.length === 0;
  if (list.length && strip.dataset.error && strip.childElementCount) {
    // Keep showing a stashed answer error instead of rebuilding over it.
    const head = strip.querySelector('.strip-head');
    if (head) { head.querySelector('.strip-hint').textContent = strip.dataset.error; return; }
  }
  strip.dataset.error = '';
  strip.innerHTML = '';
  if (!list.length) return;

  const head = document.createElement('div');
  head.className = 'strip-head';
  head.innerHTML = `<span class="strip-title">waiting — ${list.length}</span><span class="strip-hint">click an option to answer; the task resumes in its lane</span>`;
  strip.appendChild(head);

  const row = document.createElement('div');
  row.className = 'strip-cards';
  for (const t of list) row.appendChild(cardForWaiting(t));
  strip.appendChild(row);
}

function cardForWaiting(t) {
  const card = document.createElement('div');
  card.className = 'card st-waiting';
  card.dataset.id = t.id;

  const top = document.createElement('div');
  top.className = 'card-top';
  top.innerHTML = `<span class="card-id">${esc(t.id)}</span><span class="spacer"></span><span class="card-status">${esc(t.status)}</span>`;
  card.appendChild(top);

  const agentLine = document.createElement('div');
  agentLine.className = 'card-agent';
  agentLine.innerHTML = `<span class="dot" style="background:${agentColor(t.agent)}"></span>${esc(t.agent)}`;
  card.appendChild(agentLine);

  const task = document.createElement('div');
  task.className = 'card-task';
  task.textContent = t.task;
  card.appendChild(task);

  if (t.ask?.question) {
    const q = document.createElement('div');
    q.className = 'card-question';
    q.textContent = `❓ ${t.ask.question}`;
    card.appendChild(q);
  }

  const chips = document.createElement('div');
  chips.className = 'ask-chips';
  for (const opt of (t.ask?.options || []).slice(0, 4)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ask-chip';
    b.textContent = opt;
    b.addEventListener('click', (e) => { e.stopPropagation(); answerTask(t, opt); });
    chips.appendChild(b);
  }
  const other = document.createElement('button');
  other.type = 'button';
  other.className = 'ask-chip other';
  other.textContent = 'other…';
  other.addEventListener('click', (e) => {
    e.stopPropagation();
    openDrawer(t.id);
    const ta = $('#drawer-answer');
    if (ta) ta.focus();
  });
  chips.appendChild(other);
  card.appendChild(chips);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const bits = [];
  if (t.repo) bits.push(`<span class="repo">${esc(shortRepo(t.repo))}</span>`);
  bits.push(`<span class="model">${esc(MODEL_SHORT(t.model))}</span>`);
  if (t.ask?.askedAt) bits.push(`<span class="elapsed">waiting ${fmtDur(Date.now() - t.ask.askedAt)}</span>`);
  meta.innerHTML = bits.join('');
  card.appendChild(meta);

  card.addEventListener('click', () => openDrawer(t.id));
  return card;
}

// ---------------------------------------------------------------- render ---

function render() {
  renderChips();
  renderWaiting();
  renderLanes();
  renderLedger();
  renderConc();
  renderDrawer();
}

function renderConc() {
  const running = S.tasks.filter(t => t.status === 'running').length;
  const queued = S.tasks.filter(t => t.status === 'queued').length;
  const waiting = S.tasks.filter(t => t.status === 'waiting').length;
  $('#conc').innerHTML = `slots <b>${running}/${S.concurrency}</b> · queued <b>${queued}</b>${waiting ? ` · waiting <b>${waiting}</b>` : ''}`;
}

function renderChips() {
  const picker = $('#agent-picker');
  picker.innerHTML = '';
  for (const a of S.agents) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'agent-chip' + (a.name === selectedAgent ? ' sel' : '');
    b.dataset.agent = a.name;
    b.style.setProperty('--c', `var(${a.color})`);
    b.title = a.description || a.name;
    b.textContent = a.name;
    picker.appendChild(b);
  }
}

function renderLanes() {
  const key = S.agents.map(a => `${a.name}:${a.color}`).join('|');
  if (key !== renderedLaneKey) {
    renderedLaneKey = key;
    buildLanes();
  }
  for (const a of S.agents) {
    const laneTasks = tasksForLane(a.name);
    const body = $(`[data-lane="${a.name}"]`);
    if (!body) continue; // lane set just changed; next render is consistent
    const count = $(`#count-${a.name}`);
    const running = laneTasks.filter(t => t.status === 'running').length;
    count.textContent = laneTasks.length
      ? `${running} running · ${laneTasks.length - running} queued`
      : '';

    body.innerHTML = '';
    if (!laneTasks.length) {
      const d = document.createElement('div');
      d.className = 'lane-empty';
      d.textContent = 'idle';
      body.appendChild(d);
      continue;
    }
    for (const t of laneTasks) body.appendChild(cardFor(t));
  }
}

function buildLanes() {
  const wrap = $('#lanes');
  wrap.innerHTML = '';
  for (const a of S.agents) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.setProperty('--c', `var(${a.color})`);
    lane.id = `lane-${a.name}`;
    lane.innerHTML = `
      <div class="lane-head">
        <span class="lane-name">${esc(a.name)}/</span>
        <span class="spacer"></span>
        <button type="button" class="lane-edit" data-edit-team="1" title="rename this team">rename</button>
        <span class="lane-count" id="count-${esc(a.name)}"></span>
      </div>
      <div class="lane-body" data-lane="${esc(a.name)}"></div>`;
    wrap.appendChild(lane);
  }
}

function cardFor(t) {
  const card = document.createElement('div');
  card.className = `card st-${t.status}`;
  card.dataset.id = t.id;

  const top = document.createElement('div');
  top.className = 'card-top';
  top.innerHTML = `<span class="card-id">${esc(t.id)}</span><span class="spacer"></span><span class="card-status">${esc(t.status)}</span>`;
  card.appendChild(top);

  const task = document.createElement('div');
  task.className = 'card-task';
  task.textContent = t.task;
  card.appendChild(task);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const bits = [];
  if (t.parentId) bits.push(`<span class="parent" title="follow-up to ${esc(t.parentId)}">↳ ${esc(t.parentId)}</span>`);
  if (t.repo) bits.push(`<span class="repo">${esc(shortRepo(t.repo))}</span>`);
  bits.push(`<span class="model">${esc(MODEL_SHORT(t.model))}</span>`);
  if (t.status === 'running') bits.push(`<span class="elapsed">${fmtDur(Date.now() - t.startedAt)}</span>`);
  if (t.resumeSessionId || t.sessionId) {
    const sid = t.resumeSessionId || t.sessionId;
    bits.push(`<span class="sid" title="claude session ${esc(sid)} — follow-ups resume it">◇ ${esc(sid.slice(0, 8))}</span>`);
  }
  if (t.priority) bits.push(`<span class="prio" title="priority — jumps the queue">▲</span>`);
  meta.innerHTML = bits.join('');
  card.appendChild(meta);

  if (t.git && ['done'].includes(t.status)) {
    const g = document.createElement('div');
    g.className = 'card-git';
    g.textContent = t.git;
    g.title = t.git;
    card.appendChild(g);
  }

  if (t.status === 'running' && t.activity?.length) {
    const ticker = document.createElement('div');
    ticker.className = 'ticker';
    const lines = t.activity.slice(-3);
    for (const a of lines) {
      const row = document.createElement('div');
      row.className = `ticker-line ${a.kind}`;
      const kind = document.createElement('span');
      kind.className = 'tick-kind' + (a === lines[lines.length - 1] ? ' running-pulse' : ' ');
      kind.textContent = a.kind === 'tool' ? '⚙ ' + (a.tool || '').slice(0, 8) : a.kind;
      const text = document.createElement('span');
      text.className = 'tick-text';
      text.textContent = a.text;
      row.appendChild(kind); row.appendChild(text);
      ticker.appendChild(row);
    }
    card.appendChild(ticker);
  }

  card.addEventListener('click', () => openDrawer(t.id));
  return card;
}

function renderLedger() {
  const fin = finishedTasks();
  const body = $('#ledger-body');
  body.innerHTML = '';
  $('#ledger-empty').hidden = fin.length > 0;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTasks = fin.filter(t => (t.finishedAt || 0) >= today.getTime());
  const cost = todayTasks.reduce((s, t) => s + (t.costUsd || 0), 0);
  $('#ledger-summary').textContent = fin.length
    ? `${fin.length} finished · today ${todayTasks.length} · $${cost.toFixed(2)} today`
    : '';

  for (const t of fin.slice(0, 30)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="t-time">${esc(fmtDate(t.finishedAt))}<span class="t-time-sep"> · </span>${fmtTime(t.finishedAt)}</td>
      <td class="t-proj"><span class="cell">${esc(t.repo ? shortRepo(t.repo) : '—')}</span></td>
      <td class="t-agent"><span class="dot" style="background:${agentColor(t.agent)}"></span>${esc(t.agent)}</td>
      <td class="t-task"><span class="cell">${esc(t.task)}</span></td>
      <td class="t-dur">${fmtDur(t.durationMs)}</td>
      <td class="t-cost">${t.costUsd != null ? '$' + t.costUsd.toFixed(2) : '—'}</td>
      <td class="t-status st-${t.status}"><span class="card-status">${esc(t.status)}</span></td>
      <td class="t-act"></td>`;
    if (['failed', 'cancelled'].includes(t.status)) {
      const btn = document.createElement('button');
      btn.textContent = 'retry';
      btn.addEventListener('click', (e) => { e.stopPropagation(); act2(t.id, 'retry'); });
      tr.querySelector('.t-act').appendChild(btn);
    }
    tr.addEventListener('click', () => openDrawer(t.id));
    body.appendChild(tr);
  }
}

// ---------------------------------------------------------------- drawer ---

function findTask(id) { return S.tasks.find(t => t.id === id) || null; }

function openDrawer(id) {
  drawerId = id;
  $('#drawer-backdrop').hidden = false;
  $('#drawer').hidden = false;
  renderDrawer();
}
function closeDrawer() {
  drawerId = null;
  $('#drawer-backdrop').hidden = true;
  $('#drawer').hidden = true;
}

function renderDrawer() {
  if (!drawerId) return;
  const t = findTask(drawerId);
  if (!t) { closeDrawer(); return; }

  $('#drawer-title').innerHTML = `<b>${esc(t.id)}</b> · ${esc(t.agent)}`;
  const meta = [
    `status ${t.status}`,
    t.repo ? `repo ${shortRepo(t.repo)}` : null,
    `model ${MODEL_SHORT(t.model)}`,
    t.autoApprove ? 'tools auto-approved' : 'edits need approval',
    t.startedAt ? `started ${fmtTime(t.startedAt)}` : `queued ${fmtTime(t.createdAt)}`,
    t.status === 'running' ? `elapsed ${fmtDur(Date.now() - t.startedAt)}` : null,
    t.costUsd != null ? `$${t.costUsd.toFixed(2)}` : null,
    (t.resumeSessionId || t.sessionId) ? `session ${(t.resumeSessionId || t.sessionId).slice(0, 8)}` : null,
  ].filter(Boolean);
  $('#drawer-meta').innerHTML = meta.map(esc).join(' · ');

  $('#drawer-task').textContent = t.task;
  $('#drawer-task').hidden = false;

  const act = $('#drawer-activity');
  act.innerHTML = '';
  for (const a of (t.activity || []).slice().reverse().slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'line';
    row.innerHTML = `<span class="at">${fmtClock(a.at).hm}</span><span class="kind k-${esc(a.kind)}">${esc(a.kind)}</span><span class="txt ${a.kind !== 'say' ? 'muted' : ''}"></span>`;
    row.querySelector('.txt').textContent = a.kind === 'tool' && a.tool ? `${a.tool} ${a.text}` : a.text;
    act.appendChild(row);
  }

  const res = $('#drawer-result');
  if (t.result) { res.textContent = t.result; res.hidden = false; }
  else if (t.error) { res.textContent = 'error: ' + t.error; res.hidden = false; }
  else { res.textContent = ''; res.hidden = true; }

  // Question/answer history plus the live answer form while waiting.
  const qaHead = $('#drawer-qa-head');
  const qaBody = $('#drawer-qa');
  const answerWrap = $('#drawer-answer-wrap');
  const rounds = Array.isArray(t.qa) ? t.qa : [];
  const liveQ = t.status === 'waiting' && t.ask ? [{ q: t.ask.question, a: null }] : [];
  if (rounds.length || liveQ.length) {
    qaHead.hidden = false;
    qaBody.hidden = false;
    qaBody.innerHTML = '';
    for (const r of [...rounds, ...liveQ]) {
      const qRow = document.createElement('div');
      qRow.className = 'line';
      qRow.innerHTML = `<span class="at">${r.at ? fmtClock(r.at).hm : ''}</span><span class="kind k-ask">ask</span><span class="txt"></span>`;
      qRow.querySelector('.txt').textContent = r.q;
      qaBody.appendChild(qRow);
      if (r.a != null) {
        const aRow = document.createElement('div');
        aRow.className = 'line';
        aRow.innerHTML = `<span class="at"></span><span class="kind k-ans">you</span><span class="txt"></span>`;
        aRow.querySelector('.txt').textContent = r.a;
        qaBody.appendChild(aRow);
      }
    }
  } else {
    qaHead.hidden = true;
    qaBody.hidden = true;
    qaBody.innerHTML = '';
  }
  if (answerWrap) {
    answerWrap.hidden = t.status !== 'waiting';
    if (t.status === 'waiting') {
      const ta = $('#drawer-answer');
      // Reset only when the target task or its live question changed — the
      // drawer re-renders on every SSE broadcast, and clearing unconditionally
      // would wipe a half-typed answer whenever anything else streams.
      const target = t.id + ':' + (t.ask?.question || '');
      if (ta.dataset.forTarget !== target) {
        ta.value = '';
        ta.dataset.forTarget = target;
      }
      const send = $('#drawer-answer-send');
      // Errors render next to the form (drawerMsg), not console-only: a 409
      // race or a removed agent must be visible where the user is typing.
      const drawerMsg = $('#drawer-answer-msg');
      if (drawerMsg && drawerMsg.dataset.fresh !== '1') drawerMsg.textContent = '';
      send.onclick = () => {
        const text = ta.value.trim();
        if (!text) return;
        send.disabled = true;
        api('POST', `/api/tasks/${t.id}/answer`, { text })
          .then(() => { ta.value = ''; ta.dataset.forTarget = ''; if (drawerMsg) drawerMsg.textContent = ''; })
          .catch(e => {
            ta.value = text;
            if (drawerMsg) { drawerMsg.textContent = e.message; drawerMsg.dataset.fresh = '1'; }
          })
          .finally(() => { send.disabled = false; });
      };
    }
  }

  const actions = $('#drawer-actions');
  if (actions) {
    actions.innerHTML = '';
    if (['queued', 'running', 'waiting'].includes(t.status)) {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'cancel task';
      btn.addEventListener('click', () => { act2(t.id, 'cancel'); });
      actions.appendChild(btn);
    } else {
      const follow = document.createElement('button');
      follow.className = 'ghost follow';
      follow.textContent = 'follow-up (resumes its session)';
      follow.addEventListener('click', () => { prefillFollowUp(t); closeDrawer(); });
      actions.appendChild(follow);

      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'retry';
      btn.addEventListener('click', () => { act2(t.id, 'retry'); });
      actions.appendChild(btn);
    }
    // Artifact links: plans/decisions/demos the agent wrote to the shared
    // orchestrator dirs, streamed via /api/artifact (file:// links are
    // blocked from an http page).
    for (const art of artifactsFor(t)) {
      const a = document.createElement('a');
      a.className = 'ghost artifact';
      a.href = '/api/artifact?f=' + encodeURIComponent(art.file || art.path.split('/').pop());
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = art.label;
      a.title = art.path || art.file;
      a.addEventListener('click', (e) => e.stopPropagation());
      actions.appendChild(a);
    }
  }
}

// Artifacts the server found for this task (plans/decisions/demos written to
// the shared orchestrator dirs); the scan runs server-side where fs is real.
function artifactsFor(t) {
  return Array.isArray(t.artifacts) ? t.artifacts : [];
}

// Pre-fill the dispatch form with a finished task's context so the next
// dispatch starts from what the agent already learned. Sent with followTo so
// the server resumes the task's session when the transcript survives.
function prefillFollowUp(t) {
  if (!agentExists(t.agent)) {
    // The agent was renamed or removed since this task ran — dispatch to the
    // first agent on the board instead of one the server would reject.
    selectedAgent = S.agents[0]?.name || null;
    syncChipSelection();
  } else {
    selectedAgent = t.agent;
    syncChipSelection();
  }
  if ([...$('#f-model').options].some(o => o.value === t.model)) $('#f-model').value = t.model;
  $('#f-repo').value = t.repo || '';
  $('#f-task').value = `Follow-up to ${t.id} (${t.agent}, ${t.status}): `;
  $('#f-task').dataset.followTo = t.id;
  $('#f-task').focus();
  const end = $('#f-task').value.length;
  $('#f-task').setSelectionRange(end, end);
  $('#f-task').scrollIntoView({ block: 'nearest' });
  const msg = $('#form-msg');
  msg.className = 'form-msg ok';
  msg.textContent = `context from ${t.id} loaded — write the follow-up and dispatch`;
}

function syncChipSelection() {
  $$('.agent-chip').forEach(c => c.classList.toggle('sel', c.dataset.agent === selectedAgent));
}

async function act2(id, action) {
  try {
    const r = await fetch(`/api/tasks/${id}/${action}`, { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
  } catch (e) {
    console.error(e.message);
  }
}

// ------------------------------------------------------------- dispatch ----

async function dispatch(payload) {
  const msg = $('#form-msg');
  msg.className = 'form-msg';
  msg.textContent = 'dispatching…';
  $('#submit').disabled = true;
  try {
    const r = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    msg.className = 'form-msg ok';
    msg.textContent = `queued as ${j.id}`;
    $('#f-task').value = '';
    return true;
  } catch (e) {
    msg.className = 'form-msg err';
    msg.textContent = e.message;
    return false;
  } finally {
    $('#submit').disabled = false;
  }
}

// Presets fill the form with a proven workflow instead of a blank task. Each
// targets an agent + writes the working loop into the task text (the demo
// preset bakes in the build → browser-verify → iterate cycle).
const PRESETS = {
  demo: {
    agent: 'spiderman',
    fill(task) {
      return `Build an HTML demo and verify it in a real browser.

Topic: ${task || '<describe what the demo should show>'}

Rules:
- Write it to /Users/pdesai/.claude/orchestrator/demos/<repo-slug>-<slug>.html — a single self-contained file (inline CSS/JS, no build step).
- Then open it with the playwright MCP tools (browser_navigate → browser_take_screenshot → browser_console_messages).
- If the console shows errors or the screenshot looks wrong, fix and re-verify. Iterate until clean.
- Report: the artifact path, what the screenshot shows, and any console output.`;
    },
  },
  jira: {
    agent: 'hawkeye',
    fill(task) {
      return `Pull the named Jira ticket(s) with the atlassian MCP tools and produce a context pack.

Tickets / topic: ${task || '<ticket ids, e.g. PND-10368>'}

Pack contents:
1. Requirement in one paragraph (your words, linked to the ticket text).
2. Acceptance criteria, verbatim.
3. Affected components/files — grep the repo to ground each claim.
4. Open questions to resolve before coding.
- Do not modify anything. Report the pack as your result.`;
    },
  },
};

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  if (agentExists(p.agent)) { selectedAgent = p.agent; syncChipSelection(); }
  const ag = S.agents.find(a => a.name === selectedAgent);
  if (ag && [...$('#f-model').options].some(o => o.value === ag.defModel)) $('#f-model').value = ag.defModel;
  $('#f-task').value = p.fill('');
  $('#f-task').focus();
  // put the cursor on the placeholder line so the user just types the topic
  const idx = $('#f-task').value.indexOf('<');
  if (idx >= 0) $('#f-task').setSelectionRange(idx, idx + $('#f-task').value.slice(idx).indexOf('>') + 1);
}

// ----------------------------------------------------------------- form ----

// Repo autocomplete: the server ranks history + git repos under the two
// identity trees; we filter by what's typed and let the user pick with
// arrows/enter or a click.
let repoSugItems = [];
let repoSugActive = -1;
let repoSugTimer = null;

function repoSugHide() {
  repoSugItems = [];
  repoSugActive = -1;
  const el = $('#repo-sug');
  if (el) { el.hidden = true; el.innerHTML = ''; }
}

function repoSugRender() {
  const el = $('#repo-sug');
  if (!el) return;
  el.innerHTML = '';
  if (!repoSugItems.length) { el.hidden = true; return; }
  el.hidden = false;
  repoSugItems.forEach((r, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'repo-sug-item' + (i === repoSugActive ? ' sel' : '');
    b.textContent = r;
    b.addEventListener('mousedown', (e) => { e.preventDefault(); repoSugPick(r); });
    el.appendChild(b);
  });
}

function repoSugPick(r) {
  $('#f-repo').value = r;
  repoSugHide();
  $('#f-repo').focus();
}

async function repoSugFetch() {
  const q = $('#f-repo').value.trim();
  try {
    const r = await fetch('/api/repos?q=' + encodeURIComponent(q));
    const j = await r.json();
    if (!r.ok) return;
    repoSugItems = Array.isArray(j.repos) ? j.repos : [];
    repoSugActive = -1;
    repoSugRender();
  } catch (e) { /* server hiccup — leave suggestions as they are */ }
}

function repoSugOnInput() {
  clearTimeout(repoSugTimer);
  repoSugTimer = setTimeout(repoSugFetch, 120);
}

function repoSugOnKey(e) {
  if (!repoSugItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    repoSugActive = (repoSugActive + delta + repoSugItems.length) % repoSugItems.length;
    repoSugRender();
  } else if (e.key === 'Enter' && repoSugActive >= 0) {
    e.preventDefault();
    repoSugPick(repoSugItems[repoSugActive]);
  } else if (e.key === 'Escape') {
    repoSugHide();
  }
}

function initForm() {
  const picker = $('#agent-picker');
  // Delegated: chips are re-rendered whenever the roster changes.
  picker.addEventListener('click', (e) => {
    const chip = e.target.closest('.agent-chip');
    if (!chip) return;
    selectedAgent = chip.dataset.agent;
    syncChipSelection();
    const m = S.agents.find(a => a.name === selectedAgent)?.defModel;
    if (m && [...$('#f-model').options].some(o => o.value === m)) $('#f-model').value = m;
  });
  if (!selectedAgent && S.agents.length) selectedAgent = S.agents[0].name;
  renderChips();

  const modelSel = $('#f-model');
  for (const m of S.models.length ? S.models : ['anthropic.Polaris.Model.Smart.High']) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = MODEL_SHORT(m);
    modelSel.appendChild(o);
  }

  // repo shortcuts: top-level dirs of the two identity trees
  const quick = $('#repo-quick');
  const guesses = ['~/Coding/Self', '~/Coding/Work'];
  for (const g of guesses) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = g.replace('~/', '');
    b.addEventListener('click', () => { $('#f-repo').value = g; $('#f-repo').focus(); repoSugFetch(); });
    quick.appendChild(b);
  }

  const repoInput = $('#f-repo');
  repoInput.addEventListener('input', repoSugOnInput);
  repoInput.addEventListener('keydown', repoSugOnKey);
  repoInput.addEventListener('focus', repoSugOnInput);
  repoInput.addEventListener('blur', () => setTimeout(repoSugHide, 120));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.repo-sug') && e.target !== repoInput) repoSugHide();
  });

  $('#dispatch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#f-task').value.trim();
    if (!text) { $('#form-msg').textContent = 'write the task first'; $('#form-msg').className = 'form-msg err'; return; }
    const followTo = $('#f-task').dataset.followTo || null;
    const ok = await dispatch({
      agent: selectedAgent,
      repo: $('#f-repo').value.trim(),
      task: text,
      model: $('#f-model').value,
      autoApprove: $('#f-auto').checked,
      followTo,
    });
    if (ok) delete $('#f-task').dataset.followTo;
  });

  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('.preset');
    if (b) applyPreset(b.dataset.preset);
  });

  // lane "rename" buttons open the teams dialog
  $('#lanes').addEventListener('click', (e) => {
    if (e.target.closest('.lane-edit')) { e.stopPropagation(); openTeams(); }
  });

  // esc closes the topmost dialog
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (repoSugItems.length) { repoSugHide(); return; }
      if (teamsOpen) { closeTeams(); return; }
      closeDrawer();
    }
  });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);

  $('#teams-btn').addEventListener('click', openTeams);
  $('#teams-close').addEventListener('click', closeTeams);
  $('#teams-backdrop').addEventListener('click', closeTeams);

  $('#clear-btn').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/tasks/finished', { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
    } catch (e) {
      console.error('clear failed:', e.message);
    }
  });

  initTeamsBody();
}

// ---------------------------------------------------------------- teams ----
// Rename the board, rename/recolor/re-model/remove agents, add new ones.
// Renaming an agent also renames its ~/.claude/agents/<name>.md definition.

function openTeams() {
  teamsOpen = true;
  $('#teams-backdrop').hidden = false;
  $('#teams').hidden = false;
  renderTeams();
}
function closeTeams() {
  teamsOpen = false;
  $('#teams-backdrop').hidden = true;
  $('#teams').hidden = true;
}

function teamMsg(el, text, ok) {
  el.className = 'team-msg ' + (ok ? 'ok' : 'err');
  el.textContent = text;
  if (ok) setTimeout(() => { if (el.isConnected) { el.textContent = ''; el.className = 'team-msg'; } }, 2500);
}

function modelOptions(selected) {
  return (S.models.length ? S.models : ['anthropic.Polaris.Model.Smart.High'])
    .map(m => `<option value="${esc(m)}"${m === selected ? ' selected' : ''}>${esc(MODEL_SHORT(m))}</option>`)
    .join('');
}
function colorOptions(selected) {
  return colors()
    .map(c => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`)
    .join('');
}

function renderTeams() {
  const body = $('#teams-body');
  body.innerHTML = '';

  // board name
  const bn = document.createElement('div');
  bn.className = 'team-boardrow';
  bn.innerHTML = `
    <label for="t-board">board name <span class="hint">— the wordmark in the header</span></label>
    <div class="team-inline">
      <input id="t-board" type="text" spellcheck="false" maxlength="40" value="${esc(S.boardName || 'orchestrator')}">
      <button type="button" class="ghost" data-act="save-board">save</button>
    </div>
    <div class="team-msg"></div>`;
  body.appendChild(bn);

  // one row per agent
  const list = document.createElement('div');
  list.className = 'team-list';
  for (const a of S.agents) {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.dataset.agent = a.name;
    row.innerHTML = `
      <div class="team-line">
        <input class="t-name" type="text" spellcheck="false" maxlength="32" value="${esc(a.name)}" aria-label="agent name">
        <select class="t-color" title="lane color">${colorOptions(a.color)}</select>
        <select class="t-model" title="default model">${modelOptions(a.defModel)}</select>
      </div>
      <input class="t-desc" type="text" spellcheck="false" placeholder="description — what this agent is for" value="${esc(a.description || '')}">
      <div class="team-line">
        ${a.busy ? '<span class="t-busy">● has queued/running tasks</span>' : '<span class="t-idle"></span>'}
        <button type="button" class="ghost" data-act="save">save</button>
        <button type="button" class="ghost danger" data-act="remove"${a.busy ? ' disabled title="cancel or wait for its tasks first"' : ''}>remove</button>
      </div>
      <div class="team-msg"></div>`;
    list.appendChild(row);
  }
  body.appendChild(list);

  // add a new agent
  const add = document.createElement('form');
  add.className = 'team-add';
  add.innerHTML = `
    <label>add agent</label>
    <div class="team-line">
      <input class="a-name" type="text" spellcheck="false" maxlength="32" placeholder="name — lowercase, digits, dashes" aria-label="new agent name">
      <select class="a-model">${modelOptions(S.models[0])}</select>
    </div>
    <input class="a-desc" type="text" spellcheck="false" placeholder="what does this agent do? (optional)">
    <div class="team-line">
      <span class="t-idle"></span>
      <button type="submit" class="ghost">add agent</button>
    </div>
    <div class="team-msg"></div>`;
  body.appendChild(add);
}

function initTeamsBody() {
  const body = $('#teams-body');

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'save-board') {
      const msg = $('.team-msg', btn.closest('.team-boardrow'));
      try {
        const name = $('#t-board').value;
        await api('PATCH', '/api/board', { boardName: name });
        S.boardName = name; // SSE may race this fetch; keep the dialog in sync
        $('#board-name').textContent = name;
        document.title = name;
        teamMsg(msg, 'board name saved', true);
      } catch (err) { teamMsg(msg, err.message, false); }
      return;
    }

    const row = btn.closest('.team-row');
    if (!row) return;
    const oldName = row.dataset.agent;
    const msg = $('.team-msg', row);

    if (act === 'save') {
      const cur = S.agents.find(a => a.name === oldName);
      if (!cur) { teamMsg(msg, 'agent no longer on the board', false); return; }
      const patch = {};
      const name = $('.t-name', row).value.trim();
      if (name !== cur.name) patch.name = name;
      if ($('.t-color', row).value !== cur.color) patch.color = $('.t-color', row).value;
      if ($('.t-model', row).value !== cur.defModel) patch.defModel = $('.t-model', row).value;
      const desc = $('.t-desc', row).value.trim();
      if (desc !== (cur.description || '')) patch.description = desc;
      if (!Object.keys(patch).length) { teamMsg(msg, 'no changes', true); return; }
      try {
        const r = await api('PATCH', `/api/agents/${encodeURIComponent(oldName)}`, patch);
        // SSE may race this fetch — apply the change locally so the dialog
        // doesn't flash back to the pre-rename roster.
        const idx = S.agents.findIndex(a => a.name === oldName);
        if (idx !== -1) S.agents[idx] = { ...r.agent, busy: false };
        if (patch.name && selectedAgent === oldName) selectedAgent = patch.name;
        teamMsg(msg, r.warning || 'saved', !r.warning);
        renderTeams(); // re-key rows to the (possibly renamed) roster
      } catch (err) { teamMsg(msg, err.message, false); }
      return;
    }

    if (act === 'remove') {
      const cur = S.agents.find(a => a.name === oldName);
      if (!cur) return;
      if (!confirm(`remove "${cur.name}" from the board?\nIts definition file (~/.claude/agents/${cur.name}.md) is deleted too.`)) return;
      try {
        const r = await api('DELETE', `/api/agents/${encodeURIComponent(oldName)}`);
        teamMsg(msg, `removed (definition: ${r.definition})`, true);
        renderTeams();
      } catch (err) { teamMsg(msg, err.message, false); }
    }
  });

  body.addEventListener('submit', async (e) => {
    const form = e.target.closest('.team-add');
    if (!form) return;
    e.preventDefault();
    const msg = $('.team-msg', form);
    try {
      const created = await api('POST', '/api/agents', {
        name: $('.a-name', form).value,
        defModel: $('.a-model', form).value,
        description: $('.a-desc', form).value,
      });
      teamMsg(msg, `added "${created.name}" — a stub definition was written to ~/.claude/agents/`, true);
      renderTeams();
    } catch (err) { teamMsg(msg, err.message, false); }
  });
}

// ----------------------------------------------------------------- boot ----

(async function boot() {
  try {
    const r = await fetch('/api/state');
    applyState(await r.json());
  } catch (e) {
    document.body.innerHTML = '<pre style="color:#ff5d5d;padding:20px">orchestrator server unreachable — is it running?</pre>';
    return;
  }
  initForm();
  connectSSE();
  $('#board-name').textContent = S.boardName || 'orchestrator';
  document.title = S.boardName || 'orchestrator';
  render();
  // periodic elapsed-time refresh on running cards + waiting durations
  setInterval(() => {
    if (S.tasks.some(t => t.status === 'running')) renderLanes();
    if (S.tasks.some(t => t.status === 'waiting')) renderWaiting();
  }, 1000);
})();
