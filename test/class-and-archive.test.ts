import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiOrchClient, FeatureUnsupportedError, ArchiveAcknowledgementError } from '../src/client.ts';
import { buildCreateBody } from '../src/builders.ts';
import { runCli, type CliDeps } from '../src/cli.ts';
import { ApiError } from '../src/parsers.ts';
import { loadSnapshot } from '../src/snapshot.ts';
import { ZodSpec } from '../src/zod-spec.ts';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import { ERROR_CODE_EXIT_CODES, nameFor } from '../src/exit-codes.ts';
import { auditRecordFor } from '../src/audit.ts';
import type { TransportResponse } from '../src/transport.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * Step 1k (contract 1.65.0, design SESSION-LIFECYCLE §6.2): the session CLASS
 * and the archive verbs.
 *
 * - `spawn --class validation` declares the only storable class
 *   (`sessionClass: "validation"` on create, recorded once server-side). It is
 *   capability-gated on `features.sessionClass`: a server that does not
 *   advertise it — or one whose `/capabilities` cannot be read — is REFUSED
 *   before anything is created (fail closed: a silent skip would let the
 *   caller believe the class was recorded). Any other value is refused
 *   locally, as a usage error, without a request.
 * - `archive` / `unarchive` wrap `POST /api/v1/sessions/:id/archive` and
 *   `/unarchive` (capability-gated on `features.sessionArchive`), map the two
 *   409 refusal classes to documented exits (`SESSION_PINNED` 27,
 *   `SESSION_BUSY` 12), and never report a mutation the server did not
 *   confirm.
 *
 * Fake in-process server, injectable transport — the house style: no network,
 * no real server, no real session ids (fixtures invented).
 */

const SYNTHETIC_SID = 'sess-0000-1111';

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** Fake transport: controllable capabilities features, create capture, archive reply. */
function featureTransport(options: {
  features?: Record<string, unknown>;
  capabilitiesFails?: boolean;
  /** Reply for the archive routes: a body, or a thrown refusal. */
  archiveReply?: { body?: unknown; refusal?: Error };
} = {}): { transport: never; calls: Array<Call> } {
  const calls: Array<Call> = [];
  const transport = {
    request: async (
      method: string,
      path: string,
      requestOptions: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
    ): Promise<TransportResponse> => {
      calls.push({ method, path, body: requestOptions.body });
      if (method === 'GET' && path === '/api/v1/capabilities') {
        if (options.capabilitiesFails) throw new Error('capabilities unreachable');
        return ok({
          status: 'ok',
          contract: { name: 'pi-web-ui-internal-api', contractVersion: '1.65.0' },
          features: options.features ?? {},
        });
      }
      if (method === 'POST' && path === '/api/v1/sessions') {
        const body = requestOptions.body ?? {};
        return ok({ sessionId: 'new-sess-1', ...body });
      }
      const archiveRoute = /^\/api\/v1\/sessions\/([^/]+)\/(archive|unarchive)$/.exec(path);
      if (method === 'POST' && archiveRoute) {
        if (options.archiveReply?.refusal) throw options.archiveReply.refusal;
        if (options.archiveReply?.body !== undefined) return ok(options.archiveReply.body);
        const archived = archiveRoute[2] === 'archive';
        return ok({
          ok: true,
          sessionId: decodeURIComponent(archiveRoute[1] as string),
          archived,
          ...(archived ? { archivedAt: 1760714000000 } : {}),
        });
      }
      if (method === 'GET' && /^\/api\/v1\/sessions\/[^/]+$/.test(path)) {
        return ok({ sessionId: SYNTHETIC_SID, runtime: 'pi', busy: false, status: 'idle', sessionClass: 'validation' });
      }
      if (path.endsWith('/goal')) return ok({ supported: true, status: 'idle' });
      if (path.endsWith('/evidence')) return ok({ runChronology: [] });
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  return { transport, calls };
}

function makeClient(transport: never, ledgerPath: string = tempLedgerPath()): PiOrchClient {
  return new PiOrchClient({
    transportInstance: transport,
    spawnLedgerPath: ledgerPath,
    spawnLockDir: mkdtempSync(join(tmpdir(), 'piorch-1k-lock-')),
    routeLimits: {},
    randomId: () => 'k1',
    onWarn: () => undefined,
  });
}

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

// ── the create body and the snapshot ─────────────────────────────────────────

test('1k/builder: sessionClass "validation" is emitted, snapshot-conformant', () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'piorch-1k-home-'));
  try {
    const { snapshot } = loadSnapshot({ env: {}, home: emptyHome });
    const spec = new ZodSpec(snapshot.zodSchemas.createSessionBody!);
    const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/work', sessionClass: 'validation' });
    assert.equal(body.sessionClass, 'validation');
    const problems = spec.check(body);
    assert.deepEqual(problems, [], `conformance problems: ${JSON.stringify(problems)}`);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('1k/builder: any other class is refused locally (the server stores only "validation")', () => {
  for (const value of ['child', 'mine', 'Validation', '']) {
    assert.throws(
      () => buildCreateBody({ runtime: 'pi', cwd: '/tmp/work', sessionClass: value as 'validation' }),
      /sessionClass/,
      `'${value}' must be refused`,
    );
  }
  // No class given: nothing is emitted (the field is optional; absent = not validation).
  assert.equal('sessionClass' in buildCreateBody({ runtime: 'pi', cwd: '/tmp/work' }), false);
});

// ── spawn --class: the capability gate and the ledger ────────────────────────

test('1k/spawn: an advertised features.sessionClass sends sessionClass and records it in the ledger', async () => {
  const ledgerPath = tempLedgerPath();
  const { transport, calls } = featureTransport({ features: { sessionClass: { field: 'sessionClass', storableValue: 'validation' } } });
  const client = makeClient(transport, ledgerPath);
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/work', sessionClass: 'validation' });
  assert.equal(spawned.sessionId, 'new-sess-1');
  const create = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(create?.body?.sessionClass, 'validation');
  assert.equal(create?.body?.runtime, 'pi');
  assert.equal(new SpawnLedger(ledgerPath).entries()[0]?.sessionClass, 'validation');
});

test('1k/spawn: a server without features.sessionClass is refused, nothing is created and nothing is recorded', async () => {
  const ledgerPath = tempLedgerPath();
  const { transport, calls } = featureTransport({ features: { sessionArchive: {} } });
  const client = makeClient(transport, ledgerPath);
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/work', sessionClass: 'validation' }),
    (error: FeatureUnsupportedError) => {
      assert.equal(error.code, 'FEATURE_UNSUPPORTED');
      assert.match(error.message, /features\.sessionClass/);
      assert.match(error.message, /nothing was created/);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0, 'no create was attempted');
  assert.deepEqual(new SpawnLedger(ledgerPath).entries(), [], 'nothing was recorded');
});

test('1k/spawn: an unreadable /capabilities cannot verify the feature — refused (fail closed)', async () => {
  const { transport, calls } = featureTransport({ capabilitiesFails: true });
  const client = makeClient(transport);
  await assert.rejects(
    client.spawn({ runtime: 'pi', cwd: '/tmp/work', sessionClass: 'validation' }),
    (error: FeatureUnsupportedError) => {
      assert.equal(error.code, 'FEATURE_UNSUPPORTED');
      assert.match(error.message, /could not be read/);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('1k/spawn: a spawn with no class never reads /capabilities', async () => {
  const { transport, calls } = featureTransport({ capabilitiesFails: true });
  const client = makeClient(transport);
  await client.spawn({ runtime: 'pi', cwd: '/tmp/work' });
  assert.equal(calls.some((call) => call.path === '/api/v1/capabilities'), false);
});

// ── status shows the class the server echoes ─────────────────────────────────

test('1k/status: the class the server echoes rides on the child status', async () => {
  const { transport } = featureTransport();
  const client = makeClient(transport);
  const body = await client.status({ sessionId: SYNTHETIC_SID });
  assert.equal(body.children[0]?.sessionClass, 'validation');
});

test('1k/status: a child the server does not class carries none (absent = not validation)', async () => {
  const transport = {
    request: async (method: string, path: string): Promise<TransportResponse> => {
      if (path.endsWith('/goal')) return ok({ supported: true, status: 'idle' });
      if (path.endsWith('/evidence')) return ok({ runChronology: [] });
      if (method === 'GET' && /^\/api\/v1\/sessions\/[^/]+$/.test(path)) return ok({ sessionId: 's-1', runtime: 'pi', busy: false, status: 'idle' });
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const body = await makeClient(transport).status({ sessionId: 's-1' });
  assert.equal('sessionClass' in (body.children[0] ?? {}), false);
});

test('1k/cli: status prints class=validation when the server echoes it', async () => {
  const result = await runCli(
    ['status', SYNTHETIC_SID],
    fakeDeps({
      client: () => ({
        async status() {
          return { children: [{ sessionId: SYNTHETIC_SID, busy: false, goalStatus: 'idle', lastRun: { status: 'completed' }, sessionClass: 'validation' }] };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? '', /class=validation/);
});

test('1k/cli: status prints no class for an unclassed child', async () => {
  const result = await runCli(
    ['status', SYNTHETIC_SID],
    fakeDeps({
      client: () => ({
        async status() {
          return { children: [{ sessionId: SYNTHETIC_SID, busy: false, goalStatus: 'idle', lastRun: { status: 'completed' } }] };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout ?? '', /class=/);
});

// ── archive / unarchive: the client ─────────────────────────────────────────

test('1k/archive: an advertised features.sessionArchive posts to /archive and reports the ack', async () => {
  const { transport, calls } = featureTransport({ features: { sessionArchive: { routes: ['archive', 'unarchive'] } } });
  const client = makeClient(transport);
  const result = await client.archive(SYNTHETIC_SID);
  assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.path), [`/api/v1/sessions/${SYNTHETIC_SID}/archive`]);
  assert.equal(result.archived, true);
  assert.equal(result.archivedAt, 1760714000000);
  assert.equal(result.sessionId, SYNTHETIC_SID);
});

test('1k/unarchive: posts to /unarchive and reports archived=false', async () => {
  const { transport, calls } = featureTransport({ features: { sessionArchive: {} } });
  const client = makeClient(transport);
  const result = await client.unarchive(SYNTHETIC_SID);
  assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.path), [`/api/v1/sessions/${SYNTHETIC_SID}/unarchive`]);
  assert.equal(result.archived, false);
});

test('1k/archive: the documented updatedAt (LWW stamp) rides in the body; a non-integer is refused locally', async () => {
  const { transport, calls } = featureTransport({ features: { sessionArchive: {} } });
  const client = makeClient(transport);
  await client.archive(SYNTHETIC_SID, { updatedAt: 1760714000000 });
  const post = calls.find((call) => call.method === 'POST');
  assert.deepEqual(post?.body, { updatedAt: 1760714000000 });
  // No stamp given: an empty body (the server stamps Date.now()).
  await client.unarchive(SYNTHETIC_SID);
  assert.equal(calls.filter((call) => call.method === 'POST').at(-1)?.body, undefined);
  await assert.rejects(client.archive(SYNTHETIC_SID, { updatedAt: 1.5 }), /updatedAt must be a positive epoch-ms integer/);
});

test('1k/archive: a server without features.sessionArchive is refused and nothing is sent', async () => {
  const { transport, calls } = featureTransport({ features: { sessionClass: {} } });
  const client = makeClient(transport);
  await assert.rejects(
    client.archive(SYNTHETIC_SID),
    (error: FeatureUnsupportedError) => {
      assert.equal(error.code, 'FEATURE_UNSUPPORTED');
      assert.match(error.message, /features\.sessionArchive/);
      assert.match(error.message, /nothing was archived/);
      return true;
    },
  );
  assert.deepEqual(calls.filter((call) => call.method === 'POST'), []);
});

test('1k/unarchive: the same gate refuses with the unarchive wording', async () => {
  const { transport } = featureTransport({ features: {} });
  await assert.rejects(makeClient(transport).unarchive(SYNTHETIC_SID), /nothing was unarchived/);
});

test('1k/archive: an acknowledgement that does not confirm THIS archive is never reported as archived', async () => {
  const { transport } = featureTransport({
    features: { sessionArchive: {} },
    archiveReply: { body: { ok: true, sessionId: SYNTHETIC_SID, archived: false } },
  });
  await assert.rejects(
    makeClient(transport).archive(SYNTHETIC_SID),
    (error: ArchiveAcknowledgementError) => {
      assert.equal(error.code, 'ARCHIVE_ACK_FAILED');
      assert.match(error.message, /reporting NOTHING as archived/);
      return true;
    },
  );
});

test('1k/archive: an acknowledgement naming ANOTHER session is never reported as archived', async () => {
  const { transport } = featureTransport({
    features: { sessionArchive: {} },
    archiveReply: { body: { ok: true, sessionId: 'sess-someone-else', archived: true } },
  });
  await assert.rejects(makeClient(transport).archive(SYNTHETIC_SID), /ACK_FAILED/);
});

// ── archive / unarchive: the CLI verb, refusals and exit codes ──────────────

test('1k/cli: archive prints the human line and --json the whole ack', async () => {
  const human = await runCli(
    ['archive', SYNTHETIC_SID],
    fakeDeps({
      client: () => ({
        async archive() {
          return { ok: true, sessionId: SYNTHETIC_SID, archived: true, archivedAt: 1760714000000 };
        },
      }) as never,
    }),
  );
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout ?? '', /archived sess-0000-1111/);
  assert.match(human.stdout ?? '', /1760714000000/);

  const json = await runCli(
    ['unarchive', SYNTHETIC_SID, '--json'],
    fakeDeps({
      client: () => ({
        async unarchive() {
          return { ok: true, sessionId: SYNTHETIC_SID, archived: false };
        },
      }) as never,
    }),
  );
  assert.equal(json.exitCode, 0);
  assert.equal((JSON.parse(json.stdout ?? '{}') as { archived?: boolean }).archived, false);
});

test('1k/cli: --updated-at is passed through; a non-numeric value is a usage error', async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const result = await runCli(
    ['archive', SYNTHETIC_SID, '--updated-at', '1760714000000'],
    fakeDeps({
      client: () => ({
        async archive(_sessionId: string, options?: Record<string, unknown>) {
          seen.push(options);
          return { ok: true, sessionId: SYNTHETIC_SID, archived: true };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen, [{ updatedAt: 1760714000000 }]);

  const bad = await runCli(['archive', SYNTHETIC_SID, '--updated-at', 'soon'], fakeDeps());
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr ?? '', /--updated-at must be a number/);

  const fractional = await runCli(['archive', SYNTHETIC_SID, '--updated-at', '1.5'], fakeDeps());
  assert.equal(fractional.exitCode, 2);
  assert.match(fractional.stderr ?? '', /--updated-at must be a positive epoch-ms integer/);
});

test('1k/cli: archive without a session id, or with a foreign flag, is a usage error', async () => {
  const missing = await runCli(['archive'], fakeDeps());
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr ?? '', /archive needs <sessionId>/);

  const stray = await runCli(['unarchive', SYNTHETIC_SID, '--lease', 'l1'], fakeDeps());
  assert.equal(stray.exitCode, 2);
  assert.match(stray.stderr ?? '', /unknown flag\(s\) for 'unarchive': --lease/);

  const extra = await runCli(['archive', SYNTHETIC_SID, 'another'], fakeDeps());
  assert.equal(extra.exitCode, 2);
});

test('1k/cli: 409 SESSION_PINNED exits 27, 409 SESSION_BUSY exits 12, both documented', async () => {
  const pinned = await runCli(
    ['archive', SYNTHETIC_SID],
    fakeDeps({
      client: () => ({
        async archive() {
          throw new ApiError(409, 'SESSION_PINNED', 'session is pinned');
        },
      }) as never,
    }),
  );
  assert.equal(pinned.exitCode, 27);
  assert.match(pinned.stderr ?? '', /SESSION_PINNED/);

  const busy = await runCli(
    ['archive', SYNTHETIC_SID],
    fakeDeps({
      client: () => ({
        async archive() {
          throw new ApiError(409, 'SESSION_BUSY', 'session has a live turn');
        },
      }) as never,
    }),
  );
  assert.equal(busy.exitCode, 12);
  assert.match(busy.stderr ?? '', /SESSION_BUSY/);

  assert.equal(nameFor(26), 'FEATURE_UNSUPPORTED');
  assert.equal(nameFor(27), 'SESSION_PINNED');
  assert.equal(ERROR_CODE_EXIT_CODES.FEATURE_UNSUPPORTED, 26);
  assert.equal(ERROR_CODE_EXIT_CODES.SESSION_PINNED, 27);
});

test('1k/cli: a capability refusal from the client exits 26 with the reason and the no-change promise', async () => {
  const result = await runCli(
    ['archive', SYNTHETIC_SID],
    fakeDeps({
      client: () => ({
        async archive() {
          throw new FeatureUnsupportedError('features.sessionArchive', 'the server does not advertise features.sessionArchive; nothing was archived');
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 26);
  assert.match(result.stderr ?? '', /FEATURE_UNSUPPORTED/);
  assert.match(result.stderr ?? '', /features\.sessionArchive/);
});

test('1k/cli: spawn --class validation passes the class through; --class with any other value is a usage error', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ok = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/work', '--class', 'validation', '--id-only'],
    fakeDeps({
      client: () => ({
        async spawn(input: Record<string, unknown>) {
          seen.push(input);
          return { sessionId: 'new-sess-1' };
        },
      }) as never,
    }),
  );
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'new-sess-1');
  assert.equal(seen[0]?.sessionClass, 'validation');

  // A bad value (or no value at all) is refused BEFORE the client factory runs.
  for (const argv of [
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/work', '--class', 'child'],
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/work', '--class', 'mine'],
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/work', '--class'],
  ]) {
    const refused = await runCli(argv, fakeDeps());
    assert.equal(refused.exitCode, 2, `${argv.join(' ')} must be a usage error`);
    assert.match(refused.stderr ?? '', /--class/);
    assert.match(refused.stderr ?? '', /validation/);
  }
});

test('1k/cli: a spawngate refusal from the client exits 26 and says nothing was created', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/work', '--class', 'validation'],
    fakeDeps({
      client: () => ({
        async spawn() {
          throw new FeatureUnsupportedError('features.sessionClass', 'the server does not advertise features.sessionClass; nothing was created');
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 26);
  assert.match(result.stderr ?? '', /nothing was created/);
});

// ── the help text names the new verbs, flag and codes ───────────────────────

test('1k/audit: the archive verbs are audited as themselves, with the target session id', () => {
  const archive = auditRecordFor(['archive', SYNTHETIC_SID], { exitCode: 0 }, {}, 3);
  assert.deepEqual([archive.verb, archive.sessionId], ['archive', SYNTHETIC_SID]);
  const unarchive = auditRecordFor(['unarchive', SYNTHETIC_SID, '--json'], { exitCode: 27 }, {}, 3);
  assert.deepEqual([unarchive.verb, unarchive.sessionId], ['unarchive', SYNTHETIC_SID]);
});

test('1k/help: the usage text documents the class flag, the archive verbs and the two new codes', async () => {
  const help = await runCli(['help'], fakeDeps());
  assert.equal(help.exitCode, 0);
  const text = help.stdout ?? '';
  assert.match(text, /archive <sessionId>/);
  assert.match(text, /unarchive <sessionId>/);
  assert.match(text, /--class validation/);
  assert.match(text, /26 feature unsupported|26 FEATURE_UNSUPPORTED/i);
  assert.match(text, /27/);
});
