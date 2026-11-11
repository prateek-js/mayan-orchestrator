# orchestrator

Local dispatch board for Prateek's agent team. Two ways to assign work — the
web board and the `orch` CLI — both feeding the same queue.

## Run it

The server runs as a macOS LaunchAgent (`com.pdesai.orchestrator`), so it
survives terminal closes and reboots, starts at login, and launchd restarts it
if it crashes. `orch start/stop/restart` manage that agent:

```sh
orch start          # register + start the LaunchAgent (idempotent)
orch ui             # open the board in a browser
orch stop           # bootstrap-out the LaunchAgent
```

Or foreground: `node server.js` (or `orch server`). The plist lives at
`~/Library/LaunchAgents/com.pdesai.orchestrator.plist` and is regenerated on
`orch start` whenever its content drifts (e.g. after an nvm default upgrade
moves the node binary).

## Teams — rename the board and its agents

Click **teams** in the header (or a lane's `rename` button) to open the dialog:

- **Board name** — changes the wordmark in the header.
- **Rename an agent** — updates the roster, the lane, the dispatch chips, the
  ledger colors, and **renames the agent's definition file**
  (`~/.claude/agents/<name>.md`, including its frontmatter `name:`), so
  `claude --agent <new>` keeps working.
- **Color / default model** — per agent; description edits are written back
  into the definition's frontmatter.
- **Add agent** — seeds a stub `~/.claude/agents/<name>.md` (a hand-written
  file with the same name is adopted as-is).
- **Remove agent** — deletes its definition file unless the file's frontmatter
  names a different agent.

The roster lives in `config.json` next to `state.json` (seeded on first run)
and survives restarts. Agents with queued/running tasks are locked — cancel or
wait before renaming or removing them. The CLI picks renames up automatically;
`orch agents` lists the live roster.

## Assign tasks

Web UI (http://127.0.0.1:7171) — left rail: pick agent, optional repo
(with autocomplete: recent repos first, then git repos under
`Coding/Self` and `Coding/Work`; ↑/↓ + Enter or click to pick),
task text, model, auto-approve. Cards show live tool activity while running;
ledger below tracks finished work with date·time, project, duration/cost.

Terminal:

```sh
orch "add rate limiting to the login endpoint" --agent tony-stark --repo ~/Coding/Work/go-backend
orch "plan the migration to vite 7" -a dr-strange -r ~/Coding/Self/leeway-web --wait
orch "fix the flaky test" --priority          # jumps the queue
orch ps                        # what's running right now, with live activity
orch ls                        # queued + running
orch log 20                    # last 20 finished
orch result t-1a2b3c4d         # full result of one task
orch cancel t-1a2b3c4d
orch retry t-1a2b3c4d          # requeue failed/cancelled (resumes the session if it can)
orch follow t-1a2b3c4d "now add a settings entry for it" [--agent a] [--wait]
orch agents                    # the board's live agent roster
```

## Follow-ups, handoffs, sessions

- **Follow-ups resume the session** — `orch follow <id> "…"` (and the board's
  **follow-up** button) reuses the finished task's claude session when its
  transcript still exists on disk, so the agent keeps its full memory of the
  work (files it read, decisions it made). If the transcript is gone, the
  server writes a lossless context file (`~/.claude/orchestrator/contexts/<id>.md`,
  full parent task + complete result) and the prompt points the agent at it.
- **Agent handoffs** — agents don't spawn each other (that would be invisible
  to the board). A developer that wants QA to verify its work ends its final
  message with `DISPATCH: hawkeye | <what to verify>`; the board queues a real
  task that *resumes the parent's session*, linked via `↳ parentId` on the
  card. The live roster is injected into every prompt, so renamed agents never
  produce dropped handoffs.
- **Card extras** — finished cards show a git snapshot (branch, dirty-file
  count, latest commit) and links to artifacts the agent wrote
  (plans/decisions/demos under `~/.claude/orchestrator/`).

## Presets

The dispatch rail has two preset buttons that fill the form with a proven
workflow:

- **demo** (spiderman) — build a self-contained HTML demo in
  `~/.claude/orchestrator/demos/`, then verify it with the playwright MCP
  tools (navigate, screenshot, console) and iterate until clean.
- **jira context** (hawkeye) — pull tickets via the atlassian MCP tools and
  produce a context pack: requirement, acceptance criteria, affected files
  (grepped, not guessed), open questions.

## How it works

- Zero-dependency Node server (`server.js`), state in `state.json`, roster and
  board name in `config.json`.
- Each task runs a headless `claude -p --agent <name> --model <m>` process in
  the repo directory, streaming `--output-format stream-json` events; the board
  shows them live over SSE. The stream's `session_id` is captured on the task
  (even for killed runs) and used for resume.
- Concurrency 3 (env `ORCH_CONCURRENCY`), 45-min hard timeout
  (env `ORCH_TIMEOUT_MIN`) **plus an 8-min idle timeout** (env
  `ORCH_IDLE_TIMEOUT_MIN`) — a task that is still streaming is never killed
  mid-run; only silence triggers the kill.
- Priority flag (`--priority` / the card's ▲) jumps the dispatch queue.
- Finished tasks append to the daily log `~/.claude/orchestrator/tasks.md`
  (date in the `## YYYY-MM-DD` heading; each line carries the finish time,
  project, and `↳parentId` for follow-ups:
  `- [board] 14:05 · leeway ↳t-ab12 · <task> — agent (model) → done $1.23`).
- Finished tasks fall out of `state.json` after 7 days (env `ORCH_KEEP_DAYS`;
  tasks.md is the permanent record; context files live 14 days).
- `--no-auto` / unchecking auto-approve runs with `acceptEdits` instead of
  `bypassPermissions` — edits still apply, but the agent is more conservative.

## Notes

- The server is launchd-managed, so it restarts after a crash in ~10s
  (ThrottleInterval); tasks "running" during that window are marked failed on
  the next start (crash recovery) — retry them from the ledger or
  `orch retry`.
- Models available in the picker come from `availableModels` in
  `~/.claude/settings.json`.
