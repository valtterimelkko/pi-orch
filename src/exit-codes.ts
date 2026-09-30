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
  { code: 13, name: 'VERIFY_STUB', meaning: 'verify is a stub interface (filled by plan step C3); nothing was verified' },
  { code: 14, name: 'PROMPT_NOT_EXECUTED', meaning: 'Pi accepted the prompt but no turn ever started (extension input-hook swallow)' },
  { code: 15, name: 'TURN_STALLED', meaning: 'The turn stalled past the watchdog window; check the session before re-prompting' },
  { code: 16, name: 'WAIT_TARGET_NOT_FOUND', meaning: 'wait fast-fail: the --run-id is unknown/malformed (no such receipt) or the sessionId is not in the registry — nothing to wait on (correction 01)' },
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
};

/** Server error codes that map to a specific exit (others fall back to 1/4/12). */
export const ERROR_CODE_EXIT_CODES: Record<string, number> = {
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
};

export function nameFor(code: number): string | undefined {
  return EXIT_CODES.find((entry) => entry.code === code)?.name;
}

export function exitCodeFor(outcome: { kind: string }): number {
  return OUTCOME_EXIT_CODES[outcome.kind] ?? 1;
}
