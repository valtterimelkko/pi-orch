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
pi-orch lane run <lane-dir> [--dry-run] [--continue correction]  # the lane runner (see "Lane runner")
pi-orch capacity                         # admission preflight
pi-orch models --runtime pi [--match sub]  # live selectors; exactly one match
pi-orch spawn --runtime rt --cwd /dir [--model-selector SEL | --model-match SUB] \
  [--thinking LEVEL] [--owner ID --ttl S [--label L]] \
  [--goal-objective "..." --goal-max-turns N --goal-verify CMD --goal-budget-tokens N] \
  [--preflight-path P --preflight-tool T] [--agent-os-capture enabled|disabled] \
  [--route-limit 'SEL=N' ...] [--wait-for-slot S] [--wait-admission S]
pi-orch goal <sessionId> start --goal-objective "..." \
  [--goal-max-turns N --goal-verify CMD --goal-budget-tokens N]
pi-orch goal <sessionId> pause [--reason R]    # pause the goal; the engine will not re-arm a turn
pi-orch goal <sessionId> resume [--note N]     # resume the same objective
pi-orch goal <sessionId> show                  # the goal projection: status, objective, runs
pi-orch reroute <sessionId> --model-selector SEL [--thinking LEVEL]
                                               # pause goal -> abort -> set_model -> resume, stepwise
pi-orch watch <sessionId> register --conditions agent_end [--label L] [--pin] [--fire-if-settled] [--goal-id ID]
pi-orch watch <sessionId> list      # read the watch back: status, firingCount
pi-orch watch <sessionId> delete
pi-orch prompt <sessionId> --message "..."     # detached + idempotency key -> runId
                                               # [--mode prompt|follow_up|steer|deliver] [--owner ID]
pi-orch wait <sessionId> [--run-id <runId>] [--objective "..."] [--goal-id ID] [--deadline S]
pi-orch wait --all|--any <id>[@<runId>] ...    # several children, ONE long poll
pi-orch result <runId> [--transcript]          # final text + completion + outputClass + evidence
pi-orch result <runId> --final                 # only the answer (completion block / last real assistant text)
pi-orch verify <sessionId> [--run-id id] [--since ref] [--rerun "cmd"] \
  [--cwd dir] [--repo dir] [--rerun-timeout s] # re-check completion claims
pi-orch verify <sessionId> --gates-file brief.md [--gate-timeout s] [--cwd dir]
                                               # re-run the brief's GATES: block; a red gate → exit 20
pi-orch template [--goal]                      # print the full report instructions (paste into a brief)
pi-orch cleanup <sessionId> [--lease id --owner id] [--watch id]
pi-orch cleanup --owner <id>                   # EVERY ledger child of that owner (watch, lease, delete)
pi-orch status [--parent <sessionId>] | [--owner <id>] | [<sessionId>]
                                               # children: busy, goal, last run
pi-orch help | --help | -h                     # usage on stdout, exit 0
```

**Completion template and goal children.** A goal child's objective carries only a short single-line pointer; the full report instructions are no longer sent as a queued follow-up message by default (a follow-up could ride into an admission leak and fail delivery). Print them with `pi-orch template --goal` (or `pi-orch template` for the plain paragraph) and paste them into the brief file the objective points to. `spawn --goal-objective … --template-follow-up` and `goal <id> start … --template-follow-up` restore the old queued follow-up; exit 22 (`TEMPLATE_NOT_DELIVERED`) can only occur with that opt-in.

**Verifying gates.** A brief may end with a machine-readable block: a line `GATES:` followed by lines `- <command> → <expected exit>` (`->` is accepted too; backticks around the command are stripped). `verify <sessionId> --gates-file brief.md` runs each command in the child's cwd (the session's own, or `--cwd`) with a per-command timeout (`--gate-timeout S`, default 1800) and compares the exit status. Any gate whose exit differs makes the verdict `contradicted` (exit 20), listing each gate's expected and actual exit and the last 20 lines of its output. Verify stays read-only in intent: a gate containing `git push`, `git reset --hard`, `rm -rf /` or `npm ci`/`npm install` is refused (never run) and the verdict is `unverifiable` (exit 21). If no completion block was captured the verdict comes from the gates alone.

**Ledger and audit log.** `spawn-ledger.json` keeps its original format — a JSON array of entries (`sessionId`, `route`, `ownerId`, `leaseId`, `goalId`, `parentSessionId`, `at` — `goalId` is the one additive optional field, contract 1.62.0) that other tools may read directly — and is the derived view, rewritten atomically after every change. Beside it, `spawn-ledger.events.jsonl` (name derived from `PI_ORCH_SPAWN_LEDGER`) is an append-only event log (`spawned`, `deleted`, `pruned`, `lease`, `goal`); pruning and cleanup append events and change the view only, so no record is ever deleted. An existing array ledger with no events file is seeded into the log on first use (events marked `migrated`), and a missing or corrupt log falls back to the array, so no entry is lost. Every CLI invocation also appends one record `{ts, verb, subverb?, owner?, parentSession?, sessionId?, exitCode, durationMs}` to `~/.pi-orch/audit.jsonl` (override with `PI_ORCH_AUDIT_PATH`) — identifiers only, never message bodies, objectives or tokens; a failure to write it never fails the command.

`--json` gives machine output; the default is human-readable. `--id-only` prints the bare id for `$(...)` capture: `spawn` prints the session id, `prompt` prints the run id, `watch register`/`watch list` print the watch id. Never parse the human output — its wording can change at any time.

Arming a goal without `--goal-budget-tokens` prints a one-line stderr note naming the server default (5,000,000 tokens — enough to pause a long goal mid-run), so the omission is always visible. Unknown flags are a usage error (exit 2) naming the flag, before any request is sent — a typo can never silently change what a child receives.

`wait` never polls: it registers a watch on the child and blocks in the server's long poll, advancing the cursor and reconciling the run receipt at slice boundaries. `wait --all` settles every named child and `wait --any` returns with the first to settle — one long-poll request covers all watches. Unknown runs or sessions fail fast (exit 16). On a goal child, pass `--objective`; without it, `wait` reads the child's goal projection once and adopts the goal conditions when a goal is active or running. The objective you pass is matched against BOTH forms pi-orch knows: the raw text you gave `spawn --goal-objective` and the stored form the server actually holds (the raw objective plus the flattened completion-report pointer), so the wait settles on the goal whichever form you hold; an objective read from the projection (auto-detect) is already the stored form and registers once. A `goal_end` the server's restart reconciliation synthesises (its event is flagged `interruptedByRestart`) settles as `interrupted` (exit 5), never as a false `goal_failed`.

**Goal identity (contract 1.62.0).** Every `goal_state`/`goal_end` event and every goal projection now carries a stable top-level `goalId` (`goal_…`), and a new goal start mints a new one while an old goal's clear carries the old id. When pi-orch knows the CURRENT id — passed as `--goal-id`, or read from the LIVE projection by `wait`'s auto-detect only while the projection shows an active goal (`running`/`wrapping_up`) — the goal conditions it builds (`wait`, `watch register --conditions goal_end,paused`) match `dataMatch {"goalId":"…"}` instead of the objective forms, so a reused child's OLD goal cannot wake a new wait. The spawn ledger records the id for information (from `goal start` / `goal show`) but `wait` never selects conditions from it: the ledger is never cleared, so a stale id would key on the previous goal — with no active goal `wait` uses the plain `agent_end` path. Without a known current id (an older server, or no id learned) the objective forms are used exactly as before. The default goal-child condition set also carries a `stalled` condition (`goal_state` with `dataMatch {"stalled":true}`, plus the id when known): contract 1.62.0 emits it when a goal still reads `running` while its session has been idle past `GOAL_STALL_MINUTES` (default 10). A stalled goal is not a finished one — `wait` never turns that wake into a `paused` result; it keeps waiting and, if the deadline is reached, says in the outcome note that the goal reported a stall. The `stalled` token is also available explicitly: `watch <id> register --conditions stalled` (with `--goal-id` to key it on the goal).

**Quarantined admission debt (contract 1.62.0).** An admission refusal caused by quarantined leases (rather than free-capacity pressure) carries `reason: "quarantined_debt"` (with `quarantinedRuns` and `quarantinedOldestAgeMs`). By default `spawn` surfaces it at once (exit **10**, `ADMISSION_REFUSED`) with a line naming the quarantine and pointing at the flag. `spawn --wait-admission S` instead waits the server's `Retry-After` and retries the create until S seconds have elapsed, then spawns when the quarantine clears; any other refusal (and any transport loss — a create is not idempotent) is never sat out, and the budget timing out surfaces the last refusal.

On a server with contract 1.60.0 or newer, a goal child whose run was cut off by a restart interruption (a server restart or drain, or a boot-time orphan) is continued once by the server itself. `wait` treats that as progress, not a result: it stays in the same long poll and counts the continue, and the JSON result of every goal wait reports `"autoContinues": <n>` (0 when none). A stop the server does NOT continue — a restart interruption it could not continue, a second fault, a failed continue, or an unsupported runtime — surfaces as a `goal_state` paused with `pausedReason: "interrupted"`; the wait settles it as `interrupted` (exit 5) with the cause and continueCount in the JSON and a one-line note naming the parent's move (resume the goal, or re-dispatch). A provider-aborted goal ends exactly as before wave K (a failed `goal_end`) and needs you as it always did. Any other pause keeps the ordinary `paused` outcome (exit 0). `status` shows the same interruption facts (cause, continueCount, autoContinued) for a goal child, in the JSON body and on the human line.

By default every dispatched `prompt` message and every `spawn --goal-objective` asks the child to end its final answer with a fenced `completion` block (schema `pi-completion/v1`: status, summary, commands with exit codes, tests, commits, filesChanged, openIssues, blockedReason). For a goal child the instructions also tell it — in plain words — to write the exact line `Status: GOAL_ACHIEVED` on a line of its own **immediately before** the report block when the goal is met (`Status: CONTINUING` there until it is), as plain text with no decoration. The goal engine's verifier accepts the last status line anywhere in the final message, so this placement lets the report block stay the last thing in the answer while the marker stays visible: without it the two instructions conflicted (block must be last vs marker at the end) and goal children dropped the marker, looping to their turn budget. The goal form also shows every optional field's exact shape (e.g. `"tests":[{"name":"…","result":"pass"}]` — an array of objects, never a string), because children otherwise invented shapes the server rejects (`SCHEMA_VIOLATION`, fieldPath `tests`), and pins the fence format: the opening fence line must be exactly ` ```completion ` on its own line with the JSON on the next line, since a fence line carrying content is never captured as a block. Plain prompts carry the unchanged template text. The goal template rides as one queued follow-up after the arm turn; `spawn` re-sends it only when that follow-up's receipt shows a non-delivery terminal failure: `failed` (including a never-started code), or `cancelled`/`interrupted` WITHOUT a `startedAt` — a `startedAt` proves the server observed the template's user message before the restart/cancel, so a re-send would duplicate it. A `queued`, `accepted` or `started` receipt is healthy delivery-in-progress and is never re-sent, so a goal child receives the template exactly once; both attempts failing exits 22 (`TEMPLATE_NOT_DELIVERED`). `result` parses the block into `completion` / `completionError` fields; `verify` re-checks its cheap facts against the filesystem with read-only git (claimed commits exist, `filesChanged` shows change evidence, and a claimed test is re-run only when you name the exact command with `--rerun`). Use `--no-completion-template` for steering chatter that is not a task.

`result` also classifies what a run output from the receipt's own evidence: `outputClass` is `command` for a slash-command handler return (a `/goal` arm prompt ends at its command boundary with no assistant text — that is by design, not an empty final answer), `final_text` when the receipt carries final text, and `no_text` otherwise (the genuinely unexplained class: assistant messages but no text).

### Pausing, rerouting, delivering and cleaning up (W2c)

These verbs replace the hand-written `curl` sequences long parents used to carry.

- **`goal <sid> pause [--reason R] | resume [--note N] | show`** wrap the goal control route (`POST /sessions/:id/goal` with `action` `pause`/`resume`, `GET /sessions/:id/goal`). `--reason` belongs to `pause` and `--note` to `resume`; a flag that belongs to another action is a usage error, never silently dropped. Servers up to contract 1.62.0 accept but ignore `reason` and `note` (the child does not see the note); to tell a resumed child something, follow the resume with `prompt --mode deliver`.
- **`reroute <sid> --model-selector SEL [--thinking L]`** moves a goal child onto another model in the order that works: pause the goal, abort the live turn (`POST /sessions/:id/abort`), `set_model` (+ `set_thinking_level`) through `/control`, resume the goal with a short note, then re-read the goal to prove the **same objective** is running. (`set_model` on a busy child blocks until it is idle, so doing it before the abort took 45 minutes by hand.) Every step is reported (`--json` carries `steps[]`, `failedStep`, `objectiveIntact`). The first failing step stops the sequence; if the goal was paused by this call it gets ONE recovery resume so it is never left stuck, and the exit code is 1. A `409` on the abort means nothing was running and is not a failure. A session with **no active goal** gets a plain abort + `set_model` with a note — nothing is paused or resumed. A goal that was already paused is resumed at the end.
- **`prompt --mode deliver`** is one atomic choice: if the child has a live turn and its runtime supports steering (`/capabilities` `supportsSteer`), the message is sent as `steer` with `requireActiveTurn`; otherwise as `follow_up` (which starts the next turn on an idle child, or queues behind a runtime that cannot steer). If the turn ended between the read and the send, the refused steer falls back to one `follow_up`. The output reports what was done (`deliver.chosen`, `deliver.reason`, the server's `dispatchMode`) and the queue depth when the server reports one.
- **`status --json`** fills `busy`, `status` and `lastRun` (`runId`, `status`, `endedAt`) for each child. A list row that omits `busy`/`status` (they are optional on `GET /sessions`) triggers a detail read; `busy` falls back to `status == running`; `lastRun` is the newest run by timestamp (the evidence order is not pinned by the contract; without timestamps the first entry is used). A failed read is reported in the child's `readErrors` instead of silently producing nulls. **`status --owner`** reads each ledger child by id and prunes an entry only on a `404` — the sessions list (which can be limited) never decides that a child is gone, so an owner's existing children are listed until they are deleted. A child spawned with `--owner` is now recorded in the ledger even when the caller has a session identity.
- **`result <runId> --final`** returns just the answer: the parsed completion block, else the receipt's final text, else the last non-empty **assistant** message in the visible transcript — never an empty tool-call tail (`final.source` says which: `completion`, `receipt`, `transcript` or `none`). Human output prints the text alone.
- **`cleanup --owner <id>`** (no session id) cleans every child the spawn ledger holds for that owner and only that owner: cancel its watch first (generation-safe — the generation is read and sent as the precondition, a replaced watch is skipped), release the lease the spawn stored (or, for an older ledger entry, the leases the session detail reports), delete the session. A `404` anywhere means "already gone". One report line per child; a child that failed stays in the ledger so a re-run retries it, and the exit code is 1 when any child failed. `cleanup <sid>` without `--lease` now also uses the ledger's stored lease.

### Per-route child concurrency

One provider route can only serve so many children at once (measured 2026-09-30: zai GLM 5.3 Flash stops returning completions above roughly 5–8 concurrent children). `pi-orch` therefore caps the number of a caller's **live** children per model route:

- The built-in default is `zai/glm-5.3-flash: 5`; every other route is unlimited until configured.
- On a Claude SDK profile route (`--model-selector profile:<id>` with `--runtime claude`) the decision comes from what the server itself advertises, so a parent never learns about the provider's cap from a failed child: a new turn is refused exactly when `GET /capacity` `claudeProfiles` says that profile is full (`active >= maxConcurrent`). `active` already counts this parent's live turns, so the local count is never added to it or compared against a remainder — it is only listed in the refusal for context. An older server that does not advertise `claudeProfiles` keeps the unlimited default, and an explicit limit always wins over the advertised one (including an explicit `0` = unlimited).
- Configure with `PI_ORCH_ROUTE_LIMITS`, a JSON map of model selector → limit, and per call with repeatable `--route-limit 'SEL=N'` flags — the flag wins. `N=0` (or `unlimited`) lifts the cap for that route. A malformed limit map is a hard error, never a silent unlimited. Any explicit limit wins over an advertised Claude profile cap.
- **Live** means the child can still be generating: busy, a nonterminal run receipt, or a goal `running`/`wrapping_up`. A finished idle child never counts.
- `spawn` counts your live children on the route (by your session identity, or by your `--owner` retention owner for bare-CLI callers) and **refuses before creating anything** over the limit — exit **25 (`ROUTE_LIMIT`)**, naming the live children; on a Claude profile route the same refusal names the profile's `maxConcurrent` and live `active` count (the server's numbers, which already include your own live turns) and tells you to ask the owner to authorise the PAYG overflow route (`pi · anthropic · anthropic/claude-sonnet-5-5`, quoting the `anthropic-api` balance from `agent-os provider-usage`) — never automatically. A server `429 PROFILE_CAPACITY_EXHAUSTED` (contract 1.61.0, refused before any run receipt) maps to the same exit 25 with the same message. With `--wait-for-slot S` it instead watches the live children and spawns when one settles; on timeout it exits **3 (`DEADLINE`)** — except on a server-advertised profile cap, which is a server-wide condition (the holders may be other parents' turns), so there is no local slot to watch and `--wait-for-slot` refuses at once with exit 25. It never polls and never sleeps. The count→create span is serialised across processes with an exclusive lock file under the pi-orch state dir (held only across the count and the create POST; a wait for the lock is bounded and fails with a clear `ROUTE_LOCK_TIMEOUT` error).
- **Quarantined admission debt** is a separate refusal class (contract 1.62.0): when quarantined leases rather than free-capacity pressure tip an admission refusal over, the 429 body carries `reason: "quarantined_debt"`. `spawn` surfaces it at once (exit **10 (`ADMISSION_REFUSED`)**) with a line naming the quarantine and suggesting the flag; `spawn --wait-admission S` waits the server's `Retry-After` and retries the create until S seconds have elapsed, then spawns when the debt clears. Other refusal reasons are never waited out, and the budget timing out reports the last refusal.
- `prompt` applies the same gate when it would START a new turn on an idle child of a limited route (a prompt to a live child queues after its current turn and cannot raise route concurrency; `steer` is never gated). A bare-CLI caller counts the target child's owner from the spawn ledger, or an explicitly passed `--owner`.
- Counting uses the server's own views: `GET /sessions?parent=<your session>` when your identity is known; otherwise a local spawn ledger (`PI_ORCH_SPAWN_LEDGER`, default `~/.pi-orch/spawn-ledger.json`) keyed by your `--owner`. A stale identity falls back to the owner ledger when an owner is known. With neither an identity nor an owner the limit cannot be counted: the client warns once (`ROUTE_LIMIT_UNCOUNTED`) and proceeds.
- **Caps apply only to spawns that name `--model-selector`** — a spawn with no selector on record is never counted against any cap, and the client warns once when caps are configured and such a spawn is made. If liveness reads fail for a child, it counts as live (fail closed).

```bash
PI_ORCH_ROUTE_LIMITS='{"zai/glm-5.3-flash": 2}' \
  pi-orch spawn --runtime pi --cwd /task --model-selector zai/glm-5.3-flash --owner me
# over the cap: exit 25 naming the live children
# ... or wait for a slot instead:
pi-orch spawn --runtime pi --cwd /task --model-selector zai/glm-5.3-flash \
  --owner me --route-limit 'zai/glm-5.3-flash=2' --wait-for-slot 600
```

### Counting runs under admission pressure (receipt inflation)

Under admission pressure the server refuses a prompt with `429`/`503` + `Retry-After`; `pi-orch` retries under the SAME idempotency key, and the server — which creates a receipt before the admission check and releases the key on refusal — leaves one cancelled, never-started receipt per refused attempt (typed `ADMISSION_CAPACITY_EXHAUSTED`, `SERVER_DRAINING` or `SESSION_BUSY`; server behaviour at 1.58.x). A refused-then-retried prompt therefore leaves one real receipt **plus one refusal receipt per refused attempt**. Count runs with `countRunAttempts(receipts)` (from the public module surface) — it returns `{ dispatched, refusedBeforeDispatch, other }`, one run per real attempt with refusals reported separately — never with raw receipt totals, and never read run-receipt counts as dispatch counts (`classifyReceipt` marks each refusal receipt `refusedBeforeDispatch: true`).

## Parent patterns (external parents, budgets, goals)

A **Claude Code parent is not a Pi Web UI session**: the server cannot prompt it, and its children carry no parent lineage — only the retention `--owner` id you pass to `spawn`. That has three consequences:

- **Lineage.** Follow the owner-id convention `orch-<programme>-<parentShort8>-<lane>` (for example `orch-j2-01a0fc47-j2lane`): programme tag, the first 8 hex characters of the dispatching parent session id, lane. The fragment makes each real parent countable and keeps owner ids unique per (parent, lane). `status --owner <id>` lists that owner's children (busy, goal state, last run) from the local spawn ledger — the **registered session list**: a child stays listed while it exists on the server, settled-but-retained children included (durable retention keeps idle children listed on purpose); entries are pruned only when the session is DELETED from the server, never when it merely goes idle. `cleanup <sid> --lease <id> --owner <id>` releases and deletes by owner. The ledger is per-host and best-effort — children dispatched by other clients (hand-written curl) never enter it — which is exactly why programmes should dispatch through pi-orch.
- **Waiting.** Two patterns; pick one per dispatch. *Idle* (interactive parents): register the wake with your harness's own tool — the watch-wake extension or mod's `watch_wake_register` (Pi, Claude Code), or server `onFire` for a managed parent — then **end your turn**; the wake arrives while you hold no tokens. **`pi-orch watch register` is not a wake:** it creates a pure-observer server watch with no delivery to a bare CLI, and a foreign watch on the child makes the watch-wake mod refuse to register its own. Use it only where something else delivers (an exiting background watcher polling the printed watch id). Arm a deadline backstop for must-not-miss waits. *In-turn* (scripts, batch parents): `pi-orch wait <sid>` blocks the caller until the child settles (or exit 3 at the deadline). `pi-orch wait` never fits the idle pattern — it holds your turn; `pi-orch watch` never waits.
- **Budgets.** Whenever a goal child may run long, arm the budget explicitly: `--goal-budget-tokens 60000000` on zai lanes (DeepSeek needed about 40M in one measured lane). The server default is 5,000,000 tokens and pauses long goals mid-run; omitting the flag prints a stderr note so the default is never silent.

`goal <sessionId> start` arms a goal on an already-created session (the create-then-goal order hand-written dispatch scripts use), with the same `--goal-objective`, `--goal-max-turns`, `--goal-verify` and `--goal-budget-tokens` flags as `spawn` — and the same completion-template delivery (the objective carries the flattened pointer, the full report instructions arrive as one follow-up, exit 22 when delivery fails; skip with `--no-completion-template`). Pause, resume and clear stay interactive on the child; pi-orch arms only.

`watch <sessionId> register --conditions goal_end,paused` matches the `--objective` you pass against **both forms** pi-orch knows: the raw text you gave `spawn --goal-objective` and the stored form the server actually holds (the raw objective plus the flattened completion-report pointer) — the same rule `wait` uses — so the condition can fire whichever form is stored (an already-stored objective registers once). With no `--objective` the condition carries **no objective filter at all** — it wakes on any goal end or pause, so on a reused child pass `--objective`, or an earlier goal's end or pause will wake it. pi-orch never falls back to an `objective: "*"` placeholder: the server matches `dataMatch` by strict equality, so `"*"` can never equal a real objective and such a watch is dead on arrival. On contract 1.62.0 pass `--goal-id ID` and the goal conditions match the stable top-level `goalId` instead; the `stalled` token registers a `goal_state` condition on `dataMatch {"stalled":true}` (add `--goal-id` to key it on the goal too).

`watch <sessionId> delete` is generation-safe (contract 1.35.0 CAS): it sends `expectedGeneration` from `--generation` or from a fresh read it reports, and a replaced watch is refused (409 `WATCH_GENERATION_MISMATCH`, exit 19 naming both generations) instead of silently deleting a newer watch. When no generation is available (nothing registered, or a read without one) the delete **fails closed** — exit 19, nothing sent — unless you pass `--force-unconditional`, the documented legacy escape and the only unconditional path. The delete acknowledgement is validated (success, watchId, and the exact generation) before anything is reported as deleted; pi-orch's own internal watch cleanup (cleanup, wait-for-slot) uses the same conditional deletes and skips — never deletes — a replaced watch.

Deprecated: `wait --slice S` is accepted as a no-op with a stderr note — it never had any effect (the long-poll slice is chosen internally) and will be removed in a future release.

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
| `PI_ORCH_ROUTE_LIMITS` | Per-route live-children cap, JSON map `{"model selector": limit}`; `0` = unlimited; a `--route-limit` flag wins |
| `PI_ORCH_SPAWN_LEDGER` | Bare-CLI spawn ledger path (default `~/.pi-orch/spawn-ledger.json`; a JSON array, with an append-only `.events.jsonl` log beside it) used to count live children by `--owner` |
| `PI_ORCH_AUDIT_PATH` | Verb audit log path (default `~/.pi-orch/audit.jsonl`): one JSONL record per CLI invocation |
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

## Lane runner

`pi-orch lane run <lane-dir>` is a small program over this client for **one lane**. It does what a parent otherwise does by hand — spawn the implementer, register the watch, dispatch the brief (a prompt, or a goal), wait, run the brief's `GATES:`, spawn a cross-family reviewer, read its verdict — and **exits only at judgement events**: a child question, gates still red after the correction cap, a reviewer verdict to adjudicate, a capacity refusal that needs the owner's overflow decision, or done. Start it as an ordinary background process; process exit is the one wake that works on every harness. It is a loop, a journal and an exit — not a conductor: no contracts, no sign-off machinery.

```bash
pi-orch lane run ./my-lane --dry-run                 # validate every input and print the plan; no API call, nothing written
pi-orch lane run ./my-lane &                         # run (or resume) the lane
pi-orch lane run ./my-lane --continue correction     # after exit 42: send the findings as ONE correction + a closure review
```

Flags: `--dry-run`, `--continue correction`, `--deadline S` (per wait, default 1800; exit 3 means "still working, re-run to keep waiting"), `--json`, plus the common connection flags (`--parent-session` overrides the lane's `parentSessionId`). A sample directory lives in [`examples/lane/`](examples/lane/).

**Inputs** (the lane directory):

| File | Contents |
|---|---|
| `lane.json` | `lane` (name), `cwd` (absolute), `owner` (retention ownerId), `implementer` / `reviewer` (`{runtime, selector, thinking}`), `mode` (`goal` or `prompt`), `objective?` (goal mode, one line), `ttlSeconds`, `budgetTokens?` (goal mode), `parentSessionId`, `maxCorrections` (0 or 1). Unknown keys are a usage error (exit 2). |
| `brief.md` | The implementer's brief; it must end with a `GATES:` block (`- <command> → <exit>` lines). |
| `review-brief.md` | The reviewer's brief. A line `VERDICT FILE: <path>` names the verdict file (relative to the lane dir; default `verdict.md`); its first line must be `VERDICT: ACCEPT`, `VERDICT: ACCEPT WITH FIXES` or `VERDICT: REJECT`. |
| `correction-template.md` | Optional. `{{LANE}}` and `{{RED_GATES}}` (each red gate with its command, exit and last output lines) are substituted. |

**Outputs** (written into the lane dir): `runner-journal.jsonl` (one record per completed step: `ts`, `step`, ids, outcome), `runner-state.json` (the step receipts, session / lease / watch / run ids, counters) and `runner-exit.json` (code, name, reason, implementer and reviewer ids — the children are left for the parent to clean up).

**Exits:** `0 DONE` · `3 DEADLINE` · `25 ROUTE_LIMIT` (the refusal carries the overflow hint; overflow is the owner's decision, never automatic) · `40 QUESTION` (an `NN-question.md` file in the lane dir, or the `PI-ORCH-LANE-QUESTION` sentinel) · `41 GATES_RED` (still red after the one correction) · `42 VERDICT` (ACCEPT WITH FIXES or REJECT) · `43 RUNNER_ERROR`. A bad lane dir or a refused `--continue` is `2 USAGE`.

**Resume.** Every action is a named step whose receipt is persisted before the next one starts. Re-running `lane run <dir>` replays from the state: a step with a receipt is never repeated, so no child is re-spawned and no prompt re-sent (prompts also carry a deterministic idempotency key `lane:<lane>:<step>`, so even a kill between the server accepting a prompt and the receipt being written only re-sends a server-side duplicate). Spawn and goal start have no server idempotency: if a run was killed after one of those calls began but before its receipt was written, the next run refuses with exit 43 and a reconcile hint (`pi-orch status --owner <owner>`) instead of risking a second child. A `runner.lock` (holder pid) keeps two runners off one lane. After exit 40 (you answered the child) re-running resumes the wait without the first run's receipt shortcut; exit 3 and exit 25 retry the same step.

**`--continue correction`** is valid only when the lane sits at exit 42: it sends the reviewer's verdict file to the same implementer as ONE correction, re-runs the gates (red → 41), and runs a closure review on the same reviewer, ending in 0 or 42 again — never a third round.

Every prompt starts with the `agent-os-child` directive (`CHILD_DIRECTIVE` in `src/lane-runner.ts`).

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
| 22 | `TEMPLATE_NOT_DELIVERED` | spawn/goal start with `--template-follow-up`: the goal completion-template follow-up failed both delivery attempts — the child holds only the pointer objective; re-send the template or re-dispatch |
| 23 | `CREDENTIAL_IN_REPO` | a credential path (the Internal API token) resolves inside this repository; the token must come from outside the repo — point `PI_WEB_UI_TOKEN_PATH` at a path outside the package root |
| 24 | `REMOTE_API_BASE_REFUSED` | `PI_WEB_UI_API_BASE` points at a non-loopback host (or a remote host over http); only a loopback API base or the Unix socket is allowed unless `PI_ORCH_ALLOW_REMOTE_API_BASE=1` is set, and even then a remote base must be `https:` |
| 25 | `ROUTE_LIMIT` | Refused BEFORE any child was created: you already have the limit's worth of live children on that model route (busy, nonterminal run, or goal running/wrapping_up), or the server advertised a Claude profile cap (`GET /capacity` `claudeProfiles`) that is full — a server `429 PROFILE_CAPACITY_EXHAUSTED` maps here too. A Claude profile refusal names the cap and the owner-authorised PAYG overflow route. Use `--wait-for-slot` (explicit local limits only), wait manually, or spread across another route |
| 40 | `QUESTION` | lane run: a child parked with a question (an `NN-question.md` file in the lane directory, or the question sentinel) — read it, answer the child, re-run the lane to resume the wait |
| 41 | `GATES_RED` | lane run: the brief's GATES are still red after the correction cap (one bounded correction, or none when `maxCorrections` is 0) — the parent adjudicates; the runner sends nothing more |
| 42 | `VERDICT` | lane run: the reviewer returned ACCEPT WITH FIXES or REJECT (or the closure review did) — the parent adjudicates; `--continue correction` sends the findings as ONE correction plus a closure review |
| 43 | `RUNNER_ERROR` | lane run: an unexpected error, a failed child wait, an unreadable verdict, an unknown spawn outcome, or a held runner lock — the journal is intact; fix the cause and re-run to resume |

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
