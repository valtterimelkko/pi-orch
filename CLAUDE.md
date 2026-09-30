# pi-orch — maintainer guide (agents)

This file is byte-identical to `CLAUDE.md`. It is the comprehensive maintainer
reference for agents working on this repository. `README.md` is the short,
public-facing document — keep the two distinct and do not duplicate it here.

## What this repository is

`pi-orch` is the thin parent client (CLI + importable module) for
**[Pi Web UI](https://github.com/valtterimelkko/pi-web-ui)**'s same-host
Internal API. It spawns, prompts, waits on, reads and verifies child agent
sessions. TypeScript, Node >= 22.18, **zero runtime dependencies** (Node runs
the `.ts` sources directly). MIT; `"private": true` because it is not an npm
package.

## Layout

```
bin/pi-orch                 CLI shim: imports src/cli.ts (Node type stripping)
src/cli.ts                  verbs, flags, help, exit-code mapping, process entry
src/client.ts               PiOrchClient: the API surface over Transport
src/builders.ts             typed request builders (create/prompt/watch/preflight)
src/parsers.ts              response parsing + ApiError
src/transport.ts            Unix-socket/http, bearer auth, bounded Retry-After
src/credentials.ts          credential-path guard (never read a token from this repo)
src/wait.ts                 watch-based wait, multi-child wait, settlement
src/verify.ts               read-only re-check of a child's completion claims
src/completion.ts           completion-block parsing (pi-completion/v1)
src/completion-template.ts  the one dispatch-template constant (byte-pinned)
src/exit-codes.ts           the single source for exit codes (README mirrors it)
src/snapshot.ts             contract-snapshot resolution + load
src/tsc-resolver.ts         typecheck resolver (local devDependency, host fallback)
src/index.ts                public module surface
contract/                   bundled client contract snapshot (generated upstream)
test/                       node:test suites run straight from TypeScript
scripts/typecheck.mjs       `npm run typecheck` entry point
.github/workflows/ci.yml    public CI: npm test (Node 22, 24) + full-history gitleaks
```

## Running the checks

```bash
npm test              # the full suite; no install needed (Node >= 22.18 strips types)
npm run typecheck     # local devDependency TypeScript, else host tsc fallback
```

- `npm test` uses `node --test 'test/*.test.ts'`. Run it with a plain
  environment (`NODE_ENV=test` is conventional); the suite is hermetic: it does
  not need a Pi Web UI checkout, a running server, a token or a HOME.
- `npm run typecheck` resolves TypeScript in this order: local
  `node_modules/typescript` (after `npm install`); `PI_ORCH_TSC`; a `tsc` on
  the host `PATH` (using `~/pi-web-ui/node_modules/@types` for Node typings
  when the repo has no local install). It never downloads anything.
- CI must keep the owner's cost rule: public repos only, standard
  GitHub-hosted `ubuntu-latest` runners only, `push` + `pull_request`
  triggers only, no `schedule` crons, every job with `timeout-minutes` and a
  cancelling `concurrency` group, minimal matrices (Node 22 + 24 here).
  `test/ci-workflow.test.ts` fails the suite if the workflow drifts from it.

## TDD rule (non-negotiable)

Behaviour changes and bug fixes are test-first: write the failing test, run it
and record the RED output; implement the minimal fix; run it again for GREEN;
then run the full suite. Every hand-back states the test name, the RED command
with its exit code and the GREEN command with its exit code. A fix without a
RED receipt is not done. Tests that pin a constant or a fixture record the
provenance in the test or the fixture itself.

## Contract snapshot refresh

The snapshot is **generated upstream**: Pi Web UI produces
`docs/contract/internal-api-client-snapshot.json` from its zod schemas and
types, and its own drift test fails when a server schema changes without
regeneration. This repo only consumes it.

1. In the Pi Web UI checkout: `npx tsx scripts/generate-client-snapshot.ts`.
2. Copy it here: `cp <server-repo>/docs/contract/internal-api-client-snapshot.json contract/`.
3. Run `npm test` — request builders and response parsers are validated
   against the snapshot; a shape change without a client update fails the suite.
4. Commit the snapshot with the client change that needs it.

Resolution order (same in code, tests and README): `PI_ORCH_SNAPSHOT_PATH`,
then `$PI_WEB_UI_REPO/docs/contract/...` (loud error when set without a
snapshot), then `~/pi-web-ui/docs/contract/...`, then the bundled `contract/`
copy. At runtime a `contractVersion` mismatch against live `/capabilities`
surfaces `SNAPSHOT_STALE` on stderr and in `--json`; it never blocks a command.

## Exit-code rules

- `src/exit-codes.ts` is the single source. `README.md`'s table must stay in
  sync; `test/exit-codes.test.ts` enforces both directions and the row count.
- Codes are a published contract with shell-calling agents. Never reuse a
  number; a retired behaviour keeps its row (see `13 VERIFY_STUB`).
- A new refusal class gets a **distinct** code and a matching row in the help
  text (`src/cli.ts`). The latest additions: `20/21` (verify verdicts), `22`
  (template not delivered), `23` (`CREDENTIAL_IN_REPO`).
- Error mapping lives in `mapError` (`src/cli.ts`); server error codes map via
  `ERROR_CODE_EXIT_CODES`.

## Security rules

- **Never read a credential from inside this repository tree.** Every read of
  the Internal API token goes through `readToken`, which calls
  `assertCredentialPathOutsideRepo` first: a path resolving inside the package
  root — through a symlink too, existing or not — is refused with
  `CredentialPathError` (`CREDENTIAL_IN_REPO`, exit 23).
- **No `.env` loading of any kind.** The environment and explicit CLI flags are
  the only credential inputs; `test/credentials-guard.test.ts` scans the
  sources to keep it that way.
- `.gitignore` excludes `.env*`, token-shaped names, `node_modules/`, local
  logs and sockets — belt and braces only. It is **not** the protection; the
  guard is. Say so in the README when touching that section.
- Never commit tokens, session dumps, credentials or run artefacts, including
  in tests and fixtures. Use obviously fake values and temp directories.

## Release checklist (before every push)

1. `npm test` — full suite green (exit 0), including the hermetic run with
   `HOME` set to an empty temp directory and `PI_WEB_UI_REPO` unset.
2. `npm run typecheck` — exit 0.
3. `git status` — clean; no untracked artefacts.
4. **Secret scan, always:** `gitleaks git --redact .` (full history) and
   `gitleaks dir --redact .` (working tree) — both clean. Never print a matched
   value; `--redact` is mandatory in every invocation.
5. Public-doc sanity: the README's first screen links to Pi Web UI, the link
   repeats in *Requirements* and *See also*, the skill-pack pointer is present,
   and the licence is MIT.
6. `package.json` metadata still points at `github.com/valtterimelkko/pi-orch`
   (`repository`, `homepage`, `bugs`), `license: MIT`, `private: true`,
   `engines.node`, keywords.
7. CI workflow unchanged in its cost shape (see *Running the checks*).
8. Push on the current branch; do not create release branches or tags without
   the owner's say-so.

### Optional local pre-commit hook (do not install silently)

To scan staged changes locally, a maintainer may add a `.git/hooks/pre-commit`
(or point `core.hooksPath` at a committed directory) that runs
`gitleaks git --redact --staged` and exits non-zero on findings. This is
opt-in: never install or enable a hook on someone else's clone, and never make
the build depend on it. CI's full-history job is the backstop.
