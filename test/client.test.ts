import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiOrchClient } from '../src/client.ts';
import { defaultConditions } from '../src/builders.ts';
import { ApiError } from '../src/parsers.ts';
import type { TransportResponse } from '../src/transport.ts';

test('defaultConditions: goal children get goal_end+paused+deadline and NO per-turn agent_end', () => {
  // goals.md: a per-turn agent_end on a goal-armed child fires at every turn
  // boundary, producing false wakes that read like completion — the wait must
  // not carry one (the real-parent proof hit exactly this: the goal-start
  // turn's agent_end ended the wait before the work was done).
  const goal = defaultConditions('Do the bounded thing', 300_000);
  assert.equal(goal.some((condition) => condition.eventType === 'agent_end'), false);
  assert.deepEqual(
    goal.filter((condition) => condition.type !== 'deadline').map((condition) => condition.eventType),
    ['goal_end', 'goal_state'],
  );
  const plain = defaultConditions(undefined, 300_000);
  assert.deepEqual(
    plain.map((condition) => condition.eventType ?? 'deadline'),
    ['agent_end', 'deadline'],
  );
});

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
  assert.ok(
    typeof calls[1]?.body.message === 'string' && String(calls[1]?.body.message).startsWith('go\n\nEND-OF-TASK REPORT'),
    'C3b: the retried follow_up carries the same (templated) message',
  );
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
