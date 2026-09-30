import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitOnChild, waitOnChildren, type WaitDeps } from '../src/wait.ts';
import { agentEnd, goalEnd, questionSentinel, deadlineCondition } from '../src/builders.ts';
import type { WatchConditionSpec } from '../src/parsers.ts';
import { exitCodeFor } from '../src/exit-codes.ts';

/**
 * Correction 05 RED tests (Luna closure round: two majors).
 *
 * Item 1: watch compatibility must compare EVERY behaviour-affecting field —
 * pattern, patternFlags, source, once included; only ids and labels are
 * ignored. The reviewer's probe: a foreign text watch registered with a
 * different pattern and source must never be silently reused.
 *
 * Item 2: with an objective armed and NO run id, a completed last run from
 * /evidence must not settle as `completed` while the goal projection is still
 * running — the same goal-projection settlement as the run-id path, in both
 * wait and waitMany.
 */

interface State {
  longPollCalls: number;
  registrations: number;
  projectionReads: number;
  receipts: Map<string, Record<string, unknown>>;
  goals: Map<string, Record<string, unknown>>;
  evidence: Map<string, { runs: Array<Record<string, unknown>> }>;
  watches: Map<string, { watchId: string; status?: string; conditions?: Array<{ id?: string; spec?: Record<string, unknown> }>; label?: string }>;
  pendingFiring?: unknown;
}

function makeDeps(): { deps: WaitDeps; state: State } {
  const state: State = {
    longPollCalls: 0,
    registrations: 0,
    projectionReads: 0,
    receipts: new Map(),
    goals: new Map(),
    evidence: new Map(),
    watches: new Map(),
    pendingFiring: undefined,
  };
  const deps: WaitDeps = {
    async longPoll() {
      state.longPollCalls += 1;
      if (state.pendingFiring !== undefined) {
        const firing = state.pendingFiring;
        state.pendingFiring = undefined;
        return { kind: 'fired' as const, body: firing };
      }
      return { kind: 'timeout' as const };
    },
    async getReceipt(runId) {
      const receipt = state.receipts.get(runId);
      if (!receipt) {
        const error = new Error('not found') as Error & { status?: number; code?: string };
        error.status = 404;
        error.code = 'RUN_NOT_FOUND';
        throw error;
      }
      return receipt as never;
    },
    async getSessionEvidence(sessionId) {
      const entry = state.evidence.get(sessionId);
      if (!entry) throw new Error(`no scripted evidence for ${sessionId}`);
      return entry as never;
    },
    async getSession(sessionId) {
      return { sessionId, status: 'running' };
    },
    async getGoal(sessionId) {
      state.projectionReads += 1;
      const goal = state.goals.get(sessionId);
      if (!goal) throw new Error(`no scripted goal for ${sessionId}`);
      return goal as never;
    },
    async registerWatch(_sessionId, _body) {
      state.registrations += 1;
      return { watchId: `watch-${state.registrations}`, status: 'active' };
    },
    async getWatch(sessionId) {
      return state.watches.get(sessionId) ?? null;
    },
    async sleep() {},
    now: (() => {
      let ticks = 0;
      return () => (ticks += 1000);
    })(),
  };
  return { deps, state };
}

function firingBody(firings: Array<Record<string, unknown>>, cursor = 'c1'): unknown {
  return {
    fired: true, waitedMs: 5,
    watches: [{ watchId: 'watch-1', sessionId: 'child', runtime: 'pi', firings, firingCount: firings.length }],
    nextCursor: cursor,
  };
}

// ─── Item 1: compatibility covers every semantic field ──────────────────────

test('correction05/1: the reviewer probe — a foreign pattern/source text watch conflicts, never reused', async () => {
  const { deps, state } = makeDeps();
  state.watches.set('child', {
    watchId: 'foreign-text',
    status: 'active',
    label: 'other-observer',
    conditions: [{ id: 'their-text', spec: { type: 'text', pattern: 'OTHER-TEXT', source: 'any', once: true } }],
  });
  const requested = questionSentinel('BLOCKED-NEEDS-INPUT');
  const outcome = await waitOnChild({
    sessionId: 'child',
    conditions: [requested],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps,
  });
  assert.equal(outcome.kind, 'watch_conflict', `got ${outcome.kind}`);
  assert.equal(exitCodeFor({ kind: 'watch_conflict' }), 19);
  assert.equal(state.registrations, 0, 'a foreign watch is never replaced');
});

test('correction05/1: per-type probes — each semantic difference conflicts (async assertions)', async () => {
  const probes: Array<{ name: string; foreign: Record<string, unknown>; requested: WatchConditionSpec }> = [
    { name: 'event_type dataMatch', foreign: { type: 'event_type', eventType: 'goal_end', dataMatch: { objective: 'OTHER' }, once: false }, requested: goalEnd('MINE') },
    { name: 'event_type eventType', foreign: { type: 'event_type', eventType: 'agent_end', once: true }, requested: goalEnd('MINE') },
    { name: 'event_type once', foreign: { type: 'event_type', eventType: 'agent_end', once: false }, requested: agentEnd() },
    { name: 'tool toolName', foreign: { type: 'tool', toolName: 'Read', phase: 'end', once: true }, requested: { id: 't1', type: 'tool', toolName: 'Bash', phase: 'end', once: true } },
    { name: 'tool phase', foreign: { type: 'tool', toolName: 'Bash', phase: 'start', once: true }, requested: { id: 't2', type: 'tool', toolName: 'Bash', phase: 'end', once: true } },
    { name: 'tool argIncludes', foreign: { type: 'tool', toolName: 'Bash', phase: 'end', argIncludes: 'OTHER', once: true }, requested: { id: 't3', type: 'tool', toolName: 'Bash', phase: 'end', argIncludes: 'MINE', once: true } },
    { name: 'text contains', foreign: { type: 'text', contains: 'OTHER', once: true }, requested: questionSentinel('MINE') },
    { name: 'text pattern', foreign: { type: 'text', pattern: 'OTHER', source: 'assistant', once: true }, requested: { id: 'q1', type: 'text', pattern: 'MINE', source: 'assistant', once: true } },
    { name: 'text patternFlags', foreign: { type: 'text', pattern: 'SAME', patternFlags: 'i', source: 'assistant', once: true }, requested: { id: 'q2', type: 'text', pattern: 'SAME', patternFlags: 'g', source: 'assistant', once: true } },
    { name: 'text source', foreign: { type: 'text', pattern: 'SAME', source: 'any', once: true }, requested: { id: 'q3', type: 'text', pattern: 'SAME', source: 'assistant', once: true } },
    { name: 'text once', foreign: { type: 'text', contains: 'SAME', once: false }, requested: questionSentinel('SAME') },
    { name: 'deadline afterSeconds', foreign: { type: 'deadline', afterSeconds: 99, once: true }, requested: deadlineCondition(120) },
  ];
  for (const probe of probes) {
    const { deps, state } = makeDeps();
    state.watches.set('child', { watchId: 'foreign', status: 'active', label: 'other-observer', conditions: [{ id: 'theirs', spec: probe.foreign }] });
    const outcome = await waitOnChild({ sessionId: 'child', conditions: [probe.requested], deadlineMs: 30_000, sliceMs: 5_000, deps });
    assert.equal(outcome.kind, 'watch_conflict', `${probe.name}: a semantic difference must conflict (got ${outcome.kind})`);
    assert.equal(state.registrations, 0, `${probe.name}: foreign watch untouched`);
  }
});

test('correction05/1: semantically IDENTICAL conditions still reuse (ids and labels ignored)', async () => {
  const { deps, state } = makeDeps();
  state.watches.set('child', {
    watchId: 'ours-equivalent',
    status: 'active',
    label: 'different-label',
    conditions: [{ id: 'their-id', spec: { type: 'event_type', eventType: 'agent_end', once: true } }],
  });
  state.receipts.set('r1', { runId: 'r1', sessionId: 'child', runtime: 'pi', status: 'completed', acceptedAt: 't' });
  const outcome = await waitOnChild({
    sessionId: 'child', runId: 'r1', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(state.registrations, 0, 'same semantics, different ids/labels → reuse');
});

// ─── Item 2: goal settlement without --run-id ───────────────────────────────

test('correction05/2: wait without run-id — completed last run + running projection keeps waiting, then classifies', async () => {
  const { deps, state } = makeDeps();
  state.evidence.set('child', { runs: [{ runId: 'run-9', status: 'completed' }] });
  state.goals.set('child', { supported: true, status: 'running' });
  let call = 0;
  const outcome = await waitOnChild({
    sessionId: 'child',
    objective: 'Do the bounded thing',
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async longPoll(input) {
        call += 1;
        if (call === 1) {
          state.goals.set('child', { supported: true, status: 'achieved' });
          return { kind: 'fired', body: firingBody([{ conditionId: 'outcome', firedAt: 1, eventType: 'goal_end', evidence: 'achieved' }]) };
        }
        return { kind: 'timeout' };
      },
    },
  });
  assert.equal(outcome.kind, 'goal_achieved', `an objective-armed run-less wait must not complete early (got ${outcome.kind})`);
  assert.ok(state.projectionReads >= 1, 'the goal projection was consulted');
});

test('correction05/2: waitMany without run ids — same settlement through the goal projection', async () => {
  const { deps, state } = makeDeps();
  state.evidence.set('child', { runs: [{ runId: 'run-9', status: 'completed' }] });
  state.goals.set('child', { supported: true, status: 'running' });
  let call = 0;
  const result = await waitOnChildren({
    mode: 'all',
    children: [{ sessionId: 'child' }],
    objective: 'Do the bounded thing',
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: {
      ...deps,
      async longPoll(input) {
        call += 1;
        if (call === 1) {
          state.goals.set('child', { supported: true, status: 'failed' });
          return { kind: 'fired', body: firingBody([{ conditionId: 'outcome', firedAt: 1, eventType: 'goal_end', evidence: 'failed' }]) };
        }
        return { kind: 'timeout' };
      },
    },
  });
  assert.equal(result.children[0]?.outcome?.kind, 'goal_failed', 'settle on the classified goal outcome, never early completed');
  assert.ok(state.projectionReads >= 1, 'the goal projection was consulted');
});

test('correction05/2: without an objective, the completed last run still completes immediately', async () => {
  const { deps, state } = makeDeps();
  state.evidence.set('child', { runs: [{ runId: 'run-9', status: 'completed' }] });
  const outcome = await waitOnChild({
    sessionId: 'child',
    conditions: [agentEnd()],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps,
  });
  assert.equal(outcome.kind, 'completed');
  // C3b live-found race guard: the run-less reconcile reads the projection
  // ONCE (bounded, per slice) so a goal the one-shot probe missed can settle
  // the wait. A genuinely goal-less child (this test) still completes, with
  // exactly that one extra read.
  assert.equal(state.projectionReads, 1, 'one bounded guard read; outcome unchanged for plain children');
});
