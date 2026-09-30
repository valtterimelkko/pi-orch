import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiOrchClient } from '../src/client.ts';
import { ApiError } from '../src/parsers.ts';
import type { TransportResponse } from '../src/transport.ts';

/**
 * Live-found race (C1 proof, 2026-09-29): a create-time goal arms a detached
 * goal-start turn, so the first prompt to a fresh goal-armed child can hit
 * 409 SESSION_BUSY (Retry-After: 2). The client offers an explicit,
 * bounded convenience: followUpOnBusy retries ONCE in follow_up mode (which
 * queues on a busy Pi session and delivers after the current turn), instead of
 * leaving every parent to hand-code that recovery.
 */

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

test('prompt with followUpOnBusy retries once in follow_up mode after 409 SESSION_BUSY', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path.endsWith('/prompt') && calls.length === 1) {
        throw new ApiError(409, 'SESSION_BUSY', 'Session is currently busy', { retryAfterSeconds: 2 });
      }
      return ok({ runId: 'r1', sessionId: 's1', detached: true, status: 'accepted', dispatchMode: calls.length > 1 ? 'follow_up' : 'prompt' });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  const result = await client.prompt('s1', { message: 'go', followUpOnBusy: true });
  assert.equal(result.runId, 'r1');
  assert.equal(result.dispatchMode, 'follow_up');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.body.mode, 'follow_up');
  assert.equal(calls[1]?.body.message, 'go');
});

test('without followUpOnBusy the 409 propagates to the caller', async () => {
  const transport = {
    request: async () => {
      throw new ApiError(409, 'SESSION_BUSY', 'Session is currently busy', { retryAfterSeconds: 2 });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  await assert.rejects(
    client.prompt('s1', { message: 'go' }),
    (error: { code?: string }) => error.code === 'SESSION_BUSY',
  );
});

test('followUpOnBusy does not mask other 409 codes', async () => {
  let calls = 0;
  const transport = {
    request: async () => {
      calls += 1;
      throw new ApiError(409, 'SESSION_OWNED_BY_OTHER_RUNTIME', 'owned elsewhere');
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  await assert.rejects(
    client.prompt('s1', { message: 'go', followUpOnBusy: true }),
    (error: { code?: string }) => error.code === 'SESSION_OWNED_BY_OTHER_RUNTIME',
  );
  assert.equal(calls, 1, 'no retry for non-busy 409s');
});
