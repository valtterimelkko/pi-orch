import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateBody, buildPromptBody } from '../src/builders.ts';
import { COMPLETION_REPORT_INSTRUCTION, applyCompletionTemplate } from '../src/completion-template.ts';

/**
 * C3b item 1: the template rides by default on every `prompt` message and on a
 * goal objective at `spawn`; `completionTemplate: false` (CLI
 * `--no-completion-template`) opts out. Injection lives in the pure builders,
 * so the client and CLI stay thin and the conformance tests stay server-free.
 */


function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

test('create: a goal objective carries the SINGLE-LINE template pointer by default (server rejects multi-line objectives)', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  const goal = body.goal as { objective: string };
  assert.ok(!goal.objective.includes('\n'), 'single line');
  assert.ok(goal.objective.startsWith('Ship the fix '));
  assert.ok(goal.objective.includes('pi-completion/v1'), 'pointer names the schema');
});

test('create: completionTemplate:false leaves the goal objective untouched', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', completionTemplate: false, goal: { objective: 'Ship the fix' } });
  const goal = body.goal as { objective: string };
  assert.equal(goal.objective, 'Ship the fix');
});

test('create: an objective that would overflow the server 4000-char limit with the template fails with a clear opt-out error', () => {
  const long = 'x'.repeat(3400);
  assert.throws(
    () => buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: long } }),
    /completionTemplate|no-completion-template/,
  );
});

test('create: a non-goal spawn carries no template (there is no task text at spawn)', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w' });
  assert.equal('goal' in body, false);
});

test('prompt: the message carries the template by default', () => {
  const body = buildPromptBody({ message: 'Please run the suite' }, () => 'k1');
  assert.equal(body.message, `Please run the suite\n\n${COMPLETION_REPORT_INSTRUCTION}`);
});

test('prompt: completionTemplate:false leaves the message untouched', () => {
  const body = buildPromptBody({ message: 'status?', completionTemplate: false }, () => 'k1');
  assert.equal(body.message, 'status?');
});

test('prompt: a message that already contains the template is not double-appended', () => {
  const message = applyCompletionTemplate('Please run the suite');
  const body = buildPromptBody({ message }, () => 'k1');
  assert.equal(body.message, message);
  assert.equal([...body.message.matchAll(/END-OF-TASK REPORT/g)].length, 1);
});

// ─── C3b correction: goal objectives are single-line on the server ──────────

import { PiOrchClient } from '../src/client.ts';
import type { TransportResponse } from '../src/transport.ts';

test('create: the goal objective stays SINGLE-LINE (server rule) with a flattened template pointer', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  const goal = body.goal as { objective: string };
  assert.ok(!goal.objective.includes('\n'), `no newlines in the objective (got: ${JSON.stringify(goal.objective.slice(0, 120))})`);
  assert.ok(goal.objective.startsWith('Ship the fix '));
  assert.ok(goal.objective.includes('pi-completion/v1'), 'the pointer still names the schema');
  assert.ok(goal.objective.includes('follow-up'), 'the pointer says the full instructions arrive as a follow-up');
});

test('client.spawn with a goal: delivers the VERBATIM template as a follow_up prompt after create', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path === '/api/v1/sessions') {
        return ok({ sessionId: 's-goal', leaseId: 'l1', goal: { armed: true }, retention: { leaseId: 'l1' } });
      }
      return ok({ runId: 'r-follow', sessionId: 's-goal', detached: true, dispatchMode: 'follow_up' });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  assert.equal(calls[0]?.path, '/api/v1/sessions');
  assert.equal(calls[1]?.path, '/api/v1/sessions/s-goal/prompt');
  assert.equal(calls[1]?.body.mode, 'follow_up', 'the template rides as a queued follow-up (arm-turn safe)');
  assert.ok(
    String(calls[1]?.body.message).includes(COMPLETION_REPORT_INSTRUCTION),
    'the follow-up carries the VERBATIM paragraph',
  );
  assert.ok(String(calls[1]?.body.message).includes('Ship the fix'), 'the follow-up names the goal task');
  assert.equal((spawned as { templateFollowUpRunId?: string }).templateFollowUpRunId, 'r-follow');
});

test('client.spawn with a goal and completionTemplate:false: no pointer, no follow-up', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path === '/api/v1/sessions') return ok({ sessionId: 's2', retention: {} });
      throw new Error('no second call expected');
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', completionTemplate: false, goal: { objective: 'Ship the fix' } });
  assert.equal(calls.length, 1, 'only the create call');
  const goal = (calls[0]?.body as { goal?: { objective?: string } }).goal as { objective: string };
  assert.equal(goal.objective, 'Ship the fix');
});

test('client.spawn without a goal: no follow-up (prompt template unaffected)', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (_method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      return ok({ sessionId: 's3', retention: {} });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  assert.equal(calls.length, 1, 'only the create call');
});
