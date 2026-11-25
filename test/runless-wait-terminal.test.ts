import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitOnChild, waitOnChildren, type WaitDeps } from '../src/wait.ts';
import { agentEnd } from '../src/builders.ts';
import { OUTCOME_EXIT_CODES } from '../src/exit-codes.ts';

/**
 * The run-less wait defect (25 Nov 2026, live): Pi Web UI's Devin service emits
 * the closing `agent_end` event BEFORE it persists the turn and finishes the
 * run receipt, so the receipt is still `started` at that moment. A `wait` with
 * no `--run-id` read that evidence and fell through to
 * `{kind: 'completed', note: 'agent_end observed; no runId provided…'}` — exit
 * 0 — while the receipt ended `failed`. The contract promises no ordering
 * between `agent_end` and the receipt's terminal status, so the client must
 * never infer success from `agent_end` alone.
 *
 * Frozen criteria: (1) no settlement while the latest run is non-terminal;
 * (2) the terminal classification is picked up promptly (bounded re-read, not
 * at the deadline); (3) evidence with no runs at all keeps today's behaviour;
 * (4) the same rules on the multi-child path; (6) a still-non-terminal run at
 * the deadline returns `deadline`, never `completed`.
 */

interface EvidenceRun {
  runId?: string;
  status?: string;
  errorCode?: string;
}

interface DepsState {
  /** Per evidence read: the latest run's status (`null` = the session has no runs). */
  statuses: Array<string | null>;
  evidenceReads: number;
  longPolls: number;
  pollTimeouts: number[];
  pendingFiring?: unknown;
}

function makeDeps(script: { statuses: Array<string | null>; firing: unknown }): { deps: WaitDeps; state: DepsState } {
  const state: DepsState = {
    statuses: script.statuses,
    evidenceReads: 0,
    longPolls: 0,
    pollTimeouts: [],
    pendingFiring: script.firing,
  };
  const deps: WaitDeps = {
    async longPoll(input) {
      state.longPolls += 1;
      state.pollTimeouts.push(input.timeoutMs);
      if (state.pendingFiring !== undefined) {
        const firing = state.pendingFiring;
        state.pendingFiring = undefined;
        return { kind: 'fired' as const, body: firing };
      }
      return { kind: 'timeout' as const };
    },
    async getReceipt() {
      throw new Error('no receipt expected on the run-less path');
    },
    async getSessionEvidence() {
      const status = state.statuses[Math.min(state.evidenceReads, state.statuses.length - 1)] ?? null;
      state.evidenceReads += 1;
      const runs: EvidenceRun[] = status === null ? [] : [{ runId: 'run-latest', status }];
      return { runs };
    },
    async getSession(sessionId) {
      return { sessionId, status: 'running' };
    },
    async getGoal() {
      throw new Error('no goal projection: plain child');
    },
    async registerWatch() {
      return { watchId: 'watch-child', status: 'active' };
    },
    async getWatch() {
      return null;
    },
    async sleep() {
      /* instant: the wait must not hold the turn */
    },
    now: (() => {
      let ticks = 0;
      return () => (ticks += 1000);
    })(),
  };
  return { deps, state };
}

function agentEndFiring(): unknown {
  return {
    fired: true,
    waitedMs: 5,
    nextCursor: 'c2',
    watches: [
      {
        watchId: 'watch-child',
        sessionId: 'child',
        runtime: 'pi',
        firingCount: 1,
        firings: [{ conditionId: 'done-1', firedAt: 1, eventType: 'agent_end', evidence: 'end' }],
      },
    ],
  };
}

// ─── 1 + 2: no settlement while the latest run is non-terminal; prompt re-read ──

test('run-less agent_end with the latest run still started does NOT complete: the wait re-reads at a short bound and returns the terminal classification', async () => {
  const { deps, state } = makeDeps({ statuses: ['started', 'failed'], firing: agentEndFiring() });
  const outcome = await waitOnChild({ sessionId: 'child', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 45_000, deps });

  assert.equal(outcome.kind, 'failed', `agent_end is not success while the latest run is non-terminal; got ${outcome.kind} ${JSON.stringify(outcome.note ?? '')}`);
  assert.equal(outcome.receipt?.status, 'failed', 'the terminal classification carries the receipt it was read from');
  assert.ok(state.evidenceReads >= 2, `the evidence was re-read after the firing (reads: ${state.evidenceReads})`);
  assert.ok(state.longPolls >= 2, `the wait stayed in the loop for the re-check (long polls: ${state.longPolls})`);
  const recheckTimeout = state.pollTimeouts[1] ?? Infinity;
  assert.ok(recheckTimeout > 0 && recheckTimeout <= 5_000, `the re-check long poll is bounded to a short slice, not the 45 s slice (got ${recheckTimeout}ms)`);
});

test('run-less multi-child agent_end with the latest run still started does NOT complete the child: it settles on the terminal receipt', async () => {
  const { deps, state } = makeDeps({ statuses: ['started', 'failed'], firing: agentEndFiring() });
  const result = await waitOnChildren({
    mode: 'all',
    children: [{ sessionId: 'child' }],
    deadlineMs: 60_000,
    sliceMs: 45_000,
    deps,
  });

  const outcome = result.children[0]?.outcome;
  assert.equal(outcome?.kind, 'failed', `the child settles on the receipt, not on agent_end; got ${outcome?.kind}`);
  assert.equal(result.exitCode, OUTCOME_EXIT_CODES.failed, 'the failed outcome keeps its published exit code');
  const recheckTimeout = state.pollTimeouts[1] ?? Infinity;
  assert.ok(recheckTimeout > 0 && recheckTimeout <= 5_000, `the multi-child re-check is bounded to a short slice (got ${recheckTimeout}ms)`);
});

// ─── 3: no runs at all keeps today's behaviour ──────────────────────────────

test('run-less agent_end with NO runs at all keeps today\'s behaviour: completed with the existing note', async () => {
  const { deps, state } = makeDeps({ statuses: [null], firing: agentEndFiring() });
  const outcome = await waitOnChild({ sessionId: 'child', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, deps });

  assert.equal(outcome.kind, 'completed', `nothing else to read: got ${outcome.kind}`);
  assert.match(outcome.note ?? '', /no runId provided for receipt read-back/, 'the existing note is unchanged');
  assert.equal(state.longPolls, 1, 'one long poll: no re-check loop without a run to re-read');
});

test('run-less multi-child agent_end with no runs at all still completes its child', async () => {
  const { deps } = makeDeps({ statuses: [null], firing: agentEndFiring() });
  const result = await waitOnChildren({ mode: 'all', children: [{ sessionId: 'child' }], deadlineMs: 60_000, sliceMs: 5_000, deps });

  assert.equal(result.children[0]?.outcome?.kind, 'completed');
  assert.equal(result.exitCode, OUTCOME_EXIT_CODES.completed);
});

// ─── A terminal latest run is still settled at the firing (unchanged path) ──

test('run-less agent_end with an already-terminal latest run settles immediately from the receipt', async () => {
  const { deps, state } = makeDeps({ statuses: ['completed'], firing: agentEndFiring() });
  const outcome = await waitOnChild({ sessionId: 'child', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, deps });

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.receipt?.status, 'completed');
  assert.equal(state.longPolls, 1, 'no re-check needed when the receipt already classified the run');
});

// ─── 6: deadline while still non-terminal is `deadline`, never `completed` ──

test('run-less agent_end whose latest run never turns terminal returns deadline (not completed)', async () => {
  const { deps, state } = makeDeps({ statuses: ['started'], firing: agentEndFiring() });
  const outcome = await waitOnChild({ sessionId: 'child', conditions: [agentEnd()], deadlineMs: 5_000, sliceMs: 45_000, deps });

  assert.equal(outcome.kind, 'deadline', `a still-running run is not a completed wait; got ${outcome.kind}`);
  assert.equal(OUTCOME_EXIT_CODES[outcome.kind], 3);
  assert.ok(state.evidenceReads >= 2, `the evidence was re-read before the deadline (reads: ${state.evidenceReads})`);
});

test('run-less multi-child wait whose latest run never turns terminal returns a deadline outcome for the child', async () => {
  const { deps } = makeDeps({ statuses: ['started'], firing: agentEndFiring() });
  const result = await waitOnChildren({ mode: 'all', children: [{ sessionId: 'child' }], deadlineMs: 5_000, sliceMs: 45_000, deps });

  assert.equal(result.children[0]?.outcome?.kind, 'deadline');
  assert.equal(result.exitCode, OUTCOME_EXIT_CODES.deadline);
});
