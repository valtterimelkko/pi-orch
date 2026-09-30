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

import { defaultConditions } from './builders.ts';
import type { WatchConditionSpec } from './parsers.ts';
import { OUTCOME_EXIT_CODES } from './exit-codes.ts';
import { classifyReceipt, isTerminalReceipt, parseWatchesWait, type Receipt, type ReceiptClassification } from './parsers.ts';

export interface WaitDeps {
  longPoll(input: { ids: string[]; cursor?: string; timeoutMs: number }): Promise<{ kind: 'fired'; body: unknown } | { kind: 'timeout' }>;
  getReceipt(runId: string): Promise<Receipt>;
  getSessionEvidence(sessionId: string): Promise<{ runs: Array<{ runId?: string; status?: string; errorCode?: string }> }>;
  /** Existence preflight: null when the registry has no such session (404). */
  getSession(sessionId: string): Promise<{ sessionId: string; status?: string } | null>;
  /** Goal projection for goal_end classification (correction 04 item 1). */
  getGoal(sessionId: string): Promise<{ status?: string; objective?: string; pausedReason?: string | null; lastReason?: string | null }>;
  registerWatch(sessionId: string, body: Record<string, unknown>): Promise<{ watchId: string; status?: string }>;
  getWatch(sessionId: string): Promise<{ watchId: string; status?: string; conditions?: Array<{ id?: string; spec?: Record<string, unknown> }>; label?: string } | null>;
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
  | { kind: 'deadline'; note?: string }
  | { kind: 'run_not_found'; note?: string }
  | { kind: 'session_not_found'; note?: string }
  | { kind: 'goal_cleared'; evidence?: string; note?: string }
  | { kind: 'watch_conflict'; note?: string };

export interface WaitOptions {
  sessionId: string;
  runId?: string;
  conditions?: WatchConditionSpec[];
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

/**
 * Correction 01 item 2: before any watch is registered, wait knows whether its
 * target exists and whether the run already ended. An unknown/malformed run id
 * or a nonexistent session returns IMMEDIATELY with a distinct outcome (exit
 * 16) instead of sitting out the full deadline — a scripting parent waiting 600
 * s for a mistyped id is exactly the loop this verb exists to remove. An
 * already-terminal receipt returns its classified outcome immediately.
 */
async function preflightWait(
  child: { sessionId: string; runId?: string; objective?: string },
  deps: WaitDeps,
): Promise<WaitOutcome | null> {
  try {
    const session = await deps.getSession(child.sessionId);
    if (!session) return { kind: 'session_not_found', note: `no session ${child.sessionId} in the registry` };
  } catch {
    // Existence check is best-effort; the receipt check below is decisive.
  }
  if (!child.runId) return null;
  try {
    const receipt = await deps.getReceipt(child.runId);
    // Correction 04 item 4: a receipt that belongs to a DIFFERENT session is a
    // caller mistake (typo, stale id) — fail fast on it, never wait on it.
    if (receipt.sessionId !== child.sessionId) {
      return {
        kind: 'run_not_found',
        note: `mismatch: run ${child.runId} belongs to session ${receipt.sessionId}, not ${child.sessionId}`,
      };
    }
    const classified = fromClassification(classifyReceipt(receipt), receipt);
    // Correction 04 (run-5 lesson): an OBJECTIVE-ARMED wait does not complete
    // on the brief run's receipt while the goal is unsettled — the classified
    // goal outcome is the result (goals.md: prefer goal_end).
    if (classified?.kind === 'completed' && child.objective) {
      const settled = await settledGoalOutcome(child.sessionId, deps);
      if (settled) return settled;
      return null; // goal unsettled: fall through into the watch loop
    }
    return classified;
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    if (status === 404 || code === 'RUN_NOT_FOUND') {
      return { kind: 'run_not_found', note: `run ${child.runId} is unknown or malformed` };
    }
    return null; // transient receipt-read failure: proceed into the wait
  }
}

export async function waitOnChild(options: WaitOptions): Promise<WaitOutcome> {
  const { deps } = options;
  const fast = await preflightWait({ sessionId: options.sessionId, runId: options.runId, objective: options.objective }, deps);
  if (fast) return fast;
  const sliceMs = Math.min(options.sliceMs ?? 45_000, MAX_SLICE_MS);
  const start = deps.now();
  const conditions = options.conditions ?? defaultConditions(options.objective, options.deadlineMs);
  const conditionsById = new Map(conditions.flatMap((condition) => (condition.id ? [[condition.id, condition] as const] : [])));

  let watch = await registerOrReuse(options.sessionId, conditions, options.label, deps);
  if (watch.conflict) return { kind: 'watch_conflict', note: watch.conflict };
  let watchId = watch.watchId as string;
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
        watch = await registerOrReuse(options.sessionId, conditions, options.label, deps, true);
        if (watch.conflict) return { kind: 'watch_conflict', note: watch.conflict };
        watchId = watch.watchId as string;
        cursor = undefined; // new ledger: start at 0 so a reconciled firing is seen
      }
      continue;
    }
    recoveryAttempts = 0;

    if (result.kind === 'fired') {
      const parsed = parseWatchesWait(result.body);
      cursor = parsed.nextCursor;
      const outcome = await outcomeFromFirings(parsed.watches.flatMap((watch_) => watch_.firings), options, deps, conditionsById, () => {
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

/** Semantic condition shape for compatibility: EVERY behaviour-affecting field (correction 05 item 1); ids and labels are the only ignored values. */
function conditionShape(condition: WatchConditionSpec): Record<string, unknown> {
  return {
    type: condition.type,
    ...(condition.eventType !== undefined ? { eventType: condition.eventType } : {}),
    ...(condition.dataMatch !== undefined ? { dataMatch: condition.dataMatch } : {}),
    ...(condition.toolName !== undefined ? { toolName: condition.toolName } : {}),
    ...(condition.phase !== undefined ? { phase: condition.phase } : {}),
    ...(condition.argIncludes !== undefined ? { argIncludes: condition.argIncludes } : {}),
    ...(condition.contains !== undefined ? { contains: condition.contains } : {}),
    ...(condition.pattern !== undefined ? { pattern: condition.pattern } : {}),
    ...(condition.patternFlags !== undefined ? { patternFlags: condition.patternFlags } : {}),
    ...(condition.source !== undefined ? { source: condition.source } : {}),
    ...(condition.afterSeconds !== undefined ? { afterSeconds: condition.afterSeconds } : {}),
    ...(condition.once !== undefined ? { once: condition.once } : {}),
  };
}

function sameConditions(a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>): boolean {
  if (a.length !== b.length) return false;
  const key = (shape: Record<string, unknown>): string => JSON.stringify(Object.keys(shape).sort().reduce((out, k) => ({ ...out, [k]: shape[k] }), {}));
  const aKeys = a.map(key).sort();
  const bKeys = b.map(key).sort();
  return aKeys.every((value, index) => value === bKeys[index]);
}

/**
 * Correction 04 item 5: an ACTIVE watch is reused only when its conditions are
 * compatible (semantically equal). Otherwise: replace only a watch this client
 * owns (same label); a foreign watch yields an explicit watch_conflict — never
 * a silent run to the deadline, never a replaced foreign observer.
 */
async function registerOrReuse(
  sessionId: string,
  conditions: WatchConditionSpec[],
  label: string | undefined,
  deps: WaitDeps,
  recovery = false,
): Promise<{ watchId?: string; conflict?: string }> {
  if (!recovery) {
    const existing = await deps.getWatch(sessionId).catch(() => null);
    if (existing && existing.status === 'active') {
      const existingShapes = ((existing.conditions ?? []) as Array<{ spec?: Record<string, unknown> }>).map((state) => conditionShape((state.spec ?? state) as WatchConditionSpec));
      const wantedShapes = conditions.map((condition) => conditionShape(condition));
      if (sameConditions(existingShapes, wantedShapes)) {
        return { watchId: existing.watchId };
      }
      if (label !== undefined && existing.label === label) {
        // Our own watch from a previous attempt: replace it.
      } else {
        return { conflict: `session ${sessionId} has an active watch${existing.label ? ` labelled '${existing.label}'` : ''} with incompatible conditions; the client never replaces foreign watches` };
      }
    }
  }
  const body: Record<string, unknown> = { conditions };
  if (label !== undefined) body.label = label;
  body.fireIfSettled = true;
  const registered = await deps.registerWatch(sessionId, body);
  return { watchId: registered.watchId };
}

/** Correction 04 item 1: a goal_end is classified from the live projection — never assumed success. */
async function goalEndOutcome(
  sessionId: string,
  evidence: string,
  deps: WaitDeps,
): Promise<WaitOutcome> {
  try {
    const goal = await deps.getGoal(sessionId);
    switch (goal.status) {
      case 'achieved':
        return { kind: 'goal_achieved', evidence };
      case 'failed':
        return { kind: 'goal_failed', evidence, note: `goal failed (${goal.pausedReason ?? goal.lastReason ?? 'reason unknown'})` };
      case 'cleared':
        return { kind: 'goal_cleared', evidence, note: 'goal cleared — not achieved; read the session before re-arming' };
      case 'paused':
        return { kind: 'paused', evidence, note: `goal paused (${goal.pausedReason ?? 'reason unknown'})` };
      default:
        return { kind: 'goal_failed', evidence, note: `goal projection status '${String(goal.status)}' after goal_end` };
    }
  } catch {
    // Projection unreadable: a goal_end that is not provably achieved is not
    // reported as success (correction 04 item 1).
    return { kind: 'goal_failed', evidence, note: 'goal_end fired but the projection was unreadable' };
  }
}

async function outcomeFromFirings(
  firings: Array<{ conditionId: string; eventType: string; evidence?: string }>,
  options: WaitOptions,
  deps: WaitDeps,
  conditionsById: Map<string, WatchConditionSpec>,
  countReceiptCheck: () => void,
): Promise<WaitOutcome | null> {
  for (const firing of firings) {
    // Correction 04 item 2: classify by the condition ID we registered —
    // normalized text firings carry the underlying event type (for example
    // `message_update`), never the literal condition type.
    const condition = conditionsById.get(firing.conditionId);
    if (condition?.type === 'text') {
      return { kind: 'question', evidence: firing.evidence, note: 'question sentinel matched' };
    }
    if (firing.eventType === 'goal_state' || condition?.eventType === 'goal_state') {
      return { kind: 'paused', evidence: firing.evidence, note: 'goal paused — read the session before resuming' };
    }
    if (firing.eventType === 'goal_end' || condition?.eventType === 'goal_end') {
      return goalEndOutcome(options.sessionId, firing.evidence ?? '', deps);
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
      const classified = fromClassification(classifyReceipt(receipt), receipt);
      // Correction 04 (run-5 lesson): for an OBJECTIVE-ARMED wait, the brief
      // run's completion is not the goal outcome (goals.md: prefer goal_end).
      // While the projection is still unsettled, keep waiting for the
      // classified goal result; when it is settled, return it classified.
      if (classified?.kind === 'completed' && options.objective) {
        return await settledGoalOutcome(options.sessionId, deps) ?? null;
      }
      return classified;
    }
    const evidence = await deps.getSessionEvidence(options.sessionId);
    const last = evidence.runs[0];
    if (!last || !last.status) return null;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(last.status)) {
      const classified = fromClassification(
        classifyReceipt({ runId: last.runId ?? 'unknown', sessionId: options.sessionId, status: last.status, errorCode: last.errorCode }),
        last.runId ? ({ runId: last.runId, sessionId: options.sessionId, status: last.status, errorCode: last.errorCode } as Receipt) : undefined,
      );
      // Correction 05 item 2: the run-less path applies the same goal
      // settlement as the run-id path — an objective-armed wait does not
      // complete on a terminal last run while the goal is unsettled.
      if (classified?.kind === 'completed' && options.objective) {
        return await settledGoalOutcome(options.sessionId, deps) ?? null;
      }
      return classified;
    }
    return null;
  } catch {
    return null; // reconciliation is best-effort; the long poll remains the wake source
  }
}

/** Read the live projection and classify it; null when the goal is still unsettled. */
async function settledGoalOutcome(sessionId: string, deps: WaitDeps): Promise<WaitOutcome | null> {
  try {
    const goal = await deps.getGoal(sessionId);
    switch (goal.status) {
      case 'achieved':
        return { kind: 'goal_achieved', note: 'classified from the goal projection' };
      case 'failed':
        return { kind: 'goal_failed', note: `classified from the goal projection (failed: ${goal.pausedReason ?? goal.lastReason ?? 'reason unknown'})` };
      case 'cleared':
        return { kind: 'goal_cleared', note: 'classified from the goal projection (cleared — not achieved)' };
      case 'paused':
        return { kind: 'paused', note: `classified from the goal projection (paused: ${goal.pausedReason ?? 'reason unknown'})` };
      default:
        return null; // running / wrapping_up / unknown: keep waiting
    }
  } catch {
    return null; // projection unreadable: keep waiting (deadline backstop bounds this)
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

// ─── Multi-child wait (correction 01 item 3) ─────────────────────────────────

export interface WaitChild {
  sessionId: string;
  runId?: string;
}

export interface WaitOnChildrenResult {
  mode: 'all' | 'any';
  children: Array<{ sessionId: string; runId?: string; outcome?: WaitOutcome }>;
  exitCode: number;
}

/**
 * Wait on several children in ONE call: `all` settles every child, `any`
 * returns with the first to settle. One long-poll request covers all watches
 * (the server's /watches/wait takes an id list and one shared cursor), so a
 * parent fans out without a shell loop. Fast-fail preflight per child.
 */
export async function waitOnChildren(options: {
  mode: 'all' | 'any';
  children: WaitChild[];
  conditions?: WatchConditionSpec[];
  objective?: string;
  deadlineMs: number;
  sliceMs?: number;
  label?: string;
  deps: WaitDeps;
}): Promise<WaitOnChildrenResult> {
  const { deps } = options;
  const sliceMs = Math.min(options.sliceMs ?? 45_000, MAX_SLICE_MS);
  const results = new Map<number, WaitOutcome>();

  // Fast-fail preflight per child.
  for (const [index, child] of options.children.entries()) {
    const fast = await preflightWait({ ...child, objective: options.objective }, deps);
    if (fast) results.set(index, fast);
  }
  const exitCodeForChild = (outcome: WaitOutcome | undefined): number =>
    OUTCOME_EXIT_CODES[outcome?.kind ?? 'deadline'] ?? 1;
  const resultFor = (index: number): WaitOnChildrenResult['children'][number] => {
    const child = options.children[index] as { sessionId: string; runId?: string };
    return { ...child, ...(results.has(index) ? { outcome: results.get(index) } : {}) };
  };

  if (options.mode === 'any' && results.size > 0) {
    const first = options.children.findIndex((_, index) => results.has(index));
    return { mode: 'any', children: [resultFor(first)], exitCode: exitCodeForChild(results.get(first)) };
  }
  if (options.mode === 'all' && results.size === options.children.length) {
    const children = options.children.map((_, index) => resultFor(index));
    return { mode: 'all', children, exitCode: allExitCode(children) };
  }

  const unsettled = new Map<number, { watchId: string }>();
  for (const [index, child] of options.children.entries()) {
    if (results.has(index)) continue;
    const registered = await registerOrReuse(child.sessionId, childConditions(options, child), options.label, deps);
    if (registered.conflict) {
      results.set(index, { kind: 'watch_conflict', note: registered.conflict });
      continue;
    }
    unsettled.set(index, { watchId: registered.watchId as string });
  }

  const start = deps.now();
  let cursor: string | undefined = undefined;
  let recoveryAttempts = 0;

  while (unsettled.size > 0) {
    const remaining = options.deadlineMs - (deps.now() - start);
    if (remaining <= 0) {
      for (const index of unsettled.keys()) results.set(index, { kind: 'deadline', note: 'shared deadline elapsed' });
      break;
    }
    const ids = [...unsettled.values()].map((entry) => entry.watchId);
    let result: { kind: 'fired'; body: unknown } | { kind: 'timeout' };
    try {
      result = await deps.longPoll({ ids, cursor, timeoutMs: Math.min(sliceMs, remaining) });
    } catch {
      recoveryAttempts += 1;
      if (recoveryAttempts > RECOVERY_ATTEMPTS) {
        for (const index of unsettled.keys()) results.set(index, { kind: 'deadline', note: `transport lost past ${RECOVERY_ATTEMPTS} recovery attempts` });
        break;
      }
      await deps.sleep(RECOVERY_BACKOFF_MS);
      for (const [index, entry] of [...unsettled.entries()]) {
        const child = options.children[index];
        if (!child) continue;
        const existing = await deps.getWatch(child.sessionId).catch(() => null);
        if (!existing || existing.status === 'detached') {
          const registered = await registerOrReuse(child.sessionId, childConditions(options, child), options.label, deps, true);
          if (registered.conflict) {
            results.set(index, { kind: 'watch_conflict', note: registered.conflict });
            unsettled.delete(index);
            continue;
          }
          unsettled.set(index, { watchId: registered.watchId as string });
          cursor = undefined; // new ledger: start at 0 so reconciled firings are seen
        }
      }
      continue;
    }
    recoveryAttempts = 0;

    if (result.kind === 'fired') {
      const parsed = parseWatchesWait(result.body);
      cursor = parsed.nextCursor;
      const byWatchId = new Map([...unsettled.entries()].map(([index, entry]) => [entry.watchId, index]));
      for (const watch of parsed.watches) {
        const index = byWatchId.get(watch.watchId);
        const child = index === undefined ? undefined : options.children[index];
        if (index === undefined || !child) continue;
        const conditionsById = new Map(childConditions(options, child).flatMap((condition) => (condition.id ? [[condition.id, condition] as const] : [])));
        for (const firing of watch.firings) {
          const outcome = await firingOutcome(firing, child, deps, conditionsById);
          if (outcome) {
            results.set(index, outcome);
            unsettled.delete(index);
            break;
          }
        }
      }
    } else {
      // Slice timeout: one bounded receipt reconciliation per unsettled child.
      for (const [index] of [...unsettled.entries()]) {
        const child = options.children[index];
        if (!child) continue;
        const outcome = await reconcileChildReceipt(child, deps, options.objective);
        if (outcome) {
          results.set(index, outcome);
          unsettled.delete(index);
        }
      }
    }

    if (options.mode === 'any' && results.size > 0) {
      const first = options.children.findIndex((_, index) => results.has(index));
      return { mode: 'any', children: [resultFor(first)], exitCode: exitCodeForChild(results.get(first)) };
    }
  }

  const children = options.children.map((_, index) => resultFor(index));
  return { mode: options.mode, children, exitCode: allExitCode(children) };
}

function childConditions(
  options: { conditions?: WatchConditionSpec[]; objective?: string; deadlineMs: number },
  _child: WaitChild,
): WatchConditionSpec[] {
  return options.conditions ?? defaultConditions(options.objective, options.deadlineMs);
}

function allExitCode(children: Array<{ outcome?: WaitOutcome }>): number {
  for (const child of children) {
    const code = OUTCOME_EXIT_CODES[child.outcome?.kind ?? 'deadline'] ?? 1;
    if (code !== 0) return code; // first nonzero in child order (deterministic)
  }
  return 0;
}

async function firingOutcome(
  firing: { conditionId: string; eventType: string; evidence?: string },
  child: WaitChild,
  deps: WaitDeps,
  conditionsById: Map<string, WatchConditionSpec> = new Map(),
): Promise<WaitOutcome | null> {
  const condition = conditionsById.get(firing.conditionId);
  if (condition?.type === 'text') {
    return { kind: 'question', evidence: firing.evidence, note: 'question sentinel matched' };
  }
  if (firing.eventType === 'goal_state' || condition?.eventType === 'goal_state') {
    return { kind: 'paused', evidence: firing.evidence, note: 'goal paused — read the session before resuming' };
  }
  if (firing.eventType === 'goal_end' || condition?.eventType === 'goal_end') {
    return goalEndOutcome(child.sessionId, firing.evidence ?? '', deps);
  }
  if (firing.eventType === 'agent_end' || firing.eventType === 'deadline') {
    const outcome = await reconcileChildReceipt(child, deps);
    if (outcome) return outcome;
    if (firing.eventType === 'deadline') return { kind: 'deadline', note: 'server-side deadline condition fired; child still not terminal' };
    if (!child.runId) {
      return { kind: 'completed', note: 'agent_end observed; no runId provided for receipt read-back' };
    }
  }
  return null;
}

async function reconcileChildReceipt(child: WaitChild, deps: WaitDeps, objective?: string): Promise<WaitOutcome | null> {
  try {
    if (child.runId) {
      const receipt = await deps.getReceipt(child.runId);
      const classified = fromClassification(classifyReceipt(receipt), receipt);
      if (classified?.kind === 'completed' && objective) {
        return await settledGoalOutcome(child.sessionId, deps) ?? null;
      }
      return classified;
    }
    const evidence = await deps.getSessionEvidence(child.sessionId);
    const last = evidence.runs[0];
    if (!last || !last.status) return null;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(last.status)) {
      const classified = fromClassification(
        classifyReceipt({ runId: last.runId ?? 'unknown', sessionId: child.sessionId, status: last.status, errorCode: last.errorCode }),
        last.runId ? ({ runId: last.runId, sessionId: child.sessionId, status: last.status, errorCode: last.errorCode } as Receipt) : undefined,
      );
      // Correction 05 item 2: same settlement for the multi-child path.
      if (classified?.kind === 'completed' && objective) {
        return await settledGoalOutcome(child.sessionId, deps) ?? null;
      }
      return classified;
    }
    return null;
  } catch {
    return null;
  }
}
