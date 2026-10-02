import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PiOrchClient } from '../src/client.ts';
import { ApiError } from '../src/parsers.ts';
import { RouteLimitError, RouteLimitWaitDeadlineError, RouteLimitsConfigError } from '../src/route-limits.ts';
import type { TransportResponse } from '../src/transport.ts';

/**
 * G1: the per-route gate in the client, exercised against a fake in-process
 * server (the house style: no network, injectable transport). The fake server
 * answers the reads the gate needs — sessions list (?parent= and unfiltered),
 * session detail, goal projection, run evidence, watch registration and the
 * watches long poll — and records every request so a test can assert that a
 * refusal happened BEFORE any child was created.
 *
 * Liveness fixture vocabulary (server truth): busy on the list/detail, goal
 * projection status, newest receipt status in evidence.runChronology.
 */

interface FakeChild {
  sessionId: string;
  model?: string;
  busy?: boolean;
  goalStatus?: string;
  lastRunStatus?: string;
}

interface RecordedCall {
  method: string;
  path: string;
  options?: { body?: Record<string, unknown> };
}

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

function notFound(): TransportResponse {
  // The real transport throws ApiError on >= 400; the fake matches that.
  throw new ApiError(404, 'SESSION_NOT_FOUND', 'not found');
}

const throwsNotFound = (): never => {
  throw notFound();
};

const watchesWaitFired = (watchId: string, sessionId: string): TransportResponse =>
  ok({
    fired: true,
    nextCursor: 'c2',
    waitedMs: 5,
    watches: [
      {
        watchId,
        sessionId,
        firingCount: 1,
        firings: [{ conditionId: 'cond-1', firedAt: Date.now(), eventType: 'agent_end' }],
      },
    ],
  });

function fakeTransport(options: {
  /** Children visible through GET /sessions?parent=… (identity counting). */
  children?: FakeChild[];
  /** Children visible through the unfiltered GET /sessions (owner counting). */
  all?: FakeChild[];
  longPoll?: () => Promise<{ fired: boolean }>;
}) {
  const calls: Array<RecordedCall> = [];
  const pool = (): FakeChild[] => [...(options.children ?? []), ...(options.all ?? [])];
  const child = (sessionId: string): FakeChild | undefined => pool().find((entry) => entry.sessionId === sessionId);
  const shape = (entry: FakeChild) => ({
    sessionId: entry.sessionId,
    sessionPath: `/p/${entry.sessionId}`,
    runtime: 'pi',
    cwd: '/tmp/x',
    model: entry.model,
    status: entry.busy ? 'running' : 'idle',
    busy: entry.busy ?? false,
    messageCount: 1,
    firstMessage: 'x',
    createdAt: '2026-09-30T00:00:00Z',
    lastActivity: '2026-09-30T00:00:00Z',
  });
  let watchCounter = 0;
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      calls.push({ method, path, options: options_ });
      if (method === 'POST' && path === '/api/v1/sessions') {
        const body = (options_.body ?? {}) as Record<string, unknown>;
        return ok({ sessionId: `new-${calls.length}`, ...body });
      }
      if (method === 'GET' && (path === '/api/v1/sessions' || path.startsWith('/api/v1/sessions?'))) {
        const url = new URL(`http://x${path}`);
        const parent = url.searchParams.get('parent');
        const source = parent !== null ? (options.children ?? []) : (options.all ?? options.children ?? []);
        return ok({ sessions: source.map(shape) });
      }
      const detail = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (method === 'GET' && detail) {
        const entry = child(decodeURIComponent(detail[1] as string));
        return entry ? ok(shape(entry)) : throwsNotFound();
      }
      const goal = path.match(/^\/api\/v1\/sessions\/([^/]+)\/goal$/);
      if (method === 'GET' && goal) {
        const entry = child(decodeURIComponent(goal[1] as string));
        return ok({ supported: true, status: entry?.goalStatus ?? 'idle' });
      }
      const evidence = path.match(/^\/api\/v1\/sessions\/([^/]+)\/evidence$/);
      if (method === 'GET' && evidence) {
        const entry = child(decodeURIComponent(evidence[1] as string));
        return ok({
          runChronology: entry?.lastRunStatus
            ? [{ runId: `r-${entry.sessionId}`, status: entry.lastRunStatus }]
            : [],
        });
      }
      if (method === 'POST' && path.endsWith('/prompt')) {
        return ok({ runId: `run-${calls.length}`, sessionId: 's', detached: true, status: 'accepted' });
      }
      if (method === 'GET' && path.endsWith('/watch')) {
        // 04-correction A3: a registered watch carries a generation, and GET
        // returns it — the guarded slot-wait cleanup needs the generation.
        if (watchCounter === 0) return throwsNotFound();
        return ok({ watchId: `w-${watchCounter}`, status: 'active', generation: `g-${watchCounter}` });
      }
      if (method === 'POST' && path.endsWith('/watch')) {
        watchCounter += 1;
        return ok({ watchId: `w-${watchCounter}`, status: 'active', generation: `g-${watchCounter}` });
      }
      if (method === 'GET' && path.startsWith('/api/v1/watches/wait')) {
        const result = options.longPoll ? await options.longPoll() : { fired: false };
        if (result.fired) return watchesWaitFired('w-1', 'c1');
        return { status: 204, headers: {}, body: undefined, raw: '' };
      }
      return ok({});
    },
  } as never;
  return { transport, calls };
}

function gateClient(transport: never, config: Record<string, unknown> = {}): PiOrchClient {
  return new PiOrchClient({
    transportInstance: transport,
    randomId: () => 'k1',
    templateFollowUpCheckDelayMs: 1,
    ...config,
  });
}

const ZAI = 'zai/glm-5.3-flash';
const DEEPSEEK = 'commandcode/deepseek/deepseek-v4.1-flash';

function tmpLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'piorch-g1-')), 'spawn-ledger.json');
}

const created = (calls: Array<RecordedCall>): number =>
  calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/sessions').length;
const dispatched = (calls: Array<RecordedCall>): number =>
  calls.filter((call) => call.method === 'POST' && call.path.endsWith('/prompt')).length;

// ── spawn gate ───────────────────────────────────────────────────────────────

test('spawn under the limit proceeds and creates the child (identity counting)', async () => {
  const { transport, calls } = fakeTransport({ children: [{ sessionId: 'c1', model: ZAI, busy: true }] });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 2 } });
  const result = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  assert.ok(result.sessionId.startsWith('new-'));
  assert.equal(created(calls), 1);
});

test('spawn at the limit refuses BEFORE creating anything, naming the live children', async () => {
  const { transport, calls } = fakeTransport({
    children: [
      { sessionId: 'c1', model: ZAI, busy: true },
      { sessionId: 'c2', model: ZAI, lastRunStatus: 'started' },
    ],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 2 } });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.code, 'ROUTE_LIMIT_EXCEEDED');
      assert.equal(error.route, ZAI);
      assert.equal(error.limit, 2);
      assert.deepEqual(error.live.map((entry) => entry.sessionId).sort(), ['c1', 'c2']);
      assert.match(error.message, /c1/);
      assert.match(error.message, /c2/);
      return true;
    },
  );
  assert.equal(created(calls), 0, 'no create happened');
});

test('finished idle children do not count (busy=false, completed receipt, no active goal)', async () => {
  const { transport, calls } = fakeTransport({
    children: [
      { sessionId: 'c1', model: ZAI, busy: false, lastRunStatus: 'completed' },
      { sessionId: 'c2', model: ZAI, busy: false, lastRunStatus: 'failed' },
    ],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 2 } });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  assert.equal(created(calls), 1);
});

test('a goal running child counts as live even when not busy', async () => {
  const { transport } = fakeTransport({
    children: [{ sessionId: 'c1', model: ZAI, busy: false, goalStatus: 'running' }],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await assert.rejects(client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI }), RouteLimitError);
});

test('a goal wrapping_up child counts as live', async () => {
  const { transport } = fakeTransport({
    children: [{ sessionId: 'c1', model: ZAI, busy: false, goalStatus: 'wrapping_up' }],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await assert.rejects(client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI }), RouteLimitError);
});

test('mixed routes: a full limited route does not block another route', async () => {
  const { transport, calls } = fakeTransport({
    children: [
      { sessionId: 'c1', model: ZAI, busy: true },
      { sessionId: 'c2', model: ZAI, busy: true },
    ],
  });
  const client = gateClient(transport, {
    parentSessionId: 'parent-1',
    routeLimits: { [ZAI]: 2, [DEEPSEEK]: 5 },
  });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: DEEPSEEK });
  assert.equal(created(calls), 1);
});

test('a per-call routeLimit wins over the configured map', async () => {
  const { transport } = fakeTransport({
    children: [{ sessionId: 'c1', model: ZAI, busy: true }],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 5 } });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, routeLimit: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.limit, 1);
      return true;
    },
  );
});

test('a per-call routeLimit of 0 lifts the cap for this call', async () => {
  const { transport, calls } = fakeTransport({
    children: [
      { sessionId: 'c1', model: ZAI, busy: true },
      { sessionId: 'c2', model: ZAI, busy: true },
    ],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 2 } });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, routeLimit: 0 });
  assert.equal(created(calls), 1);
});

test('correction01/6: a negative, fractional or NaN per-call routeLimit is a usage-class error', async () => {
  const { transport, calls } = fakeTransport({ children: [{ sessionId: 'c1', model: ZAI, busy: true }] });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 5 } });
  for (const bad of [-1, 1.5, Number.NaN]) {
    await assert.rejects(
      client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, routeLimit: bad }),
      (error: unknown) => {
        assert.ok(error instanceof RouteLimitsConfigError, `routeLimit ${bad} must be rejected`);
        assert.match((error as Error).message, /route-limit|limit/);
        return true;
      },
    );
  }
  assert.equal(created(calls), 0, 'nothing was created');
});

test('children without a model on record are not counted against a route', async () => {
  const { transport, calls } = fakeTransport({
    children: [{ sessionId: 'c1', busy: true }],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  assert.equal(created(calls), 1);
});

// ── wait-for-slot ────────────────────────────────────────────────────────────

test('wait-for-slot: spawns after a watched child settles, without polling or sleeping', async () => {
  let live = true;
  let longPolls = 0;
  const fluctuating: FakeChild = { sessionId: 'c1', model: ZAI };
  const { transport, calls } = fakeTransport({
    children: [fluctuating],
    longPoll: async () => {
      longPolls += 1;
      live = false; // the child settles while we wait
      return { fired: true };
    },
  });
  // `live` flips only inside longPoll; expose it through the fixture getters.
  Object.defineProperties(fluctuating, {
    busy: { get: () => live },
    lastRunStatus: { get: () => (live ? 'started' : 'completed') },
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  const result = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, waitForSlotMs: 60_000 });
  assert.ok(result.sessionId.startsWith('new-'));
  assert.ok(longPolls >= 1, 'the slot came from the watch-based wait');
  assert.equal(created(calls), 1);
});

test('wait-for-slot: exits with the deadline error when nothing settles in time', async () => {
  const { transport, calls } = fakeTransport({
    children: [{ sessionId: 'c1', model: ZAI, busy: true }],
    longPoll: async () => ({ fired: false }),
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, waitForSlotMs: 40 }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitWaitDeadlineError);
      assert.equal(error.code, 'ROUTE_LIMIT_WAIT_DEADLINE');
      assert.equal(error.route, ZAI);
      return true;
    },
  );
  assert.equal(created(calls), 0, 'never created');
});

test('wait-for-slot: leaves no leftover watch on the children it watched (the parent must be able to wait on them next)', async () => {
  // Live-found (G1 proof, 2026-09-30): the slot-wait registered agent_end+
  // deadline watches on BOTH busy children; the winner's watch fired, the
  // loser's lingered, and the parent's own later wait on the loser hit
  // WATCH_CONFLICT (exit 19) — the client never replaces foreign-shaped
  // watches. The slot-wait must clean up the watches it created itself.
  let live = true;
  const fluctuating: FakeChild = { sessionId: 'c1', model: ZAI };
  const { transport, calls } = fakeTransport({
    children: [fluctuating],
    longPoll: async () => {
      live = false;
      return { fired: true };
    },
  });
  Object.defineProperties(fluctuating, {
    busy: { get: () => live },
    lastRunStatus: { get: () => (live ? 'started' : 'completed') },
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, waitForSlotMs: 60_000 });
  assert.equal(created(calls), 1);
  const watchDeletes = calls.filter((call) => call.method === 'DELETE' && call.path.endsWith('/watch'));
  assert.ok(watchDeletes.length >= 1, 'the slot-wait deleted the watch it created on the settled child');
  // 04-correction A3: the internal cleanup deletes CONDITIONALLY.
  assert.deepEqual(watchDeletes[0]?.options?.body, { expectedGeneration: 'g-1' }, 'the slot-wait sends the generation it registered');
});

test('wait-for-slot: never deletes a pre-existing watch; refuses when nothing is watchable', async () => {
  let live = true;
  const fluctuating: FakeChild = { sessionId: 'c1', model: ZAI };
  let watchState: Record<string, unknown> | null = { watchId: 'w-pre', status: 'active', conditions: [] };
  const { transport } = fakeTransport({
    children: [fluctuating],
    longPoll: async () => {
      live = false;
      return { fired: true };
    },
  });
  Object.defineProperties(fluctuating, {
    busy: { get: () => live },
    lastRunStatus: { get: () => (live ? 'started' : 'completed') },
  });
  const raw = transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> };
  const inner = raw.request.bind(raw);
  (raw as { request: unknown }).request = async (method: string, path: string, options?: { body?: Record<string, unknown> }) => {
    if (method === 'GET' && path.endsWith('/watch')) return ok(watchState as never);
    if (method === 'DELETE' && path.endsWith('/watch')) {
      throw new Error('pre-existing watch must not be deleted');
    }
    return inner(method, path, options);
  };
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  // The only live child has an incompatible (foreign) watch: there is nothing
  // watchable to wait on, so the client refuses instead of waiting out the
  // clock — and the pre-existing watch survives untouched.
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, waitForSlotMs: 60_000 }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.code, 'ROUTE_LIMIT_EXCEEDED');
      return true;
    },
  );
  assert.ok(watchState !== null, 'the pre-existing watch survives the slot wait');
});

// ── identity: warn once and proceed ──────────────────────────────────────────

test('no identity and no owner: warns once and proceeds unlimited', async () => {
  const warnings: string[] = [];
  const { transport, calls } = fakeTransport({ all: [{ sessionId: 'c1', model: ZAI, busy: true }] });
  const client = gateClient(transport, {
    routeLimits: { [ZAI]: 1 },
    spawnLedgerPath: tmpLedger(),
    onWarn: (line: string) => warnings.push(line),
  });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  assert.equal(warnings.length, 1, 'warned once, not per spawn');
  assert.match(warnings[0] ?? '', /ROUTE_LIMIT_UNCOUNTED/);
  assert.match(warnings[0] ?? '', /--parent-session/);
  assert.equal(created(calls), 2);
});

test('an unresolvable parent (404 on the list) warns once and proceeds', async () => {
  const warnings: string[] = [];
  const inner = fakeTransport({ children: [] });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      if (method === 'GET' && path.startsWith('/api/v1/sessions?')) {
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'Parent session not found: nope');
      }
      return (inner.transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> }).request(method, path, options_);
    },
  } as never;
  const client = gateClient(transport, {
    parentSessionId: 'nope',
    routeLimits: { [ZAI]: 1 },
    onWarn: (line: string) => warnings.push(line),
  });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /ROUTE_LIMIT_UNCOUNTED/);
});

// ── owner counting via the spawn ledger (bare CLI) ───────────────────────────

test('bare CLI: counts live children of the same --owner through the spawn ledger', async () => {
  const ledger = tmpLedger();
  const { transport } = fakeTransport({
    all: [],
  });
  const client = gateClient(transport, {
    routeLimits: { [ZAI]: 1 },
    spawnLedgerPath: ledger,
  });
  // First spawn records the ledger entry (owner o1) — nothing live yet, so it proceeds.
  const first = await client.spawn({
    runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI,
    retention: { mode: 'durable', ownerId: 'o1' },
  });
  assert.ok(first.sessionId.startsWith('new-'));
  const onDisk = JSON.parse(readFileSync(ledger, 'utf8')) as Array<{ sessionId: string; ownerId?: string; route?: string }>;
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0]?.ownerId, 'o1');
  assert.equal(onDisk[0]?.route, ZAI);

  // The ledger entry's child is busy on the server → the next spawn of the same owner refuses.
  const { transport: transport2 } = fakeTransport({
    all: [{ sessionId: first.sessionId, model: ZAI, busy: true }],
  });
  const client2 = gateClient(transport2, { routeLimits: { [ZAI]: 1 }, spawnLedgerPath: ledger });
  await assert.rejects(
    client2.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'o1' } }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.deepEqual(error.live.map((entry) => entry.sessionId), [first.sessionId]);
      return true;
    },
  );
});

test('bare CLI: a ledger entry whose session is gone no longer counts and is pruned', async () => {
  const ledger = tmpLedger();
  const { transport } = fakeTransport({ all: [] });
  const client = gateClient(transport, { routeLimits: { [ZAI]: 1 }, spawnLedgerPath: ledger });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'o1' } });
  // The server list is empty (session deleted elsewhere): the stale entry must not count…
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'o1' } });
  // …and the read prunes it from the ledger, keeping only the still-registered child.
  const onDisk = JSON.parse(readFileSync(ledger, 'utf8')) as Array<unknown>;
  assert.equal(onDisk.length, 1);
});

// ── prompt gate ──────────────────────────────────────────────────────────────

test('prompt to an idle child on a full limited route refuses (it would start a new turn)', async () => {
  const { transport, calls } = fakeTransport({
    children: [{ sessionId: 'busy1', model: ZAI, busy: true }],
    all: [
      { sessionId: 'busy1', model: ZAI, busy: true },
      { sessionId: 'target', model: ZAI, busy: false, lastRunStatus: 'completed' },
    ],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await assert.rejects(
    client.prompt('target', { message: 'go' }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.route, ZAI);
      return true;
    },
  );
  assert.equal(dispatched(calls), 0, 'no dispatch happened');
});

test('prompt to a live child on a full route proceeds (no extra concurrency)', async () => {
  const { transport, calls } = fakeTransport({
    all: [{ sessionId: 'target', model: ZAI, busy: true }],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await client.prompt('target', { message: 'go', mode: 'follow_up' });
  assert.equal(dispatched(calls), 1);
});

test('prompt under the limit proceeds', async () => {
  const { transport, calls } = fakeTransport({
    all: [{ sessionId: 'target', model: ZAI, busy: false, lastRunStatus: 'completed' }],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await client.prompt('target', { message: 'go' });
  assert.equal(dispatched(calls), 1);
});

test('prompt on an unlimited route never gates', async () => {
  const { transport, calls } = fakeTransport({
    all: [{ sessionId: 'target', model: DEEPSEEK, busy: false, lastRunStatus: 'completed' }],
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await client.prompt('target', { message: 'go' });
  assert.equal(dispatched(calls), 1);
});

// ── correction 01 ────────────────────────────────────────────────────────────

function waitForLockFile(dir: string, timeoutMs = 2000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      try {
        const entries = readdirSync(dir).filter((name) => name.endsWith('.lock'));
        if (entries.length > 0) return resolve(join(dir, entries[0] as string));
      } catch { /* dir not created yet */ }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('correction01/1: a concurrent pair at cap 1 creates exactly one (count→create serialised per caller+route)', async () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'piorch-lock-'));
  const calls: Array<RecordedCall> = [];
  const created: string[] = [];
  let releaseA: (() => void) | undefined;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const children: FakeChild[] = [];
  const base = fakeTransport({ children });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      calls.push({ method, path, options: options_ });
      if (method === 'POST' && path === '/api/v1/sessions') {
        const sessionId = `c-${created.length + 1}`;
        await gateA; // A's create POST holds the route lock while we hold the test
        created.push(sessionId);
        children.push({ sessionId, model: ZAI, busy: true });
        return ok({ sessionId });
      }
      return (base.transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> }).request(method, path, options_);
    },
  } as never;
  const config = { parentSessionId: 'parent-race', routeLimits: { [ZAI]: 1 }, spawnLockDir: lockDir };
  const clientA = gateClient(transport, config);
  const clientB = gateClient(transport, config);

  const spawnA = clientA.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  const lockFile = await waitForLockFile(lockDir);
  assert.ok(lockFile, 'A holds an exclusive route lock across count→create');

  // While A holds the lock, B cannot even COUNT — it must wait, not race.
  const spawnB = clientB.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  await assert.rejects(spawnB, (error: unknown) => {
      assert.match((error as Error).message, /route lock|lock/i);
      assert.equal((error as { code?: string }).code, 'ROUTE_LOCK_TIMEOUT');
      return true;
    });
  assert.equal(created.length, 0, 'B created nothing while A held the lock');

  releaseA?.();
  const resultA = await spawnA;
  assert.ok(resultA.sessionId.startsWith('c-'));
  assert.equal(created.length, 1, 'exactly one create so far');

  // Now B acquires the freed lock, counts A's busy child, and is refused.
  await assert.rejects(
    clientB.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI }),
    (error: unknown) => error instanceof RouteLimitError,
  );
  assert.equal(created.length, 1, 'the pair created exactly one child');
});

test('correction01/2: an unreadable goal/evidence read counts the child as live (fail closed, reason unknown)', async () => {
  const inner = fakeTransport({ children: [{ sessionId: 'c1', model: ZAI, busy: false }] });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      if (path.endsWith('/goal') || path.endsWith('/evidence')) {
        throw new ApiError(503, 'SERVER_BUSY', 'goal/evidence read failing');
      }
      return (inner.transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> }).request(method, path, options_);
    },
  } as never;
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.deepEqual(error.live, [{ sessionId: 'c1', reason: 'unknown' }]);
      assert.match(error.message, /unknown/);
      return true;
    },
  );
});

test('correction01/3a: wait-for-slot re-counts when a live child has vanished (session_not_found), instead of refusing', async () => {
  let listReads = 0;
  const inner = fakeTransport({ children: [{ sessionId: 'c1', model: ZAI, busy: true }] });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      if (method === 'GET' && path.startsWith('/api/v1/sessions?')) {
        listReads += 1;
        // The registry list is eventually consistent: it keeps reporting the
        // vanished child for the first two counts, then drops it.
        return ok(listReads <= 2 ? { sessions: [{ sessionId: 'c1', model: ZAI, busy: true }] } : { sessions: [] });
      }
      if (method === 'GET' && path === '/api/v1/sessions/c1') {
        // vanished from the registry: every detail read 404s → session_not_found from the wait
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'no session c1 in the registry');
      }
      return (inner.transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> }).request(method, path, options_);
    },
  } as never;
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  const result = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, waitForSlotMs: 30_000 });
  assert.ok(result.sessionId.startsWith('new-'));
  assert.ok(listReads >= 3, 'the wait re-counted instead of refusing');
});

test('correction01/3b: wait-for-slot waits on the watchable children when others hold foreign watches', async () => {
  let live = true;
  const watched: FakeChild = { sessionId: 'c1', model: ZAI, busy: true }; // foreign watch below
  const settleable: FakeChild = { sessionId: 'c2', model: ZAI };
  let longPolls = 0;
  const { transport, calls } = fakeTransport({
    children: [watched, settleable],
    longPoll: async () => {
      longPolls += 1;
      live = false;
      return { fired: true };
    },
  });
  Object.defineProperties(settleable, {
    busy: { get: () => live },
    lastRunStatus: { get: () => (live ? 'started' : 'completed') },
  });
  const raw = transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> };
  const inner = raw.request.bind(raw);
  const watchRegistrations: string[] = [];
  (raw as { request: unknown }).request = async (method: string, path: string, options?: { body?: Record<string, unknown> }) => {
    if (method === 'GET' && path === '/api/v1/sessions/c1/watch') {
      // c1 carries a foreign active watch (different conditions, no label)
      return ok({ watchId: 'w-foreign', status: 'active', conditions: [{ id: 'x', type: 'text', contains: 'foreign' }] } as never);
    }
    if (method === 'POST' && path.endsWith('/watch')) watchRegistrations.push(path);
    return inner(method, path, options);
  };
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 2 } });
  const result = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, waitForSlotMs: 60_000 });
  assert.ok(result.sessionId.startsWith('new-'));
  assert.equal(watchRegistrations.some((p) => p.includes('/c1/')), false, 'the foreign-watched child was not registered');
  assert.equal(watchRegistrations.some((p) => p.includes('/c2/')), true, 'the watchable child was waited on');
  void calls;
});

test('correction01/4: the bare-CLI prompt gate counts the target owner from the ledger (and honours an explicit routeOwner)', async () => {
  const ledger = tmpLedger();
  writeFileSync(ledger, `${JSON.stringify([
    { sessionId: 'busy1', route: ZAI, ownerId: 'o1', at: '2026-09-30T00:00:00Z' },
    { sessionId: 'target', route: ZAI, ownerId: 'o1', at: '2026-09-30T00:00:00Z' },
  ], null, 1)}\n`);
  const { transport, calls } = fakeTransport({
    all: [
      { sessionId: 'busy1', model: ZAI, busy: true },
      { sessionId: 'target', model: ZAI, busy: false, lastRunStatus: 'completed' },
    ],
  });
  const client = gateClient(transport, { routeLimits: { [ZAI]: 1 }, spawnLedgerPath: ledger });
  await assert.rejects(
    client.prompt('target', { message: 'go' }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.deepEqual(error.live.map((entry) => entry.sessionId), ['busy1']);
      return true;
    },
  );
  assert.equal(dispatched(calls), 0);
  // A different explicit owner has no live children on the route: proceeds.
  await client.prompt('target', { message: 'go', routeOwner: 'someone-else' });
  assert.equal(dispatched(calls), 1);
});

test('correction01/5: a stale identity (404 parent) falls back to the owner ledger when an owner is available', async () => {
  const ledger = tmpLedger();
  writeFileSync(ledger, `${JSON.stringify([{ sessionId: 's1', route: ZAI, ownerId: 'o1', at: '2026-09-30T00:00:00Z' }], null, 1)}\n`);
  const inner = fakeTransport({ all: [{ sessionId: 's1', model: ZAI, busy: true }] });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      if (method === 'GET' && path.startsWith('/api/v1/sessions?')) {
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'Parent session not found: stale-id');
      }
      return (inner.transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> }).request(method, path, options_);
    },
  } as never;
  const client = gateClient(transport, {
    parentSessionId: 'stale-id',
    routeLimits: { [ZAI]: 1 },
    spawnLedgerPath: ledger,
  });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'o1' } }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.deepEqual(error.live.map((entry) => entry.sessionId), ['s1']);
      return true;
    },
  );
});

test('correction01/8: caps configured + a selector-less spawn warns once that it is not counted', async () => {
  const warnings: string[] = [];
  const { transport, calls } = fakeTransport({ children: [] });
  const client = gateClient(transport, {
    parentSessionId: 'parent-1',
    routeLimits: { [ZAI]: 2 },
    onWarn: (line: string) => warnings.push(line),
  });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' }); // no model selector
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  assert.equal(created(calls), 2);
  assert.equal(warnings.length, 1, 'warned once, not per spawn');
  assert.match(warnings[0] ?? '', /--model-selector/);
  assert.match(warnings[0] ?? '', /not counted/);
});

// ── correction 03 ──────────────────────────────────────────────────────────

test('correction03/2: repeated sequential spawns after the 404 fallback at cap 1 create exactly one (owner ledger records + owner-scope lock)', async () => {
  const ledger = tmpLedger();
  const inner = fakeTransport({ children: [] });
  const created: FakeChild[] = [];
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      if (method === 'GET' && path.startsWith('/api/v1/sessions?')) {
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'Parent session not found: stale-id');
      }
      if (method === 'POST' && path === '/api/v1/sessions') {
        const sessionId = `c-${created.length + 1}`;
        created.push({ sessionId, model: ZAI, busy: true });
        return ok({ sessionId });
      }
      if (method === 'GET' && (path === '/api/v1/sessions' || path.startsWith('/api/v1/sessions?'))) {
        return ok({ sessions: created.map((entry) => ({ sessionId: entry.sessionId, model: entry.model, busy: true })) });
      }
      return (inner.transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> }).request(method, path, options_);
    },
  } as never;
  const client = gateClient(transport, {
    parentSessionId: 'stale-id',
    routeLimits: { [ZAI]: 1 },
    spawnLedgerPath: ledger,
    spawnLockDir: join(ledger, '..', 'locks'),
  });
  const first = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'o1' } });
  assert.ok(first.sessionId.startsWith('c-'));
  // The create must be recorded in the owner's ledger (the effective counting domain).
  const onDisk = JSON.parse(readFileSync(ledger, 'utf8')) as Array<{ sessionId: string; ownerId?: string }>;
  assert.equal(onDisk.length, 1, 'the fallback create is recorded in the owner ledger');
  assert.equal(onDisk[0]?.ownerId, 'o1');
  // Second sequential spawn: the owner count now sees the first child → refused.
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'o1' } }),
    (error: unknown) => error instanceof RouteLimitError,
  );
  assert.equal(created.length, 1, 'exactly one create across the repeated fallback spawns');
});

test('correction03/3: the prompt gate fails closed on unknown target liveness (counts siblings, refuses over the cap)', async () => {
  const inner = fakeTransport({
    children: [{ sessionId: 'busy1', model: ZAI, busy: true }],
    all: [
      { sessionId: 'busy1', model: ZAI, busy: true },
      { sessionId: 'target', model: ZAI, busy: false },
    ],
  });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      if (path === '/api/v1/sessions/target/goal' || path === '/api/v1/sessions/target/evidence') {
        throw new ApiError(503, 'SERVER_BUSY', 'projection read failing');
      }
      return (inner.transport as { request: (m: string, p: string, o?: { body?: Record<string, unknown> }) => Promise<TransportResponse> }).request(method, path, options_);
    },
  } as never;
  const client = gateClient(transport, { parentSessionId: 'parent-1', routeLimits: { [ZAI]: 1 } });
  await assert.rejects(
    client.prompt('target', { message: 'go' }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.deepEqual(error.live.map((entry) => entry.sessionId), ['busy1']);
      return true;
    },
  );
});
