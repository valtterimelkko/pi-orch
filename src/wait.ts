/**
 * The wait verb: watch-based, idle until woken, with a deadline. The process
 * blocks inside the server's long poll (GET /watches/wait) — it never sleeps
 * in a polling loop. Receipt reconciliation happens at slice boundaries (once
 * per long-poll return, bounded) so receipt-only terminals that emit no event
 * (NEVER_STARTED, RUN_TRANSPORT_LOST, cancelled) surface without polling.
 *
 * Restart survival: a broken long poll is reconnected with the SAME cursor; if
 * the watch itself is gone (404) or detached, it is re-registered with
 * fireIfSettled:true so a child that settled during downtime yields one
 * reconciled firing, and the cursor resets to 0 for the new ledger.
 */

import type { WatchConditionSpec } from './parsers.ts';
import { classifyReceipt, isTerminalReceipt, parseWatchesWait, type Receipt, type ReceiptClassification } from './parsers.ts';

export interface WaitDeps {
  longPoll(input: { ids: string[]; cursor?: string; timeoutMs: number }): Promise<{ kind: 'fired'; body: unknown } | { kind: 'timeout' }>;
  getReceipt(runId: string): Promise<Receipt>;
  getSessionEvidence(sessionId: string): Promise<{ runs: Array<{ runId?: string; status?: string; errorCode?: string }> }>;
  registerWatch(sessionId: string, body: Record<string, unknown>): Promise<{ watchId: string; status?: string }>;
  getWatch(sessionId: string): Promise<{ watchId: string; status?: string } | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type WaitOutcome =
  | { kind: 'completed'; receipt?: Receipt; note?: string }
  | { kind: 'failed'; receipt?: Receipt; note?: string }
  | { kind: 'never_started'; receipt?: Receipt; note?: string }
  | { kind: 'budget_exceeded'; receipt?: Receipt; note?: string }
  | { kind: 'transport_lost'; receipt?: Receipt; note?: string }
  | { kind: 'prompt_not_executed'; receipt?: Receipt; note?: string }
  | { kind: 'turn_stalled'; receipt?: Receipt; note?: string }
  | { kind: 'interrupted'; receipt?: Receipt; interruptedByRestart: boolean; note?: string }
  | { kind: 'cancelled'; receipt?: Receipt; note?: string }
  | { kind: 'paused'; evidence?: string; note?: string }
  | { kind: 'question'; evidence?: string; note?: string }
  | { kind: 'goal_achieved'; evidence?: string; note?: string }
  | { kind: 'goal_failed'; evidence?: string; note?: string }
  | { kind: 'deadline'; note?: string };

export interface WaitOptions {
  sessionId: string;
  runId?: string;
  conditions: WatchConditionSpec[];
  objective?: string;
  /** Overall deadline in ms (client-side). */
  deadlineMs: number;
  /** Long-poll slice in ms; the server caps any single wait at 300000. */
  sliceMs?: number;
  label?: string;
  deps: WaitDeps;
}

const MAX_SLICE_MS = 300_000;
const RECOVERY_ATTEMPTS = 10;
const RECOVERY_BACKOFF_MS = 1_000;

export async function waitOnChild(options: WaitOptions): Promise<WaitOutcome> {
  const { deps } = options;
  const sliceMs = Math.min(options.sliceMs ?? 45_000, MAX_SLICE_MS);
  const start = deps.now();

  let watch = await registerOrReuse(options.sessionId, options.conditions, options.label, deps);
  let watchId = watch.watchId;
  let cursor: string | undefined = undefined; // fresh ledger view on first registration
  let recoveryAttempts = 0;
  let receiptChecks = 0;

  while (true) {
    const elapsed = deps.now() - start;
    const remaining = options.deadlineMs - elapsed;
    if (remaining <= 0) {
      return { kind: 'deadline', note: `waited ${elapsed}ms without a terminal outcome` };
    }

    let result: { kind: 'fired'; body: unknown } | { kind: 'timeout' };
    try {
      result = await deps.longPoll({ ids: [watchId], cursor, timeoutMs: Math.min(sliceMs, remaining) });
    } catch {
      // Transport break or watch loss. Reconnect with bounded retries; on a
      // 404-shaped loss, re-register with fireIfSettled and reset the cursor.
      recoveryAttempts += 1;
      if (recoveryAttempts > RECOVERY_ATTEMPTS) {
        return { kind: 'deadline', note: `transport lost past ${RECOVERY_ATTEMPTS} recovery attempts` };
      }
      await deps.sleep(RECOVERY_BACKOFF_MS);
      const existing = await deps.getWatch(options.sessionId).catch(() => null);
      if (!existing || existing.status === 'detached') {
        watch = await registerOrReuse(options.sessionId, options.conditions, options.label, deps, true);
        watchId = watch.watchId;
        cursor = undefined; // new ledger: start at 0 so a reconciled firing is seen
      }
      continue;
    }
    recoveryAttempts = 0;

    if (result.kind === 'fired') {
      const parsed = parseWatchesWait(result.body);
      cursor = parsed.nextCursor;
      const outcome = await outcomeFromFirings(parsed.watches.flatMap((watch_) => watch_.firings), options, deps, () => {
        receiptChecks += 1;
        return receiptChecks;
      });
      if (outcome) return outcome;
      continue;
    }

    // Slice timed out: one bounded receipt reconciliation (catches
    // receipt-only terminals), then loop back into the long poll.
    const outcome = await reconcileReceipt(options, deps);
    if (outcome) return outcome;
  }
}

async function registerOrReuse(
  sessionId: string,
  conditions: WatchConditionSpec[],
  label: string | undefined,
  deps: WaitDeps,
  recovery = false,
): Promise<{ watchId: string }> {
  if (!recovery) {
    const existing = await deps.getWatch(sessionId).catch(() => null);
    if (existing && existing.status === 'active') {
      // One watch per session: never replace another observer's live watch.
      return { watchId: existing.watchId };
    }
  }
  const body: Record<string, unknown> = { conditions };
  if (label !== undefined) body.label = label;
  body.fireIfSettled = true;
  const registered = await deps.registerWatch(sessionId, body);
  return { watchId: registered.watchId };
}

async function outcomeFromFirings(
  firings: Array<{ conditionId: string; eventType: string; evidence?: string }>,
  options: WaitOptions,
  deps: WaitDeps,
  countReceiptCheck: () => void,
): Promise<WaitOutcome | null> {
  for (const firing of firings) {
    if (firing.eventType === 'goal_state') {
      return { kind: 'paused', evidence: firing.evidence, note: 'goal paused — read the session before resuming' };
    }
    if (firing.eventType === 'text') {
      return { kind: 'question', evidence: firing.evidence, note: 'question sentinel matched' };
    }
    if (firing.eventType === 'goal_end') {
      // Only conditions carrying the exact-objective dataMatch can fire here
      // (the server filters), so this is the real outcome, not a stale clear.
      const evidence = firing.evidence ?? '';
      if (evidence.includes('failed')) return { kind: 'goal_failed', evidence };
      return { kind: 'goal_achieved', evidence };
    }
    if (firing.eventType === 'agent_end' || firing.eventType === 'deadline') {
      const outcome = await reconcileReceipt(options, deps, countReceiptCheck);
      if (outcome) return outcome;
      if (firing.eventType === 'deadline') return { kind: 'deadline', note: 'server-side deadline condition fired; child still not terminal' };
      // agent_end without a readable receipt (e.g. no runId and no evidence
      // access): the turn ended — surface it honestly rather than waiting on.
      if (!options.runId) {
        return { kind: 'completed', note: 'agent_end observed; no runId provided for receipt read-back' };
      }
    }
  }
  return null;
}

async function reconcileReceipt(
  options: WaitOptions,
  deps: WaitDeps,
  countReceiptCheck: () => void = () => undefined,
): Promise<WaitOutcome | null> {
  countReceiptCheck();
  try {
    if (options.runId) {
      const receipt = await deps.getReceipt(options.runId);
      return fromClassification(classifyReceipt(receipt), receipt);
    }
    const evidence = await deps.getSessionEvidence(options.sessionId);
    const last = evidence.runs[0];
    if (!last || !last.status) return null;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(last.status)) {
      return fromClassification(
        classifyReceipt({ runId: last.runId ?? 'unknown', sessionId: options.sessionId, status: last.status, errorCode: last.errorCode }),
        last.runId ? ({ runId: last.runId, sessionId: options.sessionId, status: last.status, errorCode: last.errorCode } as Receipt) : undefined,
      );
    }
    return null;
  } catch {
    return null; // reconciliation is best-effort; the long poll remains the wake source
  }
}

function fromClassification(classification: ReceiptClassification, receipt?: Receipt): WaitOutcome | null {
  switch (classification.kind) {
    case 'running':
      return null;
    case 'completed':
      return { kind: 'completed', receipt };
    case 'cancelled':
      return { kind: 'cancelled', receipt };
    case 'interrupted':
      return { kind: 'interrupted', receipt, interruptedByRestart: classification.interruptedByRestart };
    case 'never_started':
    case 'budget_exceeded':
    case 'transport_lost':
    case 'prompt_not_executed':
    case 'turn_stalled':
    case 'failed':
      return { kind: classification.kind, receipt };
    default:
      return null;
  }
}

export { isTerminalReceipt };
