STATUS: complete
BRANCH / BASE SHA / HEAD SHA: claude/pm-w2g / 44373e190e5ef8cb37e4b644b3aeda1f38c4d94d / (the hand-back commit that adds this file; code head f36ce2ad7b772b161635147bc6f5986108ea1a2b)

COMMITS:
- c827a67 W2-g: goal templates no longer ride as a queued follow-up by default; add 'template' verb and --template-follow-up opt-in
- a4993da W2-g: verify --gates-file re-runs the brief's GATES block; red gate → 20, mutating gate refused → 21
- 47c10ec W2-e: spawn ledger is an append-only JSONL event log with a derived view; legacy JSON migrated with .bak
- d3ab6a9 W2-e: one JSONL audit record per CLI invocation (PI_ORCH_AUDIT_PATH); e2e tests isolate it
- f36ce2a W2-g/e: README + typecheck fix in new test

FILES CHANGED: src/{cli,client,verify,spawn-ledger,completion-template}.ts, new src/{gates,audit}.ts, README.md; new tests test/w2g-{template,gates,ledger,audit}.test.ts; existing tests adjusted (see below). No change to contract/ or package.json.

TDD (RED = new test file run before implementation, GREEN after):
- template: test/w2g-template.test.ts — RED `node --test test/w2g-template.test.ts` exit 1 (4 of 6 failed); GREEN exit 0 (6/6).
- gates: test/w2g-gates.test.ts — RED exit 1 (module src/gates.ts not found); GREEN 13/13, exit 0.
- ledger: test/w2g-ledger.test.ts — RED exit 1 (7/7 failed); GREEN 7/7, exit 0.
- audit: test/w2g-audit.test.ts — RED exit 1 (module src/audit.ts not found); GREEN 9/9 after one fix (boolean flag recorded), exit 0.

GATES:
- `env NODE_ENV=test npm test` → 0 (# tests 484, pass 484, fail 0). Also exit 0 with HOME = empty temp dir and PI_WEB_UI_REPO unset (484/484).
- `npm run typecheck` → exit 2 in this container, BEFORE and AFTER my changes, with the same single error "TS2688 Cannot find type definition file for 'node'" (no @types/node here; `npm ci` fails — repo has no lockfile). Substitute: `tsc -p tsconfig.json --typeRoots <scratch @types/node@22>` → exit 0, no errors. Host must re-run `npm run typecheck`.
- Baseline failing tests before any change: none (449/449). After: none (484/484).
- gitleaks is not installed in this container; secret scan NOT run (host must run `gitleaks git --redact .` and `gitleaks dir --redact .`).

CRITERIA:
1. Goal template without queued follow-up — met. spawn/goal start send only the pointer by default; `pi-orch template [--goal]` prints COMPLETION_REPORT_INSTRUCTION / GOAL_REPORT_INSTRUCTION; `--template-follow-up` restores the old behaviour; exit 22 only reachable with the opt-in (test: no-opt-in result exits 0). Pointer wording changed minimally ("…are in your brief file, or arrive as a follow-up message") so it is true in both modes; the stored objective form is still one constant, so watch dataMatch forms are unaffected. Help + README updated.
2. verify --gates-file — met. Parses `GATES:` with `→`/`->` (last arrow separates exit; backticks stripped); runs in --cwd or the session detail's `cwd`; --gate-timeout S (default 1800); mismatch → contradicted/20 with expected/actual and last 20 output lines (human + `gates[]` in --json); refusals (git push, git reset --hard, rm -rf /, npm ci/install/i) are not run → unverifiable/21; contradicted outranks unverifiable; gates still run if no completion block exists. Malformed/missing/empty block or bad timeout → usage error exit 2.
3. Append-only ledger — met. JSONL events spawned/deleted/pruned/lease; view derived by folding; prune/cleanup append events and never delete lines; legacy JSON array migrated on first read with byte-identical `.bak`; garbage/truncated lines skipped; unterminated last line handled. Same file name/env var. status --owner / cleanup --owner tests pass on the new ledger.
4. Audit log — met. `main()` appends {ts, verb, subverb?, owner?, parentSession?, sessionId?, exitCode, durationMs} to PI_ORCH_AUDIT_PATH or ~/.pi-orch/audit.jsonl; unknown verbs recorded as "unknown"; no bodies/objectives/tokens (test asserts); write failures swallowed (test: path is a directory → exit 0). Written in main(), NOT runCli, so in-process tests never touch it; the 4 tests that exec bin/pi-orch now pass a temp PI_ORCH_AUDIT_PATH. Verified ~/.pi-orch does not exist after the full suite.
J2 behaviours kept (strict unknown flags, generation-safe watch delete, ledger isolation, route cap exit 25): full suite green.

Existing tests modified (disclosed): completion-injection + goal-verb (add templateFollowUp:true where they test the follow-up path); unknown-flags (add `template` verb to the HELP guards); route-limit-gate, w2c-result-cleanup, status-owner, w2c-status-ledger (read ledger via `new SpawnLedger(p).entries()` instead of JSON.parse of the file); credentials-guard, api-base-guard, route-limit-cli (temp audit path); test/isolated-ledger.ts (+tempAuditPath).

HOST FOLLOW-UP NEEDED:
- `npm run typecheck` and `env NODE_ENV=test npm test`; `gitleaks git --redact .` and `gitleaks dir --redact .`.
- On a real lane: `node bin/pi-orch verify <sid> --gates-file <brief.md>` (expect exit 0 on green gates, 20 if one is red, 21 for a refused gate).
- After a real `spawn`, check `tail -1 ~/.pi-orch/audit.jsonl` has verb spawn + sessionId, and that an existing ~/.pi-orch/spawn-ledger.json is converted to JSONL with spawn-ledger.json.bak beside it.
- `node bin/pi-orch template --goal` prints the goal instructions.

NOT DONE AND WHY:
- Server-side shape of session detail `cwd` is assumed (contract SessionInfo has it); not exercised against a live server. Without it, gates need --cwd (reported as unverifiable otherwise).
- No new exit code was added, so exit-codes.ts is unchanged (row 22 wording in README now says "with --template-follow-up").

RESIDUAL RISKS:
- Gate refusal is a conservative substring/regex check, not a sandbox: a gate that mutates via another command is still run. `rm -rf /` also refuses `rm -rf /tmp/x`.
- A gate runs arbitrary parent-supplied commands via bash -c; the brief file is trusted input.
- Ledger migration on first read by two concurrent processes could race (both write the same content; .bak may be duplicated with a timestamp suffix).
- Old pi-orch versions reading a migrated ledger will see JSONL and treat it as empty (they expect a JSON array).

## Correction 01 (ledger file format is a frozen interface)
Applied as specified. COMMIT: see `HANDBACK w2g: correction 01` (code + this section in one commit).
- `spawn-ledger.json` is again a JSON ARRAY of the same entry objects (incl. `leaseId`), the derived view, rewritten atomically (temp + rename) after every append. The in-place JSONL migration and `.bak` are removed.
- Append-only log is `spawn-ledger.events.jsonl` beside it (name derived from `PI_ORCH_SPAWN_LEDGER`: `x.json` -> `x.events.jsonl`, else `<path>.events.jsonl`).
- Seeding: an existing array ledger with no events file gets one `spawned` event per entry with `migrated: true`; the `.json` is left byte-identical (test asserts). Missing or corrupt events file (no parseable line) is re-seeded from the JSON view, so no entry is lost.
- TDD: test/w2g-ledger.test.ts rewritten first. RED `node --test test/w2g-ledger.test.ts` exit 1 (6 of 8 failed); GREEN exit 0 (8/8). Tests: `.json` parses as an array with ownerId/leaseId after spawn/prune/cleanup/lease; events file byte length strictly grows across record/prune/lease/remove; seeding; corrupt/missing fallback; filename derivation.
- GATES: `env NODE_ENV=test npm test` -> 0 (485 pass, 0 fail); also exit 0 with HOME = empty temp dir and PI_WEB_UI_REPO unset. `tsc -p tsconfig.json` with scratch @types/node -> 0 (`npm run typecheck` still fails in this container only on the missing @types/node, as before).
- Residual risk removed: old readers of `spawn-ledger.json` keep working. New: a writer that edits the array directly (not via pi-orch) is not reflected in the event log until the next seed condition; the view is rewritten from the log on the next pi-orch write.
- HOST FOLLOW-UP: after a real spawn, `node -e 'console.log(Array.isArray(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.pi-orch/spawn-ledger.json"))))'` -> true, and `~/.pi-orch/spawn-ledger.events.jsonl` exists.

FROZEN
