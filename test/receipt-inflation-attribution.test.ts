/**
 * H3a — receipt inflation from refused-prompt retries (attribution pin).
 *
 * G3 measured that one `pi-orch prompt` call under admission pressure can
 * leave up to 3 run receipts on the same session: every refused attempt
 * (429/503 + Retry-After) leaves a cancelled ADMISSION_CAPACITY_EXHAUSTED
 * (or SERVER_DRAINING) receipt whose idempotency key the server releases
 * (rejectBeforeDispatch → clearIdempotency), so the retry creates a NEW
 * receipt even under the SAME key.
 *
 * H3a's frozen criterion 1 asks WHY: does the client send a new idempotency
 * key per attempt, or does the server release the key and receipt every
 * attempt anyway? These tests pin the client half of that answer: ONE logical
 * prompt() call generates exactly ONE idempotency key and re-sends it on
 * every transport-level Retry-After retry (and on the followUpOnBusy 409
 * retry). Key multiplication therefore cannot originate in pi-orch; the
 * per-attempt receipts are server-side (receipt created at beginRun before
 * the admission check; key released on refusal). The full attribution and
 * the proposed server change live in the lane's hand-back (01-question.md).
 *
 * Characterization tests: no behaviour change, so there is no RED→GREEN
 * pair; their power is proven by mutation (a build that regenerates the key
 * per attempt fails these tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiOrchClient } from '../src/client.ts';
import { ApiError } from '../src/parsers.ts';
import { Transport } from '../src/transport.ts';
import type { TransportResponse } from '../src/transport.ts';

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

function admissionRefusal(status: 429 | 503, code: string, retryAfter: string): TransportResponse {
  return { status, headers: { 'retry-after': retryAfter }, body: { error: 'refused', code }, raw: '' };
}

test('h3a: one prompt() call sends the SAME idempotency key on every Retry-After retry', async () => {
  const attempts: Array<{ method: string; path: string; body?: unknown }> = [];
  let promptAttempts = 0;
  const transport = new Transport({
    apiBase: 'http://127.0.0.1:1',
    token: 't',
    retry: { maxAttempts: 3, maxTotalWaitMs: 120_000, sleep: async () => {} },
  });
  (transport as unknown as { requestOnce: unknown }).requestOnce = async (
    method: string,
    path: string,
    options: { body?: unknown } = {},
  ) => {
    attempts.push({ method, path, body: options.body });
    // G1: the prompt-side route gate reads the child's detail first; the
    // pinned behaviour below is about the PROMPT attempts.
    if (path.endsWith('/prompt')) {
      promptAttempts += 1;
      if (promptAttempts === 1) return admissionRefusal(429, 'ADMISSION_CAPACITY_EXHAUSTED', '2');
    }
    return ok({ runId: 'r1', sessionId: 's1', detached: true, status: 'accepted', dispatchMode: 'prompt' });
  };
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'h3a-fixed-key' });
  const result = await client.prompt('s1', { message: 'go', completionTemplate: false });
  assert.equal(result.runId, 'r1');
  assert.equal(promptAttempts, 2, 'exactly one transport-level retry after the 429');
  const promptPosts = attempts.filter((attempt) => attempt.path.endsWith('/prompt'));
  assert.equal(promptPosts.length, 2);
  assert.deepEqual(
    promptPosts.map((attempt) => (attempt.body as Record<string, unknown>).idempotencyKey),
    ['h3a-fixed-key', 'h3a-fixed-key'],
    'both attempts carry the SAME idempotency key — pi-orch does not multiply keys per attempt',
  );
  assert.deepEqual(
    promptPosts[0]?.body,
    promptPosts[1]?.body,
    'the retry re-sends the identical request body (same key, same message, same mode)',
  );
});

test('h3a: a 503 SERVER_DRAINING refusal is retried under the same key too', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let promptAttempts = 0;
  const transport = new Transport({
    apiBase: 'http://127.0.0.1:1',
    token: 't',
    retry: { maxAttempts: 3, maxTotalWaitMs: 120_000, sleep: async () => {} },
  });
  (transport as unknown as { requestOnce: unknown }).requestOnce = async (
    _method: string,
    path: string,
    options: { body?: unknown } = {},
  ) => {
    if (path.endsWith('/prompt')) {
      promptAttempts += 1;
      bodies.push(options.body as Record<string, unknown>);
      if (promptAttempts === 1) return admissionRefusal(503, 'SERVER_DRAINING', '30');
    }
    return ok({ runId: 'r2', sessionId: 's1', detached: true, status: 'accepted', dispatchMode: 'prompt' });
  };
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'h3a-key-503' });
  const result = await client.prompt('s1', { message: 'go', completionTemplate: false });
  assert.equal(result.runId, 'r2');
  assert.equal(promptAttempts, 2);
  assert.deepEqual(
    bodies.map((body) => body.idempotencyKey),
    ['h3a-key-503', 'h3a-key-503'],
  );
});

test('h3a: the followUpOnBusy 409 retry reuses the same idempotency key (one logical dispatch)', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let promptCalls = 0;
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path.endsWith('/prompt')) {
        promptCalls += 1;
        if (promptCalls === 1) throw new ApiError(409, 'SESSION_BUSY', 'Session is currently busy', { retryAfterSeconds: 2 });
      }
      return ok({ runId: 'r1', sessionId: 's1', detached: true, status: 'accepted', dispatchMode: 'follow_up' });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  await client.prompt('s1', { message: 'go', followUpOnBusy: true, completionTemplate: false });
  const keys = calls.filter((call) => call.path.endsWith('/prompt')).map((call) => call.body.idempotencyKey);
  assert.deepEqual(keys, ['k1', 'k1'], 'the single allowed 409 retry is part of the SAME logical dispatch');
});
