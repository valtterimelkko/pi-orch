import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalEnd, goalPaused } from '../src/builders.ts';
import { runCli, type CliDeps } from '../src/cli.ts';

/**
 * W0-a (parent-orchestration-machinery plan, finding F2): a `goal_end` /
 * `paused` watch registered WITHOUT an objective used to be built with
 * `dataMatch.objective = '*'` (cli.ts passed `objective ?? '*'` to goalEnd /
 * goalPaused). The server matches `dataMatch` by strict equality, so `'*'`
 * can never equal a real objective string: the condition was DEAD on arrival
 * and a parent slept 46 minutes on a watch that could not fire.
 *
 * The fix (frozen criterion): with no objective, the condition carries NO
 * `objective` key at all — the server then matches any goal_end / any pause.
 * With an objective, it still matches that exact string (the existing
 * objective-filtered tests stay green).
 *
 * Provenance: brief `/root/orch-ops/parent-machinery-20261013/W0a/brief.md`
 * (plan W0-a, finding F2); code at src/cli.ts:781-782, src/builders.ts:195-201.
 */

// ─── Builder semantics ──────────────────────────────────────────────────────

test('W0a: goalEnd() without an objective carries no objective key (was the dead "*")', () => {
  const condition = goalEnd();
  assert.equal(condition.type, 'event_type');
  assert.equal(condition.eventType, 'goal_end');
  assert.equal(condition.dataMatch, undefined, 'no objective filter: the condition matches any goal_end');
  assert.equal(JSON.stringify(condition).includes('"*"'), false, 'a bare "*" must never appear');
});

test('W0a: goalPaused() without an objective filters only on status (no objective key)', () => {
  const condition = goalPaused();
  assert.equal(condition.type, 'event_type');
  assert.equal(condition.eventType, 'goal_state');
  assert.deepEqual(condition.dataMatch, { status: 'paused' }, 'paused matches any pause, with no objective filter');
  assert.equal('objective' in (condition.dataMatch as Record<string, unknown>), false, 'no objective key');
});

test('W0a: goalEnd(objective) still matches that exact objective (existing behaviour)', () => {
  const condition = goalEnd('Ship the widget');
  assert.deepEqual(condition.dataMatch, { objective: 'Ship the widget' });
  assert.equal(condition.once, false, 'goal conditions keep repeating');
});

test('W0a: goalPaused(objective) still filters objective + status (existing behaviour)', () => {
  const condition = goalPaused('Ship the widget');
  assert.deepEqual(condition.dataMatch, { objective: 'Ship the widget', status: 'paused' });
});

// ─── CLI level: `watch register` must send no "*" ───────────────────────────

function captureDeps(seen: Array<Record<string, unknown>>): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'test-key-123',
    client: () =>
      ({
        registerWatch: async (_sessionId: string, input: Record<string, unknown>) => {
          seen.push(input);
          return { watchId: 'w-1', status: 'active', raw: { watchId: 'w-1' } };
        },
      }) as never,
  };
}

test('W0a CLI: watch register --conditions goal_end without --objective sends no "*" and no objective', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(['watch', 's1', 'register', '--conditions', 'goal_end', '--id-only'], captureDeps(seen));
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  const registered = seen[0];
  assert.ok(registered, 'registerWatch was called once');
  const conditions = registered.conditions as Array<{ eventType?: string; dataMatch?: Record<string, unknown> }>;
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0]?.eventType, 'goal_end');
  assert.equal(conditions[0]?.dataMatch, undefined, 'no dataMatch at all without an objective');
  assert.equal(JSON.stringify(registered).includes('"*"'), false, 'the serialized register body must never carry "*"');
});

test('W0a CLI: watch register --conditions paused without --objective sends no objective key', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(['watch', 's1', 'register', '--conditions', 'paused', '--id-only'], captureDeps(seen));
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  const conditions = (seen[0]?.conditions ?? []) as Array<{ eventType?: string; dataMatch?: Record<string, unknown> }>;
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0]?.eventType, 'goal_state');
  assert.deepEqual(conditions[0]?.dataMatch, { status: 'paused' });
  assert.equal(JSON.stringify(seen[0]).includes('"*"'), false, 'no "*" anywhere in the register body');
});

test('W0a CLI: watch register --conditions goal_end,paused WITH --objective matches it exactly', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(
    ['watch', 's1', 'register', '--conditions', 'goal_end,paused', '--objective', 'Ship the widget', '--id-only'],
    captureDeps(seen),
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  const conditions = (seen[0]?.conditions ?? []) as Array<{ eventType?: string; dataMatch?: Record<string, unknown> }>;
  assert.equal(conditions.length, 2);
  assert.deepEqual(conditions[0]?.dataMatch, { objective: 'Ship the widget' });
  assert.deepEqual(conditions[1]?.dataMatch, { objective: 'Ship the widget', status: 'paused' });
  assert.equal(JSON.stringify(seen[0]).includes('"*"'), false, 'still no "*" when an objective is given');
});
