# pi-orch

Thin parent client for the Pi Web UI Internal API (orchestration-scaling plan
step C1; C3b adds the completion template, `result` completion fields and
`verify`). TypeScript, Node >= 22.18, **zero runtime dependencies beyond Node's
standard library**. Provides an importable module (`src/index.ts`) and a
shell-friendly CLI (`bin/pi-orch`) so parent agents stop hand-writing curl,
guessing request shapes and sleeping in loops.

Local-only until the owner approves publishing. Do not add a remote.

## Verbs

```
pi-orch capabilities                     # contract version, runtime features
pi-orch capacity                         # admission preflight
pi-orch models --runtime pi [--match zai]  # live selectors; exactly one match
pi-orch spawn --runtime pi --cwd /dir --model-selector zai/glm-5.3-flash \
  --thinking low --owner <parent-id> --ttl 3600 \
  [--goal-objective "..." --goal-max-turns 20] \
  [--preflight-path /dir/brief.md --preflight-tool node] \
  [--no-completion-template]
pi-orch prompt <sessionId> --message "..."     # detached + idempotency key -> runId
                                               # [--no-completion-template]
pi-orch wait <sessionId> [--run-id <runId>] [--objective "..."]
pi-orch wait --all|--any <id>[@<runId>] ...    # several children, ONE long poll
pi-orch result <runId> [--transcript]          # final text + completion + evidence
pi-orch verify <sessionId> [--run-id id] [--since ref] [--rerun "cmd"] \
  [--cwd dir] [--repo dir] [--rerun-timeout s] # re-check completion claims
pi-orch cleanup <sessionId> --lease <id> --owner <id> [--watch <id>]
pi-orch status --parent <sessionId>            # children: busy, goal, last run
pi-orch help | --help | -h                     # usage on stdout, exit 0
```

`--json` gives machine output; default is human-readable. `--id-only` prints
the bare id for `$(...)` capture: `spawn` prints the sessionId, `prompt` prints
the runId. Never parse the human output (its wording can change at any time).

`wait` never polls: it registers a watch on the child and blocks in the
server's long poll (`GET /watches/wait`), advancing the cursor, reconciling the
run receipt at slice boundaries. It distinguishes `interruptedByRestart`,
`NEVER_STARTED`, `RUN_BUDGET_EXCEEDED` and `RUN_TRANSPORT_LOST`, and survives a
server restart by re-registering the watch with `fireIfSettled`.

`wait --all` settles every named child, `wait --any` returns with the first to
settle — one long-poll request covers all watches, so a parent fans out without
a shell loop. Unknown runs/sessions fail fast (exit 16) instead of sitting out
the deadline. On a goal child, pass `--objective` (goal_end+paused matched on
the exact string). Without `--objective`, wait reads the child's goal
projection once and — when a goal is active or running — adopts the goal
conditions and settlement automatically, and says so in the output (C3b fix:
a forgotten `--objective` no longer yields an early false `completed`).

## Completion template (C3b)

Every dispatched `prompt` message and every `spawn --goal-objective` carries
the END-OF-TASK REPORT instruction by default: the child is told to end its
final answer with a fenced `completion` block (schema `pi-completion/v1`:
status, summary, commands with exit codes, tests, commits with repo paths,
filesChanged, openIssues, blockedReason). The wording is one module constant
(`src/completion-template.ts`) pinned byte-for-byte by test to the paragraph
live-proved in C3a (16/16 parse rate). Pass `--no-completion-template` (CLI)
or `completionTemplate: false` (module) to skip it — e.g. for steer/follow_up
chatter that is not a task. The server caps a goal objective at 4000 chars;
the template is ~600, and an overflowing objective fails with an error naming
the opt-out.

## result: completion fields (C3b)

`pi-orch result <runId> --json` returns, alongside the receipt fields:

- `completion` — the parsed block; from the run receipt when the run captured
  one, else from the session's `latestCompletion` (goal children work in
  receipt-less goal-engine continuation turns; the session surface is the only
  capture path there).
- `completionError` — the typed parse error (`NO_BLOCK`, `UNCLOSED_FENCE`,
  `OVERSIZED_BLOCK`, `MALFORMED_JSON`, `SCHEMA_VIOLATION`) when the block
  failed.
- `completionDelimiter` — `completion` (the protocol fence) or `json-tagged`
  (the schema-tagged tolerance).
- `completionSource` — `receipt` or `session_surface` (which record it came
  from), plus `completionCapturedAt`/`completionCapturedBy` for surface
  provenance.
- `evidence.completion` — the API path that holds the completion record.

## verify: re-check the child's claims (C3b)

`pi-orch verify <sessionId>` reads the child's completion block (with
`--run-id`, that receipt is authoritative; without it, the session's newest
capture) and re-checks its cheap facts against the filesystem with READ-ONLY
git:

- every claimed commit exists in its claimed repo
  (`git cat-file -e <sha>^{commit}`), and with `--since <base>` (or when the
  block names a branch) is reachable from it;
- every `filesChanged` entry shows evidence of change: present in the working
  tree, present in a named commit tree, deleted in a named commit, or touched
  by some commit — else contradicted;
- claimed commands with exit codes are recorded (never re-run automatically);
- a claimed test is re-run ONLY when the parent names the exact command:
  `--rerun "npm test"` runs it once in the child's cwd (`--cwd`, bounded by
  `--rerun-timeout`, default 120 s); a failing rerun contradicts every claimed
  `pass` and confirms an honest `fail`;
- `status: "blocked"` requires `blockedReason`.

verify never mutates anything: allow-listed read-only git subcommands, argv
arrays (no shell), no network, no writes. The only command ever executed is
the parent-named `--rerun`.

Output (use `--json` for the claims table): a per-claim table and an overall
verdict. Verdict precedence: any contradicted claim → `contradicted`; any
unverifiable claim (or nothing independently checkable) → `unverifiable`;
else `verified`.

Every request carries `X-Parent-Session` from `--parent-session`, else
`PI_ORCH_PARENT_SESSION`, else `PI_WEB_UI_SESSION_ID`, else `PI_SESSION_ID` —
so parent lineage (C5) is recorded automatically.

429/503 responses with `Retry-After` are retried within a bounded budget
(attempts and total wait); exhaustion exits `10` with the header echoed.

## Environment

| Variable | Meaning |
|---|---|
| `PI_WEB_UI_SOCKET` | Unix socket path (default `~/.pi-web-ui/internal-api.sock`) |
| `PI_WEB_UI_TOKEN_PATH` | Bearer token file (default `~/.pi-web-ui/internal-api-token`) |
| `PI_WEB_UI_API_BASE` | http base instead of the socket (tests/odd deployments) |
| `PI_ORCH_PARENT_SESSION` | Explicit parent id for bare-CLI parents |
| `PI_ORCH_SNAPSHOT_PATH` | Contract snapshot override (see below) |

## Contract snapshot (drift guard)

The server repo generates `docs/contract/internal-api-client-snapshot.json`
from its zod schemas and types (`npx tsx scripts/generate-client-snapshot.ts`);
its drift test fails CI when a server schema changes without regeneration.
This client's tests validate the request builders and response parsers against
that snapshot. Resolution order: `PI_ORCH_SNAPSHOT_PATH`, then the server main
checkout (`/root/pi-web-ui/docs/contract/...`), then the bundled copy in
`contract/`. At runtime the client compares the snapshot's `contractVersion`
with live `/capabilities`; a mismatch means the snapshot is stale relative to
the server being talked to. Regenerate the bundled copy with:

```
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
| 21 | `VERIFY_UNVERIFIABLE` | verify could not establish the claims: no completion captured, a typed parse error, an unsafe path, no repo to check against, or nothing independently checkable |

## Development

```
npm test        # node --test (Node >= 22.18 runs TS directly; no install needed)
```

Typecheck (uses the host's TypeScript; this repo installs nothing):

```
node /root/pi-web-ui/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
