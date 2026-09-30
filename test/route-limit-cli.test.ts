import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, routeLimitOverrides, mergeRouteLimits, type CliDeps } from '../src/cli.ts';
import { nameFor } from '../src/exit-codes.ts';

/**
 * G1: CLI surface of the per-route limit — flags, exit codes, help.
 * The heavy lifting is in the client (test/route-limit-gate.test.ts); here we
 * pin the shell contract: --route-limit (repeatable, wins over the env),
 * --wait-for-slot SECONDS, a distinct refusal exit code (25) and the deadline
 * exit (3) when the slot wait times out.
 */

function fakeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'test-key-123',
    client: () => {
      throw new Error('no client expected in this test');
    },
    ...overrides,
  };
}

function routeLimitError(route: string): Error {
  const error = new Error(
    `route '${route}' is at its limit of 2 live children: c1 (busy), c2 (run_active). Wait for one to settle, re-run with --wait-for-slot <seconds>, or spread the children across another route`,
  ) as Error & { code: string; route: string; limit: number; live: Array<{ sessionId: string; reason: string }> };
  error.code = 'ROUTE_LIMIT_EXCEEDED';
  error.route = route;
  error.limit = 2;
  error.live = [
    { sessionId: 'c1', reason: 'busy' },
    { sessionId: 'c2', reason: 'run_active' },
  ];
  return error;
}

test('exit code 25 ROUTE_LIMIT is a documented, distinct refusal', () => {
  assert.equal(nameFor(25), 'ROUTE_LIMIT');
});

test('spawn refused over the limit exits 25 and names the live children on stderr', async () => {
  const ZAI = 'zai/glm-5.3-flash';
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--model-selector', ZAI, '--json'],
    fakeDeps({
      client: () => ({
        async spawn() {
          throw routeLimitError(ZAI);
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 25);
  assert.match(result.stderr ?? '', /ROUTE_LIMIT_EXCEEDED/);
  assert.match(result.stderr ?? '', /c1/);
  assert.match(result.stderr ?? '', /c2/);
});

test('a timed-out --wait-for-slot exits 3 (deadline), never a fake success', async () => {
  const error = new Error('no slot on route zai/glm-5.3-flash within 30s') as Error & { code: string };
  error.code = 'ROUTE_LIMIT_WAIT_DEADLINE';
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--model-selector', 'zai/glm-5.3-flash', '--wait-for-slot', '30'],
    fakeDeps({
      client: () => ({
        async spawn() {
          throw error;
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr ?? '', /ROUTE_LIMIT_WAIT_DEADLINE|no slot/);
});

test('spawn passes --wait-for-slot seconds to the client as waitForSlotMs', async () => {
  let seen: Record<string, unknown> | undefined;
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--model-selector', 'zai/glm-5.3-flash', '--wait-for-slot', '30', '--json'],
    fakeDeps({
      client: () => ({
        async spawn(input: Record<string, unknown>) {
          seen = input;
          return { sessionId: 'sess-9' };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(seen?.waitForSlotMs, 30_000);
});

test('spawn without --wait-for-slot passes no waitForSlotMs', async () => {
  let seen: Record<string, unknown> | undefined;
  await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--model-selector', 'zai/glm-5.3-flash'],
    fakeDeps({
      client: () => ({
        async spawn(input: Record<string, unknown>) {
          seen = input;
          return { sessionId: 'sess-9' };
        },
      }) as never,
    }),
  );
  assert.equal(seen?.waitForSlotMs, undefined);
});

test('--wait-for-slot must be a positive number', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--model-selector', 'zai/glm-5.3-flash', '--wait-for-slot', 'nope'],
    fakeDeps(),
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? '', /--wait-for-slot/);
});

test('routeLimitOverrides parses repeatable key=value flags and rejects junk', () => {
  assert.deepEqual(
    routeLimitOverrides(['zai/glm-5.3-flash=2', 'commandcode/deepseek/deepseek-v4.1-flash=3']),
    { 'zai/glm-5.3-flash': 2, 'commandcode/deepseek/deepseek-v4.1-flash': 3 },
  );
  assert.deepEqual(routeLimitOverrides(['zai/glm-5.3-flash=unlimited']), { 'zai/glm-5.3-flash': 0 });
  assert.throws(() => routeLimitOverrides(['no-equals-sign']), /--route-limit/);
  assert.throws(() => routeLimitOverrides(['route=nope']), /--route-limit/);
  assert.throws(() => routeLimitOverrides(['route=-2']), /--route-limit/);
});

test('mergeRouteLimits: flags win over the env, env extends the built-in defaults', () => {
  const merged = mergeRouteLimits(
    { PI_ORCH_ROUTE_LIMITS: '{"zai/glm-5.3-flash": 2}' },
    routeLimitOverrides(['zai/glm-5.3-flash=4']),
  );
  assert.equal(merged['zai/glm-5.3-flash'], 4);
  const envOnly = mergeRouteLimits({ PI_ORCH_ROUTE_LIMITS: '{"zai/glm-5.3-flash": 2}' }, {});
  assert.equal(envOnly['zai/glm-5.3-flash'], 2);
  const plain = mergeRouteLimits({}, {});
  assert.equal(plain['zai/glm-5.3-flash'], 5, 'the measured default stands when nothing is configured');
});

test('help documents --route-limit, --wait-for-slot and exit code 25', async () => {
  const result = await runCli(['help'], fakeDeps());
  assert.equal(result.exitCode, 0);
  const help = result.stdout ?? '';
  assert.match(help, /--route-limit/);
  assert.match(help, /--wait-for-slot/);
  assert.match(help, /PI_ORCH_ROUTE_LIMITS/);
  assert.match(help, /25 route limit/);
});

test('correction01/7: --route-limit bad is a usage error through runCli (exit 2), never an uncaught stack', async () => {
  let clientUsed = false;
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--model-selector', 'zai/glm-5.3-flash', '--route-limit', 'bad'],
    fakeDeps({
      client: () => {
        clientUsed = true;
        throw new Error('client must not be reached');
      },
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? '', /--route-limit/);
  assert.equal(clientUsed, false, 'the client factory is never reached with junk flags');
});

test('prompt accepts --owner for route counting (correction01/4 CLI surface)', async () => {
  let seen: Record<string, unknown> | undefined;
  const result = await runCli(
    ['prompt', 'sess-9', '--message', 'go', '--owner', 'o1', '--json'],
    fakeDeps({
      client: () => ({
        async prompt(_sessionId: string, input: Record<string, unknown>) {
          seen = input;
          return { runId: 'run-77', sessionId: 'sess-9', detached: true, duplicate: false };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(seen?.routeOwner, 'o1');
});
