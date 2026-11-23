import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSelfSession,
  runSelfResolverProcess,
  SELF_RESOLVER_ARGS,
  SELF_RESOLVER_DISABLED,
  SELF_RESOLVER_ENV,
  SELF_RESOLVER_PROGRAM,
  SELF_RESOLVER_TIMEOUT_MS,
} from '../src/self-session.ts';
import { makeCliDeps } from '../src/cli.ts';

/**
 * J3 (native-parent-linkage): the self-session resolver asks the Agent OS board
 * who THIS process's own agent session is (`agent-os board self --json`, the
 * frozen interface in the programme's COMMON.md), so a child of Devin, the
 * Antigravity CLI, the Command Code CLI or a bare `pi` CLI gets a declared
 * native parent even though none of its identity variables are ones pi-orch
 * knows.
 *
 * Every test here injects the runner seam: no test spawns a real process and
 * none touches the live board.
 */

const SYNTHETIC_REF = 'example-board-ref';

type Run = { status: number | null; stdout: string; timedOut?: boolean; errorCode?: string };

function runner(result: Run): { calls: Array<{ program: string; args: readonly string[]; timeoutMs: number }>; run: (program: string, args: readonly string[], timeoutMs: number) => Run } {
  const calls: Array<{ program: string; args: readonly string[]; timeoutMs: number }> = [];
  return {
    calls,
    run: (program, args, timeoutMs) => {
      calls.push({ program, args, timeoutMs });
      return result;
    },
  };
}

function foundLine(sessionRef: string): string {
  return `${JSON.stringify({ found: true, entryId: 'entry-1', harness: 'example-harness', sessionRef, harnessPid: 4242 })}\n`;
}

test('the resolver default is `agent-os board self --json` with a 3000 ms hard timeout', () => {
  assert.equal(SELF_RESOLVER_PROGRAM, 'agent-os');
  assert.deepEqual([...SELF_RESOLVER_ARGS], ['board', 'self', '--json']);
  assert.equal(SELF_RESOLVER_TIMEOUT_MS, 3000);
  assert.equal(SELF_RESOLVER_ENV, 'PI_ORCH_SELF_RESOLVER');
  assert.equal(SELF_RESOLVER_DISABLED, 'off');
});

test('a found sessionRef becomes the declared native parent', () => {
  const fake = runner({ status: 0, stdout: foundLine(SYNTHETIC_REF) });
  const resolution = resolveSelfSession({ env: {}, run: fake.run });
  assert.equal(resolution.sessionRef, SYNTHETIC_REF);
  assert.equal(resolution.note, undefined, 'the happy path is silent');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.program, 'agent-os');
  assert.deepEqual([...(fake.calls[0]?.args ?? [])], ['board', 'self', '--json'], 'argv, never a shell string');
  assert.equal(fake.calls[0]?.timeoutMs, 3000);
});

test(`${SELF_RESOLVER_ENV}=off disables the resolver without running anything`, () => {
  const fake = runner({ status: 0, stdout: foundLine(SYNTHETIC_REF) });
  const resolution = resolveSelfSession({ env: { [SELF_RESOLVER_ENV]: SELF_RESOLVER_DISABLED }, run: fake.run });
  assert.deepEqual(resolution, {});
  assert.equal(fake.calls.length, 0, 'nothing is run when the resolver is switched off');
});

test(`${SELF_RESOLVER_ENV} replaces the program and keeps the same argv`, () => {
  const fake = runner({ status: 0, stdout: foundLine(SYNTHETIC_REF) });
  resolveSelfSession({ env: { [SELF_RESOLVER_ENV]: '/opt/example/bin/agent-os' }, run: fake.run });
  assert.equal(fake.calls[0]?.program, '/opt/example/bin/agent-os');
  assert.deepEqual([...(fake.calls[0]?.args ?? [])], ['board', 'self', '--json']);
});

test('found:false is no native parent and one short note', () => {
  const fake = runner({ status: 1, stdout: `${JSON.stringify({ found: false, reason: 'no active board entry for this process ancestry' })}\n` });
  const resolution = resolveSelfSession({ env: {}, run: fake.run });
  assert.equal(resolution.sessionRef, undefined);
  assert.equal(typeof resolution.note, 'string');
  assert.match(resolution.note ?? '', /SELF_RESOLVER_UNRESOLVED/);
  assert.ok((resolution.note ?? '').length < 220, 'the note stays short');
  assert.ok(!(resolution.note ?? '').includes('\n'), 'one line only');
});

test('a non-zero exit, a missing binary, a timeout and junk output are all no native parent', () => {
  const cases: Array<{ name: string; run: Run }> = [
    { name: 'non-zero exit', run: { status: 2, stdout: '' } },
    { name: 'missing binary', run: { status: null, stdout: '', errorCode: 'ENOENT' } },
    { name: 'timeout', run: { status: null, stdout: '', timedOut: true, errorCode: 'ETIMEDOUT' } },
    { name: 'unparseable output', run: { status: 0, stdout: 'not json at all\n' } },
  ];
  for (const { name, run } of cases) {
    const resolution = resolveSelfSession({ env: {}, run: runner(run).run });
    assert.equal(resolution.sessionRef, undefined, name);
    assert.match(resolution.note ?? '', /SELF_RESOLVER_UNRESOLVED/, name);
  }
});

test('a sessionRef that is not a bare native id is skipped with the note', () => {
  for (const sessionRef of ['../etc/passwd', 'a/b', '', `x${'y'.repeat(128)}`]) {
    const resolution = resolveSelfSession({ env: {}, run: runner({ status: 0, stdout: foundLine(sessionRef) }).run });
    assert.equal(resolution.sessionRef, undefined, JSON.stringify(sessionRef));
    assert.match(resolution.note ?? '', /SELF_RESOLVER_UNRESOLVED/);
  }
});

test('found:true with no sessionRef at all is skipped, never a crash', () => {
  const resolution = resolveSelfSession({ env: {}, run: runner({ status: 0, stdout: '{"found":true}\n' }).run });
  assert.equal(resolution.sessionRef, undefined);
  assert.match(resolution.note ?? '', /SELF_RESOLVER_UNRESOLVED/);
});

test('a runner that throws is no native parent either (fail open, never a failed spawn)', () => {
  const resolution = resolveSelfSession({
    env: {},
    run: () => {
      throw new Error('spawn exploded');
    },
  });
  assert.equal(resolution.sessionRef, undefined);
  assert.match(resolution.note ?? '', /SELF_RESOLVER_UNRESOLVED/);
});

test('the real runner is wired in the production deps; `off` proves it without spawning', () => {
  // The resolver seam the CLI uses in production is the spawnSync runner. Ask
  // it with the resolver switched off: it must answer without running anything,
  // so this test observes the wiring and spawns no process.
  assert.equal(typeof runSelfResolverProcess, 'function');
  const deps = makeCliDeps({ env: { [SELF_RESOLVER_ENV]: SELF_RESOLVER_DISABLED }, argv: ['node', 'pi-orch'], stdout: { write: () => true }, stderr: { write: () => true }, exitCode: 0 } as never);
  assert.equal(typeof deps.selfSession, 'function', 'main() must inject the self-session resolver');
  const resolution = deps.selfSession?.({ env: { [SELF_RESOLVER_ENV]: SELF_RESOLVER_DISABLED } });
  assert.deepEqual(resolution, {});
});
