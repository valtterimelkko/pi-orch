import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.ts';
import { PiOrchClient } from '../src/client.ts';
import { tempLedgerPath } from './isolated-ledger.ts';
import { apiError, fakeDeps, ok, routedTransport, type Call } from './w2c-helpers.ts';

/**
 * W2c verbs 1 + 2: `goal <sid> pause|resume|show` and `reroute`.
 *
 * Provenance: the goal control body shape ({action:'pause', reason} /
 * {action:'resume', note}) mirrors the existing {action:'start'} body on
 * POST /sessions/:id/goal (snapshot 1.61.0 route sessionGoalControl); the
 * abort route (POST /sessions/:id/abort) is named by the W2c brief — the
 * bundled snapshot does not list it, so the host follow-up proves it live.
 */

const GOAL_RUNNING = { sessionId: 's1', supported: true, status: 'running', objective: 'Ship the thing' };
const GOAL_PAUSED = { ...GOAL_RUNNING, status: 'paused', pausedReason: 'reroute' };

function client(transport: never): PiOrchClient {
  return new PiOrchClient({ transportInstance: transport, spawnLedgerPath: tempLedgerPath(), randomId: () => 'k1' });
}

test('W2c goal: client.goalPause / goalResume / goalShow hit the goal route with exact bodies', async () => {
  const { transport, calls } = routedTransport({
    'POST /api/v1/sessions/s1/goal': () => ok({ sessionId: 's1', accepted: true, applied: true, goal: GOAL_PAUSED }),
    'GET /api/v1/sessions/s1/goal': () => ok(GOAL_RUNNING),
  });
  const c = client(transport);
  await c.goalPause('s1', { reason: 'rerouting' });
  await c.goalPause('s1', {});
  await c.goalResume('s1', { note: 'back on' });
  await c.goalResume('s1', {});
  const shown = await c.goalShow('s1');
  assert.deepEqual(calls.map((call) => call.body), [
    { action: 'pause', reason: 'rerouting' },
    { action: 'pause' },
    { action: 'resume', note: 'back on' },
    { action: 'resume' },
    undefined,
  ]);
  assert.equal(calls[4]?.method, 'GET');
  assert.equal(shown.status, 'running');
  assert.equal(shown.objective, 'Ship the thing');
});

test('W2c goal: CLI pause/resume/show route to the client and print the goal status', async () => {
  const seen: Array<{ verb: string; sessionId: string; input?: unknown }> = [];
  const stub = {
    goalPause: async (sessionId: string, input: unknown) => { seen.push({ verb: 'pause', sessionId, input }); return { status: 'paused', objective: 'O' }; },
    goalResume: async (sessionId: string, input: unknown) => { seen.push({ verb: 'resume', sessionId, input }); return { status: 'running', objective: 'O' }; },
    goalShow: async (sessionId: string) => { seen.push({ verb: 'show', sessionId }); return { status: 'running', objective: 'O', runs: 3 }; },
  };
  const deps = fakeDeps(() => stub as never);
  const pause = await runCli(['goal', 's1', 'pause', '--reason', 'R'], deps);
  const resume = await runCli(['goal', 's1', 'resume', '--note', 'N'], deps);
  const show = await runCli(['goal', 's1', 'show', '--json'], deps);
  assert.equal(pause.exitCode, 0, pause.stderr);
  assert.equal(resume.exitCode, 0, resume.stderr);
  assert.equal(show.exitCode, 0, show.stderr);
  assert.deepEqual(seen, [
    { verb: 'pause', sessionId: 's1', input: { reason: 'R' } },
    { verb: 'resume', sessionId: 's1', input: { note: 'N' } },
    { verb: 'show', sessionId: 's1' },
  ]);
  assert.match(pause.stdout ?? '', /paused/);
  assert.equal((JSON.parse(show.stdout ?? '{}') as { runs?: number }).runs, 3);
});

test('W2c goal: per-action flag strictness — a flag that does not belong to the action is a usage error', async () => {
  const deps = fakeDeps(() => ({}) as never);
  for (const argv of [
    ['goal', 's1', 'pause', '--note', 'x'],
    ['goal', 's1', 'resume', '--reason', 'x'],
    ['goal', 's1', 'show', '--reason', 'x'],
    ['goal', 's1', 'pause', '--goal-objective', 'O'],
    ['goal', 's1', 'start', '--reason', 'x', '--goal-objective', 'O'],
    ['goal', 's1', 'clear'],
  ]) {
    const result = await runCli(argv, deps);
    assert.equal(result.exitCode, 2, `${argv.join(' ')} must be exit 2 (got ${result.exitCode})`);
  }
});

const SEQUENCE = (calls: Call[]): string[] => calls.map((call) => `${call.method} ${call.path.replace('/api/v1/sessions/s1', '')}${call.body?.action ? `#${String(call.body.action)}` : ''}`);

function goalRoutes(goalReads: unknown[], overrides: Record<string, () => never> = {}) {
  let read = 0;
  return {
    'GET /api/v1/sessions/s1/goal': () => ok(goalReads[Math.min(read++, goalReads.length - 1)]),
    'POST /api/v1/sessions/s1/goal': (call: Call) => ok({ sessionId: 's1', accepted: true, applied: true, goal: call.body?.action === 'pause' ? GOAL_PAUSED : GOAL_RUNNING }),
    'POST /api/v1/sessions/s1/abort': () => ok({ success: true }),
    'POST /api/v1/sessions/s1/control': (call: Call) => ok({ success: true, action: call.body?.action }),
    ...overrides,
  };
}

test('W2c reroute: busy goal child — pause → abort → set_model → set_thinking_level → resume with the SAME objective', async () => {
  const { transport, calls } = routedTransport(goalRoutes([GOAL_RUNNING, GOAL_RUNNING]));
  const outcome = await client(transport).reroute('s1', { modelSelector: 'zai/glm-5.3-flash', thinking: 'high' });
  assert.deepEqual(SEQUENCE(calls), [
    'GET /goal',
    'POST /goal#pause',
    'POST /abort',
    'POST /control#set_model',
    'POST /control#set_thinking_level',
    'POST /goal#resume',
    'GET /goal',
  ]);
  assert.deepEqual(calls[3]?.body, { action: 'set_model', modelId: 'zai/glm-5.3-flash' });
  assert.deepEqual(calls[4]?.body, { action: 'set_thinking_level', level: 'high' });
  const resume = calls[5]?.body as { action: string; note?: string };
  assert.equal(resume.action, 'resume');
  assert.match(resume.note ?? '', /zai\/glm-5\.3-flash/, 'the resume note names the new route');
  assert.ok((resume.note ?? '').length <= 300, 'the resume note is short');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.hadGoal, true);
  assert.equal(outcome.objectiveIntact, true);
  assert.deepEqual(outcome.steps.map((step) => [step.step, step.ok]), [
    ['read_goal', true], ['pause_goal', true], ['abort', true], ['set_model', true], ['set_thinking_level', true], ['resume_goal', true], ['verify_goal', true],
  ]);
});

test('W2c reroute: no --thinking skips set_thinking_level', async () => {
  const { transport, calls } = routedTransport(goalRoutes([GOAL_RUNNING, GOAL_RUNNING]));
  await client(transport).reroute('s1', { modelSelector: 'm/x' });
  assert.equal(SEQUENCE(calls).includes('POST /control#set_thinking_level'), false);
});

test('W2c reroute: a session with NO goal gets a plain abort + set_model and a note (no pause/resume)', async () => {
  const { transport, calls } = routedTransport(goalRoutes([{ sessionId: 's1', supported: true, status: 'idle' }]));
  const outcome = await client(transport).reroute('s1', { modelSelector: 'm/x', thinking: 'low' });
  assert.deepEqual(SEQUENCE(calls), ['GET /goal', 'POST /abort', 'POST /control#set_model', 'POST /control#set_thinking_level']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.hadGoal, false);
  assert.match(outcome.note ?? '', /no goal/i);
});

test('W2c reroute: a goal read that 404s/errors is treated as no-goal, never as success of a goal step', async () => {
  const { transport, calls } = routedTransport(goalRoutes([GOAL_RUNNING], {
    'GET /api/v1/sessions/s1/goal': () => { throw apiError(404, 'GOAL_NOT_FOUND'); },
  }));
  const outcome = await client(transport).reroute('s1', { modelSelector: 'm/x' });
  assert.equal(outcome.hadGoal, false);
  assert.equal(SEQUENCE(calls).some((entry) => entry.includes('#pause')), false);
});

test('W2c reroute: set_model failure stops the sequence, tries ONE recovery resume, and reports the failed step', async () => {
  const { transport, calls } = routedTransport(goalRoutes([GOAL_RUNNING], {
    'POST /api/v1/sessions/s1/control': () => { throw apiError(400, 'MODEL_NOT_FOUND', 'no such model'); },
  }));
  const outcome = await client(transport).reroute('s1', { modelSelector: 'bogus', thinking: 'high' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'set_model');
  assert.equal(SEQUENCE(calls).includes('POST /control#set_thinking_level'), false, 'nothing runs after the failed step');
  const last = outcome.steps[outcome.steps.length - 1];
  assert.equal(last?.step, 'resume_goal');
  assert.match(last?.detail ?? '', /recovery/i);
  assert.equal(outcome.steps.find((step) => step.step === 'set_model')?.ok, false);
  assert.match(outcome.steps.find((step) => step.step === 'set_model')?.detail ?? '', /MODEL_NOT_FOUND/);
});

test('W2c reroute: an objective that changed across the resume is reported as NOT intact (ok:false)', async () => {
  const { transport } = routedTransport(goalRoutes([GOAL_RUNNING, { ...GOAL_RUNNING, objective: 'Something else' }]));
  const outcome = await client(transport).reroute('s1', { modelSelector: 'm/x' });
  assert.equal(outcome.objectiveIntact, false);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'verify_goal');
});

test('W2c reroute: a 409 on abort (nothing running) is not a failure — the step is ok with a note', async () => {
  const { transport } = routedTransport(goalRoutes([GOAL_RUNNING, GOAL_RUNNING], {
    'POST /api/v1/sessions/s1/abort': () => { throw apiError(409, 'SESSION_NOT_STREAMING'); },
  }));
  const outcome = await client(transport).reroute('s1', { modelSelector: 'm/x' });
  assert.equal(outcome.ok, true);
  assert.match(outcome.steps.find((step) => step.step === 'abort')?.detail ?? '', /nothing to abort|not streaming|idle/i);
});

test('W2c reroute CLI: requires --model-selector (exit 2), rejects unknown flags, maps ok/failed to 0/1', async () => {
  const stub = {
    reroute: async (_sessionId: string, input: { modelSelector: string; thinking?: string }) => (input.modelSelector === 'bad'
      ? { ok: false, hadGoal: true, failedStep: 'set_model', steps: [{ step: 'set_model', ok: false, detail: 'boom' }] }
      : { ok: true, hadGoal: true, objectiveIntact: true, steps: [{ step: 'set_model', ok: true, detail: 'done' }] }),
  };
  const deps = fakeDeps(() => stub as never);
  assert.equal((await runCli(['reroute', 's1'], deps)).exitCode, 2);
  assert.equal((await runCli(['reroute'], deps)).exitCode, 2);
  assert.equal((await runCli(['reroute', 's1', '--model-selector', 'm/x', '--bogus', '1'], deps)).exitCode, 2);
  const good = await runCli(['reroute', 's1', '--model-selector', 'm/x', '--thinking', 'high', '--json'], deps);
  assert.equal(good.exitCode, 0, good.stderr);
  assert.equal((JSON.parse(good.stdout ?? '{}') as { ok?: boolean }).ok, true);
  const bad = await runCli(['reroute', 's1', '--model-selector', 'bad'], deps);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr ?? '', /set_model/);
});
