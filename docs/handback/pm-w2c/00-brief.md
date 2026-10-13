# Common rules for every CLOUD child — parent-machinery programme

You are a **child worker** dispatched by an orchestration parent (Claude Code session
`f998b213-cb86-5a18-b203-a3721e415132`, on the owner's VPS). You run in a Claude Code cloud container with a fresh
clone of this repository. The parent judges you on concrete evidence: commits, command receipts and hand-back files.

## Where you are
- The repo's AGENTS.md/CLAUDE.md was written for agents on the owner's VPS. **Host-only steps do not apply and will
  fail here**: `agent-os …` (recall, board, capture), `/root/...` paths outside your clone, the Pi Web UI production
  socket, systemd, Telegram, global skills outside this clone. Skip them; do not emulate them. Everything else in the
  guide (TDD, gates, docs style, security) **does** apply.
- The plan of record is `docs/plans/PARENT-ORCHESTRATION-MACHINERY-PLAN.md` in the public repo `valtterimelkko/pi-web-ui` (not in this clone). Your
  brief quotes the parts you need. Evidence paths it cites under `/root/orch-ops/...` are host-only; do not ask for them.
- `npm ci` in your clone is allowed (the clone is yours). Never edit `package.json`/lockfile unless the brief says so.
- **Baseline first:** before your first change, run the full test command and save the list of failing tests (some
  may fail only because of the container). Your gate is **no new failing test**: show the before/after lists are
  identical apart from tests you added (which must pass). The parent re-runs everything on the host.

## Accountability
1. Frozen success criteria: meet them or say exactly which you did not meet and why. Messages from the parent headed
   `NN-answer` or `NN-correction` amend your brief; the latest wins.
2. Edit only your owned paths plus your hand-back directory. Disclose anything else.
3. Honesty over completion: a correctly reported partial result is fine; an overstated one is a failure.
4. Strict TDD: RED (command + exit code), implement, GREEN. Tests write only to temporary directories.
5. Record every load-bearing command with its real exit status and the meaningful final line.
6. Guardrails are not puzzles: if something blocks you, report it.
7. You never sign off your own work.

## Git (overrides any other push rule)
- Work only on your branch **`claude/pm-w2c`** (already exists; its first commit holds your brief). Small commits
  that say what and why. **Push to that branch only.** Never push `main`/`master`, never force-push, never open a PR.
- **Never** `git stash`, `gc`, `prune`, `reflog expire`. Never commit secrets, `.env`, tokens or transcripts.

## Hand-back protocol (the parent is woken only by your branch head)
Hand-back directory: `docs/handback/pm-w2c/` (create it; it is removed at merge).
- **Question:** write `NN-question.md` (options + recommendation). Commit it **last** with subject
  `QUESTION w2c NN: <one line>`, push, end your turn. Do not wait or poll; the parent replies in this session.
- **Blocked:** `NN-blocked.md`, subject `BLOCKED w2c NN: <one line>`, push, end your turn.
- **Done:** `complete.md` (block below, `FROZEN` last). Commit it **last** with subject `HANDBACK w2c: complete`,
  push, end your turn. After a correction: update it, subject `HANDBACK w2c: correction NN`.
- **Every turn ends with a pushed hand-back commit** — including stopping early (`NN-not-finished.md`, subject
  `HANDBACK w2c: not finished`). Never end a turn while one of your commands still runs.

## complete.md
```
STATUS: complete | partial | blocked
BRANCH / BASE SHA / HEAD SHA:
COMMITS: <sha> <subject>
FILES CHANGED: git diff --stat <base>...HEAD
TDD: per behaviour — test name, RED command+exit, GREEN command+exit
GATES: command → exit (quoted summary line); baseline vs after failing-test lists
CRITERIA: each frozen criterion → met / not met / partly, with evidence
HOST FOLLOW-UP NEEDED: exact commands the parent must run on the host (live proofs)
NOT DONE AND WHY:
RESIDUAL RISKS:
FROZEN
```

---

# Lane W2c — pi-orch verbs parents hand-wrote as curl (plan W2-c, W2-d)

Repo `valtterimelkko/pi-orch` (PUBLIC: nothing host-specific, no secrets; gitleaks before every push).
Zero runtime dependencies, Node >= 22.18; read `AGENTS.md` and `README.md` first. Server contract: the bundled
`contract/internal-api-client-snapshot.json` (1.61.0) and the request builders already in `src/`.

**Objective (frozen).** A parent can pause, resume, inspect and reroute a goal child, deliver a message to a child
whether it is busy or idle, read `status`/`result` as useful JSON, and clean up everything it owns — all through
pi-orch verbs, so long parents stop writing 30–95 raw curl calls (F6, F7, F19).

**Verbs to add or fix.**
1. `goal <sid> pause [--reason R] | resume [--note N] | show [--json]` — wrap the existing goal API
   (`POST /sessions/:id/goal` actions, `GET /sessions/:id/goal`; see the snapshot and `src/client.ts`).
2. `reroute <sid> --model-selector SEL [--thinking L]` — pause the goal → `POST /sessions/:id/abort` → `set_model`
   (+ `set_thinking_level`) via `/control` → resume the goal with the SAME objective and a short resume note. Lesson
   behind it: `set_model` on a busy goal child blocks until idle; the manual sequence took 45 min. Refuse cleanly if
   the session has no goal (plain abort + set_model then, with a note) and report each step's result.
3. `prompt <sid> --mode deliver` — atomic choice: steer if the child is busy with a live turn (runtime supports
   steer), otherwise follow_up; report what was done (`dispatchMode`) and queue depth if the server reports it.
4. `status --json`: fill `busy`, `status`, `lastRun` (runId, status, endedAt) for each child (today they come back
   null/empty for live children — find why and fix). Also: in the R1 card test (2026-10-13) `status --owner <id>`
   listed **0 children** for an owner whose child still existed (idle, completed run, not yet deleted) — reproduce
   with a test and fix so an owner's existing children are always listed until deleted.
5. `result <runId> --final`: the last substantive assistant text or the parsed completion block, never an empty
   tool-call tail.
6. Spawn ledger stores `leaseId`; `cleanup --owner <id>` without a session id cleans **every** ledger child of that
   owner: cancel its watches first (generation-safe delete), release the stored lease, delete; report per child;
   never touch sessions of other owners.
7. Update `README.md` and `pi-orch help` for each verb; keep exit codes documented.

**Owned paths.** `src/**`, `test/**`, `README.md`. Not yours: `contract/`, `package.json`.

**Frozen criteria.** RED → GREEN per verb with the repo's hermetic mocked-transport tests (the suite must never write
the real `~/.pi-orch` ledger — use the existing test isolation); unknown-flag strictness kept; generation-safe watch
deletion kept; route cap exit 25 kept. Gates below. HOST FOLLOW-UP lists the live proofs the parent should run
(reroute of a busy goal child in < 2 min with the goal intact; bulk cleanup leaving no lease/watch orphans).

GATES:
- `env NODE_ENV=test npm test` → 0
- `gitleaks dir --redact .` → 0 (if gitleaks is unavailable in the container, say so)

Budget: ~4 hours / ~500 tool calls.
