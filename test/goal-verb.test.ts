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
      return ok({ sessionId: 's1', runtime: 'pi', status: 'running', objective: 'O' });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  const body = await client.goalStart('s1', {
    objective: 'Do the bounded thing',
    maxTurns: 40,
    verifyCommand: 'tail -n1 done.md | grep -qx FROZEN',
    budgetTokens: 60_000_000,
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
  assert.equal((body as { status?: string }).status, 'running');
});

test('client.goalStart omits unset optionals (server schemas are strict)', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const transport = {
    request: async (_method: string, _path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ body: options.body ?? {} });
      return ok({ sessionId: 's1', status: 'running' });
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, randomId: () => 'k1' });
  await client.goalStart('s1', { objective: 'O' });
  const call = calls[0];
  assert.ok(call, 'exactly one goal-control call');
  assert.deepEqual(call.body, { action: 'start', objective: 'O' });
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
