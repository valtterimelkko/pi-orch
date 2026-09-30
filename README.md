# pi-orch

**Client for [Pi Web UI](https://github.com/valtterimelkko/pi-web-ui)'s Internal API** — one small CLI plus an importable module that spawns and supervises child agent sessions, so parent agents stop hand-writing curl, guessing request shapes and sleeping in loops.

[![Pi Web UI Internal API](https://img.shields.io/badge/Pi_Web_UI-Internal_API-blue)](https://github.com/valtterimelkko/pi-web-ui) ![Node >= 22.18](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen) ![runtime dependencies: zero](https://img.shields.io/badge/runtime_dependencies-zero-brightgreen) ![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)

## What it is and why

Pi Web UI runs autonomous agent sessions and exposes them through a same-host Internal API: create a session, prompt it, watch it, read its receipt, attach a goal. `pi-orch` is the thin parent client for that API. Verbs: `spawn`, `prompt`, `wait` (watch-based — never a poll loop), `result`, `verify`, `cleanup`, `status`, `capabilities`, `capacity`, `models`.

It always sends `X-Parent-Session` so child lineage is recorded, honours `Retry-After` within a bounded budget, and uses documented exit codes so a shell-calling agent can branch on the outcome instead of parsing prose.

TypeScript, **zero runtime dependencies** beyond Node's standard library. Node ≥ 22.18 runs the TypeScript sources directly; there is no build step.

## Requirements

- A running **[Pi Web UI](https://github.com/valtterimelkko/pi-web-ui)** on the same host, with its Internal API socket and bearer token (defaults: `~/.pi-web-ui/internal-api.sock` and `~/.pi-web-ui/internal-api-token`). The client talks to the Unix socket, not the network.
- Node.js **>= 22.18**.

## Install

```bash
git clone https://github.com/valtterimelkko/pi-orch
# no runtime dependencies — nothing else to install
./pi-orch/bin/pi-orch capabilities
```

Optional: put it on `PATH` (`ln -s "$PWD/pi-orch/bin/pi-orch" ~/.local/bin/pi-orch`) or run it in place.

## 60-second quickstart

```bash
# 1. Is the API reachable, and at which contract version?
pi-orch capabilities

# 2. Which model selectors are live? (spawn and prompt accept one selector)
pi-orch models --runtime pi --match <substring>

# 3. Spawn a child session in a directory (prints the session id)
session=$(pi-orch spawn --runtime pi --cwd /tmp/demo \
  --model-selector <provider>/<model> --thinking low \
  --owner demo --ttl 600 --id-only)

# 4. Send it a task (prints the run id)
run=$(pi-orch prompt "$session" --message "Say hello, then finish." --id-only)

# 5. Wait for it — one watch-backed long poll, no sleep loop
pi-orch wait "$session"

# 6. Read the result (final text, completion block, evidence pointer)
pi-orch result "$run" --json
```

## Verbs

```
pi-orch capabilities                     # contract version, runtime features
pi-orch capacity                         # admission preflight
pi-orch models --runtime pi [--match sub]  # live selectors; exactly one match
pi-orch spawn --runtime rt --cwd /dir [--model-selector SEL | --model-match SUB] \
  [--thinking LEVEL] [--owner ID --ttl S [--label L]] \
  [--goal-objective "..." --goal-max-turns N --goal-verify CMD] \
  [--preflight-path P --preflight-tool T] [--agent-os-capture enabled|disabled]
pi-orch prompt <sessionId> --message "..."     # detached + idempotency key -> runId
                                               # [--mode prompt|follow_up|steer]
pi-orch wait <sessionId> [--run-id <runId>] [--objective "..."] [--deadline S]
pi-orch wait --all|--any <id>[@<runId>] ...    # several children, ONE long poll
pi-orch result <runId> [--transcript]          # final text + completion + evidence
pi-orch verify <sessionId> [--run-id id] [--since ref] [--rerun "cmd"] \
  [--cwd dir] [--repo dir] [--rerun-timeout s] # re-check completion claims
pi-orch cleanup <sessionId> [--lease id --owner id] [--watch id]
pi-orch status [--parent <sessionId>] | [<sessionId>]  # children: busy, goal, last run
pi-orch help | --help | -h                     # usage on stdout, exit 0
```

`--json` gives machine output; the default is human-readable. `--id-only` prints the bare id for `$(...)` capture: `spawn` prints the session id, `prompt` prints the run id. Never parse the human output — its wording can change at any time.

`wait` never polls: it registers a watch on the child and blocks in the server's long poll, advancing the cursor and reconciling the run receipt at slice boundaries. `wait --all` settles every named child and `wait --any` returns with the first to settle — one long-poll request covers all watches. Unknown runs or sessions fail fast (exit 16). On a goal child, pass `--objective`; without it, `wait` reads the child's goal projection once and adopts the goal conditions when a goal is active or running.

By default every dispatched `prompt` message and every `spawn --goal-objective` asks the child to end its final answer with a fenced `completion` block (schema `pi-completion/v1`: status, summary, commands with exit codes, tests, commits, filesChanged, openIssues, blockedReason). `result` parses it into `completion` / `completionError` fields; `verify` re-checks its cheap facts against the filesystem with read-only git (claimed commits exist, `filesChanged` shows change evidence, and a claimed test is re-run only when you name the exact command with `--rerun`). Use `--no-completion-template` for steering chatter that is not a task.

## Environment

| Variable | Meaning |
|---|---|
| `PI_WEB_UI_SOCKET` | Unix socket path (default `~/.pi-web-ui/internal-api.sock`) |
| `PI_WEB_UI_TOKEN_PATH` | Bearer token file (default `~/.pi-web-ui/internal-api-token`) |
| `PI_WEB_UI_API_BASE` | http(s) base instead of the socket (tests/odd deployments); **loopback hosts only** unless `PI_ORCH_ALLOW_REMOTE_API_BASE=1` is set, and a remote base must be `https:` |
| `PI_ORCH_ALLOW_REMOTE_API_BASE` | Explicit opt-in (`1`) to a non-loopback `https:` API base; remote `http:` is never allowed |
| `PI_WEB_UI_REPO` | Pi Web UI checkout root whose `docs/contract/` snapshot should be used (see below) |
| `PI_ORCH_SNAPSHOT_PATH` | Contract snapshot file override (wins over everything; see below) |
| `PI_ORCH_PARENT_SESSION` | Explicit parent id for bare-CLI parents |
| `PI_ORCH_TSC` | Optional path to a TypeScript entry point for `npm run typecheck` |

CLI flags `--socket`, `--token-path`, `--api-base` and `--parent-session` override the environment.

## Security model

- The client talks to a **same-host Unix socket** by default; the bearer token is read from a file and never crosses the network.
- **The token must live outside this repository.** The code enforces it: resolving a credential path inside the package root — including through a symlink, and whether or not the file exists — is refused with a clear error and the distinct exit code **23 (`CREDENTIAL_IN_REPO`)**. A token that ends up in a checkout (or its history) is a leaked token; the guard stops the read before it happens.
- **An HTTP API base must stay on this machine.** `PI_WEB_UI_API_BASE` (or `--api-base`) is accepted only when its host is loopback (`localhost`, `127.0.0.0/8`, `::1`). Any other host is refused with the distinct exit code **24 (`REMOTE_API_BASE_REFUSED`)** unless `PI_ORCH_ALLOW_REMOTE_API_BASE=1` is set explicitly — and even then only `https:` is accepted: plain `http:` to a remote host would send the bearer token in clear. The guard runs in the transport constructor, so it applies to the CLI and to the library alike.
- `.gitignore` excludes `.env*`, token-shaped names and local artefacts, but **it is belt and braces, not the protection**. The guards are the protection.
- `pi-orch` loads **no `.env` file of any kind**; the environment and the explicit flags are the only credential inputs. A test scans the sources to keep it that way.

## Contract snapshot (drift guard)

Pi Web UI generates `docs/contract/internal-api-client-snapshot.json` from its zod schemas and types; its drift test fails CI when a server schema changes without regeneration. This client validates its request builders and response parsers against that snapshot. Resolution order, in code, tests and here:

1. `PI_ORCH_SNAPSHOT_PATH`;
2. `$PI_WEB_UI_REPO/docs/contract/internal-api-client-snapshot.json` when the variable is set (a set-but-unusable repo is a loud error);
3. `~/pi-web-ui/docs/contract/internal-api-client-snapshot.json` when that checkout is present;
4. the bundled copy in `contract/` — so the client's tests pass on a machine with no Pi Web UI checkout at all.

At runtime the client compares the snapshot's `contractVersion` with live `/capabilities`; a mismatch surfaces `SNAPSHOT_STALE` on stderr (and in `--json`) without blocking the command. Refresh the bundled copy with:

```bash
cp <server-repo>/docs/contract/internal-api-client-snapshot.json contract/
```

## Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | Success (accepted dispatch, finished wait, read result, or the child parked to ask — read the JSON body) |
| 1 | `ERROR` | Unexpected error: transport failure, missing socket/token, malformed non-error response |
| 2 | `USAGE` | Bad command line (unknown verb/flag, missing required argument) |
| 3 | `DEADLINE` | Wait deadline elapsed while the child was still working — re-wait; never re-dispatch on this |
| 4 | `RUN_FAILED` | The run receipt ended failed (no specific code matched); read errorCode in the JSON |
| 5 | `INTERRUPTED` | Run interrupted (server restart or drain); interruptedByRestart — re-dispatch or resume the goal after the restart |
| 6 | `NEVER_STARTED` | Accepted run produced no runtime activity inside the start window (C2) — the dispatch never ran |
| 7 | `BUDGET_EXCEEDED` | Run hit a per-run budget (output tokens / streamed bytes / tool args); split the task |
| 8 | `CANCELLED` | Run was cancelled (abort or disconnect of an attached owner) |
| 9 | `TRANSPORT_LOST` | Receipt terminalised but the synchronous dispatch chain never returned (C2 fence); the outcome is in the receipt |
| 10 | `ADMISSION_REFUSED` | 429/503 with Retry-After persisted past the retry budget (slots, heap/lag pressure, draining) — wait the stated time, retry |
| 11 | `PREFLIGHT_FAILED` | C4 preflight refused before any model token was spent; fix the listed paths/tools |
| 12 | `REFUSED_BUSY` | 409 refusal (SESSION_BUSY / SESSION_NOT_STREAMING / SESSION_OWNED_BY_OTHER_RUNTIME / SESSION_FENCED) — resolve ownership or use follow_up/steer |
| 13 | `VERIFY_STUB` | RETIRED in C3b: verify is implemented; verdicts map to 0/20/21 and this code is no longer emitted |
| 14 | `PROMPT_NOT_EXECUTED` | Pi accepted the prompt but no turn ever started (extension input-hook swallow) |
| 15 | `TURN_STALLED` | The turn stalled past the watchdog window; check the session before re-prompting |
| 16 | `WAIT_TARGET_NOT_FOUND` | wait fast-fail: the --run-id is unknown/malformed (no such receipt) or the sessionId is not in the registry — nothing to wait on |
| 17 | `GOAL_CLEARED` | The goal ended `cleared` (classified from the goal projection) — not achieved; go look |
| 18 | `CREATE_UNKNOWN` | A create lost its connection/response; the session may exist — reconcile with `status --parent` (never blindly re-spawn) |
| 19 | `WATCH_CONFLICT` | An incompatible foreign watch is active on the child; the client never replaces foreign watches |
| 20 | `VERIFY_CONTRADICTED` | verify found at least one claim contradicted by the filesystem (missing sha, wrong repo, file with no evidence of change, failed parent-named rerun, blocked without a reason) — the block lies somewhere |
| 21 | `VERIFY_UNVERIFIABLE` | verify could not establish the claims: no completion captured, a typed parse error, an unsafe path, no repo to check against, nothing independently checkable, or the named run belongs to another session |
| 22 | `TEMPLATE_NOT_DELIVERED` | spawn: the goal completion-template follow-up failed both delivery attempts — the child holds only the pointer objective; re-send the template or re-dispatch |
| 23 | `CREDENTIAL_IN_REPO` | a credential path (the Internal API token) resolves inside this repository; the token must come from outside the repo — point `PI_WEB_UI_TOKEN_PATH` at a path outside the package root |
| 24 | `REMOTE_API_BASE_REFUSED` | `PI_WEB_UI_API_BASE` points at a non-loopback host (or a remote host over http); only a loopback API base or the Unix socket is allowed unless `PI_ORCH_ALLOW_REMOTE_API_BASE=1` is set, and even then a remote base must be `https:` |

## Skill pack

The agent skills that use this client (parent orchestration, long-horizon waiting, the orchestrated child worker protocol and secret scanning) live in the public **[Pi Web UI orchestration pack](https://github.com/valtterimelkko/agent-workflow-skills/tree/main/packs/pi-web-ui-orchestration-pack)**.

## Development

```bash
npm test              # node --test; Node >= 22.18 runs the TS sources directly
npm install           # devDependencies only (typescript, @types/node)
npm run typecheck
```

`AGENTS.md` (identical to `CLAUDE.md`) is the maintainer reference: layout, TDD, snapshot refresh, exit-code rules, the security rule and the release checklist.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Valtteri Melkko.

## See also

- **[Pi Web UI](https://github.com/valtterimelkko/pi-web-ui)** — the server this client talks to (MIT).
- Public skill pack: [Pi Web UI orchestration pack](https://github.com/valtterimelkko/agent-workflow-skills/tree/main/packs/pi-web-ui-orchestration-pack).
