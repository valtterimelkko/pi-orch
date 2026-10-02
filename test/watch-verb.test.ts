import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, type CliDeps } from '../src/cli.ts';
import { PiOrchClient } from '../src/client.ts';
import type { TransportResponse } from '../src/transport.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * J2 P4: the `watch` verb — register/list/delete, NEVER waits. The H-b parent
 * pattern registers watches between create and goal (dispatch-hwave.py), and a
 * bare-CLI parent without the Claude watch-wake mod needs the same ability
 * from pi-orch: register, print the watchId, exit. 01-answer.md approved it so
 * the "no hand-written socket calls" victory stays honest.
 */

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

function fakeDeps(client: NonNullable<CliDeps['client']>): CliDeps {
  return { env: {}, stdout: () => undefined, stderr: () => undefined, randomId: () => 'test-key-123', client };
}

test('client.getWatch surfaces firings so a parent can read the wake back', async () => {
  const transport = {
    request: async () => ok({
      watchId: 'w-1',
      status: 'active',
      label: 'lane-x',
      firingCount: 2,
      allFired: true,
      firings: [{ conditionId: 'done', firedAt: '2026-10-02T11:00:00Z' }],
      conditions: [{ id: 'done', spec: { type: 'event_type', eventType: 'agent_end' } }],
    }),
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1' });
  const watch = await client.getWatch('s1');
  assert.equal(watch?.firingCount, 2);
  assert.equal(watch?.allFired, true);
  assert.equal((watch?.firings?.[0] as { conditionId?: string })?.conditionId, 'done');
});

test('CLI: watch <sid> register posts conditions, prints the watchId, never waits', async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const result = await runCli(
    ['watch', 's1', 'register', '--conditions', 'agent_end,deadline:600', '--label', 'lane-x', '--id-only'],
    fakeDeps(() => ({
      registerWatch: async (sessionId: string, input: { conditions: unknown[]; label?: string }) => {
        calls.push({ method: 'registerWatch', path: sessionId, body: input as Record<string, unknown> });
        return { watchId: 'w-1', status: 'active', raw: { watchId: 'w-1' } };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  assert.equal((result.stdout ?? '').trim(), 'w-1', '--id-only prints just the watchId');
  const registered = calls[0];
  assert.ok(registered, 'registerWatch was called once');
  const input = registered.body as { conditions: Array<{ type: string }>; label?: string };
  assert.equal(input.conditions.length, 2, 'both parsed conditions registered');
  const first = input.conditions[0];
  const second = input.conditions[1];
  assert.ok(first && second, 'both conditions parsed');
  assert.equal(first.type, 'event_type');
  assert.equal(second.type, 'deadline');
  assert.equal(input.label, 'lane-x');
});

test('CLI: watch register accepts --fire-if-settled and --pin', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(
    ['watch', 's1', 'register', '--conditions', 'agent_end', '--fire-if-settled', '--pin'],
    fakeDeps(() => ({
      registerWatch: async (_sessionId: string, input: Record<string, unknown>) => {
        seen.push(input);
        return { watchId: 'w-2', raw: { watchId: 'w-2' } };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0);
  const registered = seen[0];
  assert.ok(registered, 'registerWatch was called once');
  assert.equal(registered.fireIfSettled, true);
  assert.equal(registered.pin, true);
});

test('CLI: watch register needs --conditions (explicit over implicit for a never-waiting verb)', async () => {
  const result = await runCli(['watch', 's1', 'register'], fakeDeps(() => ({}) as never));
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? '', /--conditions/);
});

test('CLI: watch <sid> list reads the watch back and shows firings; delete removes it', async () => {
  const result = await runCli(
    ['watch', 's1', 'list', '--json'],
    fakeDeps(() => ({
      getWatch: async () => ({ watchId: 'w-1', status: 'done', label: 'lane-x', firingCount: 1, allFired: true, firings: [{ conditionId: 'done' }] }),
    }) as never),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? '', /"firingCount": 1/);

  let deleted = 0;
  const del = await runCli(
    ['watch', 's1', 'delete', '--json'],
    fakeDeps(() => ({
      getWatch: async () => ({ watchId: 'w-1', status: 'active', generation: 'G0', firingCount: 0 }),
      deleteWatch: async (_sessionId: string, options?: Record<string, unknown>) => {
        deleted += 1;
        assert.deepEqual(options, { expectedGeneration: 'G0' }, 'delete carries the observed generation (02-correction 2)');
        return { success: true, watchId: 'w-1', generation: 'G0' };
      },
    }) as never),
  );
  assert.equal(del.exitCode, 0);
  assert.equal(deleted, 1);
});

test('CLI: watch needs a subcommand (register|list|delete) and never blocks', async () => {
  const result = await runCli(['watch', 's1'], fakeDeps(() => ({}) as never));
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? '', /register|list|delete/);
  const bad = await runCli(['watch', 's1', 'await'], fakeDeps(() => ({}) as never));
  assert.equal(bad.exitCode, 2, 'the verb never waits — "await" is not a subcommand');
});

// ─── 02-correction [major] 2: generation-safe watch delete ───────────────────
// Wire (docs/INTERNAL-API.md, contract 1.35.0): DELETE accepts body
// {expectedGeneration}; a stale precondition returns 409 WATCH_GENERATION_MISMATCH
// with {expectedGeneration, currentGeneration} and leaves the watch unchanged.
// Luna: pi-orch's deleteWatch sent no body and could delete a REPLACED watch.

import { ApiError } from '../src/parsers.ts';
import { parseApiError } from '../src/parsers.ts';

test('02-correction 2: register and getWatch surface the generation', async () => {
  const transport = {
    request: async () => ok({ watchId: 'w-9', status: 'active', generation: 'gen-A', firingCount: 0 }),
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1' });
  const registered = await client.registerWatch('s1', { conditions: [{ id: 'd', type: 'event_type', eventType: 'agent_end', once: true }] });
  assert.equal(registered.generation, 'gen-A');
  const got = await client.getWatch('s1');
  assert.equal(got?.generation, 'gen-A');
});

test('02-correction 2: parseApiError carries the 409 body so both generations can be named', () => {
  const error = parseApiError(409, {
    error: 'generation mismatch',
    code: 'WATCH_GENERATION_MISMATCH',
    expectedGeneration: 'G1',
    currentGeneration: 'G2',
    watchId: 'w-1',
  });
  assert.equal((error as ApiError & { data?: Record<string, unknown> }).data?.currentGeneration, 'G2');
  assert.equal((error as ApiError & { data?: Record<string, unknown> }).data?.expectedGeneration, 'G1');
});

test('02-correction 2: replacement race — delete with the OBSERVED generation sends it and refuses on mismatch', async () => {
  const deletes: Array<Record<string, unknown> | undefined> = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      if (method === 'GET' && path.endsWith('/watch')) return ok({ watchId: 'w-1', generation: 'G1', firingCount: 0 });
      if (method === 'DELETE' && path.endsWith('/watch')) {
        deletes.push(options.body);
        throw parseApiError(409, {
          error: 'generation mismatch',
          code: 'WATCH_GENERATION_MISMATCH',
          expectedGeneration: 'G1',
          currentGeneration: 'G2',
          watchId: 'w-1',
        });
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1' });
  const watch = await client.getWatch('s1');
  await assert.rejects(
    client.deleteWatch('s1', { expectedGeneration: watch?.generation }),
    (error: { expectedGeneration?: string; currentGeneration?: string }) => error.expectedGeneration === 'G1' && error.currentGeneration === 'G2',
  );
  assert.deepEqual(deletes, [{ expectedGeneration: 'G1' }], 'exactly one conditional delete; G2 is untouched');
});

test('02-correction 2: CLI watch delete without --generation reads the generation first and reports it', async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const result = await runCli(
    ['watch', 's1', 'delete', '--json'],
    fakeDeps(() => ({
      getWatch: async () => ({ watchId: 'w-1', status: 'active', generation: 'G1', firingCount: 0 }),
      deleteWatch: async (_sessionId: string, options?: Record<string, unknown>) => {
        seen.push(options);
        return { success: true, watchId: 'w-1', generation: 'G1' };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  assert.deepEqual(seen[0], { expectedGeneration: 'G1' }, 'the observed generation guards the delete');
  assert.match(result.stdout ?? '', /"generation": "G1"/, 'confirmed cleanup names the exact generation');
});

test('02-correction 2: CLI watch delete --generation passes it through', async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const result = await runCli(
    ['watch', 's1', 'delete', '--generation', 'G-explicit', '--json'],
    fakeDeps(() => ({
      deleteWatch: async (_sessionId: string, options?: Record<string, unknown>) => {
        seen.push(options);
        return { success: true, watchId: 'w-1', generation: 'G-explicit' };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen[0], { expectedGeneration: 'G-explicit' });
});

test('02-correction 2: CLI watch delete on mismatch exits 19 naming BOTH generations and deletes nothing further', async () => {
  let deleteCalls = 0;
  const result = await runCli(
    ['watch', 's1', 'delete', '--json'],
    fakeDeps(() => ({
      getWatch: async () => ({ watchId: 'w-1', status: 'active', generation: 'G1', firingCount: 0 }),
      deleteWatch: async () => {
        deleteCalls += 1;
        const error = new Error('pi-orch: WATCH_GENERATION_MISMATCH: the watch was replaced since you read it') as Error & { expectedGeneration?: string; currentGeneration?: string; code?: string };
        error.expectedGeneration = 'G1';
        error.currentGeneration = 'G2';
        error.code = 'WATCH_GENERATION_MISMATCH';
        throw error;
      },
    }) as never),
  );
  assert.equal(result.exitCode, 19, 'watch conflict exit code');
  assert.match(result.stderr ?? '', /G1/);
  assert.match(result.stderr ?? '', /G2/);
  assert.equal(deleteCalls, 1, 'no retry, nothing else deleted');
});
