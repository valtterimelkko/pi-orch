STATUS: complete (all 7 verbs implemented and mock-tested; live proofs and the gitleaks scan are host follow-ups, see below)
BRANCH / BASE SHA / HEAD SHA: claude/pm-w2c / 3168f9d6271be1be5253501b8bbea4be67327558 (brief commit) / a4a787b (work); the HANDBACK commit follows it

COMMITS:
- a4a787b W2c: goal pause/resume/show, reroute, prompt --mode deliver, status fixes, result --final, cleanup --owner

FILES CHANGED: src/cli.ts, src/client.ts, src/spawn-ledger.ts, README.md; new tests test/w2c-{goal-reroute,deliver,status-ledger,result-cleanup}.test.ts + test/w2c-helpers.ts; red-output.txt / green-output.txt here.
Disclosed edits to OLDER tests (all inside owned test/**), each because the contract changed by design:
- test/goal-verb.test.ts: "goal start is the only action" -> pause/resume are now verbs; clear/bogus still exit 2 and name `start`.
- test/status-owner.test.ts: the dead ledger child now answers 404 on its own detail read (existence is a per-session read now) instead of being absent from the list.
- test/unknown-flags.test.ts: the HELP parser's static verb list gained `reroute`.
Nothing outside src/**, test/**, README.md and this directory was touched (no package.json/lockfile/contract change; `npm install --no-package-lock --no-save` was used only to get @types/node for typecheck).

TDD (RED = `env NODE_ENV=test PI_ORCH_SPAWN_LEDGER=<tmp> node --test test/w2c-*.test.ts` before any src change -> exit 1, 41 tests, 3 pass / 38 fail, docs/handback/pm-w2c/red-output.txt; GREEN = same command after -> exit 0, 41/41, green-output.txt)
- goal pause/resume/show: "W2c goal: client.goalPause / goalResume / goalShow ...", "CLI pause/resume/show ...", "per-action flag strictness ..."
- reroute: 8 "W2c reroute: ..." tests (full sequence, no --thinking, no-goal plain abort + set_model + note, unreadable goal = no goal, set_model failure -> stop + ONE recovery resume, objective changed -> not intact, abort 409 not a failure) + "reroute CLI ..."
- prompt --mode deliver: 8 "W2c deliver: ..." tests (busy+steer-capable -> steer with requireActiveTurn; idle -> follow_up; cannot steer -> follow_up; steer 409 -> one follow_up fallback; non-409 propagates; queueDepth; CLI output; bad mode still rejected)
- status fills busy/status/lastRun: "list row WITHOUT busy/status triggers a detail read", "busy derived from status", "lastRun is the NEWEST run ... endedAt", "without timestamps first entry stays", "failed read surfaced in readErrors"
- status --owner lists 0 children (R1 card): "child missing from GET /sessions (limited list) is still listed and NOT pruned" (RED reproduces the report), "only a 404 prunes", "transient detail failure keeps the child", "owner-tagged spawn is recorded WITH its leaseId even when the caller has a parent identity"
- result --final: 5 tests (receipt text; empty tail -> last assistant text in transcript; completion block; nothing -> source none; CLI)
- ledger leaseId + cleanup --owner: ledger unit test + 6 cleanup tests (order watch -> release stored lease -> delete with CAS generation; failure isolation; 404 = gone; lease from detail for old entries; empty owner; CLI exit codes) + single-cleanup uses the ledger lease

GATES:
- baseline `env NODE_ENV=test npm test` -> exit 0: tests 407, pass 407, fail 0 (failing list: empty)
- after `env NODE_ENV=test npm test` -> exit 0: tests 448, pass 448, fail 0 (failing list: empty; 448 = 407 + 41 new)
- hermetic `env -u PI_WEB_UI_REPO HOME=<empty tmp> NODE_ENV=test npm test` -> exit 0: 448/448 (test/ledger-isolation.test.ts still passes; the real ~/.pi-orch ledger is never resolved)
- `npm run typecheck` -> exit 0 (local devDependency TypeScript)
- `gitleaks dir --redact .` -> NOT RUN: gitleaks is not installed in this container (`which gitleaks` exit 1). Substitute only: a pattern grep over the full diff and the new tests for key/token/PEM shapes -> no hits. The parent must run `gitleaks git --redact .` and `gitleaks dir --redact .` on the host.

CRITERIA:
1 goal pause/resume/show: met (mock). Body shapes {action:'pause',reason?} / {action:'resume',note?} are inferred from the existing {action:'start'}; the bundled snapshot lists the goal route but NOT its pause/resume request type.
2 reroute: met (mock). Uses POST /sessions/:id/abort from the brief; the snapshot does not list an abort route -> host-verify. Decision for an already-paused goal: it is resumed at the end (documented in README).
3 prompt --mode deliver: met (mock). Steer capability is read from /capabilities runtimes[rt].supportsSteer (and supportsSteerWhileBusy !== false).
4 status --json fields + owner listing: met in mock tests, ROOT CAUSES NOT PROVEN LIVE. From the code and contract: (a) SessionInfo.busy/status are optional on list rows, and the old code never read the detail for a listed row; (b) runChronology order is unpinned and [0] was assumed newest; (c) detail/goal/evidence read errors were swallowed into nulls; (d) for the 0-children owner report: spawn only wrote the ledger for callers WITHOUT a session identity, and entriesFor() pruned ledger entries absent from the (possibly limited) GET /sessions. I could not observe the live server, so if the live null cause is something else, readErrors will now show it.
5 result --final: met (mock). "Substantive" = kind assistant with non-blank text; completion block wins as headline.
6 ledger leaseId + cleanup --owner: met (mock). Watch cancel is generation-safe (reuses deleteOwnWatchConditionally); only entries with ownerId == the named owner are touched.
7 README + help: met; no new exit code was needed (reroute / cleanup --owner failures exit 1; exit table unchanged, exit-codes test passes).
Frozen criteria: unknown-flag strictness kept (plus new per-action goal strictness); generation-safe watch deletion kept; route cap exit 25 untouched (all route-limit suites pass unchanged).

HOST FOLLOW-UP NEEDED (live proofs; run against the production socket, with a throwaway goal child):
1. gitleaks: `gitleaks git --redact .` and `gitleaks dir --redact .` -> both exit 0.
2. Reroute of a BUSY goal child in < 2 min with the goal intact: spawn a goal child (--owner orch-test-w2c), wait until busy, then `time pi-orch reroute <sid> --model-selector <other> --thinking low --json`; expect ok:true, objectiveIntact:true, wall time < 120 s; then `pi-orch goal <sid> show` shows the same objective running. Also confirm POST /abort and the goal pause/resume bodies are accepted (the snapshot does not list them).
3. deliver: `pi-orch prompt <busy-sid> --message x --mode deliver --json` -> deliver.chosen steer; same on an idle child -> follow_up.
4. status: `pi-orch status --owner orch-test-w2c --json` lists the child while idle with a completed run (busy/status/lastRun.runId/status/endedAt non-null); repeat with PI_ORCH_PARENT_SESSION set at spawn time. If anything is still null, read the child's readErrors.
5. Bulk cleanup with no orphans: spawn 3 children with --owner and a watch each, then `pi-orch cleanup --owner orch-test-w2c`; afterwards `pi-orch status --owner ...` is empty, GET /sessions/<sid> 404s, and no retention lease / watch remains.

NOT DONE AND WHY: gitleaks scan (tool absent in container); any live-server proof (no server here); `goal clear` was not asked for and stays unsupported (exit 2).

RESIDUAL RISKS:
- Endpoint/body shapes absent from snapshot 1.61.0 (abort; goal pause/resume bodies; evidence timestamp field names endedAt/completedAt/finishedAt/startedAt) are inferred from the brief and existing code.
- Children spawned BEFORE this change by a caller with a session identity were never ledgered, so `status --owner` / `cleanup --owner` cannot see them (unchanged limitation, now documented only implicitly).
- status --owner no longer calls GET /sessions at all (one request per ledger child instead); large owners cost more requests.
- `prompt --mode deliver` adds up to two reads (session detail, capabilities) before the gate's own reads.
FROZEN
