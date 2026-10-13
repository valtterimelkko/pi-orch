STATUS: complete (see NOT DONE / RESIDUAL RISKS for the items that need a live host proof)
BRANCH / BASE SHA / HEAD SHA: claude/pm-w4a / 5b64580 (brief commit) / 5b69bba (feature commit; this hand-back file is the commit after it)
COMMITS:
- 5b69bba lane run: the replayable per-lane runner (W4-a)

FILES CHANGED (git diff --stat 5b64580...5b69bba): 17 files, +1770/-7
- new: src/lane-runner.ts, test/lane-runner.test.ts, test/lane-runner-helpers.ts, test/lane-cli.test.ts, examples/lane/{lane.json,brief.md,review-brief.md,correction-template.md,README.md}
- owned and edited: src/cli.ts (verb wiring only: `lane` case, VERB_FLAGS, KNOWN_VERBS, HELP, BOOLEAN_FLAGS `dry-run`), README.md (Lane runner section, Verbs line, exit rows 40–43)
- NOT in the owned list — disclosed tiny edits: src/exit-codes.ts (rows 40–43, required by the exit-code rules and test/exit-codes.test.ts), src/audit.ts (`lane` in AUDITED_VERBS / SUBVERB_POSITIONAL, `dry-run` boolean so the audit scan does not swallow the lane dir), src/index.ts (one export line), AGENTS.md + CLAUDE.md (layout lines, kept byte-identical), test/unknown-flags.test.ts (added `lane` to the two verb lists the docs-guard tests iterate).

TDD (all in test/lane-runner.test.ts unless noted):
- RED: `env NODE_ENV=test node --test test/lane-runner.test.ts test/lane-cli.test.ts` → exit 1, "Cannot find module src/lane-runner.ts" (tests 2, pass 0, fail 2), before any implementation.
- GREEN: same command after implementing → all pass; full suite exit 0 (below).
- Behaviours and their tests:
  - happy lane (gates green, ACCEPT → 0, two children, journal/state/exit files): "happy lane: gates green + ACCEPT → exit 0 …"
  - one correction (red → ONE correction to the SAME implementer → green → ACCEPT → 0): "a red gate sends ONE correction …"
  - gates still red after the cap → 41, and maxCorrections 0 → 41 with no correction: "gates still red after the correction cap …", "maxCorrections 0 …"
  - REJECT / ACCEPT WITH FIXES → 42, replay is idempotent: "REJECT and ACCEPT WITH FIXES → exit 42 …"
  - `--continue correction` → fix correction to the same implementer, closure review on the same reviewer → 0; ending REJECT → 42 again; third round refused (exit 2); refused unless the lane is at 42: three tests
  - child question file → 40, then re-run resumes the wait (no duplicate spawn/prompt; no runId shortcut); sentinel outcome → 40
  - route-cap refusal → 25 with the PAYG/owner overflow hint (RouteLimitError and server PROFILE_CAPACITY_EXHAUSTED); re-run retries the spawn
  - deadline → 3 (resumable, never re-dispatches); failed wait / unexpected error → 43; unparseable or stale (unchanged) verdict file → 43
  - goal mode (goalStart with one-line objective pointing at brief.md + token budget), correction-template substitution, deterministic idempotency keys
  - RESUME: "a kill after EVERY completed step boundary …" (kills after each of the 13 journalled steps of the correction scenario; asserts exactly one kill, the same spawns/prompts/final exit as the uninterrupted run); "the --continue correction path survives a kill at every step boundary too"; "a kill AFTER the prompt call but BEFORE its receipt is persisted re-sends only a server-side duplicate"; "a kill after a spawn … is refused (43) with a reconcile hint, never a second child"; "a registered-but-unrecorded watch is reused"
  - strict lane.json validation + dry-run (no client call, nothing written) + lock (live lock refused, stale lock taken over, released on exit)
  - test/lane-cli.test.ts: verb wiring (usage errors are exit 2 before the client factory; --dry-run needs no client; lane parentSessionId reaches the factory, --parent-session wins; --continue correction; help/flags/exit-code docs; examples/lane dry-runs)
- Mutation check (not committed): making the step cache skip `spawn_reviewer` fails 5 tests (incl. the kill-at-every-boundary ones), so the resume tests have teeth.

GATES:
- `env NODE_ENV=test npm test` → 0 ("# tests 540 / # pass 540 / # fail 0")
- hermetic: `env -u PI_WEB_UI_REPO HOME=<empty tmp> NODE_ENV=test npm test` → 0 (540/540)
- `npm run typecheck` → 0 (after `npm install --no-package-lock --no-save` for the devDependency; the container has no host tsc types otherwise)
- Baseline vs after failing-test lists: baseline (before any change) 507 tests, 0 failing; after 540 tests, 0 failing; the 33 added tests all pass (27 runner + 6 CLI); two existing docs-guard tests initially failed on the new HELP block until `lane` was added to their verb lists (a test edit, listed above), now passing. Identical (empty) failing lists.
- gitleaks is NOT installed in this container: the release-checklist secret scan was not run here (see HOST FOLLOW-UP). No tokens/credentials were written; no test touches ~/.pi-orch (confirmed absent after the run) — tests use a fake client and temp dirs only.

CRITERIA (frozen):
- happy lane → 0: met. correction lane → 0: met. gates red after cap → 41: met. REJECT → 42: met. `--continue correction` → closure → 0: met. child question → 40: met (file and sentinel). route-cap refusal → 25 with the hint: met. resume after a simulated kill at every step boundary, no duplicate spawn/prompt: met (both the main path and the continue path, plus the post-call/pre-receipt windows). tests never write the real ledger/audit log: met. J2 behaviours kept: met (full existing suite green; no existing verb behaviour changed).

HOST FOLLOW-UP NEEDED:
1. `gitleaks git --redact .` and `gitleaks dir --redact .` (release checklist step 4 — not available in the container).
2. Live proof of the pieces the mock cannot show, on the host against a real Pi Web UI: `pi-orch lane run examples/lane --dry-run` (already covered by a test), then a real small lane (cheap model) end to end; then kill the runner mid-wait and re-run to confirm the same children are reused.
3. Confirm live that (a) the question sentinel `PI-ORCH-LANE-QUESTION` as a `text` watch condition fires on child output and is not tripped by the child merely quoting the directive, and (b) re-waiting after exit 40 (no runId shortcut) returns when the child's next turn ends.
4. Confirm the verify-based gate run works with `cwd` = lane.json cwd on the real client (the mock returns canned verify results).

NOT DONE AND WHY / DECISIONS TO REVIEW:
- The text of the `agent-os-child` directive is not in this repo (host-only); `CHILD_DIRECTIVE` in src/lane-runner.ts is my own wording of the parent's child rules (cwd/ownership, honest reporting, no self sign-off, ask via NN-question.md + sentinel). Replace it with the host's canonical text if different — every prompt embeds the constant, tests assert it is present.
- `--continue correction` also re-runs the gates after the reviewer-findings correction (red → 41) before the closure review; the brief did not say so, I judged sending a gates-red tree to a closure review wrong. Remove `gates_fix` if unwanted.
- maxCorrections is validated as 0 or 1 (the brief says "maxCorrections: 1" and "ONE bounded correction"); 0 means a red gate exits 41 at once.
- Wait deadline default is 1800 s per wait (`--deadline S`); exit 3 means re-run to keep waiting. lane.json's ttlSeconds is used only as the children's retention TTL.
- Paused/failed/interrupted/etc. wait outcomes are exit 43 (not a dedicated code); the journal and state stay at that wait so a re-run re-waits.
- Verdict file location comes from a `VERDICT FILE: <path>` line in review-brief.md (default `verdict.md` in the lane dir); a verdict file unchanged since before the review dispatch is refused (43), never read as a fresh verdict.

RESIDUAL RISKS:
- Spawn and goal-start have no server idempotency: a kill between the call and the receipt write yields exit 43 with a reconcile hint (manual: `pi-orch status --owner …`), by design, instead of a possible second child.
- After a question exit the next wait of that step omits the run receipt shortcut and relies on the watch; if the child's turn already ended and the watch's one-shot condition was consumed, that wait could sit until its deadline (exit 3) — host item 3b.
- The wait/watch conditions are the existing client builders; goal mode keys on the objective forms (no goalId), so a reused child with an identical objective could match an old goal's end — lanes use fresh children, so not reachable in the runner's own flow.
FROZEN
