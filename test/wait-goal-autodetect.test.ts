import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitOnChild, waitOnChildren, type WaitDeps, type WaitOutcome, type WaitOnChildrenResult } from '../src/wait.ts';
import type { WatchConditionSpec } from '../src/parsers.ts';

/**
 * C1 carried-over acceptance item: `wait` (and `wait --all|--any`) without
 * --objective used to wait on the per-turn agent_end, so a parent that forgot
 * --objective on a goal child got an early false `completed`. Fix: when no
 * objective/conditions are given, read GET /sessions/:id/goal ONCE; if a goal
 * is active or running, adopt the goal conditions and settlement AUTOMATICALLY
 * and say so in the outcome note. Test both paths.
 */

interface DepsState {
  registrations: number;
  lastRegistrationBody: unknown;
  receipts: Map<string, Record<string, unknown>>;
  /** Per-session goal-read sequences: each read pops the next entry (last repeats). */
  goalScripts: Map<string, Array<Record<string, unknown>>>;
  goalReads: number;
  evidenceBySession: Map<string, { runs: Array<Record<string, unknown>> }>;
  pendingFiring?: unknown;
}

function makeDeps(): { deps: WaitDeps; state: DepsState } {
  const state: DepsState = {
    registrations: 0,
    lastRegistrationBody: null,
    receipts: new Map(),
    goalScripts: new Map(),
    goalReads: 0,
    evidenceBySession: new Map(),
  };
  const deps: WaitDeps = {
    async longPoll() {
      if (state.pendingFiring !== undefined) {
        const firing = state.pendingFiring;
        state.pendingFiring = undefined;
        return { kind: 'fired' as const, body: firing };
      }
      return { kind: 'timeout' as const };
    },
    async getReceipt(runId) {
      const receipt = state.receipts.get(runId);
      if (!receipt) throw new Error(`no scripted receipt ${runId}`);
      return receipt as never;
    },
    async getSessionEvidence(sessionId) {
      const evidence = state.evidenceBySession.get(sessionId);
      if (!evidence) throw new Error(`no scripted evidence ${sessionId}`);
      return evidence as never;
    },
    async getSession(sessionId) {
      return { sessionId, status: 'running' };
    },
    async getGoal(sessionId) {
      state.goalReads += 1;
      const script = state.goalScripts.get(sessionId);
      if (!script || script.length === 0) throw new Error(`no scripted goal for ${sessionId}`);
      const next = script.length > 1 ? script.shift() : script[0];
      return next as never;
    },
    async registerWatch(sessionId, body) {
      state.registrations += 1;
      state.lastRegistrationBody = body;
      return { watchId: `watch-${sessionId}`, status: 'active' };
    },
    async getWatch() {
      return null;
    },
    async sleep() {
      /* instant */
    },
    now: (() => {
      let ticks = 0;
      return () => (ticks += 1000);
    })(),
  };
  return { deps, state };
}

function goalEndFiring(sessionId: string): unknown {
  return {
    fired: true,
    waitedMs: 5,
    nextCursor: 'c2',
    watches: [{ watchId: `watch-${sessionId}`, sessionId, firings: [{ conditionId: 'outcome-1', firedAt: 1, eventType: 'goal_end' }], firingCount: 1 }],
  };
}

const running = (objective: string) => ({ supported: true, status: 'running', objective });
const achieved = (objective: string) => ({ supported: true, status: 'achieved', objective });

test('no --objective + a RUNNING goal: goal conditions are registered, settlement used, outcome says auto-detected', async () => {
  const { deps, state } = makeDeps();
  state.goalScripts.set('child', [running('Ship the widget'), achieved('Ship the widget')]);
  state.pendingFiring = goalEndFiring('child');

  const outcome = await waitOnChild({ sessionId: 'child', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved');
  assert.ok(outcome.note?.includes('auto-detected'), `outcome says the goal was auto-detected: ${outcome.note}`);

  const body = state.lastRegistrationBody as { conditions: WatchConditionSpec[] };
  const kinds = body.conditions.map((condition) => condition.eventType ?? 'deadline');
  assert.deepEqual(kinds, ['goal_end', 'goal_state', 'goal_state', 'deadline'], 'goal_end + paused + the Wave K auto-continue, matched on the objective, plus the deadline backstop');
  assert.equal(body.conditions.some((condition) => condition.eventType === 'agent_end'), false, 'no per-turn agent_end on the auto-detected goal path');
  const goalEndCondition = body.conditions.find((condition) => condition.eventType === 'goal_end') as { dataMatch?: { objective?: string } };
  assert.equal(goalEndCondition.dataMatch?.objective, 'Ship the widget', 'goal_end matched on the projection objective');
  assert.equal(state.goalReads, 2, 'one detection read + one settlement read; no further probing');
});

test('no --objective + no readable goal: plain agent_end path unchanged', async () => {
  const { deps, state } = makeDeps();
  state.evidenceBySession.set('child', { runs: [{ runId: 'r1', status: 'completed' }] });
  const outcome = await waitOnChild({ sessionId: 'child', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.note, undefined, 'no auto-goal note on the plain path');
  const body = state.lastRegistrationBody as { conditions: WatchConditionSpec[] };
  assert.equal(body.conditions.some((condition) => condition.eventType === 'agent_end'), true, 'plain agent_end registered');
  assert.equal(body.conditions.some((condition) => condition.eventType === 'goal_end'), false);
  assert.equal(state.goalReads, 2, 'one probe read + one guard read at the terminal reconcile (both best-effort)');
});

test('no --objective + a SETTLED goal projection: the guard settles the wait on the goal outcome', async () => {
  const { deps, state } = makeDeps();
  state.goalScripts.set('child', [achieved('Already done'), achieved('Already done')]);
  state.evidenceBySession.set('child', { runs: [{ runId: 'r1', status: 'completed' }] });
  const outcome = await waitOnChild({ sessionId: 'child', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved', 'a settled goal is the honest outcome (not a bare receipt completed)');
  assert.ok(outcome.note?.includes('auto-detected'));
  const body = state.lastRegistrationBody as { conditions: WatchConditionSpec[] };
  assert.equal(body.conditions.some((condition) => condition.eventType === 'agent_end'), true);
});

test('an explicit --objective is never replaced by the probe (no detection read)', async () => {
  const { deps, state } = makeDeps();
  state.goalScripts.set('child', [running('Ship the widget'), achieved('Ship the widget')]);
  state.receipts.set('r1', { runId: 'r1', sessionId: 'child', runtime: 'pi', status: 'completed', acceptedAt: 't' });
  const outcome = await waitOnChild({ sessionId: 'child', runId: 'r1', objective: 'Ship the widget', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved');
  assert.equal(state.goalReads, 2, 'goal read only by the objective settlement paths, not by a probe');
});

test('waitMany --all without --objective: per-child detection (goal child settles via projection, plain child via run)', async () => {
  const { deps, state } = makeDeps();
  state.goalScripts.set('goalchild', [running('Goal work'), achieved('Goal work')]);
  state.evidenceBySession.set('plainchild', { runs: [{ runId: 'r9', status: 'completed' }] });
  state.pendingFiring = goalEndFiring('goalchild');

  const result: WaitOnChildrenResult = await waitOnChildren({
    mode: 'all',
    children: [{ sessionId: 'goalchild' }, { sessionId: 'plainchild' }],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps,
  });
  const bySession = new Map(result.children.map((child) => [child.sessionId, child.outcome]));
  assert.equal(bySession.get('goalchild')?.kind, 'goal_achieved');
  assert.ok((bySession.get('goalchild') as Extract<WaitOutcome, { kind: 'goal_achieved' }>).note?.includes('auto-detected'));
  assert.equal(bySession.get('plainchild')?.kind, 'completed');
  assert.equal(result.exitCode, 0);
});

// ─── C3b live-found race: the probe can run BEFORE the goal registers ────────

test('probe raced (goal idle at probe, active at reconcile): a terminal last run does NOT end a run-less wait; the goal settles it', async () => {
  const { deps, state } = makeDeps();
  // Probe read #1: idle (arm turn has not registered the goal yet).
  // Guard reads: running (keep waiting), then achieved (settle).
  state.goalScripts.set('child', [
    { supported: true, status: 'idle' },
    running('Late-armed goal'),
    running('Late-armed goal'),
    achieved('Late-armed goal'),
  ]);
  state.evidenceBySession.set('child', { runs: [{ runId: 'r-follow', status: 'completed' }] });

  const outcome = await waitOnChild({ sessionId: 'child', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved', `the goal settles the wait, not the receipt: got ${outcome.kind}`);
  assert.ok(outcome.note?.includes('auto-detected'), `outcome says auto-detected: ${outcome.note}`);
});

test('probe raced on the multi-child path: same guard applies per child', async () => {
  const { deps, state } = makeDeps();
  state.goalScripts.set('racer', [
    { supported: true, status: 'idle' },
    running('Multi race'),
    achieved('Multi race'),
  ]);
  state.evidenceBySession.set('racer', { runs: [{ runId: 'r9', status: 'failed', errorCode: 'RUNTIME_ERROR' }] });

  const result = await waitOnChildren({
    mode: 'all',
    children: [{ sessionId: 'racer' }],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps,
  });
  const outcome = result.children[0]?.outcome;
  assert.equal(outcome?.kind, 'goal_achieved', `got ${outcome?.kind}`);
});

test('a genuinely goal-less child is unaffected by the guard (terminal run completes)', async () => {
  const { deps, state } = makeDeps();
  state.goalScripts.set('plain', [{ supported: false, status: 'idle' }, { supported: false, status: 'idle' }, { supported: false, status: 'idle' }]);
  state.evidenceBySession.set('plain', { runs: [{ runId: 'r1', status: 'completed' }] });
  const outcome = await waitOnChild({ sessionId: 'plain', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.note, undefined);
});

test('agent_end firing on a run-less wait does NOT declare completed while a goal the probe missed is active', async () => {
  const { deps, state } = makeDeps();
  // Probe: idle (plain path, agent_end conditions registered).
  // Guard at the agent_end shortcut: running (keep waiting).
  // Guard at the next slice reconcile: achieved (settle).
  state.goalScripts.set('child', [
    { supported: true, status: 'idle' },
    running('Slow goal'),
    running('Slow goal'),
    achieved('Slow goal'),
  ]);
  state.evidenceBySession.set('child', { runs: [{ runId: 'r-tpl', status: 'completed' }] });
  state.pendingFiring = {
    fired: true,
    waitedMs: 5,
    nextCursor: 'c2',
    watches: [{ watchId: 'watch-child', sessionId: 'child', firings: [{ conditionId: 'done-1', firedAt: 1, eventType: 'agent_end' }], firingCount: 1 }],
  };
  const outcome = await waitOnChild({ sessionId: 'child', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved', `got ${outcome.kind}`);
  assert.ok(outcome.note?.includes('auto-detected'));
});

test('waitMany preflight uses each child\'s DETECTED objective: a completed brief-run receipt + running goal is not an early completed', async () => {
  const { deps, state } = makeDeps();
  // Probe: running. Preflight settlement read (with the detected objective):
  // running (keep waiting). Slice reconcile settlement read: achieved.
  state.goalScripts.set('goalchild', [running('Late goal'), running('Late goal'), achieved('Late goal')]);
  state.receipts.set('r1', { runId: 'r1', sessionId: 'goalchild', runtime: 'pi', status: 'completed', acceptedAt: 't' });

  const result = await waitOnChildren({
    mode: 'all',
    children: [{ sessionId: 'goalchild', runId: 'r1' }],
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps,
  });
  const outcome = result.children[0]?.outcome;
  assert.equal(outcome?.kind, 'goal_achieved', `no early completed: got ${outcome?.kind}`);
  assert.ok((outcome as Extract<WaitOutcome, { kind: 'goal_achieved' }>).note?.includes('auto-detected'));
});
