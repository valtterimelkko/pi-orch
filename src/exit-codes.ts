/**
 * Documented exit codes (README "Exit codes" table must stay in sync —
 * test/exit-codes.test.ts enforces it).
 *
 * The distinction that matters to a shell-calling model: 0 = go read the
 * result; 3 = still running (re-wait is safe); 4–9, 14, 15 = the child/run
 * ended badly in a SPECIFIC way (each names the server code); 10–12 = the
 * server refused before any child work; 1 = unexpected local/transport error;
 * 2 = the command was used wrong.
 */

export interface ExitCodeEntry {
  code: number;
  name: string;
  meaning: string;
}

export const EXIT_CODES: readonly ExitCodeEntry[] = [
  { code: 0, name: 'OK', meaning: 'Success (accepted dispatch, finished wait, read result, or the child parked to ask — read the JSON body)' },
  { code: 1, name: 'ERROR', meaning: 'Unexpected error: transport failure, missing socket/token, malformed non-error response' },
  { code: 2, name: 'USAGE', meaning: 'Bad command line (unknown verb/flag, missing required argument)' },
  { code: 3, name: 'DEADLINE', meaning: 'Wait deadline elapsed while the child was still working — re-wait; never re-dispatch on this' },
  { code: 4, name: 'RUN_FAILED', meaning: 'The run receipt ended failed (no specific code matched); read errorCode in the JSON' },
  { code: 5, name: 'INTERRUPTED', meaning: 'Run interrupted (server restart or drain); interruptedByRestart — re-dispatch or resume the goal after the restart' },
  { code: 6, name: 'NEVER_STARTED', meaning: 'Accepted run produced no runtime activity inside the start window (C2) — the dispatch never ran' },
  { code: 7, name: 'BUDGET_EXCEEDED', meaning: 'Run hit a per-run budget (output tokens / streamed bytes / tool args); split the task' },
  { code: 8, name: 'CANCELLED', meaning: 'Run was cancelled (abort or disconnect of an attached owner)' },
  { code: 9, name: 'TRANSPORT_LOST', meaning: 'Receipt terminalised but the synchronous dispatch chain never returned (C2 fence); the outcome is in the receipt' },
  { code: 10, name: 'ADMISSION_REFUSED', meaning: '429/503 with Retry-After persisted past the retry budget (slots, heap/lag pressure, draining) — wait the stated time, retry' },
  { code: 11, name: 'PREFLIGHT_FAILED', meaning: 'C4 preflight refused before any model token was spent; fix the listed paths/tools' },
  { code: 12, name: 'REFUSED_BUSY', meaning: '409 refusal (SESSION_BUSY / SESSION_NOT_STREAMING / SESSION_OWNED_BY_OTHER_RUNTIME / SESSION_FENCED) — resolve ownership or use follow_up/steer' },
  { code: 13, name: 'VERIFY_STUB', meaning: 'RETIRED in C3b: verify is now implemented (verdicts map to 0/20/21); this code is no longer emitted' },
  { code: 14, name: 'PROMPT_NOT_EXECUTED', meaning: 'Pi accepted the prompt but no turn ever started (extension input-hook swallow)' },
  { code: 15, name: 'TURN_STALLED', meaning: 'The turn stalled past the watchdog window; check the session before re-prompting' },
  { code: 16, name: 'WAIT_TARGET_NOT_FOUND', meaning: 'wait fast-fail: the --run-id is unknown/malformed (no such receipt) or the sessionId is not in the registry — nothing to wait on (correction 01)' },
  { code: 17, name: 'GOAL_CLEARED', meaning: 'The goal ended `cleared` (correction 04: goal_end is classified from the goal projection, not assumed success) — not achieved; go look' },
  { code: 18, name: 'CREATE_UNKNOWN', meaning: 'A create (POST /sessions) lost its connection or response; the server may or may not have created the session — reconcile with status --parent (the client never blindly re-spawns)' },
  { code: 19, name: 'WATCH_CONFLICT', meaning: 'An incompatible watch owned by someone else is active on the child; the client never replaces foreign watches — use a different label or remove the watch' },
  { code: 20, name: 'VERIFY_CONTRADICTED', meaning: 'verify found at least one claim contradicted by the filesystem (missing sha, wrong repo, file with no evidence, failed parent-named rerun) — the block lies somewhere' },
  { code: 21, name: 'VERIFY_UNVERIFIABLE', meaning: 'verify could not establish the claims: no completion captured, a typed parse error, an unsafe/absolute path, nothing independently checkable, or the named run belongs to another session' },
  { code: 22, name: 'TEMPLATE_NOT_DELIVERED', meaning: 'spawn: the goal completion-template follow-up failed both delivery attempts — the child holds only the pointer objective, not the full report instructions. Re-send the template or re-dispatch' },
  { code: 23, name: 'CREDENTIAL_IN_REPO', meaning: 'A credential path (the Internal API token) resolves inside this repository; the token must come from outside the repo — point PI_WEB_UI_TOKEN_PATH at a path outside the package root' },
  { code: 24, name: 'REMOTE_API_BASE_REFUSED', meaning: 'PI_WEB_UI_API_BASE points at a non-loopback host (or a remote host over http); only a loopback API base or the Unix socket is allowed unless PI_ORCH_ALLOW_REMOTE_API_BASE=1 is set, and even then a remote base must be https:' },
  { code: 25, name: 'ROUTE_LIMIT', meaning: 'G1: refused BEFORE any child was created — the caller already has the limit’s worth of live children on that model route (busy, nonterminal run, or goal running/wrapping_up). Use --wait-for-slot, wait manually, or spread across another route' },
];

export const OUTCOME_EXIT_CODES: Record<string, number> = {
  completed: 0,
  goal_achieved: 0,
  goal_failed: 4,
  paused: 0,
  question: 0,
  deadline: 3,
  failed: 4,
  interrupted: 5,
  never_started: 6,
  budget_exceeded: 7,
  cancelled: 8,
  transport_lost: 9,
  prompt_not_executed: 14,
  turn_stalled: 15,
  run_not_found: 16,
  session_not_found: 16,
  goal_cleared: 17,
  create_unknown: 18,
  watch_conflict: 19,
};

/** Server error codes that map to a specific exit (others fall back to 1/4/12). */
export const ERROR_CODE_EXIT_CODES: Record<string, number> = {
  CREDENTIAL_IN_REPO: 23,
  REMOTE_API_BASE_REFUSED: 24,
  PREFLIGHT_FAILED: 11,
  SESSION_BUSY: 12,
  SESSION_NOT_STREAMING: 12,
  SESSION_OWNED_BY_OTHER_RUNTIME: 12,
  SESSION_FENCED: 12,
  NEVER_STARTED: 6,
  RUN_BUDGET_EXCEEDED: 7,
  RUN_TRANSPORT_LOST: 9,
  PROMPT_NOT_EXECUTED: 14,
  TURN_STALLED: 15,
  ADMISSION_CAPACITY_EXHAUSTED: 10,
  SERVER_DRAINING: 10,
  ROUTE_LIMIT_EXCEEDED: 25,
  ROUTE_LIMIT_WAIT_DEADLINE: 3,
};

export function nameFor(code: number): string | undefined {
  return EXIT_CODES.find((entry) => entry.code === code)?.name;
}

/** C3b: verify verdicts map to their own exit codes (documented table). */
export const VERIFY_EXIT_CODES: Record<'verified' | 'contradicted' | 'unverifiable', number> = {
  verified: 0,
  contradicted: 20,
  unverifiable: 21,
};

export function exitCodeFor(outcome: { kind: string }): number {
  return OUTCOME_EXIT_CODES[outcome.kind] ?? 1;
}
