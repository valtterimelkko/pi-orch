import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot, type ClientContractSnapshot } from '../src/snapshot.ts';
import { ZodSpec } from '../src/zod-spec.ts';
import {
  parseReceipt,
  classifyReceipt,
  parseWatchesWait,
  parseApiError,
  type ReceiptClassification,
} from '../src/parsers.ts';


/**
 * Response parsers: tolerant of additive server fields (never reject a newer
 * server), strict about the fields the client's decisions depend on, and
 * classified into the documented outcome/exit-code vocabulary.
 */

const loaded: { snapshot: ClientContractSnapshot } = loadSnapshot({ env: {} });

function syntheticReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    runtime: 'pi',
    executionInstanceId: 'inst-1',
    status: 'completed',
    acceptedAt: '2026-09-29T23:00:00.000Z',
    cessation: { state: 'confirmed', basis: 'terminal_signal', observedAt: '2026-09-29T23:01:00.000Z' },
    workState: 'completed',
    dispatchMode: 'prompt',
    ...overrides,
  };
}

test('parseReceipt accepts every field the snapshot type declares (additive-safe)', () => {
  const fields = Object.keys(loaded.snapshot.types.RunReceipt?.fields ?? {});
  assert.ok(fields.includes('runId'));
  assert.ok(fields.includes('status'));
  assert.ok(fields.includes('finalText'));
  assert.ok(fields.includes('servedModel'));
  const receipt = parseReceipt(
    syntheticReceipt({ finalText: 'done', servedModel: 'zai/glm-5.3-flash', someFutureField: { x: 1 } }),
  );
  assert.equal(receipt.runId, 'run-1');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.finalText, 'done');
});

test('parseReceipt rejects a receipt without runId or status (decision fields)', () => {
  assert.throws(() => parseReceipt({ status: 'completed' }), /runId/);
  assert.throws(() => parseReceipt({ runId: 'r' }), /status/);
});

test('classification maps the distinct terminal codes to distinct outcomes', () => {
  const cases: Array<[Record<string, unknown>, ReceiptClassification['kind']]> = [
    [syntheticReceipt(), 'completed'],
    [syntheticReceipt({ status: 'failed', errorCode: 'NEVER_STARTED' }), 'never_started'],
    [syntheticReceipt({ status: 'failed', errorCode: 'RUN_BUDGET_EXCEEDED' }), 'budget_exceeded'],
    [syntheticReceipt({ status: 'failed', errorCode: 'RUN_TRANSPORT_LOST' }), 'transport_lost'],
    [syntheticReceipt({ status: 'failed', errorCode: 'PROMPT_NOT_EXECUTED' }), 'prompt_not_executed'],
    [syntheticReceipt({ status: 'failed', errorCode: 'TURN_STALLED' }), 'turn_stalled'],
    [syntheticReceipt({ status: 'failed', errorCode: 'RUNTIME_ERROR' }), 'failed'],
    [syntheticReceipt({ status: 'interrupted', interruptionReason: 'drain_timeout' }), 'interrupted'],
    [syntheticReceipt({ status: 'cancelled' }), 'cancelled'],
  ];
  for (const [receipt, expected] of cases) {
    assert.equal(classifyReceipt(parseReceipt(receipt)).kind, expected, JSON.stringify(receipt));
  }
});

test('interrupted classification surfaces interruptedByRestart evidence', () => {
  const outcome = classifyReceipt(
    parseReceipt(syntheticReceipt({ status: 'interrupted', interruptionReason: 'server_restart' })),
  );
  assert.equal(outcome.kind, 'interrupted');
  assert.equal(outcome.interruptedByRestart, true);
});

test('watches/wait parsing advances the cursor and exposes per-watch firings', () => {
  const parsed = parseWatchesWait({
    fired: true,
    waitedMs: 4211,
    watches: [
      {
        watchId: 'watch-sess-1',
        sessionId: 'sess-1',
        runtime: 'pi',
        firings: [{ conditionId: 'done', firedAt: 1, eventType: 'agent_end', evidence: 'ended' }],
        firingCount: 3,
      },
    ],
    nextCursor: 'eyJzZXNzLTEiOjN9',
  });
  assert.equal(parsed.nextCursor, 'eyJzZXNzLTEiOjN9');
  assert.equal(parsed.watches[0]?.firings.length, 1);
  assert.equal(parsed.watches[0]?.sessionId, 'sess-1');
});

test('api error parsing keeps code and details together', () => {
  const error = parseApiError(409, { error: 'session busy', code: 'SESSION_BUSY', details: 'turn active' });
  assert.equal(error.status, 409);
  assert.equal(error.code, 'SESSION_BUSY');
  assert.equal(error.details, 'turn active');
  assert.throws(() => parseApiError(500, { error: 'boom' }), /code/);
});

test('the control-body schema in the snapshot is strict with a known action enum', () => {
  const spec = new ZodSpec(loaded.snapshot.zodSchemas.sessionControlBody as never);
  assert.deepEqual(spec.check({ action: 'release_retention', retentionLeaseId: 'lease-1', ownerId: 'o' }), []);
  assert.ok(spec.check({ action: 'explode_everything' }).length > 0);
  assert.ok(spec.check({ action: 'release_retention', rogueKey: true }).length > 0);
});
