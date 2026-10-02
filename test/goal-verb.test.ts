import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, type CliDeps } from '../src/cli.ts';
import { PiOrchClient } from '../src/client.ts';
import type { TransportResponse } from '../src/transport.ts';

/**
 * J2 P2: the `goal` verb — the H-b parent pattern arms the goal AFTER create
 * (dispatch-hb.py `goal` mode: POST /sessions/:id/goal with action start,
 * objective, maxTurns, verifyCommand, budgetTokens). pi-orch had no way to do
 * this: the Phase A replay receipt is `pi-orch goal ...` → exit 2 "unknown
 * verb". Start-only by design decision (01-answer.md): the scripts only arm;
 * pause/resume/clear stay interactive.
 */

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

function fakeDeps(client: ReturnType<typeof runCli> extends never ? never : NonNullable<CliDeps['client']>): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'test-key-123',
    client,
  };
}

test('client.goalStart POSTs the goal-control start body with the budget', async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ method, path, body: options.body ?? {} });
      return ok({ sessionId: 's1', runtime: 'pi', action: 'start', accepted: true, applied: true, receipt: { runId: 'r1' }, goal: { status: 'running', objective: 'O', budget: { tokens: 60_000_000 } } });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  const body = await client.goalStart('s1', {
    objective: 'Do the bounded thing',
    maxTurns: 40,
    verifyCommand: 'tail -n1 done.md | grep -qx FROZEN',
    budgetTokens: 60_000_000,
    completionTemplate: false, // exact-body pin; the templating path has its own test below
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call, 'exactly one goal-control call');
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/v1/sessions/s1/goal');
  assert.deepEqual(call.body, {
    action: 'start',
    objective: 'Do the bounded thing',
    maxTurns: 40,
    verifyCommand: 'tail -n1 done.md | grep -qx FROZEN',
    budgetTokens: 60_000_000,
  });
  assert.equal((body as { status?: string }).status, 'running', 'the goal projection status is surfaced at the top level');
  assert.equal((body as { accepted?: boolean }).accepted, true);
  assert.equal((body as { runId?: string }).runId, 'r1', 'the arm receipt runId is surfaced for wait/result');
  assert.equal((body as { goal?: { budget?: { tokens?: number } } }).goal?.budget?.tokens, 60_000_000, 'the full projection stays available under goal');
});

test('client.goalStart omits unset optionals (server schemas are strict)', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const transport = {
    request: async (_method: string, _path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ body: options.body ?? {} });
      return ok({ sessionId: 's1', action: 'start', accepted: true, applied: true, receipt: { runId: 'arm-1' }, goal: { status: 'running' } });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  await client.goalStart('s1', { objective: 'O', completionTemplate: false });
  const call = calls[0];
  assert.ok(call, 'exactly one goal-control call');
  assert.deepEqual(call.body, { action: 'start', objective: 'O' });
});

test('CLI: goal start human output names the accepted action and arm run', async () => {
  const result = await runCli(
    ['goal', 's1', 'start', '--goal-objective', 'O', '--json'],
    fakeDeps(() => ({ goalStart: async () => ({ sessionId: 's1', accepted: true, applied: true, runId: 'r-9', status: 'running' }) }) as never),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? '', /"accepted": true/);
});

test('CLI: goal <sid> start arms the goal through the client and exits 0', async () => {
  const seen: Array<{ method: string; input: unknown }> = [];
  const result = await runCli(
    ['goal', 's1', 'start', '--goal-objective', 'Do the bounded thing', '--goal-max-turns', '40', '--goal-verify', 'true', '--goal-budget-tokens', '60000000', '--json'],
    fakeDeps(() => ({
      goalStart: async (sessionId: string, input: unknown) => {
        seen.push({ method: 'goalStart', input: { sessionId, input } });
        return { sessionId, status: 'running', objective: 'Do the bounded thing' };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  assert.equal(seen.length, 1);
  const payload = (seen[0] as { input: { input: { budgetTokens?: number; maxTurns?: number } } }).input.input;
  assert.equal(payload.budgetTokens, 60_000_000);
  assert.equal(payload.maxTurns, 40);
  assert.ok((result.stdout ?? '').includes('"status": "running"'), '--json prints the goal projection');
});

test('CLI: goal start requires --goal-objective (usage error, client untouched)', async () => {
  let called = 0;
  const result = await runCli(
    ['goal', 's1', 'start'],
    fakeDeps(() => {
      called += 1;
      return {} as never;
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(called, 0, 'usage validation happens before the client factory');
});

test('CLI: goal start is the only action (pause/resume/clear stay interactive)', async () => {
  for (const action of ['pause', 'resume', 'clear']) {
    const result = await runCli(['goal', 's1', action], fakeDeps(() => ({}) as never));
    assert.equal(result.exitCode, 2, `goal ${action} must be a usage error`);
    assert.ok((result.stderr ?? '').includes('start'), `stderr names the supported action (goal ${action})`);
  }
});

test('CLI: goal start without --goal-budget-tokens notes the 5M default on stderr (not an error)', async () => {
  const result = await runCli(
    ['goal', 's1', 'start', '--goal-objective', 'O'],
    fakeDeps(() => ({ goalStart: async () => ({ sessionId: 's1', status: 'running' }) }) as never),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr ?? '', /5,000,000/, 'the note names the default budget');
});

test('CLI: spawn --goal-objective without --goal-budget-tokens notes the 5M default too', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/x', '--goal-objective', 'O', '--json'],
    fakeDeps(() => ({ spawn: async () => ({ sessionId: 's1', raw: {} }) }) as never),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr ?? '', /5,000,000/);
});

test('CLI: spawn WITH --goal-budget-tokens passes the budget and stays note-free', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/x', '--goal-objective', 'O', '--goal-budget-tokens', '60000000', '--json'],
    fakeDeps(() => ({
      spawn: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { sessionId: 's1', raw: {} };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0);
  const goal = (seen[0]?.goal ?? {}) as { budgetTokens?: number };
  assert.equal(goal.budgetTokens, 60_000_000, 'the budget reaches the create body');
  assert.equal(result.stderr, undefined, 'no default-budget note when the flag is given');
});

// ─── 02-correction [major] 1: shared goal-field validation ───────────────────
// Luna's probe: goalStart sent budgetTokens 1000000000000 unchanged — the
// create-time validation never ran on the goal verb. One validator, both paths,
// CLI exits 2 BEFORE any request.

test('02-correction 1: goal start rejects an out-of-range budget locally (exit 2, no request)', async () => {
  let called = 0;
  const result = await runCli(
    ['goal', 's1', 'start', '--goal-objective', 'O', '--goal-budget-tokens', '1000000000000'],
    fakeDeps(() => {
      called += 1;
      return { goalStart: async () => ({}) } as never;
    }),
  );
  assert.equal(result.exitCode, 2, 'usage-class error, not a transport error');
  assert.match(result.stderr ?? '', /budget/);
  assert.equal(called, 0, 'validation happens before the client factory');
});

test('02-correction 1: client.goalStart rejects an out-of-range budget before any request', async () => {
  const transport = {
    request: async () => {
      throw new Error('request must never be made');
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  await assert.rejects(
    client.goalStart('s1', { objective: 'O', budgetTokens: 1_000_000_000_000 }),
    /budget/,
  );
});

test('02-correction 1: spawn rejects the same budget shape before the client factory', async () => {
  let called = 0;
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/x', '--goal-objective', 'O', '--goal-budget-tokens', '1000000000000'],
    fakeDeps(() => {
      called += 1;
      return { spawn: async () => ({ sessionId: 's1', raw: {} }) } as never;
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(called, 0);
});

// ─── 02-correction [major] 3: goal start delivers the goal template ──────────

test('02-correction 3: goal start templates the objective and delivers the follow-up once', async () => {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ method, path, body: options.body });
      if (path.endsWith('/goal')) {
        return ok({ sessionId: 's1', runtime: 'pi', action: 'start', accepted: true, applied: true, receipt: { runId: 'arm-1' }, goal: { status: 'running', objective: 'templated' } });
      }
      if (path === '/api/v1/sessions/s1') {
        return ok({ sessionId: 's1', runtime: 'pi', busy: false, status: 'idle' });
      }
      if (path.endsWith('/prompt')) {
        return ok({ runId: 'tpl-1', sessionId: 's1', detached: true, duplicate: false, dispatchMode: 'follow_up' });
      }
      if (path.startsWith('/api/v1/runs/')) {
        return ok({ runId: 'tpl-1', status: 'queued' });
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  const body = await client.goalStart('s1', { objective: 'Do the bounded thing' });
  const goalCall = calls.find((call) => call.path?.endsWith('/goal'));
  assert.ok(goalCall, 'goal control was called');
  assert.match(String((goalCall?.body as { objective?: string }).objective), /pi-completion\/v1/, 'the objective carries the flattened completion pointer');
  const promptCalls = calls.filter((call) => call.path?.endsWith('/prompt'));
  assert.equal(promptCalls.length, 1, 'the template follow-up is delivered exactly once');
  assert.equal((body as { templateFollowUpRunId?: string }).templateFollowUpRunId, 'tpl-1');
});

test('02-correction 3: goal start with completionTemplate false stays raw (no follow-up)', async () => {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const transport = {
    request: async (_method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body });
      if (path.endsWith('/goal')) return ok({ sessionId: 's1', action: 'start', accepted: true, applied: true, receipt: { runId: 'arm-1' }, goal: { status: 'running' } });
      throw new Error(`unexpected ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  const body = await client.goalStart('s1', { objective: 'Raw objective', completionTemplate: false });
  assert.equal(calls.filter((call) => call.path?.endsWith('/prompt')).length, 0, 'no follow-up without the template');
  const goalCall = calls.find((call) => call.path?.endsWith('/goal'));
  assert.ok(goalCall, 'goal control was called');
  assert.equal((goalCall.body ?? {}).objective, 'Raw objective', 'objective untouched');
  assert.equal((body as { templateFollowUpRunId?: string }).templateFollowUpRunId, undefined);
});

test('02-correction 3: CLI goal start reports TEMPLATE_NOT_DELIVERED exit 22 when the follow-up fails', async () => {
  const result = await runCli(
    ['goal', 's1', 'start', '--goal-objective', 'O', '--json'],
    fakeDeps(() => ({
      goalStart: async () => ({ sessionId: 's1', accepted: true, applied: true, runId: 'arm-1', status: 'running', raw: { __templateFollowUpError: 'RUNTIME_ERROR: agent busy' } }),
    }) as never),
  );
  assert.equal(result.exitCode, 22);
  assert.match(result.stderr ?? '', /TEMPLATE_NOT_DELIVERED/);
});

test('02-correction 3: CLI goal start accepts --no-completion-template', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(
    ['goal', 's1', 'start', '--goal-objective', 'O', '--no-completion-template', '--json'],
    fakeDeps(() => ({
      goalStart: async (_sessionId: string, input: Record<string, unknown>) => {
        seen.push(input);
        return { sessionId: 's1', accepted: true, applied: true };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  assert.equal(seen[0]?.completionTemplate, false);
});
