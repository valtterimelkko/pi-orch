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

test('the bundled contract snapshot is 1.63.0 and its create body accepts parentKind', () => {
  const empty = mkdtempSync(join(tmpdir(), 'piorch-np-home-'));
  try {
    const { snapshot } = loadSnapshot({ env: {}, home: empty });
    assert.equal(snapshot.contractVersion, '1.63.0');
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
  assert.deepEqual(warnings, [], 'an older server is normal operation, not a warning');
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
  const seen: Array<{ parentSessionId?: string; nativeParentSessionId?: string }> = [];
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], fakeDeps((config) => {
    seen.push(config);
    return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
  }, { PI_SESSION_ID: 'pi-managed', CLAUDE_CODE_SESSION_ID: SYNTHETIC_NATIVE_UUID }));
  assert.equal(seen[0]?.parentSessionId, 'pi-managed');
  assert.equal(seen[0]?.nativeParentSessionId, undefined, 'the managed chain stays X-Parent-Session');
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
