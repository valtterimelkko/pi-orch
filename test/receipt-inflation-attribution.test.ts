/**
 * H3a B+ (parent 01-answer.md, 2026-10-01T20:50Z) — additive classification
 * of refused-before-dispatch receipts.
 *
 * The server (1.58.x) creates a run receipt BEFORE the admission check and
 * releases the idempotency key on refusal, so every refused attempt of a
 * Retry-After retry leaves one cancelled, never-started receipt (H3a
 * attribution; live-proven, live-1/). Receipt totals therefore overcount
 * real runs. This module classifies those receipts so audits count one run
 * per real attempt, with refused attempts reported separately.
 *
 * Classification rule (parent answer, item 1): a receipt is
 * refusedBeforeDispatch when it is `cancelled`, has NO `startedAt`, and its
 * `errorCode` is one of the typed pre-dispatch refusals
 * (ADMISSION_CAPACITY_EXHAUSTED, SERVER_DRAINING, SESSION_BUSY). A receipt
 * cancelled AFTER start (has `startedAt`) stays a plain cancellation.
 * Additive and non-breaking: `kind` keeps the receipt's own status; wait
 * exit codes are untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyReceipt, countRunAttempts, type Receipt } from '../src/parsers.ts';

/** A real dispatched run from the live-1 proof (C's accepted attempt). */
const dispatched: Receipt = {
  runId: 'a5a2d827-154d-4eac-850d-0af3afdb8942',
  sessionId: '01a0f91f-fcbb-76d3-9167-6684c8218f6a',
  status: 'completed',
  mode: 'prompt',
  acceptedAt: '2026-10-01T20:29:31.209Z',
  startedAt: '2026-10-01T20:29:31.219Z',
  terminalAt: '2026-10-01T20:29:33.437Z',
};

/** A real refused attempt from live-1 (C's round-1 call, attempt 1 of 3). */
const refused: Receipt = {
  runId: 'b7f4068e',
  sessionId: '01a0f91f-fcbb-76d3-9167-6684c8218f6a',
  status: 'cancelled',
  errorCode: 'ADMISSION_CAPACITY_EXHAUSTED',
  mode: 'prompt',
  acceptedAt: '2026-10-01T20:24:50.892Z',
  terminalAt: '2026-10-01T20:24:50.896Z',
};

test('h3a/b+: a never-started cancelled refusal receipt classifies refusedBeforeDispatch with its refusal code', () => {
  const c = classifyReceipt(refused);
  assert.equal(c.kind, 'cancelled', 'additive: kind keeps the receipt status');
  if (c.kind !== 'cancelled') throw new Error('unreachable');
  assert.equal(c.refusedBeforeDispatch, true);
  assert.equal(c.refusalCode, 'ADMISSION_CAPACITY_EXHAUSTED');
});

for (const errorCode of ['SERVER_DRAINING', 'SESSION_BUSY']) {
  test(`h3a/b+: the typed refusal ${errorCode} classifies refusedBeforeDispatch`, () => {
    const c = classifyReceipt({ ...refused, errorCode });
    if (c.kind !== 'cancelled') throw new Error('unreachable');
    assert.equal(c.refusedBeforeDispatch, true);
    assert.equal(c.refusalCode, errorCode);
  });
}

test('h3a/b+: a receipt cancelled AFTER start (has startedAt) stays a plain cancellation', () => {
  // The window-end cleanup shape (G3): the turn really ran, then was cancelled.
  const c = classifyReceipt({ ...refused, startedAt: '2026-10-01T20:24:50.900Z', errorCode: 'ADMISSION_CAPACITY_EXHAUSTED' });
  assert.equal(c.kind, 'cancelled');
  assert.equal(c.refusedBeforeDispatch, false);
  assert.equal(c.refusalCode, undefined);
});

test('h3a/b+: a dispatched run is never refusedBeforeDispatch, whatever its status', () => {
  // Only the cancelled variant carries the refusal fields; every other kind
  // classifies exactly as before (additive, non-breaking).
  assert.equal(classifyReceipt(dispatched).kind, 'completed');
  assert.equal(classifyReceipt({ ...refused, status: 'failed' }).kind, 'failed', 'only cancelled receipts classify as refusals');
  assert.equal(classifyReceipt({ ...refused, status: 'started' }).kind, 'running');
});

test('h3a/b+: countRunAttempts — one dispatched run plus N refused attempts on the same key (live-1 shape)', () => {
  // C's session in live-1: one logical prompt refused 3 times (3 receipts),
  // then the retried dispatch succeeded (1 receipt).
  const counts = countRunAttempts([refused, { ...refused, runId: '2e4682d4' }, { ...refused, runId: 'd58e6a4c' }, dispatched]);
  assert.deepEqual(counts, { dispatched: 1, refusedBeforeDispatch: 3, other: 0 });
});

test('h3a/b+: countRunAttempts — a post-start cancellation was a real attempt (dispatched), not a refusal', () => {
  const counts = countRunAttempts([
    dispatched,
    { ...refused, startedAt: '2026-10-01T20:24:50.900Z', runId: 'window-end-kill' },
  ]);
  assert.deepEqual(counts, { dispatched: 2, refusedBeforeDispatch: 0, other: 0 });
});

test('h3a/b+: countRunAttempts — the counts always sum to the receipt count', () => {
  const receipts: Receipt[] = [
    dispatched,
    refused,
    { ...refused, runId: 'x2', errorCode: 'SERVER_DRAINING' },
    { ...refused, runId: 'x3', status: 'interrupted' },
    { ...refused, runId: 'x4', status: 'queued' },
  ];
  const counts = countRunAttempts(receipts);
  assert.equal(counts.dispatched + counts.refusedBeforeDispatch + counts.other, receipts.length);
  assert.equal(counts.dispatched, 1);
  assert.equal(counts.refusedBeforeDispatch, 2);
  assert.equal(counts.other, 2, 'interrupted and in-flight queued receipts are neither dispatched nor refused');
});

test('h3a/b+: an empty receipt list counts to zeros', () => {
  assert.deepEqual(countRunAttempts([]), { dispatched: 0, refusedBeforeDispatch: 0, other: 0 });
});

test('h3a/b+: the classifier reads only snapshot-defined RunReceipt fields (contract drift guard)', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../contract/internal-api-client-snapshot.json', import.meta.url), 'utf8')) as {
    types: Record<string, { fields: Record<string, unknown> }>;
  };
  const fields = snapshot.types.RunReceipt?.fields;
  assert.ok(fields, 'RunReceipt must exist in the bundled contract snapshot');
  for (const field of ['status', 'startedAt', 'errorCode']) {
    assert.ok(field in fields, `RunReceipt.${field} must exist in the bundled contract snapshot`);
  }
});

test('h3a/b+: the bundled live-1 fixture classifies as the live run recorded it', async () => {
  // Fixture provenance: live-1 (disposable server, build 5480b9c1, 2026-10-01);
  // session C = 3 refused attempts (one logical call) + 1 completed dispatch;
  // session A = 2 goal-arm/template dispatches + 2 refused attempts.
  const fixture = JSON.parse(await readFile(new URL('./fixtures/receipt-inflation-live1.json', import.meta.url), 'utf8')) as {
    _provenance: string;
    receipts: Receipt[];
    expected: { dispatched: number; refusedBeforeDispatch: number; other: number };
  };
  assert.match(fixture._provenance, /live-1/);
  assert.deepEqual(countRunAttempts(fixture.receipts), fixture.expected);
});
