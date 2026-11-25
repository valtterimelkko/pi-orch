import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiOrchClient } from '../src/client.ts';
import { buildCreateBody, NATIVE_PARENT_ID_PATTERN } from '../src/builders.ts';
import { RouteLimitError } from '../src/route-limits.ts';
import { runCli, parseArgs, allowedFlagsFor, type CliDeps } from '../src/cli.ts';
import { loadSnapshot } from '../src/snapshot.ts';
import { ZodSpec } from '../src/zod-spec.ts';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import type { TransportResponse } from '../src/transport.ts';
import { tempLedgerPath } from './isolated-ledger.ts';
import { makeLaneDir, FakeWorld } from './lane-runner-helpers.ts';

/**
 * Step 1i.2 part C (plan 1i, SESSION-RELATIONSHIPS §4.1 C): a native parent
 * (a Claude Code session, NOT a Pi Web UI session) can be named at spawn —
 * contract 1.63.0 body `parentSessionId` + `parentKind: "native"`, persisted
 * server-side as `parentSource: "declared"`. pi-orch sends it when the caller
 * has NO managed parent identity (flag > PI_ORCH_PARENT_SESSION >
 * PI_WEB_UI_SESSION_ID > PI_SESSION_ID stay managed via X-Parent-Session;
 * else CLAUDE_CODE_SESSION_ID → the body fields), gated on
 * `features.nativeParentLinkage` so an older server (1.62.0, strict create
 * schema) never sees a new field. The ledger records what was sent (additive
 * field), `status --owner` shows it, and the per-route cap may count declared
 * children by the native parent.
 */

const SYNTHETIC_NATIVE_UUID = '11111111-2222-4333-8444-555555555555';
const SYNTHETIC_OWNER = 'orch-cc-00000000-lane';
const ZAI = 'zai/glm-5.3-flash';

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

interface RecordedCall {
  method: string;
  path: string;
  options: { body?: Record<string, unknown>; headers?: Record<string, string> };
}

/** Fake transport with controllable capabilities, ?parent= listing and create capture. */
function fakeTransport(options: {
  nativeCapability?: boolean;
  capabilitiesFail?: boolean;
  /** Session ids returned for GET /sessions?parent=<native id>; 'unset' → 404 (no declared children yet). */
  declaredChildren?: string[] | 'unset';
  /** Session ids the server KNOWS (the unfiltered GET /sessions the owner-ledger count intersects). */
  allKnown?: string[];
}): { transport: never; calls: Array<RecordedCall>; warnings: string[] } {
  const calls: Array<RecordedCall> = [];
  const warnings: string[] = [];
  const shape = (sessionId: string) => ({
    sessionId,
    sessionPath: `/p/${sessionId}`,
    runtime: 'pi',
    cwd: '/tmp/x',
    model: ZAI,
    status: 'running',
    busy: true,
    messageCount: 1,
    firstMessage: 'x',
    createdAt: '2026-10-16T00:00:00Z',
    lastActivity: '2026-10-16T00:00:00Z',
  });
  const transport = {
    request: async (method: string, path: string, options_: { body?: Record<string, unknown>; headers?: Record<string, string> } = {}): Promise<TransportResponse> => {
      calls.push({ method, path, options: options_ });
      if (method === 'GET' && path === '/api/v1/capabilities') {
        if (options.capabilitiesFail) throw new Error('capabilities unreachable');
        return ok({
          status: 'ok',
          contract: { version: options.nativeCapability ? '1.63.0' : '1.62.0' },
          features: options.nativeCapability ? { nativeParentLinkage: { parentKind: 'native', parentSource: 'declared', surfaces: [] } } : {},
        });
      }
      if (method === 'POST' && path === '/api/v1/sessions') {
        const body = (options_.body ?? {}) as Record<string, unknown>;
        return ok({ sessionId: `new-${calls.length}`, parentSessionId: body.parentSessionId, parentSource: body.parentKind === 'native' ? 'declared' : undefined, ...body });
      }
      if (method === 'GET' && path === '/api/v1/sessions') {
        return ok({ sessions: (options.allKnown ?? []).map(shape) }); // unfiltered list (owner counting)
      }
      if (method === 'GET' && path.startsWith('/api/v1/sessions?')) {
        const url = new URL(`http://x${path}`);
        const parent = url.searchParams.get('parent');
        if (parent !== null) {
          if (options.declaredChildren === 'unset') throw Object.assign(new Error('not found'), { status: 404, code: 'SESSION_NOT_FOUND' });
          return ok({ sessions: (options.declaredChildren ?? []).map(shape) });
        }
        return ok({ sessions: [] });
      }
      if (method === 'GET' && path.endsWith('/goal')) return ok({ supported: true, status: 'idle' });
      if (method === 'GET' && path.endsWith('/evidence')) return ok({ runChronology: [] });
      if (method === 'GET' && /^\/api\/v1\/sessions\/[^/]+$/.test(path)) return ok(shape('x'));
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  return { transport, calls, warnings };
}

function nativeClient(transport: never, warnings: string[], config: Record<string, unknown> = {}): PiOrchClient {
  return new PiOrchClient({
    transportInstance: transport,
    spawnLedgerPath: tempLedgerPath(),
    spawnLockDir: mkdtempSync(join(tmpdir(), 'piorch-np-lock-')),
    onWarn: (line) => warnings.push(line),
    randomId: () => 'k1',
    // The REAL environment can carry PI_ORCH_ROUTE_LIMITS; these tests set
    // route limits explicitly per case.
    routeLimits: {},
    ...config,
  });
}

// ── snapshot + builder ───────────────────────────────────────────────────────

test('the bundled contract snapshot is 1.63.0 or later and its create body accepts parentKind', () => {
  const empty = mkdtempSync(join(tmpdir(), 'piorch-np-home-'));
  try {
    const { snapshot } = loadSnapshot({ env: {}, home: empty });
    assert.equal(snapshot.contractVersion, '1.71.0');
    const fields = snapshot.zodSchemas.createSessionBody?.fields ?? {};
    assert.ok('parentKind' in fields, 'createSessionBody must accept parentKind (1.63.0)');
    assert.ok('parentSessionId' in fields);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('builder: nativeParentId emits parentSessionId + parentKind "native", snapshot-conformant', () => {
  // Force the BUNDLED copy (the one this repo ships): the real HOME's
  // ~/pi-web-ui checkout can lag it on a dev host.
  const empty = mkdtempSync(join(tmpdir(), 'piorch-np-home-'));
  try {
    const { snapshot } = loadSnapshot({ env: {}, home: empty });
    const spec = new ZodSpec(snapshot.zodSchemas.createSessionBody!);
    const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', nativeParentId: SYNTHETIC_NATIVE_UUID });
    assert.equal(body.parentSessionId, SYNTHETIC_NATIVE_UUID);
    assert.equal(body.parentKind, 'native');
    assert.deepEqual(spec.check(body), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('builder: an explicit managed parentSessionId wins over the native id', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', parentSessionId: 'reg-managed', nativeParentId: SYNTHETIC_NATIVE_UUID });
  assert.equal(body.parentSessionId, 'reg-managed');
  assert.equal(body.parentKind, undefined, 'no native marker when a managed body id is given');
});

test('builder: the native id must be a bare token like the server regex', () => {
  assert.ok(NATIVE_PARENT_ID_PATTERN.test(SYNTHETIC_NATIVE_UUID));
  assert.ok(NATIVE_PARENT_ID_PATTERN.test('ses_abc123'));
  assert.ok(!NATIVE_PARENT_ID_PATTERN.test('../etc/passwd'));
  assert.ok(!NATIVE_PARENT_ID_PATTERN.test('a/b'));
  assert.ok(!NATIVE_PARENT_ID_PATTERN.test(`x${'y'.repeat(128)}`), '129 chars is too long');
  assert.ok(!NATIVE_PARENT_ID_PATTERN.test(''), 'empty is not a native id');
  assert.throws(() => buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', nativeParentId: '../etc/passwd' }), /native/i);
});

// ── client spawn: capability-gated native parent ─────────────────────────────

test('spawn sends parentSessionId + parentKind in the body when the server advertises the capability', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: 'unset' });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: SYNTHETIC_NATIVE_UUID });
  const result = await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.ok(create, 'one create POST');
  assert.equal(create?.options.body?.parentSessionId, SYNTHETIC_NATIVE_UUID);
  assert.equal(create?.options.body?.parentKind, 'native');
  assert.equal(create?.options.headers?.['X-Parent-Session'], undefined, 'no X-Parent-Session for the native parent');
  assert.equal((result.raw as { parentSource?: string }).parentSource, 'declared', 'the echoed declared source rides back on raw');
  assert.deepEqual(warnings, [], 'no warnings on the happy path');
  // Criterion 3: the ledger records the native parent sent.
  const entry = new SpawnLedger((client as unknown as { spawnLedger: { path?: string } }).spawnLedger.path).entries().at(-1);
  assert.equal(entry?.nativeParentSessionId, SYNTHETIC_NATIVE_UUID);
});

test('spawn on an older server (no nativeParentLinkage) sends nothing new', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: false });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: SYNTHETIC_NATIVE_UUID });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.body?.parentSessionId, undefined);
  assert.equal(create?.options.body?.parentKind, undefined);
  // w11-orch: nothing NEW is sent to an older server (strict schema), but a
  // requested native parent that could not be persisted is no longer a silent
  // orphan — it is reported once via PARENT_NOT_LINKED. The env-configured
  // native id is not an explicit request, so NATIVE_PARENT_SKIPPED stays off.
  assert.ok(warnings.some((line) => line.includes('PARENT_NOT_LINKED')), `expected PARENT_NOT_LINKED: ${JSON.stringify(warnings)}`);
  assert.ok(!warnings.some((line) => line.includes('NATIVE_PARENT_SKIPPED')), `env-native must not raise NATIVE_PARENT_SKIPPED: ${JSON.stringify(warnings)}`);
});

test('an unreadable /capabilities sends nothing new (strict schema, fail safe)', async () => {
  const { transport, calls, warnings } = fakeTransport({ capabilitiesFail: true });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: SYNTHETIC_NATIVE_UUID });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.body?.parentSessionId, undefined);
  assert.equal(create?.options.body?.parentKind, undefined);
});

test('a malformed native id is skipped with one warning and the spawn proceeds', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: '../evil/path' });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.body?.parentSessionId, undefined);
  assert.equal(create?.options.body?.parentKind, undefined);
  const nativeWarnings = warnings.filter((line) => line.includes('NATIVE_PARENT_SKIPPED'));
  assert.equal(nativeWarnings.length, 1, `exactly one warning, got ${JSON.stringify(warnings)}`);
});

test('a managed parent identity suppresses the native parent entirely', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true });
  const client = nativeClient(transport, warnings, { parentSessionId: 'reg-managed', nativeParentSessionId: SYNTHETIC_NATIVE_UUID });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.body?.parentKind, undefined, 'managed wins: no native marker');
  assert.equal(create?.options.headers?.['X-Parent-Session'], 'reg-managed', 'the managed header is sent as today');
});

// ── J3: a PI_SESSION_ID parent rides BOTH channels (dual send) ──────────────

test('a managed parent also declared natively with the SAME id is sent on both channels', async () => {
  // A bare Pi CLI parent's PI_SESSION_ID is not resolvable by the server as a
  // managed session, so the same id also rides in the create body as the
  // declared native parent. When the header DOES resolve, the server keeps its
  // precedence (Pi Web UI linkChildFromRequest), so a managed Pi parent is
  // unchanged.
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: 'unset' });
  const client = nativeClient(transport, warnings, { parentSessionId: 'pi-session-abc', nativeParentSessionId: 'pi-session-abc' });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.headers?.['X-Parent-Session'], 'pi-session-abc', 'the managed header is still sent');
  assert.equal(create?.options.body?.parentSessionId, 'pi-session-abc');
  assert.equal(create?.options.body?.parentKind, 'native');
  assert.deepEqual(warnings, [], 'a linked child raises no warning');
});

// ── criterion 4: the route cap may count declared children by the native parent ──

test('the route gate counts declared children by the native parent (no identity, no owner)', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: ['declared-1'] });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: SYNTHETIC_NATIVE_UUID, routeLimits: { [ZAI]: 1 } });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI }),
    (error: unknown) => error instanceof RouteLimitError,
    'one live declared child at limit 1 → refused',
  );
  const parentRead = calls.find((call) => call.method === 'GET' && call.path.includes(`parent=${encodeURIComponent(SYNTHETIC_NATIVE_UUID)}`));
  assert.ok(parentRead, 'the gate read ?parent=<native id>');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/sessions').length, 0, 'nothing created');
});

test('no declared children yet (?parent= 404s) counts zero and creates', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: 'unset' });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: SYNTHETIC_NATIVE_UUID, routeLimits: { [ZAI]: 1 } });
  const result = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI });
  assert.ok(result.sessionId.startsWith('new-'));
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/v1/sessions').length, 1);
});

test('an owner count unions the ledger children with the declared children', async () => {
  const ledgerPath = tempLedgerPath();
  new SpawnLedger(ledgerPath).record({ sessionId: 'ledger-live', ownerId: 'orch-cc-00000000-lane', route: ZAI, at: new Date().toISOString() });
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: ['declared-1'], allKnown: ['ledger-live'] });
  const client = nativeClient(transport, warnings, { spawnLedgerPath: ledgerPath, nativeParentSessionId: SYNTHETIC_NATIVE_UUID, routeLimits: { [ZAI]: 1 } });
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'orch-cc-00000000-lane' } }),
    (error: unknown) => {
      assert.ok(error instanceof RouteLimitError);
      const live = (error as RouteLimitError).live.map((entry) => entry.sessionId).sort();
      assert.deepEqual(live, ['declared-1', 'ledger-live'], 'both counting sources feed the refusal');
      return true;
    },
  );
});

test('without the capability the owner count is unchanged (no ?parent= read)', async () => {
  const ledgerPath = tempLedgerPath();
  new SpawnLedger(ledgerPath).record({ sessionId: 'ledger-live', ownerId: 'orch-cc-00000000-lane', route: ZAI, at: new Date().toISOString() });
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: false, declaredChildren: ['declared-1'] });
  const client = nativeClient(transport, warnings, { spawnLedgerPath: ledgerPath, nativeParentSessionId: SYNTHETIC_NATIVE_UUID, routeLimits: { [ZAI]: 2 } });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', modelSelector: ZAI, retention: { mode: 'durable', ownerId: 'orch-cc-00000000-lane' } });
  assert.equal(calls.some((call) => call.path.includes('parent=')), false, 'old server: counting stays owner-ledger only');
});

// ── criterion 3: status --owner shows the native parent ──────────────────────

test('status --owner surfaces the native parent recorded at spawn', async () => {
  const ledgerPath = tempLedgerPath();
  new SpawnLedger(ledgerPath).record({ sessionId: 's-live', ownerId: 'orch-cc-00000000-lane', nativeParentSessionId: SYNTHETIC_NATIVE_UUID, at: '2026-10-16T11:00:00Z' });
  const { transport, warnings } = fakeTransport({ nativeCapability: true });
  const client = nativeClient(transport, warnings, { spawnLedgerPath: ledgerPath });
  const body = await client.status({ owner: 'orch-cc-00000000-lane' });
  assert.equal(body.children.length, 1);
  assert.equal(body.children[0]?.nativeParentSessionId, SYNTHETIC_NATIVE_UUID);
});

// ── CLI wiring: precedence, opt-out, rendering ───────────────────────────────

function fakeDeps(client: NonNullable<CliDeps['client']>, env: Record<string, string> = {}): CliDeps {
  return { env, stdout: () => undefined, stderr: () => undefined, randomId: () => 'test-key-123', client };
}

test('CLI: spawn passes CLAUDE_CODE_SESSION_ID as the native parent when no managed identity exists', async () => {
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], fakeDeps((config) => {
    seen.push(config);
    return {
      spawn: async () => ({ sessionId: 's1', raw: {} }),
    } as never;
  }, { CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }));
  assert.equal(seen[0]?.nativeParentSessionId, SYNTHETIC_NATIVE_UUID);
  assert.equal(seen[0]?.parentSessionId, undefined);
});

test('CLI: a managed parent identity wins over CLAUDE_CODE_SESSION_ID', async () => {
  // The managed chain (PI_SESSION_ID here) names the parent; the caller's
  // CLAUDE_CODE_SESSION_ID is not used at all. J3 adds one thing: the
  // PI_SESSION_ID id ALSO rides as the declared native parent (dual send), so
  // an id the server cannot resolve as a managed session (a bare Pi CLI parent)
  // still links. The managed header is unchanged.
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], fakeDeps((config) => {
    seen.push(config);
    return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
  }, { PI_SESSION_ID: 'pi-managed', CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }));
  assert.equal(seen[0]?.parentSessionId, 'pi-managed');
  assert.notEqual(seen[0]?.nativeParentSessionId, SYNTHETIC_NATIVE_UUID, 'the Claude id is not the parent');
  assert.equal(seen[0]?.nativeParentSessionId, 'pi-managed', 'J3: the PI_SESSION_ID parent also rides natively');
});

test('CLI: a --parent-session equal to CLAUDE_CODE_SESSION_ID is a native parent, not X-Parent-Session (w11-orch)', async () => {
  // The owner's orphan bug: a Claude Code parent passes --parent-session its
  // own native session id. That id is NOT an Internal API session, so sending
  // it as X-Parent-Session records NO parent and the child lands in "mine".
  // It must ride in the create body as the declared native parent instead.
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--parent-session', SYNTHETIC_NATIVE_UUID], fakeDeps((config) => {
    seen.push(config);
    return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
  }, { CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }));
  assert.equal(seen[0]?.parentSessionId, undefined, 'a native parent must NOT become the managed X-Parent-Session id');
  assert.equal(seen[0]?.nativeParentSessionId, SYNTHETIC_NATIVE_UUID, 'it rides as the declared native parent');
});

test('CLI: --no-native-parent keeps a CLAUDE_CODE_SESSION_ID-valued --parent-session as the managed id (w11-orch)', async () => {
  // Opting out of the native link leaves the explicit --parent-session on the
  // managed channel (the caller asked for no native parent).
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--parent-session', SYNTHETIC_NATIVE_UUID, '--no-native-parent'], fakeDeps((config) => {
    seen.push(config);
    return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
  }, { CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }));
  assert.equal(seen[0]?.parentSessionId, SYNTHETIC_NATIVE_UUID);
  assert.equal(seen[0]?.nativeParentSessionId, undefined, '--no-native-parent stays off the native channel');
});

test('CLI: a --parent-session that is NOT CLAUDE_CODE_SESSION_ID stays managed (w11-orch)', async () => {
  // A real Internal API parent id (or any non-native value) keeps the header.
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--parent-session', 'api-session-xyz'], fakeDeps((config) => {
    seen.push(config);
    return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
  }, { CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }));
  assert.equal(seen[0]?.parentSessionId, 'api-session-xyz');
  assert.equal(seen[0]?.nativeParentSessionId, undefined, 'a non-native --parent-session is managed');
});

test('spawn warns PARENT_NOT_LINKED when a native parent was requested but the server reports none (w11-orch)', async () => {
  // Safety net: a parent was requested and the created session reports none —
  // never fail the spawn, but warn loudly so the orphan is not silent.
  const { transport, warnings } = fakeTransport({ nativeCapability: false });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: SYNTHETIC_NATIVE_UUID });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  assert.ok(warnings.some((line) => line.includes('PARENT_NOT_LINKED')), `expected PARENT_NOT_LINKED: ${JSON.stringify(warnings)}`);
});

test('spawn does NOT warn PARENT_NOT_LINKED when the native parent linked (w11-orch)', async () => {
  const { transport, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: 'unset' });
  const client = nativeClient(transport, warnings, { nativeParentSessionId: SYNTHETIC_NATIVE_UUID });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  assert.ok(!warnings.some((line) => line.includes('PARENT_NOT_LINKED')), `unexpected warning: ${JSON.stringify(warnings)}`);
});

test('CLI: --no-native-parent opts out even with CLAUDE_CODE_SESSION_ID set', async () => {
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--no-native-parent'], fakeDeps((config) => {
    seen.push(config);
    return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
  }, { CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }));
  assert.equal(seen[0]?.nativeParentSessionId, undefined);
  assert.ok(allowedFlagsFor('spawn')?.has('no-native-parent'), '--no-native-parent is a known spawn flag');
});

test('CLI: status --owner renders the native parent on the human line', async () => {
  const result = await runCli(['status', '--owner', SYNTHETIC_OWNER], fakeDeps(() => ({
    status: async () => ({ owner: SYNTHETIC_OWNER, pruned: 0, children: [{ sessionId: 's1', busy: false, goalStatus: 'idle', nativeParentSessionId: SYNTHETIC_NATIVE_UUID }] }),
  } as never)));
  assert.equal(result.exitCode, 0);
  assert.ok((result.stdout ?? '').includes(`nativeParent=${SYNTHETIC_NATIVE_UUID}`), `got: ${result.stdout}`);
});

// ── correction 1 item 1: --no-native-parent must not swallow the positional ─

test('parseArgs: --no-native-parent is boolean — the positional survives in both orders', () => {
  const cases: Array<{ argv: string[]; positionals: string[] }> = [
    { argv: ['lane', 'run', '--no-native-parent', '/tmp/lane-x'], positionals: ['run', '/tmp/lane-x'] },
    { argv: ['lane', 'run', '/tmp/lane-x', '--no-native-parent'], positionals: ['run', '/tmp/lane-x'] },
    { argv: ['prompt', 'sid-1', '--no-native-parent', '--message', 'go'], positionals: ['sid-1'] },
  ];
  for (const { argv, positionals } of cases) {
    const parsed = parseArgs(argv);
    assert.deepEqual(parsed.positional, positionals, `positionals for ${JSON.stringify(argv)}`);
    assert.equal(parsed.flags.get('no-native-parent'), true, `the flag must be boolean for ${JSON.stringify(argv)}`);
  }
});

// ── correction 1 item 2: a module-level nativeParentId is capability-gated ──

test('a library spawn({nativeParentId}) sends nothing on a server without the capability', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: false });
  const client = nativeClient(transport, warnings, {}); // no config-level native id — the CALLER passes one
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', nativeParentId: SYNTHETIC_NATIVE_UUID });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.body?.parentSessionId, undefined, 'the gated-off value must not ride into the body');
  assert.equal(create?.options.body?.parentKind, undefined);
  assert.ok(warnings.some((line) => line.includes('NATIVE_PARENT_SKIPPED')), `the explicit request is not dropped silently: ${JSON.stringify(warnings)}`);
});

test('a library spawn({nativeParentId}) is sent when the capability is advertised', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: 'unset' });
  const client = nativeClient(transport, warnings, {});
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', nativeParentId: SYNTHETIC_NATIVE_UUID });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.body?.parentSessionId, SYNTHETIC_NATIVE_UUID);
  assert.equal(create?.options.body?.parentKind, 'native');
  assert.deepEqual(warnings, []);
});

test('a malformed library nativeParentId is skipped with one warning (builder never sees it)', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true });
  const client = nativeClient(transport, warnings, {});
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', nativeParentId: '../evil' });
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.body?.parentKind, undefined);
  assert.equal(warnings.filter((line) => line.includes('NATIVE_PARENT_SKIPPED')).length, 1);
});

// ── J3 (native-parent-linkage): the self-session resolver fallback ───────────
//
// Devin, the Antigravity CLI, the Command Code CLI and a bare `pi` CLI name
// their session in no environment variable pi-orch knows, so a child of one was
// linked to nobody. With no identity at all, pi-orch now asks the Agent OS board
// who its own session is (`agent-os board self --json`) and declares that
// session's bare ref as the native parent. The resolver is a deps seam, so no
// test spawns a process and none reads the live board.

// An invented board ref (never a real one from this host).
const SYNTHETIC_SELF_REF = 'example-board-ref';

type SelfSeam = NonNullable<CliDeps['selfSession']>;

/** A resolver seam that records its calls and answers with a fixed outcome. */
function selfSeam(outcome: { sessionRef?: string; note?: string } = { sessionRef: SYNTHETIC_SELF_REF }): { calls: number; selfSession: SelfSeam } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    selfSession: () => {
      state.calls += 1;
      return outcome;
    },
  };
}

function depsWith(
  client: NonNullable<CliDeps['client']>,
  env: Record<string, string>,
  selfSession: SelfSeam | undefined,
  stderr?: (line: string) => void,
): CliDeps {
  return {
    env,
    stdout: () => undefined,
    stderr: stderr ?? (() => undefined),
    randomId: () => 'test-key-123',
    client,
    ...(selfSession !== undefined ? { selfSession } : {}),
  };
}

function spawnOnly(seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }>): NonNullable<CliDeps['client']> {
  return (config) => {
    seen.push(config);
    return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
  };
}

test('J3 CLI: with no identity at all the resolver names the declared native parent', async () => {
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  const seam = selfSeam();
  const result = await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], depsWith(spawnOnly(seen), {}, seam.selfSession));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(seen[0]?.nativeParentSessionId, SYNTHETIC_SELF_REF);
  assert.equal(seen[0]?.parentSessionId, undefined, 'the resolver result is native, never the managed header');
  assert.equal(seam.calls, 1);
});

test('J3 CLI: the resolved native parent reaches the create BODY as parentSessionId + parentKind native', async () => {
  // Not just the config: run the CLI through the REAL client against a fake
  // transport and inspect the create body the server would receive.
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: 'unset' });
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'],
    depsWith((config) => nativeClient(transport, warnings, config) as never, {}, selfSeam().selfSession),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.ok(create, 'one create POST');
  assert.equal(create?.options.body?.parentSessionId, SYNTHETIC_SELF_REF);
  assert.equal(create?.options.body?.parentKind, 'native');
  assert.equal(create?.options.headers?.['X-Parent-Session'], undefined, 'a resolved native parent never becomes the header');
});

test('J3 CLI: the resolver never runs when any identity is already known', async () => {
  const cases: Array<{ name: string; argv: string[]; env: Record<string, string> }> = [
    { name: '--parent-session', argv: ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--parent-session', 'api-managed-1'], env: {} },
    { name: 'PI_ORCH_PARENT_SESSION', argv: ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], env: { PI_ORCH_PARENT_SESSION: 'api-managed-2' } },
    { name: 'PI_WEB_UI_SESSION_ID', argv: ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], env: { PI_WEB_UI_SESSION_ID: 'pi-web-1' } },
    { name: 'PI_SESSION_ID', argv: ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], env: { PI_SESSION_ID: 'pi-bare-1' } },
    { name: 'CLAUDE_CODE_SESSION_ID', argv: ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], env: { CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID } },
  ];
  for (const { name, argv, env } of cases) {
    const seam = selfSeam();
    const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
    await runCli(argv, depsWith(spawnOnly(seen), env, seam.selfSession));
    assert.equal(seam.calls, 0, `the resolver must not run: ${name}`);
    assert.notEqual(seen[0]?.nativeParentSessionId, SYNTHETIC_SELF_REF, name);
  }
});

test('J3 CLI: --no-native-parent disables the resolver too', async () => {
  const seam = selfSeam();
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--no-native-parent'], depsWith(spawnOnly(seen), { PI_SESSION_ID: 'pi-bare-1' }, seam.selfSession));
  assert.equal(seam.calls, 0);
  assert.equal(seen[0]?.nativeParentSessionId, undefined, 'no native id, even though PI_SESSION_ID is set');
  assert.equal(seen[0]?.parentSessionId, 'pi-bare-1', 'the managed header stays');
});

test('J3 CLI: an unresolved resolver is one short stderr note and the spawn still proceeds', async () => {
  const notes: string[] = [];
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'],
    depsWith(spawnOnly(seen), {}, selfSeam({ note: 'pi-orch: SELF_RESOLVER_UNRESOLVED — synthetic note' }).selfSession, (line) => notes.push(line)),
  );
  assert.equal(result.exitCode, 0, 'an unresolved resolver never fails the spawn');
  assert.equal(seen[0]?.nativeParentSessionId, undefined);
  assert.deepEqual(notes, ['pi-orch: SELF_RESOLVER_UNRESOLVED — synthetic note'], 'exactly one note, once');
});

test('J3 CLI: a PI_SESSION_ID parent also rides as the declared native parent (dual send)', async () => {
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  const seam = selfSeam();
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], depsWith(spawnOnly(seen), { PI_SESSION_ID: 'pi-bare-1' }, seam.selfSession));
  assert.equal(seen[0]?.parentSessionId, 'pi-bare-1', 'the managed header is unchanged');
  assert.equal(seen[0]?.nativeParentSessionId, 'pi-bare-1', 'and the same id is declared natively, so an unresolvable id still links');
  assert.equal(seam.calls, 0);
});

test('J3 CLI: the dual send reaches the create body AND the header (server keeps header precedence)', async () => {
  const { transport, calls, warnings } = fakeTransport({ nativeCapability: true, declaredChildren: 'unset' });
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'],
    depsWith((config) => nativeClient(transport, warnings, config) as never, { PI_SESSION_ID: 'pi-bare-1' }, undefined),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.options.headers?.['X-Parent-Session'], 'pi-bare-1');
  assert.equal(create?.options.body?.parentSessionId, 'pi-bare-1');
  assert.equal(create?.options.body?.parentKind, 'native');
});

test('J3 CLI: an explicit sibling of PI_SESSION_ID does not dual-send (PI_WEB_UI_SESSION_ID stays header-only)', async () => {
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], depsWith(spawnOnly(seen), { PI_WEB_UI_SESSION_ID: 'pi-web-1', PI_SESSION_ID: 'pi-bare-1' }, undefined));
  assert.equal(seen[0]?.parentSessionId, 'pi-web-1');
  assert.equal(seen[0]?.nativeParentSessionId, undefined, 'only a PI_SESSION_ID parent rides both channels');
});

test('J3 CLI: spawn and `lane run` share ONE parent resolution (there is no batch verb)', async () => {
  // pi-orch has no `batch` verb — `lane run` is the batch path (it spawns an
  // implementer and a reviewer per lane). Both paths must resolve the parent
  // through the same function, so a lane child is linked exactly like a spawn.
  assert.equal(allowedFlagsFor('batch'), undefined, 'documented: pi-orch has no batch verb');
  const batchLike = await runCli(['batch', 'x'], depsWith(spawnOnly([]), {}, undefined));
  assert.equal(batchLike.exitCode, 2, 'an unknown verb is a usage error, never a silent no-op');

  const spawnSeen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--parent-session', 'parent-session-1'], depsWith(spawnOnly(spawnSeen), {}, undefined));

  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  const laneSeen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  const lane = await runCli(['lane', 'run', dir, '--json'], depsWith((config) => {
    laneSeen.push(config);
    return world.client() as never;
  }, {}, undefined));
  assert.equal(lane.exitCode, 0, lane.stderr);
  assert.deepEqual(laneSeen[0], spawnSeen[0], 'the lane factory config is the same resolution as the spawn factory config');
});

test('J3 CLI: a declared parent id that IS this process\'s PI_SESSION_ID also rides natively', async () => {
  // The lane path can only ever carry an EXPLICIT parent (lane.json's
  // parentSessionId is required), so on `lane run` behaviour 3 would otherwise
  // never apply: a bare Pi CLI parent's lane children would orphan even though
  // its own PI_SESSION_ID is known. The same id, same rule.
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--parent-session', 'pi-bare-1'], depsWith(spawnOnly(seen), { PI_SESSION_ID: 'pi-bare-1' }, undefined));
  assert.equal(seen[0]?.parentSessionId, 'pi-bare-1');
  assert.equal(seen[0]?.nativeParentSessionId, 'pi-bare-1');
});

test('J3 CLI: `lane run` declares a Claude Code lane parent natively (the one resolution, shared)', async () => {
  const { dir } = makeLaneDir({ laneOverrides: { parentSessionId: SYNTHETIC_NATIVE_UUID } });
  const world = new FakeWorld(dir);
  const laneSeen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  const result = await runCli(['lane', 'run', dir, '--json'], depsWith((config) => {
    laneSeen.push(config);
    return world.client() as never;
  }, { CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }, undefined));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(laneSeen[0]?.parentSessionId, undefined, 'a native lane parent is not a header');
  assert.equal(laneSeen[0]?.nativeParentSessionId, SYNTHETIC_NATIVE_UUID);
});

test('J3 CLI: `lane run` dual-sends a lane parent that is the caller\'s PI_SESSION_ID', async () => {
  const { dir } = makeLaneDir({ laneOverrides: { parentSessionId: 'pi-bare-1' } });
  const world = new FakeWorld(dir);
  const laneSeen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  const result = await runCli(['lane', 'run', dir, '--json'], depsWith((config) => {
    laneSeen.push(config);
    return world.client() as never;
  }, { PI_SESSION_ID: 'pi-bare-1' }, undefined));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(laneSeen[0]?.parentSessionId, 'pi-bare-1');
  assert.equal(laneSeen[0]?.nativeParentSessionId, 'pi-bare-1');
});
