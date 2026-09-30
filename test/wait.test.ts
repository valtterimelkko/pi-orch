import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitOnChild, waitOnChildren, type WaitDeps, type WaitOutcome } from '../src/wait.ts';
import { agentEnd, goalEnd, goalPaused } from '../src/builders.ts';
import type { Receipt } from '../src/parsers.ts';

/**
 * The wait verb must be watch-based and idle until woken (a blocked long-poll
 * request, never a sleep loop), advance the cursor, reconcile the receipt,
 * survive a server restart (re-register detached watches with fireIfSettled)
 * and distinguish NEVER_STARTED / RUN_BUDGET_EXCEEDED / RUN_TRANSPORT_LOST /
 * interrupted as distinct outcomes. The fake transport makes the sequences
 * deterministic and counts receipt checks to prove slice-boundary
 * reconciliation does not degenerate into polling.
 */

type LongPollResult = { kind: 'fired'; body: unknown } | { kind: 'timeout' } | { kind: 'error'; error: Error };

function makeDeps(script: Array<(state: DepsState) => Promise<void>> = []): { deps: WaitDeps; state: DepsState } {
  const state: DepsState = {
    longPollCalls: 0,
    cursors: [] as Array<string | undefined>,
    receiptChecks: 0,
    registrations: 0,
    fireIfSettledRegistrations: 0,
    lastRegistrationBody: null as unknown,
    watches: new Map<string, { firings: Array<unknown>; firingCount: number }>(),
    receipts: new Map<string, Record<string, unknown>>(),
    evidenceBySession: new Map<string, { runs: Array<Record<string, unknown>> }>(),
  };
  const deps: WaitDeps = {
    async longPoll({ cursor }) {
      state.longPollCalls += 1;
      state.cursors.push(cursor);
      for (const step of script.splice(0, 1)) await step(state);
      if (state.pendingLongPollError) {
        const error = state.pendingLongPollError;
        state.pendingLongPollError = undefined;
        throw error;
      }
      if (state.pendingFiring) {
        const firing = state.pendingFiring;
        state.pendingFiring = undefined;
        return { kind: 'fired' as const, body: firing };
      }
      return { kind: 'timeout' as const };
    },
    async getSession(sessionId) {
      return { sessionId, status: 'running' };
    },
    async getReceipt(runId) {
      state.receiptChecks += 1;
      const receipt = state.receipts.get(runId);
      if (!receipt) throw new Error(`no scripted receipt for ${runId}`);
      return receipt as Receipt;
    },
    async getSessionEvidence(sessionId) {
      const evidence = state.evidenceBySession.get(sessionId);
      if (!evidence) throw new Error(`no scripted evidence for ${sessionId}`);
      return evidence as never;
    },
    async registerWatch(_sessionId, body) {
      state.registrations += 1;
      if ((body as { fireIfSettled?: boolean }).fireIfSettled) state.fireIfSettledRegistrations += 1;
      state.lastRegistrationBody = body;
      return {
        watchId: 'watch-child',
        generation: `gen-${state.registrations}`,
        sessionId: 'child',
        status: 'active',
        conditions: [],
        firings: [],
        firingCount: 0,
        pendingConditionIds: [],
        allFired: false,
        wakeAttempts: [],
        snapshot: { status: 'running', eventCount: 0, toolCallCount: 0, sawAgentEnd: false },
      } as never;
    },
    async getWatch() {
      return null; // 404: no surviving watch (restart scenario)
    },
    async sleep() {
      /* injected: instant in tests */
    },
    now: (() => {
      let ticks = 0;
      return () => (ticks += 1000);
    })(),
  };
  return { deps, state };
}

interface DepsState {
  longPollCalls: number;
  cursors: Array<string | undefined>;
  receiptChecks: number;
  registrations: number;
  fireIfSettledRegistrations: number;
  lastRegistrationBody: unknown;
  watches: Map<string, { firings: Array<unknown>; firingCount: number }>;
  receipts: Map<string, Record<string, unknown>>;
  evidenceBySession: Map<string, { runs: Array<Record<string, unknown>> }>;
  pendingFiring?: unknown;
  pendingLongPollError?: Error;
}

function firingBody(firings: Array<Record<string, unknown>>, firingCount: number, cursor = 'c2'): unknown {
  return {
    fired: true,
    waitedMs: 30,
    watches: [{ watchId: 'watch-child', sessionId: 'child', runtime: 'pi', firings, firingCount }],
    nextCursor: cursor,
  };
}

const receiptCompleted = { runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'completed', acceptedAt: 't' };
const receiptNeverStarted = {
  runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'failed', errorCode: 'NEVER_STARTED', acceptedAt: 't',
};

test('agent_end firing then terminal receipt completes the wait', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', { runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'started', acceptedAt: 't' });
  const outcome = await waitOnChild({
    sessionId: 'child',
    runId: 'run-1',
    conditions: [agentEnd()],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async longPoll(input) {
        state.longPollCalls += 1;
        state.cursors.push(input.cursor);
        if (state.longPollCalls === 1) {
          state.receipts.set('run-1', receiptCompleted);
          return { kind: 'fired', body: firingBody([{ conditionId: 'done', firedAt: 1, eventType: 'agent_end', evidence: 'end' }], 1, 'c1') };
        }
        return { kind: 'timeout' };
      },
    },
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.receipt?.status, 'completed');
  assert.equal(state.longPollCalls, 1, 'one long poll, no polling loop');
});

test('slice timeout then NEVER_STARTED receipt yields the never_started outcome (no firing needed)', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', receiptNeverStarted);
  const outcome = await waitOnChild({
    sessionId: 'child',
    runId: 'run-1',
    conditions: [agentEnd()],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps,
  });
  assert.equal(outcome.kind, 'never_started');
  assert.equal(state.receiptChecks >= 1, true, 'receipt reconciled at the slice boundary');
});

test('RUN_TRANSPORT_LOST is a distinct outcome', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', { ...receiptCompleted, status: 'failed', errorCode: 'RUN_TRANSPORT_LOST' });
  const outcome = await waitOnChild({
    sessionId: 'child', runId: 'run-1', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'transport_lost');
});

test('a transport reset mid-wait reconnects, preserves the cursor when the watch survives, then completes', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', { runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'started', acceptedAt: 't' });
  let call = 0;
  const outcome = await waitOnChild({
    sessionId: 'child',
    runId: 'run-1',
    conditions: [agentEnd()],
    deadlineMs: 600_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async getWatch() {
        // The watch survived the reset: recovery must NOT re-register it.
        return { watchId: 'watch-child', status: 'active' };
      },
      async longPoll(input) {
        call += 1;
        state.longPollCalls = call;
        state.cursors.push(input.cursor);
        if (call === 1) {
          // A firing this wait does not act on (e.g. a tool condition) — it
          // still advances the cursor.
          return { kind: 'fired', body: firingBody([{ conditionId: 'other', firedAt: 1, eventType: 'tool_execution_end', evidence: 'x' }], 1, 'c5') };
        }
        if (call === 2) throw new Error('socket hang up (ECONNRESET)');
        if (call === 3) {
          state.receipts.set('run-1', receiptCompleted);
          return { kind: 'fired', body: firingBody([{ conditionId: 'done', firedAt: 2, eventType: 'agent_end', evidence: 'end' }], 2, 'c9') };
        }
        return { kind: 'timeout' };
      },
    },
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(state.registrations, 0, 'a surviving watch is reused (initial reuse + recovery reuse); never re-registered');
  assert.deepEqual(state.cursors, [undefined, 'c5', 'c5'], 'cursor preserved across reconnect (only a received nextCursor advances it)');
});

test('a lost watch after restart is re-registered with fireIfSettled and the cursor resets', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', { runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'started', acceptedAt: 't' });
  let call = 0;
  const outcome = await waitOnChild({
    sessionId: 'child',
    runId: 'run-1',
    conditions: [agentEnd()],
    deadlineMs: 600_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async longPoll(input) {
        call += 1;
        if (call === 1) throw new Error('WATCH_NOT_FOUND');
        if (call === 2) {
          state.receipts.set('run-1', receiptCompleted);
          return { kind: 'fired', body: firingBody([{ conditionId: 'done', firedAt: 3, eventType: 'agent_end', evidence: 'reconciled' }], 1, 'c7') };
        }
        return { kind: 'timeout' };
      },
    },
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(state.registrations, 2, 'initial registration plus one recovery re-registration');
  assert.equal(state.fireIfSettledRegistrations, 2, 'EVERY registration asks for the settled reconciliation firing (wait registers after dispatch)');
  assert.equal(state.cursors[1], undefined, 'cursor resets after re-register so the reconciled firing is seen');
});

test('goal children: goal_end with the exact objective ends the wait; paused surfaces as paused', async () => {
  const { deps, state } = makeDeps();
  // Non-terminal receipt: the goal events decide, not slice reconciliation.
  state.receipts.set('run-1', { runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'started', acceptedAt: 't' });
  let call = 0;
  const paused = await waitOnChild({
    sessionId: 'child',
    runId: 'run-1',
    conditions: [goalEnd('Build the thing'), goalPaused('Build the thing')],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async longPoll() {
        call += 1;
        if (call === 1) {
          return {
            kind: 'fired',
            body: firingBody([
              { conditionId: 'paused', firedAt: 4, eventType: 'goal_state', evidence: 'paused: supervising' },
            ], 1, 'cp'),
          };
        }
        return { kind: 'timeout' };
      },
    },
  });
  assert.equal(paused.kind, 'paused');

  const done = await waitOnChild({
    sessionId: 'child',
    runId: 'run-1',
    conditions: [goalEnd('Build the thing')],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async longPoll() {
        call += 1;
        if (call === 3) {
          return {
            kind: 'fired',
            body: firingBody([
              { conditionId: 'outcome', firedAt: 5, eventType: 'goal_end', evidence: 'achieved' },
            ], 2, 'cg'),
          };
        }
        return { kind: 'timeout' };
      },
    },
  });
  assert.equal(done.kind, 'goal_achieved');
});

test('goal_end conditions carry the exact-objective dataMatch and repeat (once:false) so repeated goal events reconcile identity', () => {
  // goals.md: reusing a session can clear the OLD goal, producing an old-goal
  // goal_end before the new goal starts. goalEnd() always registers the exact
  // objective as dataMatch — the server filters on it, so a stale clear never
  // fires the condition. once:false keeps the condition live across repeated
  // goal events (goals.md's recommended shape for objective-matched watches);
  // the wait loop itself returns on the first terminal firing.
  const condition = goalEnd('The NEW objective');
  assert.deepEqual(condition.dataMatch, { objective: 'The NEW objective' });
  assert.equal(condition.once, false);
});

test('deadline exceeded without any event is a distinct outcome', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', { runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'started', acceptedAt: 't' });
  const outcome = await waitOnChild({
    sessionId: 'child', runId: 'run-1', conditions: [agentEnd()], deadlineMs: 10_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'deadline');
});

test('without a runId, reconciliation falls back to the session evidence chronology', async () => {
  const { deps, state } = makeDeps();
  state.evidenceBySession.set('child', { runs: [{ runId: 'run-x', status: 'failed', errorCode: 'RUN_BUDGET_EXCEEDED' }] });
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'budget_exceeded');
});

test('receipt checks stay bounded by long-poll returns (no polling degeneration)', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', { runId: 'run-1', sessionId: 'child', runtime: 'pi', status: 'started', acceptedAt: 't' });
  await waitOnChild({
    sessionId: 'child', runId: 'run-1', conditions: [agentEnd()], deadlineMs: 10_000, sliceMs: 5_000, deps,
  });
  assert.ok(
    state.receiptChecks <= state.longPollCalls + 1,
    `receipt checks (${state.receiptChecks}) must be bounded by long-poll returns (${state.longPollCalls})`,
  );
});

test('wait outcome kinds are exhaustively mapped in the exit-code table', async () => {
  const { OUTCOME_EXIT_CODES } = await import('../src/exit-codes.ts');
  const kinds: Array<WaitOutcome['kind']> = [
    'completed', 'failed', 'never_started', 'budget_exceeded', 'transport_lost',
    'prompt_not_executed', 'turn_stalled', 'interrupted', 'cancelled', 'paused',
    'question', 'goal_achieved', 'goal_failed', 'deadline',
    'run_not_found', 'session_not_found',
  ];
  for (const kind of kinds) {
    assert.ok(kind in OUTCOME_EXIT_CODES, `outcome '${kind}' has no exit code`);
  }
});

// ─── Correction 01 item 2: wait fails fast on a run it cannot find ──────────

test('correction 01: wait --run-id with an unknown run fails fast (no watch, no long poll)', async () => {
  const { deps, state } = makeDeps();
  const outcome = await waitOnChild({
    sessionId: 'child',
    runId: 'run-missing',
    conditions: [agentEnd()],
    deadlineMs: 600_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async getReceipt() {
        const error = new Error('run not found') as Error & { status?: number; code?: string };
        error.status = 404;
        error.code = 'RUN_NOT_FOUND';
        throw error;
      },
      async getSession() {
        return { sessionId: 'child', status: 'idle' };
      },
    },
  });
  assert.equal(outcome.kind, 'run_not_found');
  assert.equal(state.registrations, 0, 'no watch registered');
  assert.equal(state.longPollCalls, 0, 'no long poll started');
});

test('correction 01: wait with an already-terminal receipt returns its outcome immediately', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('run-1', receiptCompleted);
  const outcome = await waitOnChild({
    sessionId: 'child',
    runId: 'run-1',
    conditions: [agentEnd()],
    deadlineMs: 600_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async getSession() {
        return { sessionId: 'child', status: 'idle' };
      },
    },
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(state.registrations, 0);
  assert.equal(state.longPollCalls, 0);
});

test('correction 01: wait on a session that does not exist fails fast', async () => {
  const { deps, state } = makeDeps();
  const outcome = await waitOnChild({
    sessionId: 'nope',
    conditions: [agentEnd()],
    deadlineMs: 600_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async getSession() {
        return null; // 404
      },
    },
  });
  assert.equal(outcome.kind, 'session_not_found');
  assert.equal(state.registrations, 0);
  assert.equal(state.longPollCalls, 0);
});

// ─── Correction 01 item 3: wait on several children in one call ─────────────

test('waitOnChildren --all settles every child and reports per-child outcomes', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('r1', receiptCompleted);
  state.receipts.set('r2', { ...receiptCompleted, runId: 'r2', errorCode: 'RUN_BUDGET_EXCEEDED', status: 'failed' });
  // Both children already terminal: everything settles in preflight, no polls.
  const result = await waitOnChildren({
    mode: 'all',
    children: [
      { sessionId: 'c1', runId: 'r1' },
      { sessionId: 'c2', runId: 'r2' },
    ],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: { ...deps, async getSession() { return { sessionId: 'x', status: 'idle' }; } },
  });
  assert.equal(result.mode, 'all');
  const outcomes = result.children.map((child) => child.outcome?.kind);
  assert.deepEqual(outcomes, ['completed', 'budget_exceeded']);
  assert.equal(result.exitCode > 0, true, 'a failed child makes the all-wait nonzero');
});

test('waitOnChildren --any returns the first child to settle', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('r2', { runId: 'r2', sessionId: 'c2', runtime: 'pi', status: 'completed', acceptedAt: 't' });
  // c1 has no receipt (stays running); c2 is terminal in preflight.
  const result = await waitOnChildren({
    mode: 'any',
    children: [
      { sessionId: 'c1', runId: 'r9' },
      { sessionId: 'c2', runId: 'r2' },
    ],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async getSession() { return { sessionId: 'x', status: 'idle' }; },
      async getReceipt(runId) {
        if (runId === 'r9') {
          return { runId: 'r9', sessionId: 'c1', runtime: 'pi', status: 'started', acceptedAt: 't' };
        }
        return state.receipts.get(runId) as Receipt;
      },
    },
  });
  assert.equal(result.mode, 'any');
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0]?.sessionId, 'c2');
  assert.equal(result.children[0]?.outcome?.kind, 'completed');
});
