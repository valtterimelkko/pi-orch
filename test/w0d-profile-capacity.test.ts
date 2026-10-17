import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PiOrchClient } from '../src/client.ts';
import { ApiError } from '../src/parsers.ts';
import { runCli, type CliDeps } from '../src/cli.ts';
import { ERROR_CODE_EXIT_CODES, nameFor } from '../src/exit-codes.ts';
import {
  CLAUDE_PAYG_OVERFLOW_HINT,
  RouteLimitError,
  advertisedProfileCapacity,
  advertisedProfileCapacities,
  profileCapacityFull,
  profileIdOfSelector,
} from '../src/route-limits.ts';
import { Transport, type TransportResponse } from '../src/transport.ts';

/**
 * W0d (plan W0-d, finding F8): pi-orch's per-route limit defaults to the
 * SERVER-ADVERTISED Claude profile cap (contract 1.61.0), so a parent learns
 * about the cap from pi-orch before it ever fails a child:
 *
 * - `GET /capacity` `claudeProfiles: [{ profileId, maxConcurrent, active }]`
 *   (absent on older servers) is the source;
 * - on a `profile:<id>` route under runtime `claude` with no explicit limit,
 *   the SERVER's own numbers decide (correction 01): refuse a new turn iff
 *   `active >= maxConcurrent` — `active` already includes this parent's live
 *   turns, so the local count is never added to it or compared against it
 *   (it is listed in the refusal for context only);
 * - an explicit limit (per-call flag, PI_ORCH_ROUTE_LIMITS) still wins and keeps
 *   the local-count semantics, including an explicit 0 = unlimited;
 * - a server that does not advertise keeps today's behaviour (no default cap);
 * - the exit-25 refusal names the profile, maxConcurrent and active, and for a
 *   Claude profile prints the owner-authorisation (PAYG overflow) hint;
 * - a server `429 PROFILE_CAPACITY_EXHAUSTED` maps to the same exit 25 with the
 *   same hint (no run exists).
 *
 * Fake in-process server, injectable transport — the house style: no network,
 * no real server, nothing outside temp dirs.
 */

const PROFILE_ID = 'claude-sonnet';
const PROFILE_SELECTOR = `profile:${PROFILE_ID}`;

interface FakeChild {
  sessionId: string;
  modelSelector?: string;
  model?: string;
  runtime?: string;
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

function fakeTransport(options: {
  children?: FakeChild[];
  all?: FakeChild[];
  /** GET /api/v1/capacity body (contract 1.61.0 shape when claudeProfiles is set). */
  capacity?: unknown;
  /** Make the capacity read fail (server busy). */
  capacityThrows?: boolean;
  /** Long-poll hook, so a test can prove a watch wait did NOT happen. */
  longPoll?: () => Promise<{ fired: boolean }>;
}) {
  const calls: Array<RecordedCall> = [];
  const pool = (): FakeChild[] => [...(options.children ?? []), ...(options.all ?? [])];
  const child = (sessionId: string): FakeChild | undefined => pool().find((entry) => entry.sessionId === sessionId);
  const shape = (entry: FakeChild) => ({
    sessionId: entry.sessionId,
    sessionPath: `/p/${entry.sessionId}`,
    runtime: entry.runtime ?? 'claude',
    cwd: '/tmp/x',
    model: entry.model ?? entry.modelSelector,
    modelSelector: entry.modelSelector ?? entry.model,
    status: entry.busy ? 'running' : 'idle',
    busy: entry.busy ?? false,
    messageCount: 1,
    firstMessage: 'x',
    createdAt: '2026-10-13T00:00:00Z',
    lastActivity: '2026-10-13T00:00:00Z',
  });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown> } = {}): Promise<TransportResponse> => {
      calls.push({ method, path, options: options_ });
      if (method === 'GET' && path === '/api/v1/capacity') {
        if (options.capacityThrows) throw new ApiError(503, 'SERVER_BUSY', 'capacity read failing');
        return ok(options.capacity ?? {});
      }
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
        if (!entry) throw new ApiError(404, 'SESSION_NOT_FOUND', 'not found');
        return ok(shape(entry));
      }
      const goal = path.match(/^\/api\/v1\/sessions\/([^/]+)\/goal$/);
      if (method === 'GET' && goal) {
        const entry = child(decodeURIComponent(goal[1] as string));
        return ok({ supported: true, status: entry?.goalStatus ?? 'idle' });
      }
      const evidence = path.match(/^\/api\/v1\/sessions\/([^/]+)\/evidence$/);
      if (method === 'GET' && evidence) {
        const entry = child(decodeURIComponent(evidence[1] as string));
        return ok({ runChronology: entry?.lastRunStatus ? [{ runId: `r-${entry.sessionId}`, status: entry.lastRunStatus }] : [] });
      }
      if (method === 'GET' && path.startsWith('/api/v1/watches/wait')) {
        const result = options.longPoll ? await options.longPoll() : { fired: false };
        if (result.fired) return ok({ fired: true, nextCursor: 'c2', waitedMs: 5, watches: [] });
        return { status: 204, headers: {}, body: undefined, raw: '' };
      }
      if (method === 'POST' && path.endsWith('/prompt')) {
        return ok({ runId: `run-${calls.length}`, sessionId: 's', detached: true, status: 'accepted' });
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
    spawnLedgerPath: join(mkdtempSync(join(tmpdir(), 'piorch-w0d-')), 'ledger.json'),
    ...config,
  });
}

const created = (calls: Array<RecordedCall>): number =>
  calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/sessions').length;
const dispatched = (calls: Array<RecordedCall>): number =>
  calls.filter((call) => call.method === 'POST' && call.path.endsWith('/prompt')).length;

const busyProfileChildren = (count: number): FakeChild[] =>
  Array.from({ length: count }, (_, index) => ({
    sessionId: `c${index + 1}`,
    modelSelector: PROFILE_SELECTOR,
    runtime: 'claude',
    busy: true,
  }));

const capacityBody = (maxConcurrent: number, active: number): unknown => ({
  claudeProfiles: [{ profileId: PROFILE_ID, maxConcurrent, active }],
});

// ── pure logic (src/route-limits.ts) ─────────────────────────────────────────

test('W0d/1: profileIdOfSelector reads the profile:<id> selector form only', () => {
  assert.equal(profileIdOfSelector(PROFILE_SELECTOR), PROFILE_ID);
  assert.equal(profileIdOfSelector('profile:'), undefined);
  assert.equal(profileIdOfSelector(' zai/glm-5.3-flash '), undefined);
  assert.equal(profileIdOfSelector('opus'), undefined);
  assert.equal(profileIdOfSelector(undefined), undefined);
});

test('W0d/2: advertisedProfileCapacity reads /capacity claudeProfiles (1.61.0) and is undefined on older servers', () => {
  const body = { claudeProfiles: [{ profileId: 'a', maxConcurrent: 8, active: 3 }, { profileId: 'b', maxConcurrent: 2, active: 0 }] };
  assert.deepEqual(advertisedProfileCapacities(body), [
    { profileId: 'a', maxConcurrent: 8, active: 3 },
    { profileId: 'b', maxConcurrent: 2, active: 0 },
  ]);
  assert.deepEqual(advertisedProfileCapacity(body, 'b'), { profileId: 'b', maxConcurrent: 2, active: 0 });
  assert.equal(advertisedProfileCapacity(body, 'missing'), undefined);
  // Older servers (contract < 1.61.0) do not advertise claudeProfiles at all.
  assert.deepEqual(advertisedProfileCapacities({ activeTurns: 1, maxActiveTurns: 4 }), []);
  assert.equal(advertisedProfileCapacity({}, 'a'), undefined);
  assert.equal(advertisedProfileCapacity(undefined, 'a'), undefined);
  // Malformed rows are ignored, never invented.
  assert.deepEqual(advertisedProfileCapacities({ claudeProfiles: [{ profileId: 'x', maxConcurrent: 'many', active: 0 }, { maxConcurrent: 1, active: 0 }] }), []);
});

test('W0d/3: profileCapacityFull is the server\'s own predicate: active >= maxConcurrent', () => {
  assert.equal(profileCapacityFull({ maxConcurrent: 8, active: 0 }), false);
  assert.equal(profileCapacityFull({ maxConcurrent: 8, active: 4 }), false, 'four slots are still free — the local count must not be added to active');
  assert.equal(profileCapacityFull({ maxConcurrent: 8, active: 7 }), false);
  assert.equal(profileCapacityFull({ maxConcurrent: 8, active: 8 }), true);
  assert.equal(profileCapacityFull({ maxConcurrent: 2, active: 5 }), true, 'over the cap is still full');
});

test('W0d/4: the exit-25 message names the profile cap and the PAYG overflow route (Claude profiles only)', () => {
  const error = new RouteLimitError(PROFILE_SELECTOR, 2, [{ sessionId: 'c1', reason: 'busy' }], {
    profileId: PROFILE_ID,
    maxConcurrent: 8,
    active: 6,
  });
  assert.match(error.message, /c1/);
  assert.match(error.message, new RegExp(PROFILE_ID));
  assert.match(error.message, /maxConcurrent 8/);
  assert.match(error.message, /6 active turn/);
  assert.ok(error.message.includes(CLAUDE_PAYG_OVERFLOW_HINT), 'the overflow hint is quoted verbatim');
  assert.match(error.message, /anthropic\/claude-sonnet-5-5/);
  assert.match(error.message, /never automatic/);
  assert.deepEqual(error.profile, { profileId: PROFILE_ID, maxConcurrent: 8, active: 6 });

  // A non-Claude refusal carries no profile line and no overflow hint.
  const plain = new RouteLimitError('zai/glm-5.3-flash', 2, [{ sessionId: 'c1', reason: 'busy' }]);
  assert.equal(plain.profile, undefined);
  assert.ok(!plain.message.includes(CLAUDE_PAYG_OVERFLOW_HINT));
});

test('W0d/5: PROFILE_CAPACITY_EXHAUSTED is a documented exit 25 refusal', () => {
  assert.equal(ERROR_CODE_EXIT_CODES.PROFILE_CAPACITY_EXHAUSTED, 25);
  assert.equal(nameFor(25), 'ROUTE_LIMIT');
});

// ── client gate: spawn ───────────────────────────────────────────────────────

test('W0d/6: a spawn under the advertised profile cap proceeds', async () => {
  const { transport, calls } = fakeTransport({ children: busyProfileChildren(1), capacity: capacityBody(8, 0) });
  const client = gateClient(transport, { parentSessionId: 'parent-1' });
  const result = await client.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR });
  assert.ok(result.sessionId.startsWith('new-'));
  assert.equal(created(calls), 1);
});

test('W0d/7: a full advertised profile refuses BEFORE creating anything, naming the cap and the local children', async () => {
  const { transport, calls } = fakeTransport({ children: busyProfileChildren(2), capacity: capacityBody(2, 2) });
  const client = gateClient(transport, { parentSessionId: 'parent-1' });
  await assert.rejects(
    client.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.route, PROFILE_SELECTOR);
      assert.equal(error.limit, 2, 'the profile cap is what is named');
      assert.deepEqual(error.profile, { profileId: PROFILE_ID, maxConcurrent: 2, active: 2 });
      assert.match(error.message, /maxConcurrent 2/);
      assert.match(error.message, /2 active turn/);
      assert.match(error.message, /c1/, 'the local live children are listed for context');
      assert.ok(error.message.includes(CLAUDE_PAYG_OVERFLOW_HINT));
      return true;
    },
  );
  assert.equal(created(calls), 0, 'no create happened');
});

test('W0d/8: the decision is the server\'s active count alone — free server slots are never wasted on the local count', async () => {
  // correction 01: 8 allowed, 4 active server-side (this parent's 4 live turns
  // ARE those 4) → four slots free → the spawn is ALLOWED.
  const allowed = fakeTransport({ children: busyProfileChildren(4), capacity: capacityBody(8, 4) });
  const allowedClient = gateClient(allowed.transport, { parentSessionId: 'parent-1' });
  await allowedClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR });
  assert.equal(created(allowed.calls), 1, 'limit = maxConcurrent - active would have refused here');

  const full = fakeTransport({ children: busyProfileChildren(2), capacity: capacityBody(8, 8) });
  const fullClient = gateClient(full.transport, { parentSessionId: 'parent-1' });
  await assert.rejects(
    fullClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.limit, 8);
      assert.deepEqual(error.profile, { profileId: PROFILE_ID, maxConcurrent: 8, active: 8 });
      assert.match(error.message, /maxConcurrent 8/);
      assert.match(error.message, /8 active turn/);
      return true;
    },
  );
  assert.equal(created(full.calls), 0);
});

test('W0d/9: a full profile is refused from the server numbers with no local live child at all', async () => {
  const { transport, calls } = fakeTransport({ children: [], capacity: capacityBody(2, 2) });
  const client = gateClient(transport, { parentSessionId: 'parent-1' });
  await assert.rejects(
    client.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.limit, 2);
      assert.match(error.message, /maxConcurrent 2/);
      assert.ok(error.message.includes(CLAUDE_PAYG_OVERFLOW_HINT));
      return true;
    },
  );
  assert.equal(created(calls), 0);
});

test('W0d/19 (correction 01): 8 allowed / 4 active / 4 local live → ALLOWED; 8 active → refused with the hint', async () => {
  const fourFree = fakeTransport({ children: busyProfileChildren(4), capacity: capacityBody(8, 4) });
  const fourFreeClient = gateClient(fourFree.transport, { parentSessionId: 'parent-1' });
  const result = await fourFreeClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR });
  assert.ok(result.sessionId.startsWith('new-'), 'the four free server slots are usable');
  assert.equal(created(fourFree.calls), 1);

  const atCap = fakeTransport({ children: busyProfileChildren(4), capacity: capacityBody(8, 8) });
  const atCapClient = gateClient(atCap.transport, { parentSessionId: 'parent-1' });
  await assert.rejects(
    atCapClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.match(error.message, /maxConcurrent 8/);
      assert.match(error.message, /8 active turn/);
      assert.ok(error.message.includes(CLAUDE_PAYG_OVERFLOW_HINT));
      return true;
    },
  );
  assert.equal(created(atCap.calls), 0);
});

test('W0d/20 (correction 01): --wait-for-slot does not promise a watch on a server-side profile cap — it refuses at once', async () => {
  let longPolls = 0;
  const { transport, calls } = fakeTransport({
    children: busyProfileChildren(2),
    capacity: capacityBody(2, 2),
    longPoll: async () => {
      longPolls += 1;
      return { fired: true };
    },
  });
  const client = gateClient(transport, { parentSessionId: 'parent-1' });
  await assert.rejects(
    client.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR, waitForSlotMs: 60_000 }),
    (error: unknown) => error instanceof RouteLimitError,
  );
  assert.equal(longPolls, 0, 'no watch wait: the holder may be another parent, so a local watch would be a false promise');
  assert.equal(created(calls), 0);
});

test('W0d/10: an explicit per-call --route-limit wins over the advertised cap (and 0 still lifts it)', async () => {
  const tighter = fakeTransport({ children: busyProfileChildren(1), capacity: capacityBody(8, 0) });
  const tighterClient = gateClient(tighter.transport, { parentSessionId: 'parent-1' });
  await assert.rejects(
    tighterClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR, routeLimit: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.limit, 1, 'the flag, not the advertised 8');
      return true;
    },
  );
  assert.equal(created(tighter.calls), 0);

  const lifted = fakeTransport({ children: busyProfileChildren(3), capacity: capacityBody(2, 2) });
  const liftedClient = gateClient(lifted.transport, { parentSessionId: 'parent-1' });
  await liftedClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR, routeLimit: 0 });
  assert.equal(created(lifted.calls), 1, 'an explicit 0 = unlimited beats the advertised cap');
});

test('W0d/11: PI_ORCH_ROUTE_LIMITS wins over the advertised cap, including an explicit unlimited', async () => {
  const configured = fakeTransport({ children: busyProfileChildren(1), capacity: capacityBody(8, 0) });
  const configuredClient = gateClient(configured.transport, { parentSessionId: 'parent-1', routeLimits: { [PROFILE_SELECTOR]: 1 } });
  await assert.rejects(
    configuredClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR }),
    (error: unknown) => error instanceof RouteLimitError && error.limit === 1,
  );
  assert.equal(created(configured.calls), 0);

  const unlimited = fakeTransport({ children: busyProfileChildren(3), capacity: capacityBody(2, 2) });
  const unlimitedClient = gateClient(unlimited.transport, { parentSessionId: 'parent-1', routeLimits: { [PROFILE_SELECTOR]: 0 } });
  await unlimitedClient.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR });
  assert.equal(created(unlimited.calls), 1);
});

test('W0d/12: an older server without claudeProfiles keeps today\'s behaviour (no default cap)', async () => {
  const { transport, calls } = fakeTransport({ children: busyProfileChildren(9), capacity: { activeTurns: 3, maxActiveTurns: 12 } });
  const client = gateClient(transport, { parentSessionId: 'parent-1' });
  await client.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR });
  assert.equal(created(calls), 1, 'an unadvertised profile route stays unlimited unless configured');
});

test('W0d/13: an unreadable /capacity does not invent a cap either', async () => {
  const { transport, calls } = fakeTransport({ children: busyProfileChildren(9), capacityThrows: true });
  const client = gateClient(transport, { parentSessionId: 'parent-1' });
  await client.spawn({ runtime: 'claude', cwd: '/tmp/w', modelSelector: PROFILE_SELECTOR });
  assert.equal(created(calls), 1);
});

test('W0d/14: prompting an idle child on a full profile route refuses; a live child is never gated', async () => {
  const idle = fakeTransport({
    all: [
      ...busyProfileChildren(2),
      { sessionId: 'target', modelSelector: PROFILE_SELECTOR, runtime: 'claude', busy: false, lastRunStatus: 'completed' },
    ],
    children: busyProfileChildren(2),
    capacity: capacityBody(2, 2),
  });
  const idleClient = gateClient(idle.transport, { parentSessionId: 'parent-1' });
  await assert.rejects(
    idleClient.prompt('target', { message: 'go' }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      assert.equal(error.route, PROFILE_SELECTOR);
      assert.ok(error.message.includes(CLAUDE_PAYG_OVERFLOW_HINT));
      return true;
    },
  );
  assert.equal(dispatched(idle.calls), 0, 'no dispatch happened');

  // A free server slot: the local busy children alone must NOT refuse the prompt.
  const free = fakeTransport({
    all: [
      ...busyProfileChildren(2),
      { sessionId: 'target', modelSelector: PROFILE_SELECTOR, runtime: 'claude', busy: false, lastRunStatus: 'completed' },
    ],
    children: busyProfileChildren(2),
    capacity: capacityBody(8, 2),
  });
  const freeClient = gateClient(free.transport, { parentSessionId: 'parent-1' });
  await freeClient.prompt('target', { message: 'go' });
  assert.equal(dispatched(free.calls), 1, 'six server slots were free');

  const live = fakeTransport({
    all: [{ sessionId: 'target', modelSelector: PROFILE_SELECTOR, runtime: 'claude', busy: true }],
    capacity: capacityBody(2, 2),
  });
  const liveClient = gateClient(live.transport, { parentSessionId: 'parent-1' });
  await liveClient.prompt('target', { message: 'go', mode: 'follow_up' });
  assert.equal(dispatched(live.calls), 1, 'a prompt to a live child adds no concurrency');
});

// ── CLI: a server 429 maps to exit 25 with the same hint ─────────────────────

function fakeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'test-key-123',
    client: () => {
      throw new Error('no client expected in this test');
    },
    ...overrides,
  };
}

function profileCapacityRefusal(): ApiError {
  return new ApiError(429, 'PROFILE_CAPACITY_EXHAUSTED', `Claude profile '${PROFILE_ID}' is at its maxConcurrent cap (8/8 active turns)`, {
    retryAfterSeconds: 5,
    data: { profileId: PROFILE_ID, maxConcurrent: 8, active: 8, retryAfterSeconds: 5 },
  });
}

test('W0d/15: a server 429 PROFILE_CAPACITY_EXHAUSTED on spawn exits 25 with the overflow hint', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'claude', '--cwd', '/tmp/w', '--model-selector', PROFILE_SELECTOR],
    fakeDeps({
      client: () => ({
        async spawn() {
          throw profileCapacityRefusal();
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 25);
  const stderr = result.stderr ?? '';
  assert.match(stderr, /PROFILE_CAPACITY_EXHAUSTED/);
  assert.match(stderr, new RegExp(PROFILE_ID));
  assert.match(stderr, /maxConcurrent 8/);
  assert.match(stderr, /8 active turn/);
  assert.ok(stderr.includes(CLAUDE_PAYG_OVERFLOW_HINT), 'the parent is told about the overflow route, not left guessing');
  assert.match(stderr, /anthropic\/claude-sonnet-5-5/);
});

test('W0d/16: the same 429 on prompt exits 25 with the same hint', async () => {
  const result = await runCli(
    ['prompt', 'sess-9', '--message', 'go'],
    fakeDeps({
      client: () => ({
        async prompt() {
          throw profileCapacityRefusal();
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 25);
  assert.ok((result.stderr ?? '').includes(CLAUDE_PAYG_OVERFLOW_HINT));
});

test('W0d/17: a 429 that carries no profile fields still exits 25 and keeps the hint', async () => {
  const result = await runCli(
    ['prompt', 'sess-9', '--message', 'go'],
    fakeDeps({
      client: () => ({
        async prompt() {
          throw new ApiError(429, 'PROFILE_CAPACITY_EXHAUSTED', 'profile cap reached');
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 25);
  assert.ok((result.stderr ?? '').includes(CLAUDE_PAYG_OVERFLOW_HINT));
});

// ── the bundled contract snapshot ────────────────────────────────────────────

test('W0d/18 + W2h + 1i.2C + 1i.3 + 1k: the bundled snapshot is the server\'s 1.65.0 (session class, archive; still carrying native session ids, native parent, claudeProfiles, the typed refusal, goalId/stalled)', () => {
  const snapshot = JSON.parse(readFileSync(join(process.cwd(), 'contract', 'internal-api-client-snapshot.json'), 'utf8')) as {
    contractVersion: string;
    errorCodes: string[];
    types: Record<string, { fields?: Record<string, { type?: string; optional?: boolean }> }>;
    zodSchemas: Record<string, { fields?: Record<string, unknown> } | undefined>;
  };
  assert.equal(snapshot.contractVersion, '1.65.0');
  assert.ok(snapshot.errorCodes.includes('PROFILE_CAPACITY_EXHAUSTED'));
  const claudeProfiles = snapshot.types.CapacityResponse?.fields?.claudeProfiles;
  assert.ok(claudeProfiles, 'CapacityResponse advertises claudeProfiles');
  assert.match(claudeProfiles.type ?? '', /Array<\{ profileId: string; maxConcurrent: number; active: number \}>/);
  assert.equal(claudeProfiles.optional, true, 'absent on older servers');
  assert.equal(snapshot.types.ModelInfo?.fields?.maxConcurrent?.type, 'number');
  // W2h (contract 1.62.0): the stable goal identity and the stall facts.
  assert.equal(snapshot.types.SessionGoalProjection?.fields?.goalId?.type, 'string');
  assert.equal(snapshot.types.SessionGoalProjection?.fields?.stalled?.type, 'boolean');
  assert.equal(snapshot.types.SessionGoalProjection?.fields?.stalledForMs?.type, 'number');
  // Step 1i.2 C (contract 1.63.0): the native parent linkage this client sends.
  assert.match(snapshot.types.CapabilitiesResponse?.fields?.features?.type ?? '', /nativeParentLinkage/);
  assert.ok(snapshot.zodSchemas.createSessionBody?.fields && 'parentKind' in snapshot.zodSchemas.createSessionBody.fields, 'createSessionBody accepts parentKind');
  assert.ok(snapshot.zodSchemas.createSessionBody?.fields && 'parentSessionId' in snapshot.zodSchemas.createSessionBody.fields);
  // Step 1k (contract 1.65.0): the session class this client can declare, the
  // archive refusal codes, and the two advertising capabilities.
  assert.ok(snapshot.zodSchemas.createSessionBody?.fields && 'sessionClass' in snapshot.zodSchemas.createSessionBody.fields, 'createSessionBody accepts sessionClass');
  assert.equal(snapshot.types.SessionInfo?.fields?.sessionClass?.type, "'validation'");
  assert.equal(snapshot.types.SessionInfo?.fields?.sessionClass?.optional, true, 'absent = not validation');
  assert.equal(snapshot.types.CreateSessionResponse?.fields?.sessionClass?.type, "'validation'");
  assert.ok(snapshot.errorCodes.includes('SESSION_PINNED'));
  assert.ok(snapshot.errorCodes.includes('SESSION_BUSY'));
  assert.match(snapshot.types.CapabilitiesResponse?.fields?.features?.type ?? '', /sessionClass/);
  assert.match(snapshot.types.CapabilitiesResponse?.fields?.features?.type ?? '', /sessionArchive/);
});

// ─── W0d review fix 1: a profile-cap 429 surfaces at once (no silent Retry-After stall) ──────────
test('W0d/review-1: 429 PROFILE_CAPACITY_EXHAUSTED is not retried by the transport', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const transport = new Transport({
    apiBase: 'http://127.0.0.1:1',
    token: 't',
    retry: { maxAttempts: 3, maxTotalWaitMs: 120_000, sleep: async (ms) => { sleeps.push(ms); } },
  });
  (transport as unknown as { requestOnce: unknown }).requestOnce = async () => {
    attempts += 1;
    return { status: 429, headers: { 'retry-after': '15' }, body: { error: 'cap', code: 'PROFILE_CAPACITY_EXHAUSTED', profileId: 'p', maxConcurrent: 8, active: 8 }, raw: '' } as TransportResponse;
  };
  await assert.rejects(transport.request('POST', '/api/v1/sessions/s/prompt', { body: {} }), (error: { code?: string }) => error.code === 'PROFILE_CAPACITY_EXHAUSTED');
  assert.equal(attempts, 1, 'one attempt only');
  assert.deepEqual(sleeps, []);
});

test('W0d/review-2: a server-decided profile refusal does not print an empty child list or suggest --wait-for-slot', () => {
  const error = new RouteLimitError('profile:p', 8, [], { profileId: 'p', maxConcurrent: 8, active: 8 });
  assert.doesNotMatch(error.message, /live children: \./);
  assert.doesNotMatch(error.message, /--wait-for-slot/);
  assert.match(error.message, /maxConcurrent 8, 8 active/);
});
