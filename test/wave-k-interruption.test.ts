import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiOrchClient } from '../src/client.ts';
import { runCli, type CliDeps } from '../src/cli.ts';
import {
  defaultConditions,
  callerObjectiveConditions,
  goalAutoContinue,
  goalEnd,
  goalPaused,
} from '../src/builders.ts';
import { applyGoalObjectiveTemplate } from '../src/completion-template.ts';
import { OUTCOME_EXIT_CODES } from '../src/exit-codes.ts';
import { waitOnChild, waitOnChildren, type WaitDeps } from '../src/wait.ts';
import type { WatchConditionSpec } from '../src/parsers.ts';
import type { TransportResponse } from '../src/transport.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * Wave K (contract 1.60.0): a Pi goal child whose run hit a TRANSIENT stop is
 * auto-continued by the server exactly once. The auto-continue surfaces as a
 * `goal_state` with `status: "running"` and `interruption.autoContinued: true`
 * — PROGRESS, never a settlement — and a stop the server does NOT continue
 * surfaces as `goal_state` `paused` + `pausedReason: "interrupted"` with the
 * same `interruption` object on the projection. The wait must keep waiting
 * through continues (counting them into `autoContinues`), settle a visible
 * stop as `interrupted` (existing exit 5) with the cause and continueCount in
 * the JSON and a note naming the parent's move (resume or re-dispatch), and
 * leave an ordinary pause exactly as today. Fixtures are shaped exactly like
 * the K contract docs (docs/INTERNAL-API.md § Goal, Wave K section); no live
 * server is used.
 */

type LongPollResult = { kind: 'fired'; body: unknown } | { kind: 'timeout' } | { kind: 'error'; error: Error };

interface HarnessState {
  longPollCalls: number;
  receiptChecks: number;
  registrations: Array<Record<string, unknown>>;
  goalsBySession: Map<string, Array<Record<string, unknown>>>;
  evidenceBySession: Map<string, { runs: Array<Record<string, unknown>> }>;
  receipts: Map<string, Record<string, unknown>>;
  script: Array<() => unknown>;
}

function autoDeps(state: HarnessState): WaitDeps {
  return {
    async longPoll() {
      state.longPollCalls += 1;
      const next = state.script.shift();
      if (!next) return { kind: 'timeout' as const };
      const result = next() as unknown;
      // Script entries may return a full result or a bare response body.
      if (result && typeof result === 'object' && 'kind' in (result as Record<string, unknown>)) return result as { kind: 'fired'; body: unknown } | { kind: 'timeout' };
      return { kind: 'fired' as const, body: result };
    },
    async getReceipt(runId) {
      state.receiptChecks += 1;
      const receipt = state.receipts.get(runId);
      if (!receipt) throw new Error(`no scripted receipt for ${runId}`);
      return receipt as never;
    },
    async getSession(sessionId) {
      return { sessionId, status: 'running' };
    },
    async getGoal(sessionId) {
      const script = state.goalsBySession.get(sessionId);
      const goal = script?.shift();
      if (!goal) throw new Error(`no scripted goal read for ${sessionId}`);
      return goal as never;
    },
    async getSessionEvidence(sessionId) {
      const evidence = state.evidenceBySession.get(sessionId);
      if (!evidence) throw new Error(`no scripted evidence for ${sessionId}`);
      return evidence as never;
    },
    async registerWatch(_sessionId, body) {
      state.registrations.push(body as Record<string, unknown>);
      return { watchId: `watch-${_sessionId}`, status: 'active' };
    },
    async getWatch() {
      return null; // no surviving watch: every test registers fresh
    },
    async sleep() {
      /* instant in tests */
    },
    now: (() => {
      let ticks = 0;
      return () => (ticks += 1000);
    })(),
  };
}

function makeHarness(): { deps: WaitDeps; state: HarnessState } {
  const state: HarnessState = {
    longPollCalls: 0,
    receiptChecks: 0,
    registrations: [],
    goalsBySession: new Map(),
    evidenceBySession: new Map(),
    receipts: new Map(),
    script: [],
  };
  return { deps: autoDeps(state), state };
}

function firingBody(watchId: string, firings: Array<Record<string, unknown>>, cursor = 'c2'): unknown {
  return {
    fired: true,
    waitedMs: 30,
    watches: [{ watchId, sessionId: 'child', runtime: 'pi', firings, firingCount: firings.length }],
    nextCursor: cursor,
  };
}

function conditionOf(conditions: Array<Record<string, unknown>>, predicate: (condition: Record<string, unknown>) => boolean): Record<string, unknown> {
  const condition = conditions.find(predicate);
  assert.ok(condition, `no registered condition matches the predicate in ${JSON.stringify(conditions)}`);
  return condition;
}

/** The wait's OWN registered conditions (ids are allocated at registration time). */
function registeredConditions(state: HarnessState, index = 0): Array<Record<string, unknown>> {
  const conditions = (state.registrations[index]?.conditions ?? []) as Array<Record<string, unknown>>;
  assert.ok(conditions.length > 0, 'the wait registered no conditions');
  return conditions;
}
/** A scripted firing for the wait's own condition of the given kind. */
function ownFiring(state: HarnessState, kind: 'goal_end' | 'auto' | 'paused', evidence: string, cursor = 'c2'): () => LongPollResult {
  return () => {
    const conditions = registeredConditions(state);
    const condition = conditionOf(conditions, kind === 'goal_end'
      ? (c) => c.eventType === 'goal_end'
      : kind === 'auto' ? isGoalStateAutoContinue : isGoalStatePaused) as { id?: string };
    return { kind: 'fired' as const, body: firingBody('watch-child', [{ conditionId: condition.id, firedAt: 4, eventType: kind === 'goal_end' ? 'goal_end' : 'goal_state', evidence }], cursor) };
  };
}

const isGoalStatePaused = (condition: Record<string, unknown>): boolean =>
  condition.eventType === 'goal_state' && (condition.dataMatch as Record<string, unknown> | undefined)?.status === 'paused';
const isGoalStateAutoContinue = (condition: Record<string, unknown>): boolean =>
  condition.eventType === 'goal_state' && (condition.dataMatch as Record<string, unknown> | undefined)?.['interruption.autoContinued'] === true;

// ─── Conditions (item 1: the watch must be ABLE to see the auto-continue) ────

test('goalAutoContinue: goal_state condition carrying the dotted autoContinued match and the objective filter, repeating', () => {
  const condition = goalAutoContinue('Ship it');
  assert.equal(condition.type, 'event_type');
  assert.equal(condition.eventType, 'goal_state');
  assert.equal(condition.once, false, 'repeats: several continues across one long-lived goal must all be visible');
  assert.deepEqual(condition.dataMatch, { objective: 'Ship it', 'interruption.autoContinued': true });
});

test('defaultConditions on a goal objective registers goal_end + paused + auto-continue + deadline (and no agent_end)', () => {
  const conditions = defaultConditions('Do the bounded thing', 300_000) as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(
    conditions.filter((condition) => condition.type !== 'deadline').map((condition) => condition.eventType),
    ['goal_end', 'goal_state', 'goal_state'],
    'goal_end, the paused goal_state and the auto-continue goal_state',
  );
  assert.equal(conditions.some((condition) => condition.eventType === 'agent_end'), false, 'no per-turn agent_end');
  assert.equal(conditions.filter(isGoalStatePaused).length, 1);
  assert.equal(conditions.filter(isGoalStateAutoContinue).length, 1);
});

test('callerObjectiveConditions registers the auto-continue condition for BOTH objective forms', () => {
  const raw = 'Ship the fix';
  const stored = applyGoalObjectiveTemplate(raw);
  const conditions = callerObjectiveConditions(raw, 120_000) as unknown as Array<Record<string, unknown>>;
  const autoObjectives = conditions.filter(isGoalStateAutoContinue).map((condition) => (condition.dataMatch as Record<string, unknown>).objective);
  assert.deepEqual(autoObjectives, [raw, stored], 'one auto-continue condition per objective form');
  const conditionsStored = callerObjectiveConditions(stored, 120_000) as unknown as Array<Record<string, unknown>>;
  assert.equal(conditionsStored.filter(isGoalStateAutoContinue).length, 1, 'the stored form stays single-form');
});

// ─── wait: the auto-continue firing is progress, not settlement ─────────────

test('wait: an auto-continue goal_state firing keeps the wait going and is counted (autoContinues: 1 at the real end)', async () => {
  const { deps, state } = makeHarness();
  state.goalsBySession.set('child', [
    // Read at the auto-continue firing: the goal carried on (status running).
    { status: 'running', objective: 'Ship it', interruption: { cause: 'restart_interruption', source: 'receipt', detectedAt: 1000, continueCount: 1, autoContinued: true } },
    // Read at the goal_end classification: the goal finished.
    { status: 'achieved', objective: 'Ship it' },
  ]);
  state.script = [ownFiring(state, 'auto', 'event goal_state', 'c1'), ownFiring(state, 'goal_end', 'achieved', 'c2')];
  const outcome = await waitOnChild({ sessionId: 'child', objective: 'Ship it', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved', `outcome: ${JSON.stringify(outcome)}`);
  assert.equal(state.longPollCalls, 2, 'the auto-continue firing did NOT settle the wait; the goal_end did');
  assert.equal((outcome as { autoContinues?: number }).autoContinues, 1, 'the continue is counted in the result');
  // The registered conditions include the dotted auto-continue condition, filtered by the exact objective.
  const conditions = (state.registrations[0]?.conditions ?? []) as Array<Record<string, unknown>>;
  const autoCondition = conditionOf(conditions, isGoalStateAutoContinue) as { dataMatch: Record<string, unknown> };
  assert.equal(autoCondition.dataMatch.objective, 'Ship it');
  assert.equal((outcome as { interruption?: unknown }).interruption, undefined, 'an achieved goal is not an interruption');
});

test('wait: the auto-continue counting works even when the dotted wake never fires (projection scrape at the slice boundary)', async () => {
  // The server's dataMatch is a shallow top-level match over the event data
  // (the projection), so the dotted `interruption.autoContinued` key cannot
  // fire on the current server build. The wait must still COUNT the continue:
  // the projection read at reconciliation shows it. Run-less goal child (the
  // receipt-less class), first slice times out, the last run is terminal, the
  // projection says running + autoContinued → keep waiting, count it.
  const { deps, state } = makeHarness();
  state.evidenceBySession.set('child', { runs: [{ runId: 'r1', status: 'completed' }] });
  state.goalsBySession.set('child', [
    // Read at the slice-boundary settlement probe: running + auto-continued.
    { status: 'running', objective: 'Ship it', interruption: { cause: 'restart_interruption', source: 'drain', detectedAt: 55, continueCount: 1, autoContinued: true } },
    // Read at the goal_end classification.
    { status: 'achieved', objective: 'Ship it' },
  ]);
  state.script = [
    () => ({ kind: 'timeout' as const }),
    ownFiring(state, 'goal_end', 'achieved', 'c9'),
  ];
  const outcome = await waitOnChild({ sessionId: 'child', objective: 'Ship it', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved', `outcome: ${JSON.stringify(outcome)}`);
  assert.equal(state.longPollCalls, 2, 'a terminal brief run on an auto-continued goal does not settle the wait');
  assert.equal((outcome as { autoContinues?: number }).autoContinues, 1, 'the continue observed on the projection is counted');
});

// ─── wait: the visible stop settles as interrupted (exit 5) ─────────────────

test('wait: a visible stop (paused + interrupted) settles exit 5 with cause, continueCount and a resume-or-redispatch note', async () => {
  const { deps, state } = makeHarness();
  state.goalsBySession.set('child', [
    // Read at the goal_state firing: the projection carries the interruption.
    {
      status: 'paused',
      objective: 'Ship it',
      pausedReason: 'interrupted',
      interruption: { cause: 'continue_failed', source: 'receipt', detectedAt: 77, continueCount: 1, autoContinued: false, continueNote: '/goal resume …' },
    },
  ]);
  const conditions = defaultConditions('Ship it', 60_000) as unknown as WatchConditionSpec[];
  assert.ok(conditions.some(isGoalStatePaused as (c: unknown) => boolean), 'the default set carries the paused condition (fixture sanity)');
  state.script = [ownFiring(state, 'paused', 'event goal_state', 'c4')];
  const outcome = await waitOnChild({ sessionId: 'child', objective: 'Ship it', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'interrupted', `outcome: ${JSON.stringify(outcome)}`);
  assert.equal(OUTCOME_EXIT_CODES.interrupted, 5, 'interrupted stays exit 5');
  assert.equal(OUTCOME_EXIT_CODES[outcome.kind], 5);
  const facts = (outcome as { interruption?: { cause?: string; continueCount?: number; autoContinued?: boolean } }).interruption;
  assert.equal(facts?.cause, 'continue_failed', 'the cause is in the result');
  assert.equal(facts?.continueCount, 1, 'the continueCount is in the result');
  assert.equal(facts?.autoContinued, false);
  assert.match(outcome.note ?? '', /resume|re-dispatch/, 'the note says what the parent must do');
  const asJson = JSON.stringify(outcome);
  assert.match(asJson, /"cause":"continue_failed"/);
  assert.match(asJson, /"continueCount":1/);
});

test('wait: an ordinary pause (any other pausedReason) keeps today\\u2019s behaviour exactly', async () => {
  const { deps, state } = makeHarness();
  state.goalsBySession.set('child', [{ status: 'paused', objective: 'Ship it', pausedReason: 'question' }]);
  state.script = [ownFiring(state, 'paused', 'event goal_state', 'c4')];
  const outcome = await waitOnChild({ sessionId: 'child', objective: 'Ship it', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'paused', `outcome: ${JSON.stringify(outcome)}`);
  assert.equal(OUTCOME_EXIT_CODES.paused, 0);
  assert.equal((outcome as { interruption?: unknown }).interruption, undefined, 'no interruption facts on an ordinary pause');
  assert.equal(outcome.note, 'goal paused — read the session before resuming');
});

// ─── multi-child: per-child classification and counting ─────────────────────

test('waitOnChildren: an auto-continue does not settle its child; a visible stop settles only its own child', async () => {
  const { deps, state } = makeHarness();
  state.goalsBySession.set('child-a', [
    { status: 'running', objective: 'X', interruption: { cause: 'restart_interruption', source: 'drain', detectedAt: 5, continueCount: 1, autoContinued: true } },
    { status: 'achieved', objective: 'X' },
  ]);
  state.goalsBySession.set('child-b', [
    { status: 'paused', objective: 'X', pausedReason: 'interrupted', interruption: { cause: 'restart_interruption', source: 'receipt', detectedAt: 6, continueCount: 0, autoContinued: false } },
  ]);
  const registersBySession = new Map<string, Array<Record<string, unknown>>>();
  const depsMulti: WaitDeps = {
    ...deps,
    async registerWatch(sessionId, body) {
      registersBySession.set(sessionId, (body as { conditions: Array<Record<string, unknown>> }).conditions);
      state.registrations.push(body as Record<string, unknown>);
      return { watchId: `watch-${sessionId}`, status: 'active' };
    },
    async longPoll({ ids }) {
      state.longPollCalls += 1;
      if (state.longPollCalls === 1) {
        const conditionsA = registersBySession.get('child-a') ?? [];
        const conditionsB = registersBySession.get('child-b') ?? [];
        const autoA = conditionOf(conditionsA, isGoalStateAutoContinue) as { id?: string };
        const pausedB = conditionOf(conditionsB, isGoalStatePaused) as { id?: string };
        return {
          kind: 'fired' as const,
          body: {
            fired: true,
            waitedMs: 10,
            watches: [
              { watchId: 'watch-child-a', sessionId: 'child-a', runtime: 'pi', firings: [{ conditionId: autoA.id, firedAt: 1, eventType: 'goal_state', evidence: 'event goal_state' }], firingCount: 1 },
              { watchId: 'watch-child-b', sessionId: 'child-b', runtime: 'pi', firings: [{ conditionId: pausedB.id, firedAt: 2, eventType: 'goal_state', evidence: 'event goal_state' }], firingCount: 1 },
            ],
            nextCursor: 'm2',
          },
        };
      }
      return { kind: 'fired' as const, body: firingBody('watch-child-a', [{ conditionId: 'outcome-1', firedAt: 3, eventType: 'goal_end', evidence: 'achieved' }], 'm3') };
    },
  };
  const result = await waitOnChildren({
    mode: 'all',
    children: [{ sessionId: 'child-a' }, { sessionId: 'child-b' }],
    objective: 'X',
    deadlineMs: 60_000,
    sliceMs: 5_000,
    deps: depsMulti,
  });
  const a = result.children.find((child) => child.sessionId === 'child-a');
  const b = result.children.find((child) => child.sessionId === 'child-b');
  assert.equal(a?.outcome?.kind, 'goal_achieved', `child-a: ${JSON.stringify(a?.outcome)}`);
  assert.equal((a?.outcome as { autoContinues?: number } | undefined)?.autoContinues, 1, 'child-a counted its continue');
  assert.equal(b?.outcome?.kind, 'interrupted', `child-b: ${JSON.stringify(b?.outcome)}`);
  assert.equal((b?.outcome as { interruption?: { cause?: string } } | undefined)?.interruption?.cause, 'restart_interruption');
  assert.equal(result.exitCode, 5, 'all-mode exit is the first nonzero child outcome (b: interrupted)');
});

// ─── every goal wait reports autoContinues (0 when none) ────────────────────

test('wait: a goal wait with no continues reports autoContinues: 0', async () => {
  const { deps, state } = makeHarness();
  state.goalsBySession.set('child', [{ status: 'achieved', objective: 'Ship it' }]);
  state.script = [ownFiring(state, 'goal_end', 'achieved', 'c2')];
  const outcome = await waitOnChild({ sessionId: 'child', objective: 'Ship it', deadlineMs: 60_000, sliceMs: 5_000, deps });
  assert.equal(outcome.kind, 'goal_achieved');
  assert.equal((outcome as { autoContinues?: number }).autoContinues, 0, '0 when none');
});

// ─── client and CLI layers ──────────────────────────────────────────────────

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

test('client.wait on a goal child registers the auto-continue condition; the CLI JSON reports autoContinues', async () => {
  const makeTransport = () => {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    let goalReads = 0;
    let waitPosts = 0;
    return {
      calls,
      transport: {
        request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
          calls.push({ method, path, body: options.body });
          if (path === '/api/v1/sessions/s1') return ok({ sessionId: 's1', busy: false });
          if (path === '/api/v1/sessions/s1/watch' && method === 'GET') {
            return { status: 404, headers: {}, body: { code: 'NOT_FOUND' }, raw: '{}' };
          }
          if (path === '/api/v1/sessions/s1/goal') {
            goalReads += 1;
            // Read 1: at the auto-continue firing — the projection shows the
            // continue (running + autoContinued). Read 2: at the goal_end — achieved.
            if (goalReads === 1) {
              return ok({
                supported: true,
                status: 'running',
                objective: 'Ship it',
                interruption: { cause: 'restart_interruption', source: 'drain', detectedAt: 9, continueCount: 1, autoContinued: true },
              });
            }
            return ok({ supported: true, status: 'achieved', objective: 'Ship it' });
          }
          if (path === '/api/v1/sessions/s1/watch' && method === 'POST') return ok({ watchId: 'w1', status: 'active' });
          if (path.startsWith('/api/v1/watches/wait')) {
            waitPosts += 1;
            if (waitPosts === 1) {
              const registration = calls.find((call) => call.path === '/api/v1/sessions/s1/watch' && call.method === 'POST');
              const conditions = (registration?.body as { conditions: Array<Record<string, unknown>> }).conditions;
              const auto = conditionOf(conditions, isGoalStateAutoContinue) as { id?: string };
              return ok({
                fired: true,
                waitedMs: 10,
                watches: [{ watchId: 'w1', sessionId: 's1', runtime: 'pi', firings: [{ conditionId: auto.id, firedAt: 1, eventType: 'goal_state', evidence: 'event goal_state' }], firingCount: 1 }],
                nextCursor: 'w2',
              });
            }
            return ok({
              fired: true,
              waitedMs: 10,
              watches: [{ watchId: 'w1', sessionId: 's1', runtime: 'pi', firings: [{ conditionId: 'outcome-1', firedAt: 2, eventType: 'goal_end', evidence: 'achieved' }], firingCount: 1 }],
              nextCursor: 'w3',
            });
          }
          throw new Error(`unexpected ${method} ${path}`);
        },
      } as never,
    };
  };
  const first = makeTransport();
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: first.transport, waitSliceMs: 50, waitDeadlineMs: 5_000 });
  const outcome = await client.wait({ sessionId: 's1', objective: 'Ship it' });
  assert.equal(outcome.kind, 'goal_achieved', JSON.stringify(outcome));
  assert.equal((outcome as { autoContinues?: number }).autoContinues, 1);
  const second = makeTransport();
  const cliClient = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: second.transport, waitSliceMs: 50, waitDeadlineMs: 5_000 });
  const deps: CliDeps = { env: {}, stdout: () => undefined, stderr: () => undefined, randomId: () => 'k', client: (() => cliClient) as never };
  const json = await runCli(['wait', 's1', '--objective', 'Ship it', '--json'], deps);
  assert.equal(json.exitCode, 0);
  assert.match(json.stdout ?? '', /"autoContinues": 1/, 'the JSON result reports the count');
});

test('status: a goal child\\u2019s interruption is in the JSON body (cause, continueCount, autoContinued) and the human line', async () => {
  const transport = {
    request: async (method: string, path: string) => {
      if (path === '/api/v1/sessions/s1/goal') {
        return ok({
          supported: true,
          status: 'paused',
          objective: 'Ship it',
          pausedReason: 'interrupted',
          interruption: { cause: 'restart_interruption', source: 'receipt', detectedAt: 3, continueCount: 0, autoContinued: false },
        });
      }
      if (path === '/api/v1/sessions/s1/evidence') return ok({ runChronology: [{ runId: 'r1', status: 'interrupted' }] });
      if (path === '/api/v1/sessions/s1') return ok({ sessionId: 's1', runtime: 'pi', busy: false, status: 'idle' });
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k' });
  const body = await client.status({ sessionId: 's1' });
  const child = body.children[0];
  assert.ok(child, 'the child is listed');
  const facts = (child as { goalInterruption?: { cause?: string; continueCount?: number; autoContinued?: boolean } }).goalInterruption;
  assert.ok(facts, 'goalInterruption present in the JSON body');
  assert.equal(facts?.cause, 'restart_interruption');
  assert.equal(facts?.continueCount, 0);
  assert.equal(facts?.autoContinued, false);

  const deps: CliDeps = {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'k',
    client: (() => client) as never,
  };
  const human = await runCli(['status', 's1'], deps);
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout ?? '', /interrupted cause=restart_interruption continueCount=0 autoContinued=false/);
});

test('status: a child without an interruption has no goalInterruption field (additive only)', async () => {
  const transport = {
    request: async (method: string, path: string) => {
      if (path === '/api/v1/sessions/s2/goal') return ok({ supported: true, status: 'running', objective: 'O' });
      if (path === '/api/v1/sessions/s2/evidence') return ok({ runChronology: [] });
      if (path === '/api/v1/sessions/s2') return ok({ sessionId: 's2', runtime: 'pi', busy: true, status: 'running' });
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k' });
  const body = await client.status({ sessionId: 's2' });
  assert.equal((body.children[0] as { goalInterruption?: unknown }).goalInterruption, undefined);
});

// ─── goal_end and goalPaused builders stay byte-compatible ──────────────────

test('goalEnd/goalPaused keep their existing shapes (no drift)', () => {
  assert.deepEqual(((goalEnd('O') as unknown as Record<string, unknown>).dataMatch as Record<string, unknown>), { objective: 'O' });
  assert.deepEqual(((goalPaused('O') as unknown as Record<string, unknown>).dataMatch as Record<string, unknown>), { objective: 'O', status: 'paused' });
});
