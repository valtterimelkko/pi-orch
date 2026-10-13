# Common rules for every CLOUD child — parent-machinery programme

You are a **child worker** dispatched by an orchestration parent (Claude Code session
`f998b213-cb86-5a18-b203-a3721e415132`, on the owner's VPS). You run in a Claude Code cloud container with a fresh
clone of this repository. The parent judges you on concrete evidence: commits, command receipts and hand-back files.

## Where you are
- The repo's AGENTS.md/CLAUDE.md was written for agents on the owner's VPS. **Host-only steps do not apply and will
  fail here**: `agent-os …` (recall, board, capture), `/root/...` paths outside your clone, the Pi Web UI production
  socket, systemd, Telegram, global skills outside this clone. Skip them; do not emulate them. Everything else in the
  guide (TDD, gates, docs style, security) **does** apply.
- The plan of record is `docs/plans/PARENT-ORCHESTRATION-MACHINERY-PLAN.md` in `valtterimelkko/pi-web-ui`. Your
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
- Work only on your branch **`claude/pm-w2g`** (already exists; its first commit holds your brief). Small commits
  that say what and why. **Push to that branch only.** Never push `main`/`master`, never force-push, never open a PR.
- **Never** `git stash`, `gc`, `prune`, `reflog expire`. Never commit secrets, `.env`, tokens or transcripts.

## Hand-back protocol (the parent is woken only by your branch head)
Hand-back directory: `docs/handback/pm-w2g/` (create it; it is removed at merge).
- **Question:** write `NN-question.md` (options + recommendation). Commit it **last** with subject
  `QUESTION w2g NN: <one line>`, push, end your turn. Do not wait or poll; the parent replies in this session.
- **Blocked:** `NN-blocked.md`, subject `BLOCKED w2g NN: <one line>`, push, end your turn.
- **Done:** `complete.md` (block below, `FROZEN` last). Commit it **last** with subject `HANDBACK w2g: complete`,
  push, end your turn. After a correction: update it, subject `HANDBACK w2g: correction NN`.
- **Every turn ends with a pushed hand-back commit** — including stopping early (`NN-not-finished.md`, subject
  `HANDBACK w2g: not finished`). Never end a turn while one of your commands still runs.

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

# Lane W2g — pi-orch: completion template without a queued follow-up, verify runs the brief's GATES, append-only ledger + audit log (plan W2-g, W2-e)

Repo `valtterimelkko/pi-orch` (PUBLIC: nothing host-specific, no secrets). Read `AGENTS.md` + `README.md` first.

**Objective (frozen).** (1) A goal child's completion instructions no longer ride as a queued follow-up message;
(2) `pi-orch verify` can re-run a lane's gates from the brief's machine-readable `GATES:` block and fails on a red
gate; (3) the spawn ledger is append-only and every verb call is recorded in an audit log, so curl-vs-verb use and
per-lane parent effort can be counted without regexing transcripts.

**Why.** F10/B2: the goal verify command checked the hand-back's FORMAT, not the gates; the completion template was
delivered as one queued follow-up, which rode into an admission leak and produced `TEMPLATE_NOT_DELIVERED` (exit 22).
X2/X3: the ledger prunes data (view and data are one thing), and there is no record of which verbs parents use.

**Design.**
1. **Template (W2-g).** `spawn --goal-objective` / `goal start`: put only the short pointer in the objective (as today)
   and STOP sending the full report instructions as a queued follow-up by default. Instead the full text is
   available as `pi-orch template [--goal]` (prints it) so parents paste it into the brief file the objective points
   to. Keep a `--template-follow-up` opt-in flag that restores today's behaviour. Exit 22 can then only occur with the
   opt-in. Update help/README.
2. **verify runs GATES (W2-g).** `verify <sid> --gates-file <path>` parses a block that starts with a line `GATES:` and
   continues with lines `- <command> → <expected exit>` (also accept `->`), runs each command in the child's cwd (or
   `--cwd`), with a per-command timeout (`--gate-timeout S`, default 1800), and the verdict becomes `contradicted`
   (exit 20) if any gate's exit differs, listing each gate with expected/actual and the last 20 lines of output.
   Read-only intent: never run a gate whose command contains `git push`, `git reset --hard`, `rm -rf /` or
   `npm ci`/`npm install` (refuse that gate with a clear reason, verdict `unverifiable`).
3. **Append-only ledger (W2-e).** The spawn ledger file becomes an append-only JSONL event log (`spawned`, `deleted`,
   `lease`...) with a derived view; pruning changes the VIEW only, never deletes records. Migrate the existing JSON
   ledger on first read (keep a `.bak`). Tests must never touch the real ledger (keep `tempLedgerPath`).
4. **Audit log (W2-e).** Every CLI invocation appends one JSONL record to `~/.pi-orch/audit.jsonl` (overridable by
   `PI_ORCH_AUDIT_PATH`; tests use a temp path): `{ts, verb, subverb?, owner?, parentSession?, sessionId?, exitCode,
   durationMs}` — never message bodies, objectives or tokens. Failures to write the audit log never fail the command.

**Owned paths.** `src/**`, `test/**`, `README.md`. Not yours: `contract/`, `package.json`.

**Frozen criteria.** RED → GREEN per item with the hermetic tests; J2 behaviours kept (strict unknown flags,
generation-safe watch delete, ledger isolation in tests, route cap exit 25); `status --owner` / `cleanup --owner`
(just merged) keep working on the new ledger. HOST FOLLOW-UP: the parent will run `verify --gates-file` on a real lane
and check `~/.pi-orch/audit.jsonl` after a real spawn.

GATES:
- `env NODE_ENV=test npm test` → 0
- `npm run typecheck` → 0

Budget: ~4 hours / ~500 tool calls.
