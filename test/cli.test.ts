import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, type CliDeps } from '../src/cli.ts';

/**
 * CLI contract: short verb commands, `--json` for machine output, human output
 * otherwise, meaningful exit codes, and an injectable client factory so tests
 * never need a server. runCli is pure: it returns the stdout/stderr it would
 * print and the exit code; main() does the printing.
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

test('usage: no arguments exits 2 with help on stderr', async () => {
  const result = await runCli([], fakeDeps());
  assert.equal(result.exitCode, 2);
  assert.ok((result.stderr ?? '').includes('usage:'));
});

test('usage: unknown verb exits 2', async () => {
  const result = await runCli(['frobnicate'], fakeDeps());
  assert.equal(result.exitCode, 2);
  assert.ok((result.stderr ?? '').includes('unknown verb'));
});

test('help prints usage on stdout with exit 0 (C1 carried-over item: it printed nothing)', async () => {
  const result = await runCli(['help'], fakeDeps());
  assert.equal(result.exitCode, 0);
  assert.ok((result.stdout ?? '').includes('usage: pi-orch'), 'usage on STDOUT');
  assert.equal(result.stderr, undefined);
});

test('--help prints usage on stdout with exit 0', async () => {
  const result = await runCli(['--help'], fakeDeps());
  assert.equal(result.exitCode, 0);
  assert.ok((result.stdout ?? '').includes('usage: pi-orch'));
});

test('-h prints usage on stdout with exit 0 (previously rejected as an unknown verb)', async () => {
  const result = await runCli(['-h'], fakeDeps());
  assert.equal(result.exitCode, 0);
  assert.ok((result.stdout ?? '').includes('usage: pi-orch'));
});

test('verify surfaces the child verdict and exit codes (C3b: stub removed)', async () => {
  const result = await runCli(
    ['verify', 'sess-1', '--json'],
    fakeDeps({
      client: () => ({
        async verify() {
          return { sessionId: 'sess-1', verdict: 'contradicted', claims: [], summary: 'contradicted: 1 claim(s) contradicted' };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 20);
  const parsed = JSON.parse(result.stdout ?? '{}') as { verdict?: string };
  assert.equal(parsed.verdict, 'contradicted');
});

test('spawn prints the session id and lease as json', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w1', '--model-selector', 'zai/glm-5.3-flash', '--thinking', 'low', '--owner', 'p1', '--ttl', '3600', '--json'],
    fakeDeps({
      client: () => ({
        async spawn() {
          return { sessionId: 'sess-9', leaseId: 'lease-1', parentId: 'p1', resolvedModel: 'zai/glm-5.3-flash' };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout ?? '{}') as Record<string, unknown>;
  assert.equal(parsed.sessionId, 'sess-9');
  assert.equal(parsed.leaseId, 'lease-1');
});

test('human spawn output names the session', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w1'],
    fakeDeps({
      client: () => ({
        async spawn() {
          return { sessionId: 'sess-9' };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.ok((result.stdout ?? '').includes('session sess-9'));
});

test('prompt prints the runId; wait passes deadline; result prints final text', async () => {
  const prompt = await runCli(
    ['prompt', 'sess-9', '--message', 'do the thing', '--json'],
    fakeDeps({
      client: () => ({
        async prompt() {
          return { runId: 'run-77', sessionId: 'sess-9', detached: true, duplicate: false };
        },
      }) as never,
    }),
  );
  assert.equal(prompt.exitCode, 0);
  assert.equal((JSON.parse(prompt.stdout ?? '{}') as Record<string, unknown>).runId, 'run-77');

  const wait = await runCli(
    ['wait', 'sess-9', '--run-id', 'run-77', '--deadline', '60', '--json'],
    fakeDeps({
      client: () => ({
        async wait() {
          return { kind: 'completed', receipt: { status: 'completed' } };
        },
      }) as never,
    }),
  );
  assert.equal(wait.exitCode, 0);
  assert.equal((JSON.parse(wait.stdout ?? '{}') as Record<string, unknown>).kind, 'completed');

  const result = await runCli(
    ['result', 'run-77', '--json'],
    fakeDeps({
      client: () => ({
        async result() {
          return { runId: 'run-77', status: 'completed', finalText: 'all done', evidence: { transcript: '/api/v1/sessions/sess-9/transcript?scope=visible_full' } };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal((JSON.parse(result.stdout ?? '{}') as Record<string, unknown>).finalText, 'all done');
});

test('wait outcomes map to their documented exit codes', async () => {
  const wait = await runCli(
    ['wait', 'sess-9', '--run-id', 'run-77', '--json'],
    fakeDeps({
      client: () => ({
        async wait() {
          return { kind: 'never_started', receipt: { status: 'failed', errorCode: 'NEVER_STARTED' } };
        },
      }) as never,
    }),
  );
  assert.equal(wait.exitCode, 6);
});

test('deadline outcome exits 3 (re-wait, never re-dispatch)', async () => {
  const wait = await runCli(
    ['wait', 'sess-9', '--json'],
    fakeDeps({
      client: () => ({
        async wait() {
          return { kind: 'deadline', note: 'waited 60000ms' };
        },
      }) as never,
    }),
  );
  assert.equal(wait.exitCode, 3);
});

test('cleanup and status round-trip', async () => {
  const cleanup = await runCli(
    ['cleanup', 'sess-9', '--lease', 'lease-1', '--owner', 'p1', '--json'],
    fakeDeps({
      client: () => ({
        async cleanup() {
          return { released: true, deleted: true, notes: [] };
        },
      }) as never,
    }),
  );
  assert.equal(cleanup.exitCode, 0);
  assert.equal((JSON.parse(cleanup.stdout ?? '{}') as Record<string, unknown>).deleted, true);

  const status = await runCli(
    ['status', '--parent', 'p1', '--json'],
    fakeDeps({
      client: () => ({
        async status() {
          return {
            parent: 'p1',
            children: [{ sessionId: 'c1', busy: false, goalStatus: 'achieved', lastRun: { status: 'completed' } }],
          };
        },
      }) as never,
    }),
  );
  assert.equal(status.exitCode, 0);
  const parsed = JSON.parse(status.stdout ?? '{}') as { children: unknown[] };
  assert.equal(parsed.children.length, 1);
});

test('http error mapping: preflight refusal exits 11 with the failures list', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/nope'],
    fakeDeps({
      client: () => {
        throw Object.assign(new Error('preflight failed'), { httpCode: 'PREFLIGHT_FAILED', failures: [{ kind: 'cwd_missing' }] });
      },
    }),
  );
  assert.equal(result.exitCode, 11);
  assert.ok((result.stderr ?? '').includes('PREFLIGHT_FAILED'));
  assert.ok((result.stderr ?? '').includes('cwd_missing'));
});

test('admission refusal with retry-after exits 10 and echoes the header', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/x'],
    fakeDeps({
      client: () => {
        throw Object.assign(new Error('admission refused'), { status: 503, retryAfterSeconds: 30 });
      },
    }),
  );
  assert.equal(result.exitCode, 10);
  assert.ok((result.stderr ?? '').includes('retry-after: 30s'));
});

test('--parent-session overrides the environment identity', async () => {
  const seen: Array<Record<string, string | undefined>> = [];
  await runCli(
    ['status', '--parent', 'p1', '--parent-session', 'explicit-parent'],
    fakeDeps({
      env: { PI_WEB_UI_SESSION_ID: 'env-parent' },
      client: (config) => {
        seen.push({ parentSession: config.parentSessionId });
        return {
          async status() {
            return { parent: 'p1', children: [] };
          },
        } as never;
      },
    }),
  );
  assert.equal(seen[0]?.parentSession, 'explicit-parent');
});

test('missing required flags are usage errors', async () => {
  const result = await runCli(['spawn', '--runtime', 'pi'], fakeDeps());
  assert.equal(result.exitCode, 2);
  assert.ok((result.stderr ?? '').includes('--cwd'));
});

// ─── Correction 01 item 3: scripting ergonomics ─────────────────────────────

test('--id-only prints exactly the sessionId for spawn and the runId for prompt', async () => {
  const spawn = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w1', '--id-only'],
    fakeDeps({
      client: () => ({
        async spawn() {
          return { sessionId: 'sess-only', leaseId: 'l1' };
        },
      }) as never,
    }),
  );
  assert.equal(spawn.exitCode, 0);
  assert.equal(spawn.stdout?.trim(), 'sess-only');

  const prompt = await runCli(
    ['prompt', 'sess-only', '--message', 'go', '--id-only'],
    fakeDeps({
      client: () => ({
        async prompt() {
          return { runId: 'run-only', sessionId: 'sess-only', detached: true, duplicate: false };
        },
      }) as never,
    }),
  );
  assert.equal(prompt.exitCode, 0);
  assert.equal(prompt.stdout?.trim(), 'run-only');
});

test('help tells models to use --json or --id-only, never human output', async () => {
  const result = await runCli(['help'], fakeDeps());
  const help = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.ok(help.includes('--id-only'));
  assert.ok(help.includes('never parse the human-readable output'));
});

test('wait --all waits several children in one call and reports per-child outcomes', async () => {
  const waits: Array<{ ids: string[] }> = [];
  const result = await runCli(
    ['wait', '--all', 'c1@r1', 'c2@r2', '--deadline', '30', '--json'],
    fakeDeps({
      client: () => ({
        async waitMany(options: { mode: string; children: Array<{ sessionId: string; runId?: string }> }) {
          waits.push({ ids: options.children.map((child) => child.sessionId) });
          assert.equal(options.mode, 'all');
          return {
            mode: 'all',
            children: [
              { sessionId: 'c1', runId: 'r1', outcome: { kind: 'completed' } },
              { sessionId: 'c2', runId: 'r2', outcome: { kind: 'completed' } },
            ],
            exitCode: 0,
          };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(waits[0]?.ids, ['c1', 'c2']);
  const parsed = JSON.parse(result.stdout ?? '{}') as { children: Array<{ sessionId: string }> };
  assert.equal(parsed.children.length, 2);
});

test('wait --any returns the first settled child and its exit code', async () => {
  const result = await runCli(
    ['wait', '--any', 'c1@r1', 'c2@r2', '--json'],
    fakeDeps({
      client: () => ({
        async waitMany() {
          return {
            mode: 'any',
            children: [{ sessionId: 'c2', runId: 'r2', outcome: { kind: 'never_started' } }],
            exitCode: 6,
          };
        },
      }) as never,
    }),
  );
  assert.equal(result.exitCode, 6);
  const parsed = JSON.parse(result.stdout ?? '{}') as { mode: string; children: Array<{ sessionId: string }> };
  assert.equal(parsed.mode, 'any');
  assert.equal(parsed.children[0]?.sessionId, 'c2');
});
