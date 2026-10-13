import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCli } from '../src/cli.ts';
import { PiOrchClient } from '../src/client.ts';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import { tempLedgerPath } from './isolated-ledger.ts';
import { apiError, fakeDeps, ok, routedTransport, type Call, type Handler } from './w2c-helpers.ts';

/**
 * W2c verbs 5 + 6: `result <runId> --final` and bulk `cleanup --owner <id>`.
 * Provenance: TranscriptResponse.items kinds user|assistant|tool (snapshot
 * 1.61.0); the cleanup sequence reuses the existing single-session cleanup
 * (generation-safe watch delete, release_retention control, DELETE session).
 */

function client(transport: never, ledger = tempLedgerPath()): PiOrchClient {
  return new PiOrchClient({ transportInstance: transport, spawnLedgerPath: ledger, randomId: () => 'k1' });
}

const receipt = (extra: Record<string, unknown>): unknown => ({ runId: 'r1', sessionId: 's1', status: 'completed', ...extra });

// ─── result --final ──────────────────────────────────────────────────────────

test('W2c result --final: receipt finalText is returned as final.text', async () => {
  const { transport, calls } = routedTransport({
    'GET /api/v1/runs/r1': () => ok(receipt({ finalText: 'All done: 3 files changed.' })),
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1' }),
  });
  const result = await client(transport).result('r1', { final: true });
  assert.deepEqual(result.final, { source: 'receipt', text: 'All done: 3 files changed.' });
  assert.equal(calls.some((call) => call.path.includes('/transcript')), false, 'no transcript read when the receipt already has text');
});

test('W2c result --final: an EMPTY receipt (tool-call tail) falls back to the last substantive assistant text in the transcript', async () => {
  const { transport } = routedTransport({
    'GET /api/v1/runs/r1': () => ok(receipt({ finalText: '   ' })),
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1' }),
    'GET /api/v1/sessions/s1/transcript?scope=visible_full': () => ok({
      items: [
        { kind: 'user', text: 'do it' },
        { kind: 'assistant', text: 'Here is the real summary of the work.' },
        { kind: 'tool', text: 'bash: ls', toolName: 'bash' },
        { kind: 'assistant', text: '   ' },
        { kind: 'tool', text: '', toolName: 'read' },
      ],
    }),
  });
  const result = await client(transport).result('r1', { final: true });
  assert.deepEqual(result.final, { source: 'transcript', text: 'Here is the real summary of the work.' });
});

test('W2c result --final: a parsed completion block is returned (with its text) and wins as the headline', async () => {
  const completion = { schema: 'pi-completion/v1', status: 'done', summary: 'Shipped' };
  const { transport } = routedTransport({
    'GET /api/v1/runs/r1': () => ok(receipt({ finalText: '', completion })),
  });
  const result = await client(transport).result('r1', { final: true });
  assert.equal(result.final?.source, 'completion');
  assert.deepEqual(result.final?.completion, completion);
});

test('W2c result --final: nothing substantive anywhere → source none, never an empty string pretending to be an answer', async () => {
  const { transport } = routedTransport({
    'GET /api/v1/runs/r1': () => ok(receipt({})),
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1' }),
    'GET /api/v1/sessions/s1/transcript?scope=visible_full': () => ok({ items: [{ kind: 'tool', text: 'x' }] }),
  });
  const result = await client(transport).result('r1', { final: true });
  assert.equal(result.final?.source, 'none');
  assert.equal(result.final?.text, undefined);
});

test('W2c result --final CLI: prints just the final text (human) / the final object (json); flag accepted before or after the run id', async () => {
  const stub = { result: async (_runId: string, options: { final?: boolean }) => ({ status: 'completed', evidence: { transcript: 't' }, ...(options.final ? { final: { source: 'transcript', text: 'THE ANSWER' } } : {}) }) };
  const deps = fakeDeps(() => stub as never);
  const human = await runCli(['result', 'r1', '--final'], deps);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.equal(human.stdout, 'THE ANSWER');
  const flagFirst = await runCli(['result', '--final', 'r1'], deps);
  assert.equal(flagFirst.stdout, 'THE ANSWER');
  const json = await runCli(['result', 'r1', '--final', '--json'], deps);
  assert.equal((JSON.parse(json.stdout ?? '{}') as { final?: { text?: string } }).final?.text, 'THE ANSWER');
});

// ─── cleanup --owner ─────────────────────────────────────────────────────────

function seed(ledger: string): void {
  const book = new SpawnLedger(ledger);
  book.record({ sessionId: 'a', ownerId: 'me', leaseId: 'LA', at: 't' });
  book.record({ sessionId: 'b', ownerId: 'me', leaseId: 'LB', at: 't' });
  book.record({ sessionId: 'x', ownerId: 'someone-else', leaseId: 'LX', at: 't' });
}

function cleanupRoutes(id: string, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`GET /api/v1/sessions/${id}/watch`]: () => ok({ watchId: `w-${id}`, status: 'active', generation: `g-${id}` }),
    [`DELETE /api/v1/sessions/${id}/watch`]: (call: Call) => ok({ success: true, watchId: `w-${id}`, generation: call.body?.expectedGeneration }),
    [`POST /api/v1/sessions/${id}/control`]: () => ok({ success: true }),
    [`DELETE /api/v1/sessions/${id}`]: () => ok({ success: true }),
    ...extra,
  };
}

test('W2c cleanup --owner: every ledger child of the owner — watch (generation-safe) → release stored lease → delete; others untouched', async () => {
  const ledger = tempLedgerPath();
  seed(ledger);
  const { transport, calls } = routedTransport({ ...cleanupRoutes('a'), ...cleanupRoutes('b') });
  const report = await client(transport, ledger).cleanupOwner('me');
  assert.deepEqual(report.children.map((child) => [child.sessionId, child.watchDeleted, child.released, child.deleted]), [
    ['a', true, true, true],
    ['b', true, true, true],
  ]);
  assert.equal(calls.some((call) => call.path.includes('/x')), false, 'the other owner’s session is never touched');
  const forA = calls.filter((call) => call.path.startsWith('/api/v1/sessions/a'));
  assert.deepEqual(forA.map((call) => `${call.method} ${call.path.replace('/api/v1/sessions/a', '') || '/'}${call.body?.action ? `#${String(call.body.action)}` : ''}`), [
    'GET /watch', 'DELETE /watch', 'POST /control#release_retention', 'DELETE /',
  ]);
  assert.deepEqual(forA[1]?.body, { expectedGeneration: 'g-a' }, 'the watch delete carries the CAS generation');
  assert.deepEqual(forA[2]?.body, { action: 'release_retention', retentionLeaseId: 'LA', ownerId: 'me' });
  const left = new SpawnLedger(ledger).entries() as Array<{ sessionId: string }>;
  assert.deepEqual(left.map((entry) => entry.sessionId), ['x'], 'cleaned children leave the ledger; the other owner’s entry stays');
});

test('W2c cleanup --owner: one child failing is reported and does NOT stop the others (failed child stays in the ledger)', async () => {
  const ledger = tempLedgerPath();
  seed(ledger);
  const { transport } = routedTransport({
    ...cleanupRoutes('a', { 'DELETE /api/v1/sessions/a': () => { throw apiError(500, 'INTERNAL', 'cannot delete'); } }),
    ...cleanupRoutes('b'),
  });
  const report = await client(transport, ledger).cleanupOwner('me');
  const [first, second] = report.children;
  assert.equal(first?.deleted, false);
  assert.match(first?.error ?? '', /INTERNAL/);
  assert.equal(second?.deleted, true);
  assert.equal(report.ok, false);
  const left = (new SpawnLedger(ledger).entries() as Array<{ sessionId: string }>).map((entry) => entry.sessionId).sort();
  assert.deepEqual(left, ['a', 'x']);
});

test('W2c cleanup --owner: an already-deleted child (404) counts as cleaned and leaves the ledger', async () => {
  const ledger = tempLedgerPath();
  new SpawnLedger(ledger).record({ sessionId: 'g', ownerId: 'me', leaseId: 'LG', at: 't' });
  const { transport } = routedTransport({
    'GET /api/v1/sessions/g/watch': () => { throw apiError(404, 'WATCH_NOT_FOUND'); },
    'POST /api/v1/sessions/g/control': () => { throw apiError(404, 'SESSION_NOT_FOUND'); },
    'DELETE /api/v1/sessions/g': () => { throw apiError(404, 'SESSION_NOT_FOUND'); },
  });
  const report = await client(transport, ledger).cleanupOwner('me');
  assert.equal(report.children[0]?.deleted, true);
  assert.match(report.children[0]?.notes.join(' ') ?? '', /already gone|not found/i);
  assert.equal(report.ok, true);
  assert.equal((new SpawnLedger(ledger).entries() as unknown[]).length, 0);
});

test('W2c cleanup --owner: a ledger entry without a leaseId reads the live lease(s) from the session detail', async () => {
  const ledger = tempLedgerPath();
  new SpawnLedger(ledger).record({ sessionId: 'old', ownerId: 'me', at: 't' });
  const { transport, calls } = routedTransport({
    'GET /api/v1/sessions/old': () => ok({ sessionId: 'old', retention: { protected: true, leases: [{ leaseId: 'L-live', mode: 'durable', expiresAt: 'z' }] } }),
    ...cleanupRoutes('old'),
  });
  const report = await client(transport, ledger).cleanupOwner('me');
  assert.equal(report.children[0]?.released, true);
  assert.equal(calls.find((call) => call.body?.action === 'release_retention')?.body?.retentionLeaseId, 'L-live');
});

test('W2c cleanup --owner: no ledger children → empty report, ok, no requests', async () => {
  const { transport, calls } = routedTransport({});
  const report = await client(transport).cleanupOwner('nobody');
  assert.deepEqual(report.children, []);
  assert.equal(report.ok, true);
  assert.equal(calls.length, 0);
});

test('W2c cleanup CLI: --owner without a sessionId is the bulk path (exit 0 / 1); neither is a usage error', async () => {
  const stub = {
    cleanupOwner: async (owner: string) => (owner === 'bad'
      ? { owner, ok: false, children: [{ sessionId: 'a', deleted: false, released: false, watchDeleted: false, notes: [], error: 'boom' }] }
      : { owner, ok: true, children: [{ sessionId: 'a', deleted: true, released: true, watchDeleted: true, notes: [] }] }),
  };
  const deps = fakeDeps(() => stub as never);
  const good = await runCli(['cleanup', '--owner', 'me', '--json'], deps);
  assert.equal(good.exitCode, 0, good.stderr);
  assert.equal((JSON.parse(good.stdout ?? '{}') as { ok?: boolean }).ok, true);
  const bad = await runCli(['cleanup', '--owner', 'bad'], deps);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout ?? '', /a: .*boom/);
  assert.equal((await runCli(['cleanup'], deps)).exitCode, 2);
  assert.equal((await runCli(['cleanup', '--lease', 'L'], deps)).exitCode, 2);
});

test('W2c cleanup <sid>: the single-session path takes the lease from the ledger when --lease is not given', async () => {
  const ledger = tempLedgerPath();
  new SpawnLedger(ledger).record({ sessionId: 'a', ownerId: 'me', leaseId: 'LA', at: 't' });
  const { transport, calls } = routedTransport(cleanupRoutes('a'));
  const result = await client(transport, ledger).cleanup('a', { ownerId: 'me' });
  assert.equal(result.released, true);
  assert.equal(calls.find((call) => call.body?.action === 'release_retention')?.body?.retentionLeaseId, 'LA');
});
