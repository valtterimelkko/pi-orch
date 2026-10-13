import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, allowedFlagsFor, HELP, type CliDeps } from '../src/cli.ts';
import { EXIT_CODES, nameFor } from '../src/exit-codes.ts';
import { makeLaneDir, FakeWorld } from './lane-runner-helpers.ts';

/** W4-a — the `lane run` verb wiring (no network: the client factory is a fake or a trap). */

function cliDeps(client: (config: { parentSessionId?: string }) => unknown): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'id',
    client: client as unknown as CliDeps['client'],
  };
}

const trap = () => { throw new Error('the client factory must not run'); };

test('lane run --dry-run needs no client and prints the plan', async () => {
  const { dir } = makeLaneDir();
  const before = readdirSync(dir).sort();
  const result = await runCli(['lane', 'run', dir, '--dry-run'], cliDeps(trap));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? '', /spawn_implementer/);
  assert.deepEqual(readdirSync(dir).sort(), before);
});

test('lane usage errors are exit 2 before the client factory runs', async () => {
  const { dir } = makeLaneDir();
  for (const argv of [
    ['lane'],
    ['lane', 'walk', dir],
    ['lane', 'run'],
    ['lane', 'run', dir, '--bogus'],
    ['lane', 'run', dir, '--continue', 'sideways'],
    ['lane', 'run', join(dir, 'nowhere')],
    ['lane', 'run', dir, '--deadline', 'soon'],
  ]) {
    const result = await runCli(argv, cliDeps(trap));
    assert.equal(result.exitCode, 2, argv.join(' '));
  }
  const broken = makeLaneDir({ laneOverrides: { surprise: 1 } });
  const unknownKey = await runCli(['lane', 'run', broken.dir, '--dry-run'], cliDeps(trap));
  assert.equal(unknownKey.exitCode, 2);
  assert.match(unknownKey.stderr ?? '', /surprise/);
});

test('lane run drives the runner through the injected client; the lane parentSessionId reaches the factory', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  const seen: Array<{ parentSessionId?: string }> = [];
  const result = await runCli(['lane', 'run', dir, '--json'], cliDeps((config: { parentSessionId?: string }) => { seen.push(config); return world.client(); }));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(seen[0]?.parentSessionId, 'parent-session-1');
  const body = JSON.parse(result.stdout ?? '{}') as { code: number; name: string; implementer: { sessionId: string } };
  assert.equal(body.code, 0);
  assert.equal(body.name, 'DONE');
  assert.equal(body.implementer.sessionId, 's-implementer-1');
});

test('an explicit --parent-session wins over lane.json; --continue correction is wired', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { verdicts: ['REJECT', 'ACCEPT'] });
  const seen: Array<{ parentSessionId?: string }> = [];
  const factory = (config: { parentSessionId?: string }) => { seen.push(config); return world.client(); };
  const first = await runCli(['lane', 'run', dir, '--parent-session', 'explicit-1', '--deadline', '60'], cliDeps(factory));
  assert.equal(first.exitCode, 42);
  assert.equal(seen[0]?.parentSessionId, 'explicit-1');
  assert.ok(world.waitCalls.every((call) => call.options.deadlineMs === 60_000));
  const second = await runCli(['lane', 'run', dir, '--continue', 'correction'], cliDeps(factory));
  assert.equal(second.exitCode, 0, second.stderr);
});

test('the lane verb is documented: help text, flag allow-list and the new exit codes', () => {
  assert.ok(allowedFlagsFor('lane')?.has('dry-run'));
  assert.ok(allowedFlagsFor('lane')?.has('continue'));
  assert.match(HELP, /lane run <lane-dir>/);
  for (const [code, name] of [[40, 'QUESTION'], [41, 'GATES_RED'], [42, 'VERDICT'], [43, 'RUNNER_ERROR']] as const) {
    assert.equal(nameFor(code), name);
    assert.ok(EXIT_CODES.some((entry) => entry.code === code));
    assert.ok(HELP.includes(`${code} `), `help mentions ${code}`);
  }
});

test('examples/lane is a valid sample lane (dry-run passes)', async () => {
  const dir = new URL('../examples/lane/', import.meta.url).pathname;
  const result = await runCli(['lane', 'run', dir, '--dry-run'], cliDeps(trap));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(readFileSync(join(dir, 'lane.json'), 'utf8').includes('"maxCorrections"'));
});
