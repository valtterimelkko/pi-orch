# pi-orch

Thin parent client for the Pi Web UI Internal API (orchestration-scaling plan
step C1). TypeScript, Node >= 22.18, **zero runtime dependencies beyond Node's
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
  [--preflight-path /dir/brief.md --preflight-tool node]
pi-orch prompt <sessionId> --message "..."     # detached + idempotency key -> runId
pi-orch wait <sessionId> --run-id <runId> --deadline 1800 [--objective "..."]
pi-orch result <runId> [--transcript]          # final text + evidence pointers
pi-orch verify <sessionId>                     # STUB (plan step C3); exits 13
pi-orch cleanup <sessionId> --lease <id> --owner <id> [--watch <id>]
pi-orch status --parent <sessionId>            # children: busy, goal, last run
```

`--json` gives machine output; default is human-readable. `wait` never polls:
it registers a watch on the child and blocks in the server's long poll
(`GET /watches/wait`), advancing the cursor, reconciling the run receipt at
slice boundaries. It distinguishes `interruptedByRestart`, `NEVER_STARTED`,
`RUN_BUDGET_EXCEEDED` and `RUN_TRANSPORT_LOST`, and survives a server restart
by re-registering the watch with `fireIfSettled`.

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
| 13 | `VERIFY_STUB` | verify is a stub interface (filled by plan step C3); nothing was verified |
| 14 | `PROMPT_NOT_EXECUTED` | Pi accepted the prompt but no turn ever started (extension input-hook swallow) |
| 15 | `TURN_STALLED` | The turn stalled past the watchdog window; check the session before re-prompting |
| 16 | `WAIT_TARGET_NOT_FOUND` | wait fast-fail: the --run-id is unknown/malformed (no such receipt) or the sessionId is not in the registry — nothing to wait on |

## Development

```
npm test        # node --test (Node >= 22.18 runs TS directly; no install needed)
```

Typecheck (uses the host's TypeScript; this repo installs nothing):

```
node /root/pi-web-ui/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
