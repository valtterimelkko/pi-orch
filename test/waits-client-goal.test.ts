import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiOrchClient } from '../src/client.ts';
import { runCli, type CliDeps } from '../src/cli.ts';
import type { TransportResponse } from '../src/transport.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * C3b correction 01 item 1: goal auto-detect is bypassed by early defaults.
 * `PiOrchClient.wait()` and the CLI filled in default `agent_end` conditions
 * BEFORE waitOnChild could detect a goal, so `pi-orch wait <sessionId>` on a
 * goal child never watched goal_end — the parent's brief default produced the
 * early false `completed` the carried-over item exists to kill. Fix: keep
 * "no conditions supplied" as undefined until goal detection has run; apply
 * defaults only AFTER it (goal conditions if active/running, plain otherwise).
 * These tests exercise the CLIENT and CLI layers, not just waitOnChild.
 */

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

test('client.wait on a goal child (no objective/conditions): watches goal_end/paused and settles on the goal outcome', async () => {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let goalReads = 0;
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ method, path, body: options.body });
      if (path === '/api/v1/sessions/s1') return ok({ sessionId: 's1', busy: false });
      if (path === '/api/v1/sessions/s1/watch' && method === 'GET') {
        return { status: 404, headers: {}, body: { code: 'NOT_FOUND' }, raw: '{}' };
      }
      if (path === '/api/v1/sessions/s1/goal') {
        goalReads += 1;
        return ok({ supported: true, status: goalReads === 1 ? 'running' : 'achieved', objective: 'Ship it' });
      }
      if (path === '/api/v1/sessions/s1/watch' && method === 'POST') return ok({ watchId: 'w1', status: 'active' });
      if (path.startsWith('/api/v1/watches/wait')) return { status: 204, headers: {}, body: undefined, raw: '' };
      if (path === '/api/v1/sessions/s1/evidence') return ok({ runChronology: [{ runId: 'r9', status: 'completed' }] });
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, waitSliceMs: 50, waitDeadlineMs: 5_000 });
  const outcome = await client.wait({ sessionId: 's1' });
  assert.equal(outcome.kind, 'goal_achieved', JSON.stringify(outcome));
  assert.ok((outcome as { note?: string }).note?.includes('auto-detected'), `note: ${(outcome as { note?: string }).note}`);
  assert.ok(goalReads >= 1, 'at least one goal read');
  const registration = calls.find((call) => call.path === '/api/v1/sessions/s1/watch' && call.method === 'POST');
  const conditions = (registration?.body as { conditions: Array<Record<string, unknown>> } | undefined)?.conditions ?? [];
  const eventTypes = conditions.map((condition) => condition.eventType ?? 'deadline');
  assert.deepEqual(eventTypes, ['goal_end', 'goal_state', 'goal_state', 'deadline'], `registered: ${JSON.stringify(eventTypes)}`);
  const goalEnd = conditions.find((condition) => condition.eventType === 'goal_end') as { dataMatch?: { objective?: string } };
  assert.equal(goalEnd.dataMatch?.objective, 'Ship it', 'goal_end matched on the projection objective');
  const autoContinue = conditions.find((condition) => condition.eventType === 'goal_state' && (condition.dataMatch as Record<string, unknown> | undefined)?.['interruption.autoContinued'] === true) as { dataMatch?: Record<string, unknown> } | undefined;
  assert.ok(autoContinue, 'the Wave K auto-continue goal_state condition is registered (auto-detected goal path)');
  assert.equal(autoContinue?.dataMatch?.objective, 'Ship it', 'the auto-continue condition keeps the objective filter');
});

test('CLI wait without --objective/--conditions leaves conditions undefined so waitOnChild can detect the goal', async () => {
  let captured: Record<string, unknown> | undefined;
  const deps: CliDeps = {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'k',
    client: () => ({
      async wait(options: Record<string, unknown>) {
        captured = options;
        return { kind: 'goal_achieved' };
      },
    }) as never,
  };
  const result = await runCli(['wait', 's1'], deps);
  assert.equal(result.exitCode, 0);
  assert.equal(captured?.conditions, undefined, 'no pre-baked defaults; detection runs first');
  assert.equal(captured?.objective, undefined);
});

test('CLI wait --objective still passes the objective (and no fabricated conditions)', async () => {
  let captured: Record<string, unknown> | undefined;
  const deps: CliDeps = {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'k',
    client: () => ({
      async wait(options: Record<string, unknown>) {
        captured = options;
        return { kind: 'goal_achieved' };
      },
    }) as never,
  };
  const result = await runCli(['wait', 's1', '--objective', 'Ship it'], deps);
  assert.equal(result.exitCode, 0);
  assert.equal(captured?.objective, 'Ship it');
  assert.equal(captured?.conditions, undefined, 'waitOnChild applies goal conditions for an explicit objective');
});
