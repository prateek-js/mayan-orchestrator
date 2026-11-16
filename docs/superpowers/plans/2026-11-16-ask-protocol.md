# ASK Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent hits a decision, it ends its turn with an `ASK:` line; the task pauses in `waiting` on the board; Prateek answers (web or CLI); the **same task** resumes the **same claude session** in place.

**Architecture:** Sibling of the DISPATCH protocol. The server parses the ASK line from the final result on clean process close, flips the task to a new `waiting` status (no slot, no process, survives restarts), and a new `POST /api/tasks/<id>/answer` endpoint re-queues the task at priority with a `--resume` leg (or a fresh run + context file when the transcript is gone). UI gets a waiting strip above the lanes with one-click option chips; CLI gets `orch waiting` / `orch answer`.

**Tech Stack:** Zero-dependency Node.js (existing server.js, vanilla JS UI, standalone orch CLI). Tests are zero-dependency node scripts driving an isolated server copy through HTTP with a fake `claude` binary on PATH.

**Spec:** `docs/superpowers/specs/2026-11-16-interactive-ask-design.md` (the plan argues from it; read both)

## Global Constraints

- Zero dependencies: Node stdlib only, in server, UI, CLI, and tests. No npm install, no package.json.
- Tests must NEVER touch the live server (127.0.0.1:7171) or its state.json. Every test runs an isolated server copy on a random port 7500–7999 with `ORCH_DIR` pointed at a temp dir.
- The live server is launchd-managed and currently running — do not restart it as part of any task except the explicit deploy step in Task 6 and E2E in Task 7.
- Repo identity is `/Users/pdesai/Coding/Self/**` → commits use `prateekdesai1990@gmail.com` (repo-local config already set; verify with `git config user.email` before the first commit).
- Every commit message ends with:
  `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- Commit style follows the repo log: imperative summary, no conventional-commit prefixes.
- Status vocabulary stays lowercase strings: `queued`, `running`, `waiting`, `done`, `failed`, `cancelled`.

## Review Focus

The five inputs most likely to bite a person, each pinned by a test in its owning task:

1. A result that *quotes* the protocol mid-prose ("Earlier I sent: ASK: …" not at line start) must complete as `done`, never wait — Task 2, `mid-prose ask ignored` test.
2. An empty/whitespace answer (`"  "`) must be rejected 400 and leave the task waiting — Task 3.
3. Answering a task whose agent was renamed/removed while waiting must fail 400 with recovery guidance, never spawn under a stale name — Task 3.
4. Double-submitting an answer (two chip clicks) must resume once; the second gets 409 — Task 3.
5. An ASK line with >4 options or pipes inside option text yields the question plus the first 4 options, remainder ignored — Task 1 parser tests.

---

### Task 1: Test harness, ORCH_DIR override, and the ASK parser

**Files:**
- Create: `ask.js` (new module — the one pure function, testable without the server)
- Create: `test/helpers.mjs`, `test/fake-claude.mjs` (installed as a fake `claude` executable)
- Create: `test/ask.test.mjs`
- Modify: `server.js:40` (ORCH_DIR env override)

**Interfaces:**
- Produces `ask.js`: `parseAsk(text: string) -> { question: string, options: string[] } | null`
- Produces `test/helpers.mjs` (used by Tasks 2, 3, 5):
  - `startServer() -> { port, stop(), tmpDir, orchDir, stateFile, setScenario(invocations), argsLog(), readState() }` — copies `server.js`, `ask.js`, `public/` to a fresh temp dir, writes `config.json` seeding the five real agent names (tony-stark, dr-strange, vision, hawkeye, spiderman), spawns `node server.js` with `ORCH_PORT` (random 7500–7999), `ORCH_DIR` (temp), and `PATH` prepended with the fake-claude bin dir; resolves when `/health` responds (5s timeout).
  - `seedTask(stateFile, overrides) -> task` — writes a `state.json` containing one task merged over the exact field shape of `queueTask()` in server.js (id `t-test0001`, agent `tony-stark`, status `waiting`, `ask`, `qa: []`, `sessionId: 'sess-test-0001'`, `cwd`, `activity: []`, model, autoApprove true, timestamps). Must be called before `startServer()` (state loads at boot).
  - `plantTranscript(sessionId, cwd) -> cleanup()` — creates `~/.claude/projects/<munged-realpath-cwd>/<sessionId>.jsonl` with one dummy line so `sessionTranscriptExists()` passes; cleanup unlinks it.
  - Fake-claude contract (spec'd here, it's load-bearing): `test/fake-claude.mjs` is a node script copied into `<tmp>/bin/claude` (chmod +x). Env: `FAKE_SCENARIOS` (JSON file) and `FAKE_ARGS_LOG`. On each invocation it (1) appends one JSON line `{"args": [...], "cwd": "..."}` to the args log, (2) shifts invocation N's event array off the scenarios file (rewrite file with the rest), (3) writes each event as one JSON line to stdout with 20ms gaps, (4) exits 0. A `result` event carries `session_id: 'sess-test-0001'`, `is_error: false`, `total_cost_usd`, `duration_ms`.

- [ ] **Step 1: Write the failing parser tests** in `test/ask.test.mjs` — plain `node:assert` + `node:test`, covering: simple ask with two options; no options (`ASK: question?` alone → `options: []`); first ASK wins when two line-anchored ASKs exist; mid-prose (not line-start) ASK returns null; lowercase `ask:` returns null; >4 options keeps first 4; empty question (`ASK: | a | b`) returns null; leading whitespace before ASK on its line is still accepted (`  ASK: …` after `\n`); CRLF line endings tolerated.

- [ ] **Step 2: Run to verify failure** — `node --test test/ask.test.mjs` → FAIL (cannot find module `../ask.js`).

- [ ] **Step 3: Implement `ask.js`** — `parseAsk`: multiline-anchored regex `/^[ \t]*ASK:[ \t]*(.+?)[ \t]*$/im`; split capture on `|`; `question = parts[0].trim()`; `options = parts.slice(1).map(s => s.trim()).filter(Boolean).slice(0, 4)`; return null if no match or empty question. Export via `module.exports = { parseAsk }`.

- [ ] **Step 4: Run to verify pass** — `node --test test/ask.test.mjs` → all PASS.

- [ ] **Step 5: ORCH_DIR override in server.js** — change line 40 to `const ORCH_DIR = process.env.ORCH_DIR || path.join(os.homedir(), '.claude', 'orchestrator');` (TASKS_MD and CONTEXTS_DIR derive from it; nothing else changes).

- [ ] **Step 6: Build the harness** (`test/helpers.mjs` + `test/fake-claude.mjs`) per the contract above. `startServer()` must fail loudly if port 7171 responds first (guards against testing the live board).

- [ ] **Step 7: Harness smoke test** — add to `test/ask.test.mjs`: start server with a scenario whose result contains `ASK: red or blue? | red | blue`, poll `readState()` until the seeded/dispatched task's status is `waiting`, `stop()`. Run file → PASS.

- [ ] **Step 8: Commit** — `git add ask.js test/ server.js && git commit -m "test harness: isolated server + fake claude + ASK parser"` (with Co-Authored-By trailer).

### Task 2: Waiting status in the server lifecycle

**Files:**
- Modify: `server.js` — close handler (~line 695), `agentBusy` (~line 127), `pruneOldTasks` (~line 328), `pruneContexts` untouched, `cancelTask` (~line 823), `startTask` reset block (~line 555), POST `/api/tasks` followTo guard (~line 1104), `DELETE /api/tasks/finished` (~line 1141)
- Create: `test/waiting.test.mjs`

**Interfaces:**
- Consumes: `parseAsk` (Task 1).
- Produces: task fields `status: 'waiting'`, `ask: { question, options: string[], askedAt: number }`, `qa: [{ q, a, at }]` (empty array until first answer — created in Task 3, but initialize `qa: []` here on transition). `queueTask()`'s task shape gains `ask: null, qa: []`.
- Produces semantics later tasks rely on: waiting tasks are ignored by `dispatchLoop`, don't count in `agentBusy`, are preserved by `pruneOldTasks` and `DELETE /api/tasks/finished`, can be cancelled, reject retry (existing 409) and reject follow-ups targeting them (new 409).

- [ ] **Step 1: Write failing tests** in `test/waiting.test.mjs`:
  - `clean close with ASK result → waiting`: dispatch fake task (scenario result text ends with `\nASK: Which store? | redis | mem`), poll → status `waiting`, `ask.question === 'Which store?'`, `ask.options` deep-equal `['redis','mem']`, `qa` is `[]`, task has NO `finishedAt`; tasks.md in `orchDir` was NOT written; no `git` snapshot on the task.
  - `mid-prose ASK ignored`: result text `We could do A. Earlier I wrote: ASK: fake | x` (ASK not line-anchored) → status `done`.
  - `waiting survives restart`: stop server, start a new one on the same tmpDir/state → status still `waiting`.
  - `waiting preserved by prune + clear-finished`: seed a waiting task with `createdAt` 8 days ago → still present after boot; `DELETE /api/tasks/finished` → still present; a `done` task from 8 days ago IS pruned.
  - `waiting not busy`: seed waiting task, `PATCH /api/agents/tony-stark {color:'--plan'}` → 200 (rename/remove not locked).
  - `cancel from waiting`: POST cancel → `cancelled`, ledger line written to tasks.md, `finishedAt` set.
  - `retry + followTo rejected`: POST retry on waiting → 409; POST /api/tasks with `followTo` targeting the waiting task → 409.
  - `handoff + ask same message`: scenario assistant text contains a `DISPATCH: vision | do X` line, result ends with an ASK → waiting, activity contains "handoff registered", and NO vision task queued yet.

- [ ] **Step 2: Run to verify failure** — `node --test test/waiting.test.mjs` → FAIL (tasks land `done`, no `ask` field).

- [ ] **Step 3: Implement in server.js**:
  - Close handler: inside the `else if (code === 0 || code === null)` branch, before assigning `done`: `const ask = task.result ? parseAsk(task.result) : null;` — if `ask`, set status `waiting`, `task.ask = { question, options, askedAt: Date.now() }`, `task.qa = task.qa || []`, `addActivity(task, 'sys', 'waiting for Prateek: ' + ask.question)`; skip the done-only block (`attachGitSnapshot`, `findArtifacts`, `appendTasksMd`, `queueHandoffs`) by keying it on `task.status === 'done'` as it already is.
  - `queueTask()` shape: add `ask: null, qa: []` next to `retryOf`.
  - `agentBusy`: unchanged code — add a comment noting waiting intentionally doesn't count.
  - `pruneOldTasks` and the DELETE finished filter: `['queued', 'running', 'waiting']`.
  - `cancelTask`: treat `waiting` exactly like the `queued` branch (direct cancel, ledger line).
  - `startTask` reset block: also `task.isError = false;` (stale `isError` from a previous leg would mislabel the next close) and `task.ask = null;` (a resumed leg clearing the live question).
  - POST `/api/tasks`: when `body.followTo` is set and `getTask(body.followTo)?.status === 'waiting'` → 409 `{ error: '<id> is waiting for an answer — answer it instead of following up' }`.

- [ ] **Step 4: Run to verify pass** — `node --test test/waiting.test.mjs` and `node --test test/ask.test.mjs` → all PASS.

- [ ] **Step 5: Commit** — `git add server.js test/waiting.test.mjs && git commit -m "ASK protocol: waiting status on the board"`.

### Task 3: Answer endpoint, resume leg, fallback leg

**Files:**
- Modify: `server.js` — new `answerTask()` near `retryTask` (~line 877), route after the cancel/retry route (~line 1139), `startTask` prompt/args composition (~line 589), `writeContextFile` (~line 781), duration handling (~line 678 + close fallback ~line 717)
- Create: `test/answer.test.mjs`

**Interfaces:**
- Consumes: waiting lifecycle (Task 2), helpers (Task 1).
- Produces: `POST /api/tasks/t-<hex>/answer` body `{ text: string }` → `200` with the updated task (status `queued`, `priority 1`, `ask: null`, `qa` appended) | `404` no such task | `409` not waiting or already answered | `400` empty text or agent no longer exists.
- Produces `startTask` behavior for answer legs: when `task.answerText` is set — resume `task.sessionId` with prompt `[answer from Prateek] <text>` when the transcript exists; otherwise a fresh run whose context file holds the task, prior result, and full `qa`. In both cases the roster + ASK injection lines ride along (Task 3 adds the ASK injection line; roster line already exists).

- [ ] **Step 1: Write failing tests** in `test/answer.test.mjs`:
  - `answer resumes same session`: seed waiting task with `sessionId` + `plantTranscript`; scenario leg 2 result `final answer done` with `total_cost_usd: 0.08, duration_ms: 2000` (task pre-seeded `costUsd: 0.05, durationMs: 1000`); POST answer `{text: 'use redis'}` → 200, status `queued` with `priority 1`; poll → `running` → `done`; assert: `qa` deep-equals `[{ q: <ask.question>, a: 'use redis', at } ]`; fake-claude args log contains `--resume` and `sess-test-0001`; prompt contains `[answer from Prateek] use redis`; `costUsd === 0.08` (assigned, NOT 0.13); `durationMs === 3000` (summed); exactly one ledger line; result on the task is `final answer done`.
  - `answer falls back to fresh leg when transcript gone`: same but NO planted transcript → args log has no `--resume`; context file exists under `orchDir/contexts/<id>.md` containing the original task text, prior result, and the question/answer pair; prompt contains `Read` + the context path.
  - `answer validation`: POST on a `done` task → 409; empty text → 400 and task still `waiting`; unknown id → 404.
  - `answer after agent renamed`: rename the agent (PATCH roster), POST answer → 400 naming the agent, task still `waiting`, nothing spawned.
  - `double answer`: two rapid POSTs → first 200, second 409; fake claude invoked exactly once.
  - `slots respected`: seed 3 running tasks (fake scenarios that never finish: long sleep in fake claude via scenario flag), `ORCH_CONCURRENCY: 3`; answer a waiting task → status stays `queued` (never `running`) until a slot frees.
  - `DISPATCH after answer still resolves`: leg 1 registers a DISPATCH (Task 2 scenario shape), answer, leg 2 result clean → on `done`, a vision task exists with `parentId` = the answered task's id.
  - `answer survives server restart`: seed waiting + transcript, stop server, start new server on same tmpDir, POST answer → leg runs.

- [ ] **Step 2: Run to verify failure** — `node --test test/answer.test.mjs` → FAIL (404 no route).

- [ ] **Step 3: Implement**:
  - `answerTask(task, text)`: validate status/agent (error strings per Interfaces); push `{ q: task.ask.question, a: text, at: Date.now() }` to `task.qa`; `task.ask = null`; `task.priority = 1`; `task.answerText = '[answer from Prateek] ' + text`; `task.status = 'queued'`; if `!sessionTranscriptExists(task.sessionId, task.cwd)` → `task.contextFile = writeAnswerContext(task)`; `addActivity(task, 'sys', 'answer received — requeued at priority')`; log + save + broadcast; `dispatchLoop()`.
  - `writeAnswerContext(task)`: like `writeContextFile` but source is the task itself — sections: task text, full previous result, `### Questions and answers` (each `q`/`a`). Return the path (overwrites `contexts/<id>.md` — the qa chain supersedes any parent context for the fresh leg).
  - Route: `POST /api/tasks/:id/answer` alongside cancel/retry (extend the existing regex).
  - `startTask`: when `task.answerText` — build `promptParts` as: if transcript exists (`--resume` leg): `[answerText, 'Repo: …' (when repo), roster line, ASK injection line (placeholder string constant now, real text lands in Task 4 — define it as `ASK_HINT` in this task so Task 4 only fills it)]`; if fallback leg: `['Read ' + task.contextFile + ' first — it has the full task, the prior result, and the question/answer history. Prateek answered your question — continue the task:', answerText, repo line, roster line, ASK_HINT]`. Pass `--resume task.sessionId` in the resume case. Reset per-leg state but PRESERVE `task.activity` (append `addActivity(task, 'sys', 'resumed with Prateek's answer')`); reset `result`, `error`, `isError` (Task 2 already added isError reset). Log line: `dispatch <id> (answer leg, resume|fresh)`.
  - Duration: result-event handler becomes `task.durationMs = (task.durationMs || 0) + ev.duration_ms;` and the close-handler fallback becomes additive the same way.
  - Cost stays as-is (already assignment — verified cumulative).

- [ ] **Step 4: Run to verify pass** — all three test files PASS.

- [ ] **Step 5: Commit** — `git add server.js test/answer.test.mjs && git commit -m "ASK protocol: answer endpoint, resume + fallback legs"`.

### Task 4: Teach the agents — definitions, stub, prompt injection

**Files:**
- Modify: `server.js` — `promptParts` composition (fresh + all resume legs) and `stubAgentMd` (~line 177)
- Modify (outside repo, NOT in git): `~/.claude/agents/{tony-stark,dr-strange,vision,hawkeye,spiderman}.md`

**Interfaces:**
- Consumes: `ASK_HINT` constant (Task 3).
- Produces: `ASK_HINT` filled with the spec's exact injection text; the canonical definition paragraph below present in all five agent files and in `stubAgentMd`.

- [ ] **Step 1: Fill `ASK_HINT`** with the spec's exact text (single string, newlines preserved):
  `[Board: if a decision needs Prateek, end your turn with a final line\n"ASK: <question> | <option> | <option>" — the task pauses for his answer\nand this session continues afterward. Never guess and never ask mid-run.]`

- [ ] **Step 2: Add to `stubAgentMd`** a bullet (placed right after the DISPATCH bullet, same wording as the canonical paragraph below, formatted as a list item).

- [ ] **Step 3: Bake the definitions.** For each of the five files, insert immediately after the line containing `use exactly those.` (the DISPATCH paragraph's last line — exactly one such line per file), one blank line then this bullet, verbatim:

  ```
  - Do not guess at decisions Prateek should make (design forks, trade-offs,
    scope changes). Instead, end your turn with a final line:
    ASK: <question> | <option A> | <option B>
    (options optional, up to 4). The board pauses the task until he answers,
    then this same session continues with the answer. Make ASK the ending of
    your turn — nothing after it; if you also need to hand off work
    (DISPATCH), do that after the answer comes back.
  ```

  Edit in place; never regenerate. Skip any file already containing an `ASK:` bullet (idempotent).

- [ ] **Step 4: Verify** — for each of the five files: `grep -c 'ASK:' <file>` returns 1; frontmatter intact (`head -4` shows `name:`, `description:`, `model:` unchanged — diff against `git`-less originals via the `ask:`-only rule: `diff` each file against its pre-edit copy taken in this step before editing).

- [ ] **Step 5: Test the stub** — extend a case in `test/waiting.test.mjs`: POST `/api/agents` to add a temp agent, read `~/.claude/agents/<temp>.md`, assert it contains `ASK:`, delete the agent (cleanup). Run suite → PASS.

- [ ] **Step 6: Commit** — repo files only: `git add server.js test/waiting.test.mjs && git commit -m "teach agents the ASK protocol (definitions + prompt injection)"`. (The five definition files live outside the repo — noted in the commit body, no path trickery.)

### Task 5: Board UI — waiting strip, chips, drawer answering

**Files:**
- Modify: `public/index.html` (waiting strip section above `.lanes`; drawer qa + answer form)
- Modify: `public/app.js` (~867 lines: `renderWaiting`, `cardForWaiting`, drawer answer form, `renderConc`, periodic refresh, escape-hatch `other…`)
- Modify: `public/style.css` (strip, `st-waiting`, chips, qa rows)

**Interfaces:**
- Consumes: task fields `ask`/`qa`/`status` (Tasks 2–3); `POST /api/tasks/<id>/answer` (Task 3).
- Produces: `.waiting-strip` section; `#drawer-answer` textarea + `#drawer-answer-send` button.

- [ ] **Step 1: index.html** — inside `.board`, before `<section class="lanes">`: `<section class="waiting-strip" id="waiting-strip" hidden></section>`. In the drawer, after `#drawer-result`: `<div class="drawer-qa" id="drawer-qa" hidden></div>` and `<div class="drawer-answer" id="drawer-answer-wrap" hidden><textarea id="drawer-answer" rows="3" placeholder="answer the question…"></textarea><button type="button" class="submit" id="drawer-answer-send">Answer</button></div>`.

- [ ] **Step 2: app.js**:
  - `waitingTasks()` = tasks with status `waiting`, oldest `ask.askedAt` first.
  - `renderWaiting()` (called from `render()`): hides the strip when empty; otherwise head `waiting — n`, one card per task: card top (id + `waiting` status), agent line (colored dot + name via `agentColor`), task text, question line prefixed `❓ `, option chips (buttons, max 4) + an `other…` dashed button that opens the drawer with the textarea focused; meta line `repo · <model> · waiting <fmtDur(now - ask.askedAt)>`. Chip click → `api('POST', '/api/tasks/' + t.id + '/answer', { text: option })`; on error show the message in the strip head.
  - `tasksForLane` already excludes waiting (it filters queued/running) — no change; `finishedTasks()` excludes waiting (not in its filter) — leave as is; ledger stays terminal-only.
  - `renderConc()`: append `· waiting <n>` when n > 0.
  - Drawer (`renderDrawer`): when `t.qa?.length`, fill `#drawer-qa` with one row per round (`q` at time, `a` below, styled like `.drawer-activity` lines with a `k-ask` kind class); when status `waiting`, show the answer wrap and the current question at top of qa; send button → same answer POST, clears textarea; cancel button already offered for queued/running — extend the condition to include `waiting`.
  - Periodic 1s refresh: extend the existing interval's condition to `['running', 'waiting'].includes(t.status)` so waiting durations tick.

- [ ] **Step 3: style.css** — add `--ask: #4dd0e1;` to `:root` (cyan — unused by any lane/status color); `.st-waiting { --st: var(--ask); }` + status-text rule alongside the existing status block; `.waiting-strip` styled like a lane (panel background, `border-top: 2px solid var(--ask)`), cards horizontal-flex wrap so multiple questions sit side by side; `.ask-chip` styled like `.ghost` with `--ask` hover border; `.drawer-qa` rows reuse drawer line styles; `#drawer-answer` reuses existing textarea styles.

- [ ] **Step 4: Verify in a real browser (no API cost)** — seed a harness server: waiting task with 3 options + a leg-2 scenario; start it (`node -e` script using `test/helpers.mjs`); open `http://127.0.0.1:<port>`; confirm: strip above lanes with count in header (`slots … · waiting 1`), chips render, lane heads unchanged, ledger empty. Click a chip → card leaves the strip, lands in its lane as running → done; ledger shows ONE line. Re-run with a second seeded task to verify the drawer textarea path. (Use the playwright MCP tools to screenshot if working headlessly.)

- [ ] **Step 5: Commit** — `git add public/ && git commit -m "board UI: waiting strip with one-click answers"`.

### Task 6: CLI — bin/orch in the repo, waiting/answer commands

**Files:**
- Create: `bin/orch` (copied from `~/.local/bin/orch`, then extended; executable bit on)
- Modify (outside repo): `~/.local/bin/orch` — replaced by deploy copy after a dated backup

**Interfaces:**
- Consumes: `POST /api/tasks/<id>/answer`, `status: 'waiting'`, `ask` fields (Tasks 2–3).
- Produces: `orch waiting`, `orch answer <id> "text"`; `orch ls`/`orch ps` include waiting; `--wait` blocks through waiting.

- [ ] **Step 1: Bring the CLI home** — `cp ~/.local/bin/orch ~/.local/bin/orch.bak-ask-2026-11-16` (dated backup, precedent `orch.bak-teams`); `mkdir -p bin && cp ~/.local/bin/orch bin/orch && chmod +x bin/orch`.

- [ ] **Step 2: Extend bin/orch**:
  - Help text: add `orch waiting` and `orch answer <id> "text"` lines (alphabetical-ish placement near follow).
  - `cmdWaiting()`: from `/api/state`, filter status `waiting`, for each print `` ⏸  <id>  <agent>  <repo?short>  — <question> `` then options as `     options: a / b / c` (dim), then `     waiting <fmtDur(now - ask.askedAt)>`; empty state → `nothing waiting`; tail hint `answer with: orch answer <id> "text"`.
  - `cmdAnswer(id, textParts)`: require id + non-empty joined text (usage + exit 2 otherwise); POST answer; print `answered <id> → requeued (priority)` + dim watch hint.
  - Wire both into the `main()` switch.
  - `cmdLs`: include waiting rows tagged dim `wait ` between queued and running sort groups; summary line gains `· N waiting`.
  - `cmdPs`: after the running section, a waiting section per task: id/agent/model + `waiting <dur>` + the question line + options line.
  - `--wait` loops (cmdDispatch and cmdFollow): condition arrays become `['queued', 'running', 'waiting']` — blocking through waiting is the documented v1 semantics (no interactive answering inside the loop).

- [ ] **Step 3: Deploy** — `cp bin/orch ~/.local/bin/orch` (the repo copy is now source of truth).

- [ ] **Step 4: Verify against the live server (read-only first)** — `orch waiting` (empty output ok), `orch ls`, `orch status`. Then a real round-trip using the Task 7 seeded waiting task if it exists, else skip to Task 7's E2E which exercises `orch answer`.

- [ ] **Step 5: Commit** — `git add bin/orch && git commit -m "orch CLI: waiting/answer commands; move CLI into bin/"`.

### Task 7: README + real-agent end-to-end verification

**Files:**
- Modify: `README.md` (ASK section under "Follow-ups, handoffs, sessions"; CLI block; install note for bin/orch)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–6.

- [ ] **Step 1: README** — add a subsection **Decisions — the ASK protocol**: what the marker looks like, waiting semantics (no slot, no expiry, cancel to abandon), answering from card/drawer/CLI, cost = session-cumulative & duration = summed legs. CLI block: `orch waiting`, `orch answer`. Install note: the CLI's source of truth is `bin/orch` in this repo; `cp bin/orch ~/.local/bin/orch` deploys it. Server "How it works" list: add the `waiting` status to the concurrency sentence.

- [ ] **Step 2: Scripted regression** — `node --test test/` → all files PASS (spec scenarios 3, 4, 5 are covered by `answer survives server restart`, the fallback test, and the mid-prose test).

- [ ] **Step 3: Real-agent E2E (spec scenarios 1, 2, 6, 7 — live board, real tokens, tiny tasks)**:
  1. Dispatch: `orch "Ask me one question via the board's ASK protocol: which of two demo names should I use, 'atlas' or 'comet'? Then stop." --agent spiderman --repo ~/Coding/Self/orchestrator` → wait for `waiting` (poll `orch waiting`) → answer via card chip → confirm same card, `orch result <id>` shows the follow-through, one ledger line, session id on the card unchanged. Then repeat the answer round once more (a second ASK) to confirm multi-round on one session.
  2. Answer a waiting task via `orch answer <id> "…"` (scenario 2's CLI leg).
  3. Scenario 7 (unprompted): `orch "Plan whether leeway-web should adopt vite 7 — if the decision is genuinely open, ask me rather than guessing." -a dr-strange -r ~/Coding/Self/leeway-web` → expect `waiting` with the agent's own question, no ASK mention in the task text.
  4. Scenario 6: after an ask/answer chain completes `done` with a `DISPATCH:` line in the final result, confirm the handoff task appears with `↳parentId`.
  File any failure as a bug fix task against the owning component, not a plan edit.

- [ ] **Step 4: Commit** — `git add README.md && git commit -m "docs: ASK protocol in README"`.

---

## Verification map (spec → where proven)

| Spec scenario | Proven in |
|---|---|
| 1. two rounds, one session, cost/duration honest | Task 3 scripted + Task 7 manual |
| 2. free-text via drawer + CLI | Task 5 browser check + Task 6/7 |
| 3. restart while waiting | Task 2 + Task 3 scripted |
| 4. transcript gone → fresh leg + context file | Task 3 scripted |
| 5. mid-prose ASK ignored | Task 2 scripted |
| 7. unprompted ASK from baked definitions | Task 7 manual |
| 6. DISPATCH after answer resolves | Task 3 scripted + Task 7 manual |
