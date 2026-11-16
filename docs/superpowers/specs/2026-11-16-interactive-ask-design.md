# Interactive decisions — the ASK protocol

Date: 2026-11-16 · Status: approved approach, pending plan · Board: mayan-orchestrator

## Intent and why

Today an agent that hits a decision mid-task has two bad options: guess
silently, or end the task ("done") and wait for Prateek to notice and fire a
follow-up. Every decision therefore costs a dead task, a new ledger line, and
a context reload. This change adds a third option: the agent ends its turn
with a question, the task pauses in `waiting` on the board, Prateek answers
(card, drawer, or CLI), and the **same task resumes the same claude session**
in place — same card, same ledger line, full conversational memory.

## Goals

- An agent can ask Prateek a question and get an answer without the task
  ending: one task, N ask/answer rounds, all on one card.
- Asking costs the board nothing: a waiting task holds no concurrency slot
  and no process.
- The answer continues the agent's session via `--resume`, with a lossless
  context-file fallback when the transcript is gone (same machinery as
  follow-ups).
- Both surfaces work: web board (one-click options + free text) and `orch`
  CLI (`orch waiting`, `orch answer`).

## Non-goals (v1)

- No mid-run interjection into a still-streaming process — questions happen
  at turn boundaries only.
- No permission-style prompts (auto-approve flow stays untouched).
- No push notifications / sound when a task starts waiting — the board card
  and `orch waiting` are the surface.
- No mobile layout work.

## Anti-goals (failure even if it works)

- A waiting task that consumes a concurrency slot or blocks the queue.
- Answering that silently starts a *different* task (new card, new ledger
  line) — that's the behavior being replaced.
- The resume leg losing the roster injection (DISPATCH handoffs after an
  answer must still work).

## Constraints

- Zero-dependency Node server; state in `state.json`; server is
  launchd-managed and restarts on crash — waiting must survive restarts.
- Agents are headless `claude -p` runs; the only continuation mechanism is
  `--resume <sessionId>` (proven in follow-ups) or a fresh run with a context
  file.
- Verified 2026-11-16 (probe): `claude -p --input-format stream-json
  --output-format stream-json` keeps one process alive across turns with a
  stable session id — this makes approach C possible later, but A does not
  need it.
- `orch` CLI is a standalone script at `~/.local/bin/orch`, not part of this
  repo; changes there are deployed by copying.

## Approaches considered

1. **ASK marker + same-task resume (chosen).** Sibling of the DISPATCH
   protocol: agent ends a turn's final message with
   `ASK: <question> | <option> | <option>`. Server flips the task to
   `waiting` instead of `done`; answering resumes the same task with
   `claude --resume`. Reuses the proven resume machinery; no process held
   while waiting; restart-safe (waiting is just state.json).
   Trade-off: relies on agents emitting the marker correctly (same risk
   DISPATCH already carries and handles).
2. **Blocking MCP tool (`ask_user`).** A tool call that long-polls the board,
   pausing the agent mid-run. Most elegant, but holds a live process per
   waiting task, needs MCP plumbing + tool-timeout tuning, and a blocked
   call must survive launchd restarts. Rejected for v1 complexity.
3. **Immediate-return MCP tool.** Tool records the question and tells the
   agent to end its turn; detection is a tool call, not a regex. More
   reliable than the marker but needs an MCP server; keep as the drop-in
   upgrade if markers prove flaky in practice.

Prateek picked 1.

## The protocol

A task's final result text may contain one line:

```
ASK: <question> | <option A> | <option B> | ...
```

- Options are optional (0+); the UI always offers free text regardless.
- Exactly one ASK per turn is acted on — the first — to keep the state
  machine simple.
- Matching is anchored to line start (`^ASK:\s`), same style as the DISPATCH
  regex (which learned dashes the hard way on 2026-11-11 — agent names don't
  appear here, but the lesson generalizes: keep the regex permissive about
  spacing, strict about structure).

## Server behavior

**Detection.** In the stream handler, the existing `result` event already
captures the final text. On clean process close (exit 0 or null, not
`isError`, not cancelled, not idle/timeout-killed): parse the result for the
ASK line. Found → task becomes `waiting`; not found → `done` as today.
Mid-run text blocks are **not** scanned for ASK — only the final result — so
an agent quoting the protocol in prose can't trip it. DISPATCH scanning
stays exactly as is.

**New task fields.**

- `status: 'waiting'` — a real status, persisted; lane counts, ledger
  filters, and `agentBusy` semantics updated for it.
  - **`agentBusy` does NOT count waiting** (builder-call, 2026-11-16): a
    forgotten question must never lock rename/remove indefinitely. Instead
    the answer leg re-resolves the agent at spawn time: if the roster no
    longer has `task.agent`, the answer fails with a clear error naming the
    situation (same failure style as the existing "agent no longer exists"
    retry guard) rather than running under a stale name. Lane rendering
    already keys off live roster names — the UI shows waiting cards in a
    separate "waiting" strip, not inside per-agent lanes (see UI section), so
    a renamed agent never hides a waiting card either.
- `ask: { question, options[], askedAt }` — the live question while waiting.
- `qa: [{ q, a, at }, ...]` — every round's question and Prateek's answer,
  kept on the task for the context file and the drawer.

**Answering.** `POST /api/tasks/<id>/answer { text }`:

- Valid only from `waiting`. On answer, the task re-enters the **queue**
  (status `queued`, `priority 1` so it jumps unrelated line-waiters) and
  `dispatchLoop` spawns it as a resume leg when a slot frees — never a
  direct spawn that could show `slots 4/3` (builder-call, 2026-11-16).
  Rationale: answers are time-sensitive but not slot-breaking; priority
  already encodes "next pick". The leg is spawned with
  `claude --resume <sessionId>` using the answer as the user message,
  prefixed `[answer from Prateek] `, plus the same roster-injection line
  fresh runs get (so post-answer DISPATCH handoffs never reference stale
  names).
- If the session transcript is gone (`sessionTranscriptExists` fails), fall
  back to a fresh run whose context file carries the parent task, the full
  result, and the whole `qa` history — extend `writeContextFile` for this.
- Runs through the same spawn path as `startTask` (timers, stream parsing,
  close handler) via a resume branch, like follow-ups do.
- Verified by probe 2026-11-16 (three-leg `--resume` chain): **session id is
  stable across resume legs** — every leg reports the same `session_id`, so
  the server's capture-once logic (`if (ev.session_id && !task.sessionId)`)
  needs no change and a round-2 answer can never silently resume the wrong
  leg's session.
- Cost: `total_cost_usd` is **session-cumulative**, not per-invocation
  (verified: after a $0.17 big leg, a tiny leg reported $0.18 — it stayed
  high). So **assign, never sum**: `task.costUsd = ev.total_cost_usd` each
  leg. The field name says total and means it; `+=` would double-count.
- Duration: `duration_ms` is per-invocation (verified: legs reported
  3150/2534 ms, no accumulation). Sum across legs:
  `task.durationMs = (task.durationMs || 0) + ev.duration_ms`.

**Waiting lifecycle.**

- Waiting tasks hold no slot (the process already exited) and the dispatch
  loop ignores them. Both timers are disarmed while waiting (no process);
  the hard 45-min ceiling applies to each running leg, not to wall-clock
  waiting time. No auto-expiry — Prateek cancels if he changes his mind.
- Cancel from waiting is allowed → `cancelled`, ledger line written.
- `tasks.md` gets its line only when the task reaches a terminal status.
  Waiting never writes the ledger; answering never creates a second line.
- DISPATCH + ASK in the same final message: handoffs are registered but
  queue only on eventual terminal `done` (queueHandoffs already runs on
  close-with-done; keep it that way).
- Restart while waiting: `loadState` must leave `waiting` tasks waiting
  (today it only fails `running` ones). Answering after a restart works if
  the transcript exists — same check as follow-ups.
- Retry of a waiting task: not offered (cancel instead).
- Follow-up onto a waiting task: out of scope; the UI only prefills from
  finished tasks, and the server should reject follow-up dispatches whose
  `followTo` target is `waiting` (cheap guard, same session would otherwise
  get two writers).

**Teaching agents the protocol — two channels.**

1. **Baked into the definitions (Prateek's call, 2026-11-16).** Each of the
   five hand-written files in `~/.claude/agents/` gets one canonical
   paragraph inserted directly after its DISPATCH paragraph, identical
   wording in all five so the files stay uniform:

   ```
   - Do not guess at decisions Prateek should make (design forks, trade-offs,
     scope changes). Instead, end your turn with a final line:
     ASK: <question> | <option A> | <option B>
     (options optional, up to 4). The board pauses the task until he answers,
     then this same session continues with the answer. Make ASK the ending of
     your turn — nothing after it; if you also need to hand off work
     (DISPATCH), do that after the answer comes back.
   ```

   These files are edited **in place** — never regenerated — preserving
   frontmatter and all role-specific content (they live outside the repo and
   aren't in git; the teams dialog's rename/description writers only touch
   their own lines, so the paragraph survives roster edits).

2. **Prompt injection stays.** Every dispatch (fresh and resume legs) keeps
   a line alongside the roster injection:

   ```
   [Board: if a decision needs Prateek, end your turn with a final line
   "ASK: <question> | <option> | <option>" — the task pauses for his answer
   and this session continues afterward. Never guess and never ask mid-run.]
   ```

   It covers adopted hand-written definitions and stubs that predate this
   change, and it's free. `stubAgentMd` also gains the protocol so newly
   added agents learn it from day one.

## UI (web board)

- **Waiting tasks live above the lanes, not in them** (builder-call,
  2026-11-16): a single "waiting" strip at the top of the lanes area holds
  all waiting cards regardless of agent — questions are the one thing on
  the board that need Prateek, so they shouldn't hide inside an agent lane
  (and a renamed/removed agent must never hide one). Lane counts stay
  queue/running only; the strip has its own count.
- **Waiting card** — distinct style (`st-waiting`): agent chip + question
  text prominent, option chips beneath (up to 4, one click = answer +
  resume), and "other…" to answer free-text. Card meta shows
  `waiting <duration>` instead of elapsed-run.

```
┌ t-1a2b3c4d ────────────────── waiting ┐
│ add rate limiting to login endpoint   │
│ ❓ Which store should back the limiter?│
│ [redis] [in-memory] [other…]          │
│ repo · polaris·high · waiting 4m      │
└───────────────────────────────────────┘
```

- **Drawer** — full question, the `qa` history (each round: question,
  answer, time), a textarea + send button when waiting; cancel available.
- **Counts** — the header slot line gains a waiting count
  (`slots 2/3 · queued 1 · waiting 2`); the waiting strip head shows its own
  total. Lane heads stay queue/running only.
- Ledger rows only ever show terminal statuses (already true via
  `finishedTasks()` — confirm waiting can't leak in).

## CLI (`~/.local/bin/orch`)

- `orch waiting` — waiting tasks with id, agent, repo, question, options,
  how long waiting.
- `orch answer <id> "text"` — answer and resume; prints the new leg's
  dispatch line.
- `orch ls` / `orch ps` include waiting tasks (ps shows the question).
- `--wait` on dispatch: unchanged semantics (blocks until terminal). Note:
  a task that goes waiting while `--wait` is attached just keeps blocking
  until terminal — document, don't fix, in v1.

## Verification (no test framework exists here — manual, scripted)

1. Dispatch a tiny task instructing the agent to ask which of two options it
   prefers → card flips to waiting with chips → click one → same task
   resumes, completes, one ledger line; **run two ask/answer rounds** and
   confirm the session id shown on the card never changes (resume legs must
   stay on one session) and the ledger cost equals the final leg's
   cumulative value, not a sum.
2. Free-text answer via drawer and via `orch answer`.
3. Kill the server while a task waits → restart → answer still resumes the
   session.
4. Corrupt/remove the transcript file → answer falls back to fresh run +
   context file containing the qa history.
5. Agent result mentioning "ASK:" mid-prose (not as final line-anchored
   request) does NOT trigger waiting.
7. Dispatch a real task with a genuine open decision, with **no** mention of
   ASK in the task text → the agent ends its turn with the marker on its own
   (baked-in definition carries it; injection is backup).
6. DISPATCH handoff queued after an ask-then-answer chain still resolves.

## Left to the builder

- Exact CSS treatment of the waiting card (match the board's existing
  status-color language).
- **CLI home (builder-call, 2026-11-16):** move the CLI into the repo at
  `bin/orch`, deploy by copying to `~/.local/bin/orch` (make it literal), and
  update the README's install note. One dated backup of the standalone
  script first (`orch.bak-ask-<date>`, same precedent as `orch.bak-teams`),
  then the repo copy becomes the source of truth. New `waiting`/`answer`
  subcommands, `ls`/`ps` changes, and the deploy copy all land in this
  repo's commit history.
- Cost/duration accumulation choice (spec'd above, pick one).
- Whether option chips appear inline on the card, only in the drawer, or
  both — spec'd as both, builder may simplify to drawer-only if the card
  gets cramped.
- CLI rendering details for `orch waiting` output.
