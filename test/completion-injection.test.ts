import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateBody, buildPromptBody } from '../src/builders.ts';
import { COMPLETION_REPORT_INSTRUCTION, applyCompletionTemplate } from '../src/completion-template.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

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
  // I5 correction 01: the pointer suffix is ≤ 700 chars, so the overflow
  // boundary sits near 3,300 accepted / ~3,690 rejected; 3,900 still overflows.
  const long = 'x'.repeat(3900);
  assert.throws(
    () => buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: long } }),
    /completionTemplate|no-completion-template/,
  );
});

test('I5 correction 01: a 3,300-char raw objective is accepted and the stored objective stays ≤ 4000 (boundary regression)', () => {
  // Review minor: the I5 pointer suffix initially grew to 1,280 chars, so a
  // 3,000-char plain objective that previously stored at 3,665 was rejected.
  // With the concise pointer the full 3,300-char range is accepted again.
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'y'.repeat(3300) } });
  const goal = body.goal as { objective: string };
  assert.ok(goal.objective.length <= 4000, `stored objective is ${goal.objective.length} chars`);
  assert.ok(goal.objective.startsWith('y'.repeat(100)), 'objective preserved verbatim at the start');
  assert.ok(!goal.objective.includes('\n'), 'still single line');
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
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1' });
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  assert.equal(calls[0]?.path, '/api/v1/sessions');
  // G1: the prompt-side route gate reads the child's detail between create and
  // dispatch; the template follow-up is still the first PROMPT after create.
  const followUp = calls.find((call) => call.path === '/api/v1/sessions/s-goal/prompt');
  assert.ok(followUp, 'a follow-up prompt followed the create');
  assert.equal(followUp?.body.mode, 'follow_up', 'the template rides as a queued follow-up (arm-turn safe)');
  assert.ok(
    String(followUp?.body.message).includes(COMPLETION_REPORT_INSTRUCTION),
    'the follow-up carries the VERBATIM paragraph',
  );
  assert.ok(String(followUp?.body.message).includes('Ship the fix'), 'the follow-up names the goal task');
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
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1' });
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
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1' });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w' });
  assert.equal(calls.length, 1, 'only the create call');
});

// ─── C3b live-found race: the queued follow-up can fail mid-arm-turn ─────────

test('client.spawn retries the template follow-up ONCE when the first delivery fails', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let followUpCount = 0;
  const runReceipts: Record<string, Record<string, unknown>> = {};
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path === '/api/v1/sessions') return ok({ sessionId: 's-goal', retention: { leaseId: 'l1' }, goal: { armed: true } });
      if (path.endsWith('/prompt')) {
        followUpCount += 1;
        const runId = `r-follow-${followUpCount}`;
        // The FIRST delivery fails at runtime (Pi refused mid-arm-turn); the retry succeeds.
        runReceipts[runId] = followUpCount === 1
          ? { runId, status: 'failed', errorCode: 'RUNTIME_ERROR' }
          : { runId, status: 'completed' };
        return ok({ runId, sessionId: 's-goal', detached: true, dispatchMode: 'follow_up' });
      }
      if (path.startsWith('/api/v1/runs/')) {
        const runId = path.split('/').pop() as string;
        return ok(runReceipts[runId]);
      }
      // G1: the prompt-side route gate reads the child's detail first.
      if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) return ok({ sessionId: 's-goal' });
      return ok({});
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  assert.equal(followUpCount, 2, 'exactly one retry');
  assert.equal((spawned as { templateFollowUpRunId?: string }).templateFollowUpRunId, 'r-follow-2');
  assert.equal((spawned.raw as { __templateFollowUpRetried?: boolean }).__templateFollowUpRetried, true);
  assert.equal((spawned.raw as { __templateFollowUpFirstRunId?: string }).__templateFollowUpFirstRunId, 'r-follow-1');
});

// ─── I1 criterion 1: a NON-TERMINAL first receipt is healthy — no re-send ───

// Root cause (r4/rootcause-empty-cancelled.md Mechanism B): the +3s health
// read classified ANY status except completed/started as failed, so a `queued`
// follow-up (the normal state while the arm turn is still busy) was sent a
// SECOND time; both copies drained in one loop and the second stayed `queued`
// forever, then cancelled at cleanup — 6 of G5's 13 bad receipts. The retry is
// for TERMINAL failures only: `failed` (any code, incl. NEVER_STARTED),
// `cancelled`, `interrupted` (never delivered). `accepted`, `queued`,
// `started`, `completed`, an unreadable receipt and any unknown status are
// healthy and never re-sent.

async function spawnWithFirstReceiptStatus(firstStatus: Record<string, unknown>): Promise<{ followUpCount: number; spawned: { templateFollowUpRunId?: string; raw: Record<string, unknown> } }> {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let followUpCount = 0;
  const runReceipts: Record<string, Record<string, unknown>> = {};
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path === '/api/v1/sessions') return ok({ sessionId: 's-goal', retention: { leaseId: 'l1' }, goal: { armed: true } });
      if (path.endsWith('/prompt')) {
        followUpCount += 1;
        const runId = `r-follow-${followUpCount}`;
        runReceipts[runId] = followUpCount === 1 ? firstStatus : { runId, status: 'completed' };
        return ok({ runId, sessionId: 's-goal', detached: true, dispatchMode: 'follow_up' });
      }
      if (path.startsWith('/api/v1/runs/')) {
        const runId = path.split('/').pop() as string;
        return ok(runReceipts[runId]);
      }
      if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) return ok({ sessionId: 's-goal' });
      return ok({});
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  return { followUpCount, spawned: spawned as { templateFollowUpRunId?: string; raw: Record<string, unknown> } };
}

test('I1: a queued first template receipt is healthy — NO second send (the G5 duplicate-template defect)', async () => {
  const { followUpCount, spawned } = await spawnWithFirstReceiptStatus({ runId: 'r-follow-1', status: 'queued' });
  assert.equal(followUpCount, 1, 'exactly one template follow-up for a queued receipt');
  assert.equal(spawned.templateFollowUpRunId, 'r-follow-1');
  assert.equal(spawned.raw.__templateFollowUpRetried, undefined, 'no retry recorded');
});

test('I1: an accepted first template receipt is healthy — no second send', async () => {
  const { followUpCount, spawned } = await spawnWithFirstReceiptStatus({ runId: 'r-follow-1', status: 'accepted' });
  assert.equal(followUpCount, 1);
  assert.equal(spawned.templateFollowUpRunId, 'r-follow-1');
  assert.equal(spawned.raw.__templateFollowUpRetried, undefined);
});

test('I1: a started first template receipt is healthy — no second send', async () => {
  const { followUpCount } = await spawnWithFirstReceiptStatus({ runId: 'r-follow-1', status: 'started' });
  assert.equal(followUpCount, 1);
});

test('I1: a failed first template receipt still causes exactly ONE retry', async () => {
  const { followUpCount, spawned } = await spawnWithFirstReceiptStatus({ runId: 'r-follow-1', status: 'failed', errorCode: 'RUNTIME_ERROR' });
  assert.equal(followUpCount, 2, 'failed delivery is retried exactly once');
  assert.equal(spawned.templateFollowUpRunId, 'r-follow-2');
  assert.equal(spawned.raw.__templateFollowUpRetried, true);
});

test('I1: a never-started first template receipt (failed + NEVER_STARTED) is retried once', async () => {
  const { followUpCount } = await spawnWithFirstReceiptStatus({ runId: 'r-follow-1', status: 'failed', errorCode: 'NEVER_STARTED' });
  assert.equal(followUpCount, 2, 'a never-started delivery is a terminal failure: retry once');
});

test('I1: a cancelled first template receipt without startedAt is retried once (never delivered)', async () => {
  const { followUpCount } = await spawnWithFirstReceiptStatus({ runId: 'r-follow-1', status: 'cancelled' });
  assert.equal(followUpCount, 2, 'cancelled before delivery is a terminal failure: retry once');
});

test('I1: an interrupted first template receipt without startedAt is retried once (never delivered)', async () => {
  const { followUpCount } = await spawnWithFirstReceiptStatus({ runId: 'r-follow-1', status: 'interrupted', interruptionReason: 'server_restart' });
  assert.equal(followUpCount, 2, 'interrupted before delivery is a terminal failure: retry once');
});

// ─── Correction 01: startedAt proves DELIVERY — never re-send a delivered ────
// ─── template ────────────────────────────────────────────────────────

// The server marks the queued follow-up `started` at the matching user
// message_start (internal-api/routes/sessions.ts queue-observer), so a
// cancelled/interrupted receipt that carries startedAt means the template's
// user message WAS observed before a restart/cancel cut the run off — the
// child already has it. Resending duplicates the template: the exact defect
// I1 removes. Retry those receipts only WITHOUT startedAt. `failed` stays an
// unconditional retry (it covers NEVER_STARTED — no delivery possible).

test('I1 correction 01: an interrupted receipt WITH startedAt was delivered — NO second send', async () => {
  const { followUpCount, spawned } = await spawnWithFirstReceiptStatus({
    runId: 'r-follow-1', status: 'interrupted', interruptionReason: 'server_restart', startedAt: '2026-10-01T13:49:05Z',
  });
  assert.equal(followUpCount, 1, 'delivered then interrupted: the child has the template');
  assert.equal(spawned.raw.__templateFollowUpRetried, undefined, 'no retry recorded');
});

test('I1 correction 01: a cancelled receipt WITH startedAt was delivered — NO second send', async () => {
  const { followUpCount, spawned } = await spawnWithFirstReceiptStatus({
    runId: 'r-follow-1', status: 'cancelled', startedAt: '2026-10-01T13:49:05Z',
  });
  assert.equal(followUpCount, 1, 'delivered then cancelled: the child has the template');
  assert.equal(spawned.raw.__templateFollowUpRetried, undefined, 'no retry recorded');
});

test('client.spawn does not retry when the first follow-up run is healthy', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path === '/api/v1/sessions') return ok({ sessionId: 's-goal', retention: {} });
      if (path.endsWith('/prompt')) return ok({ runId: 'r-ok', sessionId: 's-goal', detached: true });
      return ok({ runId: 'r-ok', status: 'completed' });
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship it' } });
  assert.equal(calls.filter((call) => call.path.endsWith('/prompt')).length, 1);
  assert.equal((spawned as { templateFollowUpRunId?: string }).templateFollowUpRunId, 'r-ok');
});

// ─── I5: the goal forms carry the marker instruction; plain forms unchanged ──

test('I5: a goal objective built by the builder carries the marker instruction (single line, 4000-bounded)', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  const goal = body.goal as { objective: string };
  assert.ok(goal.objective.includes('Status: GOAL_ACHIEVED'), 'builder goal objective carries the achieved marker form');
  assert.ok(goal.objective.includes('Status: CONTINUING'), 'builder goal objective carries the continuing marker form');
  assert.ok(!goal.objective.includes('\n'), 'still single line');
  assert.ok(goal.objective.length <= 4000, `objective is ${goal.objective.length} chars (limit 4000)`);
  assert.ok(!COMPLETION_REPORT_INSTRUCTION.includes('GOAL_ACHIEVED'), 'the plain template text itself stays marker-free');
});

test('I5: the goal template follow-up carries the marker instruction and the field shapes', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (_method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path === '/api/v1/sessions') return ok({ sessionId: 's-goal', leaseId: 'l1', goal: { armed: true }, retention: { leaseId: 'l1' } });
      if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) return ok({ sessionId: 's-goal' });
      return ok({ runId: 'r-follow', sessionId: 's-goal', detached: true, dispatchMode: 'follow_up' });
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  const followUp = calls.find((call) => call.path === '/api/v1/sessions/s-goal/prompt');
  assert.ok(followUp, 'a follow-up prompt followed the create');
  const message = String(followUp?.body.message);
  assert.ok(message.includes('Status: GOAL_ACHIEVED'), 'follow-up carries the exact achieved form');
  assert.ok(message.includes('Status: CONTINUING'), 'follow-up carries the exact continuing form');
  assert.ok(/immediately before the report block/i.test(message), 'follow-up states the placement');
  assert.ok(message.includes('"tests":[{"name"'), 'follow-up shows the tests array-of-objects shape');
  assert.ok(message.includes('"commits":[{"sha"'), 'follow-up shows the commits shape');
  assert.ok(message.includes('"openIssues":['), 'follow-up shows the openIssues shape');
  assert.ok(message.includes('"blockedReason":"'), 'follow-up shows the blockedReason shape');
});
