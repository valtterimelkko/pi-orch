import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PiOrchClient } from '../src/client.ts';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import { tempLedgerPath } from './isolated-ledger.ts';
import { apiError, ok, routedTransport, type Handler } from './w2c-helpers.ts';

/**
 * W2c verb 4 (+ ledger half of verb 6): `status --json` must fill busy /
 * status / lastRun for live children, and `status --owner` must list an
 * owner's existing children until they are deleted.
 *
 * Provenance of the two defects (found by reading the code, then pinned here):
 *  - SessionInfo.busy / .status are OPTIONAL on GET /sessions rows (snapshot
 *    1.61.0). childStatus() trusted a list row and never read the detail, so
 *    a row without them produced null busy/status.
 *  - GET /sessions/:id/evidence runChronology order is not pinned by the
 *    contract; lastRun was always [0]. Timestamps now decide when present.
 *  - Spawn recorded the ledger only for callers WITHOUT a session identity, so
 *    an owner-tagged child spawned by a parent that carries one (env
 *    PI_ORCH_PARENT_SESSION) was never recorded and `status --owner` found 0.
 *  - entriesFor() pruned ledger entries missing from GET /sessions — a list
 *    that can be limited — destroying the only owner record.
 */

function client(transport: never, ledger = tempLedgerPath(), extra: Record<string, unknown> = {}): PiOrchClient {
  return new PiOrchClient({ transportInstance: transport, spawnLedgerPath: ledger, randomId: () => 'k1', ...extra });
}

const quietRoutes = (sessionId: string, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  [`GET /api/v1/sessions/${sessionId}/goal`]: () => ok({ status: 'idle' }),
  [`GET /api/v1/sessions/${sessionId}/evidence`]: () => ok({ runChronology: [] }),
  ...extra,
});

test('W2c status: a list row WITHOUT busy/status triggers a detail read that fills them', async () => {
  const { transport } = routedTransport({
    'GET /api/v1/sessions?parent=p1': () => ok({ sessions: [{ sessionId: 's1', runtime: 'pi' }] }),
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1', runtime: 'pi', busy: true, status: 'running' }),
    ...quietRoutes('s1'),
  });
  const { children } = await client(transport).status({ parent: 'p1' });
  assert.equal(children[0]?.busy, true);
  assert.equal(children[0]?.status, 'running');
});

test('W2c status: busy is derived from status when the server omits busy', async () => {
  const { transport } = routedTransport({
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1', runtime: 'pi', status: 'running' }),
    'GET /api/v1/sessions/s2': () => ok({ sessionId: 's2', runtime: 'pi', status: 'idle' }),
    ...quietRoutes('s1'),
    ...quietRoutes('s2'),
  });
  const c = client(transport);
  assert.equal((await c.status({ sessionId: 's1' })).children[0]?.busy, true);
  assert.equal((await c.status({ sessionId: 's2' })).children[0]?.busy, false);
});

test('W2c status: lastRun is the NEWEST run by timestamp, with runId, status and endedAt', async () => {
  const { transport } = routedTransport({
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1', runtime: 'pi', busy: false, status: 'idle' }),
    'GET /api/v1/sessions/s1/goal': () => ok({ status: 'idle' }),
    'GET /api/v1/sessions/s1/evidence': () => ok({
      runChronology: [
        { runId: 'r-old', status: 'completed', startedAt: '2026-10-13T08:00:00Z', endedAt: '2026-10-13T08:05:00Z' },
        { runId: 'r-new', status: 'completed', startedAt: '2026-10-13T09:00:00Z', endedAt: '2026-10-13T09:30:00Z' },
      ],
    }),
  });
  const { children } = await client(transport).status({ sessionId: 's1' });
  const lastRun = children[0]?.lastRun;
  assert.deepEqual([lastRun?.runId, lastRun?.status, lastRun?.endedAt], ['r-new', 'completed', '2026-10-13T09:30:00Z']);
});

test('W2c status: without timestamps the first entry stays the last run (the pre-existing contract)', async () => {
  const { transport } = routedTransport({
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1', busy: false, status: 'idle' }),
    'GET /api/v1/sessions/s1/goal': () => ok({ status: 'idle' }),
    'GET /api/v1/sessions/s1/evidence': () => ok({ runChronology: [{ runId: 'r1', status: 'completed' }, { runId: 'r0', status: 'failed' }] }),
  });
  const { children } = await client(transport).status({ sessionId: 's1' });
  assert.equal(children[0]?.lastRun?.runId, 'r1');
});

test('W2c status: a failed read is SURFACED in readErrors, not silently turned into nulls', async () => {
  const { transport } = routedTransport({
    'GET /api/v1/sessions/s1': () => { throw apiError(500, 'INTERNAL', 'boom'); },
    'GET /api/v1/sessions/s1/goal': () => ok({ status: 'idle' }),
    'GET /api/v1/sessions/s1/evidence': () => { throw apiError(503, 'BUSY', 'later'); },
  });
  const { children } = await client(transport).status({ sessionId: 's1' });
  const errors = (children[0] as { readErrors?: string[] }).readErrors ?? [];
  assert.equal(errors.length, 2);
  assert.ok(errors.some((line) => line.startsWith('detail:') && line.includes('INTERNAL')));
  assert.ok(errors.some((line) => line.startsWith('evidence:')));
});

test('W2c status --owner: a child missing from GET /sessions (limited list) is still listed and NOT pruned', async () => {
  const ledger = tempLedgerPath();
  new SpawnLedger(ledger).record({ sessionId: 's-hidden', ownerId: 'orch-r1', at: '2026-10-13T00:00:00Z' });
  const { transport } = routedTransport({
    'GET /api/v1/sessions': () => ok({ sessions: [] }), // the list does not show it
    'GET /api/v1/sessions/s-hidden': () => ok({ sessionId: 's-hidden', runtime: 'claude', busy: false, status: 'idle' }),
    'GET /api/v1/sessions/s-hidden/goal': () => ok({ status: 'idle' }),
    'GET /api/v1/sessions/s-hidden/evidence': () => ok({ runChronology: [{ runId: 'r1', status: 'completed' }] }),
  });
  const body = await client(transport, ledger).status({ owner: 'orch-r1' });
  assert.equal(body.children.length, 1, 'R1 card regression: an existing idle child with a completed run is listed');
  assert.equal(body.children[0]?.sessionId, 's-hidden');
  assert.equal(body.children[0]?.lastRun?.status, 'completed');
  assert.equal(body.pruned, 0);
  assert.ok(JSON.parse(readFileSync(ledger, 'utf8')).some((entry: { sessionId: string }) => entry.sessionId === 's-hidden'), 'ledger entry survives');
});

test('W2c status --owner: only a 404 on the detail read prunes (the session is really gone)', async () => {
  const ledger = tempLedgerPath();
  const book = new SpawnLedger(ledger);
  book.record({ sessionId: 's-gone', ownerId: 'o', at: '2026-10-13T00:00:00Z' });
  book.record({ sessionId: 's-alive', ownerId: 'o', at: '2026-10-13T00:00:00Z' });
  const { transport } = routedTransport({
    'GET /api/v1/sessions': () => ok({ sessions: [{ sessionId: 's-alive' }] }),
    'GET /api/v1/sessions/s-gone': () => { throw apiError(404, 'SESSION_NOT_FOUND'); },
    'GET /api/v1/sessions/s-alive': () => ok({ sessionId: 's-alive', busy: false, status: 'idle' }),
    ...quietRoutes('s-alive'),
  });
  const body = await client(transport, ledger).status({ owner: 'o' });
  assert.deepEqual(body.children.map((child) => child.sessionId), ['s-alive']);
  assert.equal(body.pruned, 1);
  assert.deepEqual((JSON.parse(readFileSync(ledger, 'utf8')) as Array<{ sessionId: string }>).map((entry) => entry.sessionId), ['s-alive']);
});

test('W2c status --owner: a transient detail failure keeps the child listed (with readErrors) and keeps the ledger entry', async () => {
  const ledger = tempLedgerPath();
  new SpawnLedger(ledger).record({ sessionId: 's1', ownerId: 'o', at: '2026-10-13T00:00:00Z' });
  const { transport } = routedTransport({
    'GET /api/v1/sessions': () => ok({ sessions: [] }),
    'GET /api/v1/sessions/s1': () => { throw apiError(500, 'INTERNAL'); },
    ...quietRoutes('s1'),
  });
  const body = await client(transport, ledger).status({ owner: 'o' });
  assert.equal(body.children.length, 1);
  assert.equal(body.pruned, 0);
});

test('W2c ledger: an owner-tagged spawn is recorded WITH its leaseId even when the caller has a parent identity', async () => {
  const ledger = tempLedgerPath();
  const { transport } = routedTransport({
    'POST /api/v1/sessions': () => ok({ sessionId: 's-new', runtime: 'claude', retention: { leaseId: 'lease-77', mode: 'durable' } }),
  });
  const c = client(transport, ledger, { parentSessionId: 'claude-code-parent' });
  const spawned = await c.spawn({ runtime: 'claude', cwd: '/w', retention: { mode: 'durable', ownerId: 'orch-r1', ttlSeconds: 600 } });
  assert.equal(spawned.leaseId, 'lease-77');
  const entries = JSON.parse(readFileSync(ledger, 'utf8')) as Array<{ sessionId: string; ownerId?: string; leaseId?: string }>;
  assert.deepEqual(entries.map((entry) => [entry.sessionId, entry.ownerId, entry.leaseId]), [['s-new', 'orch-r1', 'lease-77']]);
});

test('W2c ledger: record() keeps leaseId and entriesOf() returns whole entries for one owner only', () => {
  const book = new SpawnLedger(tempLedgerPath());
  book.record({ sessionId: 'a', ownerId: 'o1', leaseId: 'L1', at: 't' });
  book.record({ sessionId: 'b', ownerId: 'o2', leaseId: 'L2', at: 't' });
  book.record({ sessionId: 'c', at: 't' });
  assert.deepEqual(book.entriesOf('o1').map((entry) => [entry.sessionId, entry.leaseId]), [['a', 'L1']]);
  assert.equal(book.entriesOf('nobody').length, 0);
  book.remove('a');
  assert.equal(book.entriesOf('o1').length, 0);
  assert.equal(book.entriesOf('o2').length, 1, 'remove touches only the named session');
});
