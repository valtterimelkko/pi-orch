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
- Work only on your branch **`claude/pm-w4a`** (already exists; its first commit holds your brief). Small commits
  that say what and why. **Push to that branch only.** Never push `main`/`master`, never force-push, never open a PR.
- **Never** `git stash`, `gc`, `prune`, `reflog expire`. Never commit secrets, `.env`, tokens or transcripts.

## Hand-back protocol (the parent is woken only by your branch head)
Hand-back directory: `docs/handback/pm-w4a/` (create it; it is removed at merge).
- **Question:** write `NN-question.md` (options + recommendation). Commit it **last** with subject
  `QUESTION w4a NN: <one line>`, push, end your turn. Do not wait or poll; the parent replies in this session.
- **Blocked:** `NN-blocked.md`, subject `BLOCKED w4a NN: <one line>`, push, end your turn.
- **Done:** `complete.md` (block below, `FROZEN` last). Commit it **last** with subject `HANDBACK w4a: complete`,
  push, end your turn. After a correction: update it, subject `HANDBACK w4a: correction NN`.
- **Every turn ends with a pushed hand-back commit** — including stopping early (`NN-not-finished.md`, subject
  `HANDBACK w4a: not finished`). Never end a turn while one of your commands still runs.

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

# Lane W4a — `pi-orch lane run <lane-dir>`: the lane runner (plan W4-a, pilot O3)

Repo `valtterimelkko/pi-orch` (PUBLIC; zero runtime dependencies; read AGENTS.md + README.md). The plan of record is
W4 in `docs/plans/PARENT-ORCHESTRATION-MACHINERY-PLAN.md` of the public repo `valtterimelkko/pi-web-ui` (quoted below).

**What it is (plan W4, verbatim intent).** A small program over the existing pi-orch client, started by a parent as
an ordinary background process. For ONE lane it does what parents now do by hand — spawn the implementer → register
the watch → start the work (goal or prompt) → wait → run the brief's `GATES:` → spawn a cross-family reviewer → on
REJECT send ONE bounded correction to the SAME implementer → review closure → done — keeps a journal so a restarted
run resumes, and **exits only at judgement events**: a child question, a reviewer verdict to adjudicate, gates red after
the correction cap, a capacity refusal needing the owner's overflow decision, or done. Process exit is the one wake
that works on every harness. **Not** a conductor: no contracts, no sign-off machinery, no gate stacks — a loop, a
journal and an exit (plan §4). Every child keeps the parent's rules: the `agent-os-child` directive in every prompt.

**Inputs: a lane directory** (the programme kit's files):
- `lane.json`: `{ lane, cwd, owner, implementer: {runtime, selector, thinking}, reviewer: {runtime, selector,
  thinking}, mode: "goal"|"prompt", objective?, ttlSeconds, budgetTokens?, parentSessionId, maxCorrections: 1 }`
  (validate strictly; unknown keys → usage error).
- `brief.md` (the implementer's brief, ends with a `GATES:` block), `review-brief.md` (reviewer brief; verdict file
  path inside it), optional `correction-template.md`.
**Outputs:** `runner-journal.jsonl` in the lane dir (one record per step: ts, step, ids, outcome) and
`runner-state.json` (current step, session ids, lease ids, watch ids, counters); a final `runner-exit.json`.

**Steps and exits (design; deviate only via a QUESTION).**
1. spawn implementer (client spawn; route cap/exit 25 → exit `25` with the overflow hint) → journal.
2. dispatch: prompt with the child directive + `brief.md`, or goal with a one-line objective pointing at it.
3. wait: use the client's long-poll wait (this process is the waiter; never poll in a tight loop). A child question
   (hand-back file `NN-question.md` in the lane dir, or the question sentinel) → exit `40 QUESTION`.
4. gates: `verify --gates-file brief.md` logic (reuse the existing code). Red → if corrections left, send ONE bounded
   correction (prompt to the SAME implementer naming the red gates and their output tails), go to 3; else exit `41
   GATES_RED`.
5. review: spawn the reviewer (fresh session), dispatch `review-brief.md`, wait, read the verdict file's first line
   `VERDICT: ACCEPT|ACCEPT WITH FIXES|REJECT`. ACCEPT → exit `0 DONE` (implementer + reviewer left for the parent to
   clean up, ids in runner-exit.json). ACCEPT WITH FIXES or REJECT → exit `42 VERDICT` (the parent adjudicates; it may
   re-run the runner with `--continue correction` to send the reviewer's findings as one correction and run a closure
   review on the SAME reviewer, then exit 0 or 42 again — never a third round).
6. Any unexpected error → exit `43 RUNNER_ERROR` with the journal intact.
7. **Resume:** re-running `lane run <dir>` reads `runner-state.json` and continues from the last completed step
   (never re-spawns a child that exists; never re-sends a prompt that has a receipt).
8. `--dry-run` prints the plan of steps and validates inputs without any API call.

**Owned paths.** `src/lane-runner.ts` (new), `src/cli.ts` (verb wiring only), `test/**`, README section, and
`examples/lane/` (a sample lane dir). Not yours: other src files except tiny exports you need (disclose them).

**Frozen criteria.** TDD with the mocked client: a happy lane (gates green, ACCEPT → 0); a lane needing one
correction (red gate → correction → green → ACCEPT → 0); gates still red after the cap → 41; REJECT → 42;
`--continue correction` → closure → 0; a child question → 40; route-cap refusal → 25 with the hint; **resume after a
simulated kill at every step boundary** reaches the same end without duplicate spawns or prompts; tests never write
the real ledger/audit log. J2 behaviours kept.

GATES:
- `env NODE_ENV=test npm test` → 0
- `npm run typecheck` → 0

Budget: ~4 hours / ~500 tool calls.
