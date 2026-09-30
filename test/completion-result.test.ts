import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiOrchClient } from '../src/client.ts';
import { resolveCompletion, type CompletionBlock, type ReceiptWithCompletion, type SessionDetailWithCompletion } from '../src/completion.ts';
import type { TransportResponse } from '../src/transport.ts';

/**
 * C3b item 2: `result` returns the parsed completion — the receipt's
 * `completion` when the run captured one, else the session's
 * `latestCompletion` (goal children work in receipt-less goal-engine
 * continuation turns; the session surface is the only capture path there).
 * The parse error, the delimiter used and the evidence pointers ride along,
 * and the caller is always told WHICH record the completion came from.
 */

const BLOCK: CompletionBlock = {
  schema: 'pi-completion/v1',
  status: 'done',
  summary: 'did the thing',
  commands: [{ command: 'npm test', exitCode: 0 }],
  commits: [{ sha: 'abcdef1234567890', repo: '/tmp/repo' }],
  filesChanged: ['src/x.ts'],
};

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId: 'r1', sessionId: 's1', runtime: 'pi', status: 'completed', ...overrides };
}

test('resolveCompletion: a receipt block wins and reports source receipt with its delimiter', () => {
  const resolved = resolveCompletion(
    { ...receipt({ completion: BLOCK, completionDelimiter: 'completion' }) } as ReceiptWithCompletion,
    undefined,
  );
  assert.equal(resolved?.completion, BLOCK);
  assert.equal(resolved?.source, 'receipt');
  assert.equal(resolved?.delimiter, 'completion');
  assert.equal(resolved?.error, undefined);
});

test('resolveCompletion: a receipt parse error surfaces as an error from the receipt', () => {
  const resolved = resolveCompletion(
    { ...receipt({ completionError: { code: 'SCHEMA_VIOLATION', message: 'bad', fieldPath: 'schema' } }) } as ReceiptWithCompletion,
    { latestCompletion: { source: { kind: 'session_turn', agentEndAt: 't' }, capturedAt: 't2', completion: BLOCK } },
  ) as { source: string; error: { code: string } };
  assert.equal(resolved.source, 'receipt');
  assert.equal(resolved.error?.code, 'SCHEMA_VIOLATION');
});

test('resolveCompletion: a receipt-less (goal) run falls back to latestCompletion with provenance', () => {
  const resolved = resolveCompletion(
    receipt() as ReceiptWithCompletion,
    { latestCompletion: { source: { kind: 'session_turn', agentEndAt: '2026-09-30T00:54:09.976Z' }, capturedAt: 'c', completion: BLOCK, delimiter: 'completion' } } as SessionDetailWithCompletion,
  );
  assert.equal(resolved?.completion, BLOCK);
  assert.equal(resolved?.source, 'session_surface');
  assert.equal(resolved?.delimiter, 'completion');
  assert.equal(resolved?.capturedAt, 'c');
  assert.deepEqual(resolved?.capturedBy, { kind: 'session_turn', agentEndAt: '2026-09-30T00:54:09.976Z' });
});

test('resolveCompletion: a surface parse error surfaces with session_surface source', () => {
  const resolved = resolveCompletion(
    receipt() as ReceiptWithCompletion,
    { latestCompletion: { source: { runId: 'r9' }, capturedAt: 'c', completionError: { code: 'NO_BLOCK', message: 'none' } } } as SessionDetailWithCompletion,
  );
  assert.equal(resolved?.completion, undefined);
  assert.equal(resolved?.error?.code, 'NO_BLOCK');
  assert.equal(resolved?.source, 'session_surface');
});

test('resolveCompletion: neither record has a completion → undefined (no claim)', () => {
  assert.equal(resolveCompletion(receipt() as ReceiptWithCompletion, {}), undefined);
  assert.equal(resolveCompletion(receipt() as ReceiptWithCompletion, undefined), undefined);
});

test('result: returns the receipt completion and does NOT read the session', async () => {
  const paths: string[] = [];
  const transport = {
    request: async (method: string, path: string) => {
      paths.push(`${method} ${path}`);
      if (path === '/api/v1/runs/r1') return ok(receipt({ completion: BLOCK, completionDelimiter: 'json-tagged' }));
      throw new Error(`unexpected call ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport });
  const result = await client.result('r1');
  assert.equal(result.completion, BLOCK);
  assert.equal(result.completionSource, 'receipt');
  assert.equal(result.completionDelimiter, 'json-tagged');
  assert.equal(result.evidence.completion, '/api/v1/runs/r1');
  assert.ok(!paths.some((path) => path.includes('/sessions/')), 'no session read when the receipt carries the block');
});

test('result: falls back to the session surface for a receipt-less goal child', async () => {
  const transport = {
    request: async (_method: string, path: string) => {
      if (path === '/api/v1/runs/r1') return ok(receipt({ finalText: '' }));
      if (path === '/api/v1/sessions/s1') {
        return ok({
          sessionId: 's1',
          latestCompletion: {
            source: { kind: 'session_turn', agentEndAt: 't' },
            capturedAt: 'c',
            completion: BLOCK,
            delimiter: 'completion',
          },
        });
      }
      throw new Error(`unexpected call ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport });
  const result = await client.result('r1');
  assert.equal(result.completion, BLOCK);
  assert.equal(result.completionSource, 'session_surface');
  assert.equal(result.evidence.completion, '/api/v1/sessions/s1');
});

test('result: no completion anywhere → completion stays undefined, result still returns', async () => {
  const transport = {
    request: async (_method: string, path: string) => {
      if (path === '/api/v1/runs/r1') return ok(receipt());
      if (path === '/api/v1/sessions/s1') return ok({ sessionId: 's1' });
      throw new Error(`unexpected call ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport });
  const result = await client.result('r1');
  assert.equal(result.completion, undefined);
  assert.equal(result.completionError, undefined);
  assert.equal(result.completionSource, undefined);
});
