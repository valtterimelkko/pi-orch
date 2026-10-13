import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PiOrchClient } from '../src/client.ts';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import {
  callerObjectiveConditions,
  defaultConditions,
  goalAutoContinueMatch,
  goalEndMatch,
  goalPausedMatch,
  stalledCondition,
} from '../src/builders.ts';
import { applyGoalObjectiveTemplate } from '../src/completion-template.ts';
import { runCli, type CliDeps } from '../src/cli.ts';
import { ApiError, type WatchConditionSpec } from '../src/parsers.ts';
import type { TransportResponse } from '../src/transport.ts';
import { waitOnChild, type WaitDeps, type WaitOutcome } from '../src/wait.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * Lane W2h (PARENT-ORCHESTRATION-MACHINERY-PLAN; contract 1.62.0): the pi-orch
 * client side of W2-a (stable `goalId`) and W2-f (quarantined admission debt),
 * plus the W2-b `stalled` watch token.
 *
 * RED-first provenance: this file was written before the implementation it
 * pins (see the hand-back's TDD receipts). Server facts: pi-web-ui 58757808 /
 * contract 1.62.0 — every goal_state/goal_end carries a top-level `goalId`;
 * a running goal on an idle session emits `goal_state {stalled:true}`; an
 * admission refusal tipped over by quarantined leases carries
 * `reason:"quarantined_debt"`.
 */

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

// ─── 1. Condition builders: goalId keying with the objective fallback ───────

test('W2h: goalEnd/goalPaused/goalAutoContinue key on the top-level goalId when it is known', () => {
  assert.deepEqual(goalEndMatch({ goalId: 'goal_1' }).dataMatch, { goalId: 'goal_1' }, 'goal_end matches the top-level goalId');
  assert.deepEqual(goalPausedMatch({ goalId: 'goal_1' }).dataMatch, { status: 'paused', goalId: 'goal_1' }, 'paused keeps status AND the goalId');
  assert.deepEqual(goalAutoContinueMatch({ goalId: 'goal_1' }).dataMatch, { goalId: 'goal_1', autoContinued: true }, 'auto-continue keeps both top-level keys');
  for (const condition of [goalEndMatch({ goalId: 'goal_1' }), goalPausedMatch({ goalId: 'goal_1' }), goalAutoContinueMatch({ goalId: 'goal_1' })]) {
    assert.equal(condition.once, false, 'goal conditions repeat');
    assert.equal('objective' in (condition.dataMatch as Record<string, unknown>), false, 'a known goalId must not also carry an objective filter');
  }
});

test('W2h: without a goalId the builders keep today\'s objective forms (older-server fallback)', () => {
  assert.deepEqual(goalEndMatch({ objective: 'Ship it' }).dataMatch, { objective: 'Ship it' });
  assert.deepEqual(goalPausedMatch({ objective: 'Ship it' }).dataMatch, { objective: 'Ship it', status: 'paused' });
  assert.deepEqual(goalAutoContinueMatch({ objective: 'Ship it' }).dataMatch, { objective: 'Ship it', autoContinued: true });
  assert.equal(goalEndMatch({}).dataMatch, undefined, 'no identity at all: any goal_end');
});

// ─── 2. The `stalled` token and the default goal-child set ──────────────────

test('W2h: stalledCondition matches goal_state dataMatch {stalled:true} (plus the goalId when known)', () => {
  const bare = stalledCondition();
  assert.equal(bare.type, 'event_type');
  assert.equal(bare.eventType, 'goal_state');
  assert.deepEqual(bare.dataMatch, { stalled: true });
  assert.equal(bare.once, false, 'a stall episode can re-arm; the condition keeps observing');
  assert.deepEqual(stalledCondition({ goalId: 'goal_1' }).dataMatch, { stalled: true, goalId: 'goal_1' });
});

test('W2h: defaultConditions with a known goalId registers id-keyed goal_end/paused/auto-continue plus stalled', () => {
  const conditions = defaultConditions('Ship it', 120_000, 'goal_1');
  const goalEnds = conditions.filter((condition) => condition.eventType === 'goal_end');
  assert.deepEqual(goalEnds.map((condition) => condition.dataMatch), [{ goalId: 'goal_1' }], 'one id-keyed goal_end');
  assert.equal(conditions.some((condition) => condition.dataMatch !== undefined && 'objective' in condition.dataMatch), false, 'no objective key when the id is known');
  assert.equal(conditions.filter((condition) => (condition.dataMatch as Record<string, unknown> | undefined)?.stalled === true).length, 1, 'the stalled condition is part of the default goal set');
  assert.equal(conditions.filter((condition) => condition.type === 'deadline').length, 1);
});

test('W2h: callerObjectiveConditions with a known goalId keys on the id; without it keeps both objective forms + stalled', () => {
  const withId = callerObjectiveConditions('Ship it', 120_000, 'goal_1');
  assert.deepEqual(withId.filter((condition) => condition.eventType === 'goal_end').map((condition) => condition.dataMatch), [{ goalId: 'goal_1' }]);
  assert.equal(withId.some((condition) => condition.dataMatch !== undefined && 'objective' in condition.dataMatch), false, 'the objective forms are dropped once the id is known');
  assert.equal(withId.filter((condition) => (condition.dataMatch as Record<string, unknown> | undefined)?.stalled === true).length, 1);

  const without = callerObjectiveConditions('Ship it', 120_000);
  const stored = applyGoalObjectiveTemplate('Ship it');
  assert.deepEqual(without.filter((condition) => condition.eventType === 'goal_end').map((condition) => (condition.dataMatch as { objective: string }).objective), ['Ship it', stored]);
  assert.equal(without.filter((condition) => (condition.dataMatch as Record<string, unknown> | undefined)?.stalled === true).length, 1, 'stalled rides on the objective-fallback set too');
});

// ─── 3. CLI: watch register and wait accept --goal-id and the stalled token ──

function captureRegisterDeps(seen: Array<Record<string, unknown>>): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'test-key-123',
    client: () =>
      ({
        registerWatch: async (_sessionId: string, input: Record<string, unknown>) => {
          seen.push(input);
          return { watchId: 'w-1', status: 'active', raw: { watchId: 'w-1' } };
        },
      }) as never,
  };
}

test('W2h CLI: watch register --conditions goal_end,paused,stalled --goal-id keys on the id, not the objective', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(
    ['watch', 's1', 'register', '--conditions', 'goal_end,paused,stalled', '--objective', 'Ship it', '--goal-id', 'goal_7', '--id-only'],
    captureRegisterDeps(seen),
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  const conditions = (seen[0]?.conditions ?? []) as WatchConditionSpec[];
  const goalEnds = conditions.filter((condition) => condition.eventType === 'goal_end');
  assert.deepEqual(goalEnds.map((condition) => condition.dataMatch), [{ goalId: 'goal_7' }], 'goal_end keyed on the id');
  assert.deepEqual(
    conditions.filter((condition) => condition.eventType === 'goal_state' && (condition.dataMatch as Record<string, unknown>)?.status === 'paused').map((condition) => condition.dataMatch),
    [{ status: 'paused', goalId: 'goal_7' }],
  );
  assert.deepEqual(
    conditions.filter((condition) => (condition.dataMatch as Record<string, unknown> | undefined)?.stalled === true).map((condition) => condition.dataMatch),
    [{ stalled: true, goalId: 'goal_7' }],
    'the stalled token is registered and carries the id',
  );
  assert.equal(JSON.stringify(seen[0]).includes('"objective"'), false, 'no objective filter once the id is known');
});

test('W2h CLI: watch register --conditions stalled without an objective registers a stall-only condition', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(['watch', 's1', 'register', '--conditions', 'stalled', '--id-only'], captureRegisterDeps(seen));
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  const conditions = (seen[0]?.conditions ?? []) as WatchConditionSpec[];
  assert.deepEqual(conditions.map((condition) => condition.dataMatch), [{ stalled: true }]);
});

test('W2h CLI: wait passes --goal-id through to the client', async () => {
  let captured: Record<string, unknown> | undefined;
  const deps: CliDeps = {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'k',
    client: () => ({
      async wait(options: Record<string, unknown>) {
        captured = options;
        return { kind: 'goal_achieved' };
      },
    }) as never,
  };
  const result = await runCli(['wait', 's1', '--objective', 'Ship it', '--goal-id', 'goal_7'], deps);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  assert.equal(captured?.goalId, 'goal_7');
  assert.equal(captured?.objective, 'Ship it');
});

// ─── 4. client.wait: id-keyed registration from the LIVE projection, never the ledger ──

/**
 * Correction 01 (parent review): the spawn ledger's goalId is INFORMATION, never
 * a condition selector. It is written by `goal start` / `goal show` and never
 * cleared, so a child reused for a second goal (or a plain run) would otherwise
 * have `wait` key on the OLD goal's id — the exact stale-goal failure this lane
 * exists to prevent. `wait` keys on an explicit `--goal-id` only; otherwise it
 * reads the LIVE projection and keys on that id only while a goal is active.
 */
test('W2h/01: a stale ledger goalId is ignored — wait keys on the projection\'s current goalId', async () => {
  const ledgerPath = tempLedgerPath();
  new SpawnLedger(ledgerPath).record({ sessionId: 's1', goalId: 'goal_old', at: 't' });
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ method, path, body: options.body });
      if (path === '/api/v1/sessions/s1') return ok({ sessionId: 's1', busy: false });
      if (path === '/api/v1/sessions/s1/watch' && method === 'GET') return { status: 404, headers: {}, body: { code: 'NOT_FOUND' }, raw: '{}' };
      if (path === '/api/v1/sessions/s1/watch' && method === 'POST') return ok({ watchId: 'w1', status: 'active' });
      // The reused child now runs goal B: a DIFFERENT, active goalId.
      if (path === '/api/v1/sessions/s1/goal') return ok({ supported: true, status: 'running', objective: 'Ship the widget', goalId: 'goal_new' });
      if (path.startsWith('/api/v1/watches/wait')) return { status: 204, headers: {}, body: undefined, raw: '' };
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: ledgerPath, transportInstance: transport, waitSliceMs: 20, waitDeadlineMs: 120 });
  await client.wait({ sessionId: 's1' });
  const registration = calls.find((call) => call.path === '/api/v1/sessions/s1/watch' && call.method === 'POST');
  const conditions = (registration?.body as { conditions: WatchConditionSpec[] } | undefined)?.conditions ?? [];
  assert.deepEqual(conditions.filter((condition) => condition.eventType === 'goal_end').map((condition) => condition.dataMatch), [{ goalId: 'goal_new' }], 'keyed on the CURRENT goal, not the ledger');
  assert.equal(JSON.stringify(conditions).includes('goal_old'), false, 'the stale ledger id must not appear in any condition');
});

test('W2h/01: with no active goal a stale ledger goalId yields the plain agent_end set (never a goal-only set)', async () => {
  const ledgerPath = tempLedgerPath();
  new SpawnLedger(ledgerPath).record({ sessionId: 's1', goalId: 'goal_old', at: 't' });
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ method, path, body: options.body });
      if (path === '/api/v1/sessions/s1') return ok({ sessionId: 's1', busy: false });
      if (path === '/api/v1/sessions/s1/watch' && method === 'GET') return { status: 404, headers: {}, body: { code: 'NOT_FOUND' }, raw: '{}' };
      if (path === '/api/v1/sessions/s1/watch' && method === 'POST') return ok({ watchId: 'w1', status: 'active' });
      // No active goal: a plain run on the reused child.
      if (path === '/api/v1/sessions/s1/goal') return ok({ supported: true, status: 'idle' });
      if (path.startsWith('/api/v1/watches/wait')) return { status: 204, headers: {}, body: undefined, raw: '' };
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: ledgerPath, transportInstance: transport, waitSliceMs: 20, waitDeadlineMs: 120 });
  await client.wait({ sessionId: 's1' });
  const registration = calls.find((call) => call.path === '/api/v1/sessions/s1/watch' && call.method === 'POST');
  const conditions = (registration?.body as { conditions: WatchConditionSpec[] } | undefined)?.conditions ?? [];
  assert.deepEqual(conditions.map((condition) => condition.eventType ?? 'deadline'), ['agent_end'], 'no active goal: the plain path (the sub-second test deadline adds no deadline backstop), no goal conditions');
  assert.equal(conditions.some((condition) => condition.eventType === 'goal_end' || condition.eventType === 'goal_state'), false, 'no goal condition of any kind');
  assert.equal(JSON.stringify(conditions).includes('goal_'), false, 'no goal id or goal event leaked into the conditions');
});

test('W2h: an explicit wait goalId wins over the ledger', async () => {
  const ledgerPath = tempLedgerPath();
  new SpawnLedger(ledgerPath).record({ sessionId: 's1', goalId: 'goal_ledger', at: 't' });
  let registration: WatchConditionSpec[] | undefined;
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      if (path === '/api/v1/sessions/s1') return ok({ sessionId: 's1', busy: false });
      if (path === '/api/v1/sessions/s1/watch' && method === 'GET') return { status: 404, headers: {}, body: { code: 'NOT_FOUND' }, raw: '{}' };
      if (path === '/api/v1/sessions/s1/watch' && method === 'POST') {
        registration = (options.body?.conditions ?? []) as WatchConditionSpec[];
        return ok({ watchId: 'w1', status: 'active' });
      }
      if (path === '/api/v1/sessions/s1/goal') return ok({ supported: true, status: 'achieved', objective: 'Ship it', goalId: 'goal_ledger' });
      if (path.startsWith('/api/v1/watches/wait')) return { status: 204, headers: {}, body: undefined, raw: '' };
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: ledgerPath, transportInstance: transport, waitSliceMs: 20, waitDeadlineMs: 200 });
  await client.wait({ sessionId: 's1', objective: 'Ship it', goalId: 'goal_explicit' });
  assert.deepEqual((registration ?? []).filter((condition) => condition.eventType === 'goal_end').map((condition) => condition.dataMatch), [{ goalId: 'goal_explicit' }]);
});

// ─── 5. wait: a stalled firing is progress, never a fabricated pause ─────────

test('W2h: a stalled goal_state firing does not settle the wait as paused (it keeps waiting)', async () => {
  let stalledId: string | undefined;
  let polled = 0;
  const deps: WaitDeps = {
    longPoll: async () => {
      polled += 1;
      if (polled === 1 && stalledId !== undefined) {
        return { kind: 'fired', body: { fired: true, nextCursor: 'c1', waitedMs: 1, watches: [{ watchId: 'w1', sessionId: 's', firingCount: 1, firings: [{ conditionId: stalledId, firedAt: 1, eventType: 'goal_state', evidence: 'goal_state stalled' }] }] } };
      }
      return { kind: 'timeout' };
    },
    getReceipt: async () => ({ runId: 'r', sessionId: 's', status: 'running' }),
    getSessionEvidence: async () => ({ runs: [] }),
    getSession: async () => ({ sessionId: 's' }),
    getGoal: async () => ({ status: 'running', objective: 'Ship it' }),
    registerWatch: async (_sessionId, body) => {
      const conditions = (body as { conditions?: WatchConditionSpec[] }).conditions ?? [];
      stalledId = conditions.find((condition) => (condition.dataMatch as Record<string, unknown> | undefined)?.stalled === true)?.id;
      return { watchId: 'w1' };
    },
    getWatch: async () => null,
    sleep: async () => undefined,
    now: () => Date.now(),
  };
  const outcome: WaitOutcome = await waitOnChild({ sessionId: 's', objective: 'Ship it', deadlineMs: 60, sliceMs: 10, deps });
  assert.equal(outcome.kind, 'deadline', `a stall must not report a terminal outcome: ${JSON.stringify(outcome)}`);
  assert.notEqual(outcome.kind, 'paused');
  assert.match((outcome as { note?: string }).note ?? '', /stall/i, 'the deadline note reports the observed stall');
});

// ─── 6. Ledger: goalId is additive; the JSON view stays an array ────────────

test('W2h: the spawn ledger stores a goalId additively and the .json view stays a JSON array', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's1', ownerId: 'o', at: 'a' });
  book.noteGoal('s1', 'goal_7');
  assert.equal(book.goalOf('s1'), 'goal_7');
  const view = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(view), 'the frozen JSON view is still an array');
  assert.equal(view.length, 1);
  assert.equal(view[0]?.sessionId, 's1');
  assert.equal(view[0]?.ownerId, 'o');
  assert.equal(view[0]?.goalId, 'goal_7', 'one additive optional field');
});

test('W2h: goalStart and goalShow record the goalId the server returned', async () => {
  const path = tempLedgerPath();
  const seed = new SpawnLedger(path);
  seed.record({ sessionId: 's1', at: 't1' });
  seed.record({ sessionId: 's2', at: 't2' });
  const transport = {
    request: async (method: string, url: string) => {
      if (method === 'GET') return ok({ supported: true, status: 'running', objective: 'Ship it', goalId: 'goal_show' });
      if (url.endsWith('/goal')) return ok({ sessionId: 's1', runtime: 'pi', action: 'start', accepted: true, receipt: null, goal: { supported: true, status: 'running', objective: 'Ship it', goalId: 'goal_start' } });
      throw new Error(`unexpected ${method} ${url}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: path, transportInstance: transport });
  await client.goalStart('s1', { objective: 'Ship it' });
  assert.equal(new SpawnLedger(path).goalOf('s1'), 'goal_start');
  await client.goalShow('s2');
  assert.equal(new SpawnLedger(path).goalOf('s2'), 'goal_show');
});

// ─── 7. spawn --wait-admission: quarantined debt waits, other refusals do not ─

function admissionRefused(reason: string | undefined, retryAfterSeconds = 1): ApiError {
  return new ApiError(429, 'ADMISSION_CAPACITY_EXHAUSTED', 'admission capacity exhausted', {
    retryAfterSeconds,
    data: { code: 'ADMISSION_CAPACITY_EXHAUSTED', ...(reason !== undefined ? { reason } : {}), quarantinedRuns: 2, quarantinedOldestAgeMs: 30_000 },
  });
}

test('W2h: spawn --wait-admission retries a quarantined_debt refusal honouring Retry-After, then succeeds', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const transport = {
    request: async () => {
      attempts += 1;
      if (attempts <= 2) throw admissionRefused('quarantined_debt', 3);
      return ok({ sessionId: 's1' });
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, sleep: async (ms) => { sleeps.push(ms); } });
  const created = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', waitAdmissionMs: 30_000 });
  assert.equal(created.sessionId, 's1');
  assert.equal(attempts, 3, 'two refusals then the accepted create');
  assert.deepEqual(sleeps, [3000, 3000], 'each wait honoured the server\'s Retry-After');
});

test('W2h: without --wait-admission a quarantined_debt refusal is surfaced at once', async () => {
  let attempts = 0;
  const transport = { request: async () => { attempts += 1; throw admissionRefused('quarantined_debt'); } } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, sleep: async () => undefined });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w' }),
    (error: { code?: string }) => error.code === 'ADMISSION_CAPACITY_EXHAUSTED',
  );
  assert.equal(attempts, 1, 'no silent wait without the flag');
});

test('W2h: --wait-admission never sits out a refusal that is not quarantined debt', async () => {
  let attempts = 0;
  const transport = { request: async () => { attempts += 1; throw admissionRefused('global_limit'); } } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, sleep: async () => undefined });
  await assert.rejects(client.spawn({ runtime: 'pi', cwd: '/tmp/w', waitAdmissionMs: 30_000 }), (error: { code?: string }) => error.code === 'ADMISSION_CAPACITY_EXHAUSTED');
  assert.equal(attempts, 1, 'a non-quarantine refusal is someone else\'s decision, not a wait');
});

test('W2h: --wait-admission gives up at its budget and surfaces the last refusal', async () => {
  let clock = 0;
  let attempts = 0;
  const transport = { request: async () => { attempts += 1; throw admissionRefused('quarantined_debt', 1); } } as never;
  const client = new PiOrchClient({
    spawnLedgerPath: tempLedgerPath(),
    transportInstance: transport,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  await assert.rejects(client.spawn({ runtime: 'pi', cwd: '/tmp/w', waitAdmissionMs: 2500 }), (error: { code?: string }) => error.code === 'ADMISSION_CAPACITY_EXHAUSTED');
  assert.equal(attempts, 4, 'two full 1s waits, a 0.5s tail, then the budget is spent');
});

test('W2h: spawn --wait-admission re-enters the gated create path on each retry (re-counts, no lock held across the wait)', async () => {
  let counts = 0;
  let creates = 0;
  const transport = {
    request: async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/api/v1/sessions?parent=')) {
        counts += 1;
        return ok({ sessions: [] });
      }
      creates += 1;
      if (creates === 1) throw admissionRefused('quarantined_debt', 1);
      return ok({ sessionId: 's1' });
    },
  } as never;
  const client = new PiOrchClient({
    parentSessionId: 'p1',
    spawnLedgerPath: tempLedgerPath(),
    transportInstance: transport,
    sleep: async () => undefined,
  });
  const created = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: 'route/a', routeLimit: 1, waitAdmissionMs: 10_000 });
  assert.equal(created.sessionId, 's1');
  assert.equal(creates, 2, 'the refusal was retried');
  assert.equal(counts, 2, 'each attempt re-counted through the gate (so the route lock was re-acquired, not held across the wait)');
});

// ─── 8. CLI: the quarantined refusal names the debt and the flag ─────────────

function spawnDeps(spawn: (input: Record<string, unknown>) => Promise<Record<string, unknown>>): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'test-key-123',
    client: () => ({ spawn }) as never,
  };
}

test('W2h CLI: a quarantined_debt refusal names the debt and suggests --wait-admission', async () => {
  const result = await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], spawnDeps(async () => { throw admissionRefused('quarantined_debt'); }));
  assert.equal(result.exitCode, 10, `stderr: ${result.stderr ?? ''}`);
  assert.match(result.stderr ?? '', /quarantin/i);
  assert.match(result.stderr ?? '', /--wait-admission/);
});

test('W2h CLI: spawn --wait-admission passes the seconds budget to the client', async () => {
  let captured: Record<string, unknown> | undefined;
  const result = await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--wait-admission', '45'], spawnDeps(async (input) => {
    captured = input;
    return { sessionId: 's1' };
  }));
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  assert.equal(captured?.waitAdmissionMs, 45_000);
});
