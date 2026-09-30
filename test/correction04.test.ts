import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitOnChild, waitOnChildren, type WaitDeps, type WaitOutcome } from '../src/wait.ts';
import { agentEnd, goalEnd, questionSentinel } from '../src/builders.ts';
import { PiOrchClient } from '../src/client.ts';
import { Transport, type TransportResponse } from '../src/transport.ts';
import { runCli } from '../src/cli.ts';
import { exitCodeFor } from '../src/exit-codes.ts';

/**
 * Correction 04 RED tests (Luna majors + parent pre-review). Each test
 * reproduces a reviewer probe before the fix exists.
 */

function makeDeps(): { deps: WaitDeps; state: {
  longPollCalls: number; registrations: number; receipts: Map<string, Record<string, unknown>>;
  goals: Map<string, Record<string, unknown>>; watches: Map<string, { watchId: string; status?: string; conditions?: unknown[]; label?: string }>;
  pendingFiring?: unknown; getWatchCalls: number;
} } {
  const state = {
    longPollCalls: 0, registrations: 0, getWatchCalls: 0,
    receipts: new Map<string, Record<string, unknown>>(),
    goals: new Map<string, Record<string, unknown>>(),
    watches: new Map<string, { watchId: string; status?: string; conditions?: Array<{ id?: string; spec?: Record<string, unknown> }>; label?: string }>(),
    pendingFiring: undefined as unknown,
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
    async getSessionEvidence() {
      return { runs: [] };
    },
    async getSession(sessionId) {
      return { sessionId, status: 'running' };
    },
    async getGoal(sessionId) {
      const goal = state.goals.get(sessionId);
      if (!goal) throw new Error(`no scripted goal for ${sessionId}`);
      return goal as never;
    },
    async registerWatch(_sessionId, _body) {
      state.registrations += 1;
      return { watchId: `watch-${state.registrations}`, status: 'active' };
    },
    async getWatch(sessionId) {
      state.getWatchCalls += 1;
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

function firingBody(firings: Array<Record<string, unknown>>, firingCount = 1, cursor = 'c1'): unknown {
  return {
    fired: true, waitedMs: 5,
    watches: [{ watchId: 'watch-1', sessionId: 'child', runtime: 'pi', firings, firingCount }],
    nextCursor: cursor,
  };
}

// ─── Item 1: goal_end is classified from the goal projection ────────────────

test('correction04/1: goal_end with projection status failed → goal_failed (not success)', async () => {
  const { deps, state } = makeDeps();
  state.goals.set('child', { supported: true, status: 'failed', pausedReason: 'error', lastReason: 'run ended in under 15000ms' });
  state.pendingFiring = firingBody([{ conditionId: 'outcome', firedAt: 1, eventType: 'goal_end', evidence: 'failed' }]);
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [goalEnd('obj')], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'goal_failed');
  assert.equal(exitCodeFor({ kind: 'goal_failed' }), 4);
  assert.ok((outcome.note ?? '').includes('error'), 'the projection reason surfaces in the outcome');
});

test('correction04/1: goal_end with projection status cleared → distinct goal_cleared outcome (exit 17)', async () => {
  const { deps, state } = makeDeps();
  state.goals.set('child', { supported: true, status: 'cleared' });
  state.pendingFiring = firingBody([{ conditionId: 'outcome', firedAt: 1, eventType: 'goal_end', evidence: 'cleared' }]);
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [goalEnd('obj')], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'goal_cleared');
  assert.equal(exitCodeFor({ kind: 'goal_cleared' }), 17);
});

test('correction04/1: goal_end with projection status achieved → goal_achieved', async () => {
  const { deps, state } = makeDeps();
  state.goals.set('child', { supported: true, status: 'achieved' });
  state.pendingFiring = firingBody([{ conditionId: 'outcome', firedAt: 1, eventType: 'goal_end', evidence: 'achieved' }]);
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [goalEnd('obj')], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'goal_achieved');
});

test('correction04/1: goal_state paused with budget reason keeps the paused outcome with the reason', async () => {
  const { deps, state } = makeDeps();
  state.pendingFiring = firingBody([{ conditionId: 'paused', firedAt: 1, eventType: 'goal_state', evidence: 'paused' }]);
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [goalEnd('obj')], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'paused');
});

// ─── Item 2: question sentinel classified by the registered condition id ────

test('correction04/2: a realistic text firing (eventType message_update) on the sentinel condition → question', async () => {
  const { deps, state } = makeDeps();
  const sentinel = questionSentinel('BLOCKED-NEEDS-INPUT');
  state.pendingFiring = firingBody([
    // Real normalized text firings carry the underlying event type:
    { conditionId: sentinel.id, firedAt: 1, eventType: 'message_update', evidence: '…BLOCKED-NEEDS-INPUT…' },
  ]);
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [sentinel], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'question', `got ${outcome.kind}`);
});

// ─── Item 4: receipt/session mismatch fails fast ─────────────────────────────

test('correction04/4: a receipt belonging to another session fails fast (exit 16 class), no watch', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('r1', { runId: 'r1', sessionId: 'OTHER-SESSION', runtime: 'pi', status: 'started', acceptedAt: 't' });
  const outcome = await waitOnChild({
    sessionId: 'child', runId: 'r1', conditions: [agentEnd()], deadlineMs: 600_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'run_not_found');
  assert.ok((outcome.note ?? '').includes('mismatch'), 'note names the mismatch');
  assert.equal(state.registrations, 0);
  assert.equal(state.longPollCalls, 0);
});

// ─── Item 5: watch reuse only when compatible ────────────────────────────────

test('correction04/5: an unrelated active foreign watch → explicit watch_conflict, never a silent deadline', async () => {
  const { deps, state } = makeDeps();
  state.watches.set('child', { watchId: 'foreign', status: 'active', label: 'other-observer', conditions: [{ id: 'x', type: 'tool', spec: { type: 'tool', toolName: 'Bash' } }] });
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'watch_conflict');
  assert.equal(exitCodeFor({ kind: 'watch_conflict' }), 19);
  assert.equal(state.registrations, 0, 'a foreign watch is never replaced');
});

test('correction04/5: a watch with OUR label is reused (owned), not replaced', async () => {
  const { deps, state } = makeDeps();
  state.watches.set('child', { watchId: 'ours', status: 'active', label: 'c1-wait', conditions: [] });
  state.receipts.set('r1', { runId: 'r1', sessionId: 'child', runtime: 'pi', status: 'completed', acceptedAt: 't' });
  const outcome = await waitOnChild({
    sessionId: 'child', runId: 'r1', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, label: 'c1-wait', deps,
  });
  assert.equal(outcome.kind, 'completed');
  assert.equal(state.registrations, 0, 'own watch reused');
});

test('correction04/5: an existing watch with no conditions/label (legacy shape) is treated as foreign', async () => {
  const { deps, state } = makeDeps();
  state.watches.set('child', { watchId: 'legacy', status: 'active', conditions: [] });
  const outcome = await waitOnChild({
    sessionId: 'child', conditions: [agentEnd()], deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(outcome.kind, 'watch_conflict');
});

// ─── waitMany shares the fixes ────────────────────────────────────────────────

test('correction04/4: waitMany preflight also rejects a receipt/session mismatch', async () => {
  const { deps, state } = makeDeps();
  state.receipts.set('r1', { runId: 'r1', sessionId: 'NOT-CHILD', runtime: 'pi', status: 'started', acceptedAt: 't' });
  const result = await waitOnChildren({
    mode: 'all',
    children: [{ sessionId: 'child', runId: 'r1' }],
    deadlineMs: 60_000, sliceMs: 5_000, deps,
  });
  assert.equal(result.children[0]?.outcome?.kind, 'run_not_found');
});

// ─── Item 3: no duplicate create after a lost response ──────────────────────

test('correction04/3: a create whose response is lost is NEVER retried — one POST, unknown outcome', async () => {
  let posts = 0;
  const transport = {
    request: async (method: string) => {
      if (method === 'POST') {
        posts += 1;
        throw new (await import('../src/transport.ts')).TransportError('pi-orch: POST /api/v1/sessions failed after 1 attempt(s): socket hung up');
      }
      return { status: 200, headers: {}, body: {}, raw: '' } as TransportResponse;
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k' });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/x', retention: { mode: 'durable', ownerId: 'o' } }),
    (error: { code?: string }) => error.code === 'CREATE_UNKNOWN',
  );
  assert.equal(posts, 1, 'the dropped-response probe must produce ONE POST, not two');
});

test('correction04/3: prompt dispatch carries the idempotent marker (transport owns retry policy)', async () => {
  const seenOptions: Array<{ _idempotent?: boolean }> = [];
  const transport = {
    request: async (_method: string, _path: string, options: { _idempotent?: boolean } = {}) => {
      seenOptions.push(options);
      return { status: 200, headers: {}, body: { runId: 'r9', sessionId: 's1', detached: true, status: 'accepted' }, raw: '' } as TransportResponse;
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k' });
  const result = await client.prompt('s1', { message: 'go' });
  assert.equal(result.runId, 'r9');
  assert.equal(seenOptions[0]?._idempotent, true, 'prompt requests must be marked idempotent');
});

test('correction04/3: CLI maps CREATE_UNKNOWN to exit 18 with an outcome:unknown JSON body', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/x'],
    {
      env: {}, stdout: () => {}, stderr: () => {}, randomId: () => 'k',
      client: () => {
        throw Object.assign(new Error('create outcome unknown'), { code: 'CREATE_UNKNOWN', outcome: 'unknown', hint: 'reconcile with status --parent' });
      },
    },
  );
  assert.equal(result.exitCode, 18);
  const parsed = JSON.parse(result.stdout ?? '{}') as { outcome?: string; hint?: string };
  assert.equal(parsed.outcome, 'unknown');
  assert.ok((parsed.hint ?? '').includes('status --parent'));
});

// ─── Item 8: Retry-After is never shortened ──────────────────────────────────

test('correction04/8: the retry waits the FULL requested delay (no early retry)', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const transport = new Transport({
    apiBase: 'http://127.0.0.1:1',
    token: 't',
    retry: { maxAttempts: 3, maxTotalWaitMs: 120_000, sleep: async (ms) => { sleeps.push(ms); } },
  });
  const handler = transport.request.bind(transport);
  (transport as unknown as { requestOnce: unknown }).requestOnce = async () => {
    attempts += 1;
    if (attempts === 1) {
      return { status: 429, headers: { 'retry-after': '30' }, body: { error: 'slow down', code: 'ADMISSION_CAPACITY_EXHAUSTED' }, raw: '' } as TransportResponse;
    }
    return { status: 200, headers: {}, body: { ok: true }, raw: '' } as TransportResponse;
  };
  const response = await handler('GET', '/api/v1/capacity');
  assert.equal(response.status, 200);
  assert.deepEqual(sleeps, [30_000], 'the sleep is exactly the requested 30 s, not a capped shorter value');
});

test('correction04/8: a delay the budget cannot cover returns the refusal with its hint — no early retry', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const transport = new Transport({
    apiBase: 'http://127.0.0.1:1',
    token: 't',
    retry: { maxAttempts: 3, maxTotalWaitMs: 120_000, sleep: async (ms) => { sleeps.push(ms); } },
  });
  const handler = transport.request.bind(transport);
  (transport as unknown as { requestOnce: unknown }).requestOnce = async () => {
    attempts += 1;
    return { status: 503, headers: { 'retry-after': '200' }, body: { error: 'draining', code: 'SERVER_DRAINING' }, raw: '' } as TransportResponse;
  };
  await assert.rejects(
    handler('GET', '/api/v1/capacity'),
    (error: { retryAfterSeconds?: number; status?: number }) => error.status === 503 && error.retryAfterSeconds === 200,
  );
  assert.equal(attempts, 1, 'no retry when the budget cannot cover the requested delay');
  assert.deepEqual(sleeps, [], 'no sleep happened either');
});

// ─── Item 6: status shape on both paths ──────────────────────────────────────

test('correction04/6: status --parent enriches children with busy, goal status and last run', async () => {
  const client = new PiOrchClient({ transportInstance: fakeStatusTransport() as never, randomId: () => 'k' });
  const status = await client.status({ parent: 'p1' });
  const child = status.children[0] as Record<string, unknown>;
  assert.equal(child.busy, false);
  assert.equal(child.goalStatus, 'achieved');
  assert.equal(child.goalObjective, 'Do the thing');
  assert.deepEqual(child.lastRun, { runId: 'run-9', status: 'completed', errorCode: undefined });
});

test('correction04/6: direct status <id> derives busy from session detail', async () => {
  const client = new PiOrchClient({ transportInstance: fakeStatusTransport() as never, randomId: () => 'k' });
  const status = await client.status({ sessionId: 'c1' });
  const child = status.children[0] as Record<string, unknown>;
  assert.equal(child.busy, true, 'busy comes from the session detail');
});

function fakeStatusTransport(): Record<string, unknown> {
  return {
    request: async (method: string, path: string) => {
      if (path === '/api/v1/sessions?parent=p1') {
        return ok({ sessions: [{ sessionId: 'c1', runtime: 'pi', busy: false, status: 'idle' }] });
      }
      if (path === '/api/v1/sessions/c1') {
        return ok({ sessionId: 'c1', busy: true, status: 'running' });
      }
      if (path.endsWith('/goal')) {
        return ok({ sessionId: 'c1', supported: true, status: 'achieved', objective: 'Do the thing' });
      }
      if (path.endsWith('/evidence')) {
        return ok({ sessionId: 'c1', status: 'idle', runChronology: [{ runId: 'run-9', status: 'completed', errorCode: null }] });
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

// ─── Item 7: SNAPSHOT_STALE warning + JSON field, not blocking ──────────────

test('correction04/7: a stale snapshot warns on stderr and flags the JSON, without blocking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-c04-'));
  try {
    const stale = join(dir, 'stale.json');
    const base = JSON.parse(readFileSyncStr(join(process.cwd(), 'contract', 'internal-api-client-snapshot.json'), 'utf8'));
    writeFileSync(stale, JSON.stringify({ ...base, contractVersion: '9.9.9' }));
    const stderrLines: string[] = [];
    const result = await runCli(
      ['capabilities', '--json', '--snapshot', stale],
      staleCliDeps(stderrLines, '1.57.0'),
    );
    assert.equal(result.exitCode, 0, 'not blocked');
    assert.ok(stderrLines.join('\n').includes('SNAPSHOT_STALE'), 'stderr carries the warning');
    const parsed = JSON.parse(result.stdout ?? '{}') as { snapshot?: { stale?: boolean } };
    assert.equal(parsed.snapshot?.stale, true, 'JSON carries the stale flag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('correction04/7: a matching snapshot produces no warning and stale:false', async () => {
  const stderrLines: string[] = [];
  const result = await runCli(
    ['capabilities', '--json'],
    staleCliDeps(stderrLines, '1.57.0'),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(stderrLines.join('\n').includes('SNAPSHOT_STALE'), false);
  const parsed = JSON.parse(result.stdout ?? '{}') as { snapshot?: { stale?: boolean } };
  assert.equal(parsed.snapshot?.stale, false);
});

import { readFileSync as readFileSyncStr } from 'node:fs';

function staleCliDeps(stderrLines: string[], serverVersion: string) {
  return {
    env: { PI_WEB_UI_SOCKET: '/tmp/none.sock', PI_WEB_UI_TOKEN_PATH: '/tmp/none-token' },
    stdout: () => undefined,
    stderr: (line: string) => stderrLines.push(line),
    randomId: () => 'k',
    client: () => ({
      async capabilities() {
        return { contract: { name: 'pi-web-ui-internal-api', contractVersion: serverVersion } };
      },
    }) as never,
  };
}

// ─── every new outcome has an exit code ──────────────────────────────────────

test('correction04: new outcome kinds are exhaustively mapped', () => {
  const kinds = ['goal_cleared', 'watch_conflict'] as const;
  for (const kind of kinds) {
    assert.ok(exitCodeFor({ kind }) >= 0, `${kind} has an exit code`);
  }
});
