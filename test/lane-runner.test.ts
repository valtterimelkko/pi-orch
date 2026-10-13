import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLane, loadLane, LaneConfigError, QUESTION_SENTINEL, CHILD_DIRECTIVE, type LaneDeps } from '../src/lane-runner.ts';
import { makeLaneDir, FakeWorld, routeLimitError, type Scenario } from './lane-runner-helpers.ts';

/**
 * W4-a — `pi-orch lane run`. Every behaviour is driven through the mocked
 * client (test/lane-runner-helpers.ts); no test writes a real ledger, audit
 * log or token — lane dirs are fresh temp directories.
 */

class SimulatedKill extends Error {}

function deps(world: FakeWorld, extra: Partial<LaneDeps> = {}): LaneDeps {
  return { client: world.client() as unknown as LaneDeps['client'], now: () => '2026-01-01T00:00:00.000Z', ...extra };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const readJournal = (dir: string) => readFileSync(join(dir, 'runner-journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>);

test('happy lane: gates green + ACCEPT → exit 0, two children, journal + state + exit file', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(world.spawns.length, 2);
  assert.deepEqual(world.spawns.map((entry) => entry.role), ['implementer', 'reviewer']);
  assert.equal(world.implementerPrompts.length, 1);
  assert.equal(world.reviewerPrompts.length, 1);
  // every prompt carries the child directive and the brief it dispatches
  for (const prompt of world.prompts) assert.ok(prompt.message.includes(CHILD_DIRECTIVE), 'directive in every prompt');
  assert.ok(world.implementerPrompts[0]?.message.includes('Implement the thing.'));
  assert.ok(world.reviewerPrompts[0]?.message.includes('Review the work.'));
  // spawn inputs: retention with the lane owner, route from lane.json
  const impl = world.spawns[0]?.input as any;
  assert.equal(impl.runtime, 'pi');
  assert.equal(impl.modelSelector, 'zai/glm-5.3');
  assert.equal(impl.thinkingLevel, 'high');
  assert.equal(impl.retention.ownerId, 'orch-test-12345678-w4a');
  assert.equal(impl.retention.ttlSeconds, 14_400);
  // gates ran from the brief in the lane's cwd
  assert.equal(world.verifyCalls.length, 1);
  assert.deepEqual((world.verifyCalls[0] as any).gates.map((gate: any) => gate.expectedExit), [0, 0]);
  const exit = readJson(join(dir, 'runner-exit.json'));
  assert.equal(exit.code, 0);
  assert.equal(exit.name, 'DONE');
  assert.equal(exit.implementer.sessionId, 's-implementer-1');
  assert.equal(exit.reviewer.sessionId, 's-reviewer-1');
  assert.equal(exit.verdict, 'ACCEPT');
  const state = readJson(join(dir, 'runner-state.json'));
  assert.equal(state.implementer.sessionId, 's-implementer-1');
  assert.equal(state.implementer.leaseId, 'lease-s-implementer-1');
  assert.ok(state.watches.implementer && state.watches.reviewer);
  assert.equal(state.counters.corrections, 0);
  const journal = readJournal(dir);
  assert.ok(journal.every((record) => typeof record.ts === 'string' && typeof record.step === 'string'));
  assert.deepEqual(journal.map((record) => record.step).slice(0, 3), ['spawn_implementer', 'watch_implementer', 'dispatch']);
  assert.equal(journal.at(-1)?.step, 'exit');
});

test('a red gate sends ONE correction to the SAME implementer, then green → ACCEPT → exit 0', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { gatesGreen: [false, true] });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(world.spawns.filter((entry) => entry.role === 'implementer').length, 1, 'no second implementer');
  assert.equal(world.implementerPrompts.length, 2);
  const correction = world.implementerPrompts[1];
  assert.equal(correction?.sessionId, 's-implementer-1');
  assert.ok(correction?.message.includes(CHILD_DIRECTIVE));
  assert.ok(correction?.message.includes('env NODE_ENV=test npm test'), 'names the red gate');
  assert.ok(correction?.message.includes('not ok 3 - widget works'), 'carries the output tail');
  assert.equal(readJson(join(dir, 'runner-state.json')).counters.corrections, 1);
});

test('gates still red after the correction cap → exit 41, no reviewer spawned', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { gatesGreen: [false, false] });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 41);
  assert.equal(world.spawns.length, 1);
  assert.equal(world.implementerPrompts.length, 2);
  const exit = readJson(join(dir, 'runner-exit.json'));
  assert.equal(exit.name, 'GATES_RED');
  assert.ok(JSON.stringify(exit.redGates).includes('env NODE_ENV=test npm test'));
  // re-running does not send a third prompt: it replays the same judgement exit
  const again = await runLane({ laneDir: dir }, deps(world));
  assert.equal(again.exitCode, 41);
  assert.equal(world.implementerPrompts.length, 2);
});

test('maxCorrections 0: a red gate exits 41 with no correction', async () => {
  const { dir } = makeLaneDir({ maxCorrections: 0 });
  const world = new FakeWorld(dir, { gatesGreen: [false] });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 41);
  assert.equal(world.implementerPrompts.length, 1);
});

test('REJECT and ACCEPT WITH FIXES → exit 42, verdict recorded, children left for the parent', async () => {
  for (const verdict of ['REJECT', 'ACCEPT WITH FIXES']) {
    const { dir } = makeLaneDir();
    const world = new FakeWorld(dir, { verdicts: [verdict] });
    const result = await runLane({ laneDir: dir }, deps(world));
    assert.equal(result.exitCode, 42, verdict);
    const exit = readJson(join(dir, 'runner-exit.json'));
    assert.equal(exit.name, 'VERDICT');
    assert.equal(exit.verdict, verdict);
    assert.equal(exit.implementer.sessionId, 's-implementer-1');
    assert.equal(exit.reviewer.sessionId, 's-reviewer-1');
    assert.equal(exit.verdictFile, join(dir, 'verdict.md'));
    // replaying is idempotent: same exit, no new children or prompts
    const again = await runLane({ laneDir: dir }, deps(world));
    assert.equal(again.exitCode, 42);
    assert.equal(world.spawns.length, 2);
    assert.equal(world.prompts.length, 2);
  }
});

test('--continue correction: reviewer findings go to the SAME implementer, closure review on the SAME reviewer → exit 0', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { verdicts: ['REJECT', 'ACCEPT'] });
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 42);
  const result = await runLane({ laneDir: dir, continueCorrection: true }, deps(world));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(world.spawns.length, 2, 'no new children');
  assert.equal(world.implementerPrompts.length, 2);
  assert.equal(world.implementerPrompts[1]?.sessionId, 's-implementer-1');
  assert.ok(world.implementerPrompts[1]?.message.includes('fix the widget'), 'carries the reviewer findings');
  assert.equal(world.reviewerPrompts.length, 2);
  assert.ok(world.reviewerPrompts.every((prompt) => prompt.sessionId === 's-reviewer-1'));
  assert.ok(world.reviewerPrompts[1]?.message.includes('closure'), 'the second review is a closure review');
  const exit = readJson(join(dir, 'runner-exit.json'));
  assert.equal(exit.code, 0);
  assert.equal(exit.verdict, 'ACCEPT');
  assert.equal(exit.closure, true);
});

test('--continue correction ending in REJECT exits 42 again, and a third round is refused', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { verdicts: ['REJECT', 'REJECT'] });
  await runLane({ laneDir: dir }, deps(world));
  const second = await runLane({ laneDir: dir, continueCorrection: true }, deps(world));
  assert.equal(second.exitCode, 42);
  const promptsBefore = world.prompts.length;
  const third = await runLane({ laneDir: dir, continueCorrection: true }, deps(world));
  assert.equal(third.exitCode, 2, 'never a third round');
  assert.match(third.stderr ?? '', /third|already|closure/i);
  assert.equal(world.prompts.length, promptsBefore);
});

test('--continue correction is refused unless the lane sits at exit 42', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 0);
  const result = await runLane({ laneDir: dir, continueCorrection: true }, deps(world));
  assert.equal(result.exitCode, 2);
  assert.equal(world.prompts.length, 2);
  const fresh = makeLaneDir();
  const noState = await runLane({ laneDir: fresh.dir, continueCorrection: true }, deps(new FakeWorld(fresh.dir)));
  assert.equal(noState.exitCode, 2);
});

test('a child question file (NN-question.md) → exit 40; after the parent answers, re-running continues without a duplicate spawn', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { questionFileAtWait: { wait: 1, file: '01-question.md' } });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 40);
  const exit = readJson(join(dir, 'runner-exit.json'));
  assert.equal(exit.name, 'QUESTION');
  assert.deepEqual(exit.questionFiles, ['01-question.md']);
  assert.equal(world.spawns.length, 1);
  // the parent answered the child out of band; the runner resumes the wait and does NOT report the same file again
  const again = await runLane({ laneDir: dir }, deps(world));
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(world.spawns.filter((entry) => entry.role === 'implementer').length, 1);
  assert.equal(world.implementerPrompts.length, 1, 'the dispatch is never re-sent');
  // the second wait has no runId shortcut (the first run's receipt is already terminal)
  const waits = world.waitCalls.filter((entry) => entry.role === 'implementer');
  assert.equal(waits.length, 2);
  assert.equal(waits[1]?.options.runId, undefined);
});

test('the question sentinel outcome → exit 40', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { waitKinds: { implementer: ['question'] } });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 40);
  // the sentinel rides in the registered watch conditions
  const conditions = JSON.stringify(world.watches.get('s-implementer-1')?.conditions);
  assert.ok(conditions.includes(QUESTION_SENTINEL));
});

test('a route-cap refusal on spawn → exit 25 with the overflow hint; re-running retries the spawn', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { spawnError: { at: 1, error: routeLimitError() } });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 25);
  assert.match(result.stderr ?? '', /PAYG overflow/);
  assert.match(result.stderr ?? '', /owner/i);
  assert.equal(readJson(join(dir, 'runner-exit.json')).name, 'ROUTE_LIMIT');
  assert.equal(world.spawns.length, 0);
  const again = await runLane({ laneDir: dir }, deps(world));
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(world.spawns.length, 2);
});

test('a server PROFILE_CAPACITY_EXHAUSTED refusal also maps to 25', async () => {
  const { dir } = makeLaneDir();
  const error = Object.assign(new Error('profile full'), { code: 'PROFILE_CAPACITY_EXHAUSTED', status: 429, data: { profileId: 'max', maxConcurrent: 2, active: 2 } });
  const world = new FakeWorld(dir, { spawnError: { at: 1, error } });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 25);
  assert.match(result.stderr ?? '', /PAYG overflow/);
});

test('a wait deadline → exit 3 and the lane resumes at the same wait; other bad outcomes and unexpected errors → 43', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { waitKinds: { implementer: ['deadline'] } });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 3);
  assert.equal(world.implementerPrompts.length, 1);
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 0);
  assert.equal(world.implementerPrompts.length, 1, 'no re-dispatch after a deadline');

  const failed = makeLaneDir();
  const failedWorld = new FakeWorld(failed.dir, { waitKinds: { implementer: ['failed'] } });
  const failedResult = await runLane({ laneDir: failed.dir }, deps(failedWorld));
  assert.equal(failedResult.exitCode, 43);
  assert.equal(readJson(join(failed.dir, 'runner-exit.json')).name, 'RUNNER_ERROR');
  assert.ok(existsSync(join(failed.dir, 'runner-journal.jsonl')), 'journal intact');

  const boom = makeLaneDir();
  const boomWorld = new FakeWorld(boom.dir, { spawnError: { at: 1, error: new Error('socket exploded') } });
  const boomResult = await runLane({ laneDir: boom.dir }, deps(boomWorld));
  assert.equal(boomResult.exitCode, 43);
  assert.match(boomResult.stderr ?? '', /socket exploded/);
});

test('an unparseable or stale reviewer verdict → exit 43, never a guess', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { verdicts: ['MAYBE'] });
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 43);
  assert.match(result.stderr ?? '', /VERDICT/);
  // a leftover verdict file from an earlier run is not mistaken for this review
  const stale = makeLaneDir();
  writeFileSync(join(stale.dir, 'verdict.md'), 'VERDICT: ACCEPT\n');
  const staleWorld = new FakeWorld(stale.dir);
  const original = staleWorld.client().wait;
  const client = { ...staleWorld.client(), async wait(options: Record<string, unknown>) {
    const role = staleWorld.roleOf(String(options.sessionId));
    if (role === 'reviewer') return { kind: 'completed' }; // reviewer "finishes" without writing a verdict
    return original.call(staleWorld.client(), options);
  } };
  const staleResult = await runLane({ laneDir: stale.dir }, { client: client as unknown as LaneDeps['client'], now: () => 't' });
  assert.equal(staleResult.exitCode, 43);
  assert.match(staleResult.stderr ?? '', /did not write|stale|unchanged/i);
});

test('goal mode: goalStart with a one-line objective pointing at brief.md and the token budget; no prompt dispatch', async () => {
  const { dir } = makeLaneDir({ mode: 'goal' });
  const world = new FakeWorld(dir);
  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(world.goalStarts.length, 1);
  const start = world.goalStarts[0]?.input as any;
  assert.equal(start.budgetTokens, 60_000_000);
  assert.ok(!/[\r\n]/.test(start.objective));
  assert.ok(start.objective.includes(join(dir, 'brief.md')));
  assert.ok(start.objective.includes('Carry out the lane brief'));
  assert.equal(world.implementerPrompts.length, 0);
  assert.equal(world.reviewerPrompts.length, 1, 'the reviewer is still a prompt');
  const wait = world.waitCalls.find((entry) => entry.role === 'implementer');
  assert.ok(wait?.options.objective, 'the goal wait is keyed on the objective');
});

test('correction-template.md is used when present ({{RED_GATES}} and {{LANE}} substituted)', async () => {
  const { dir } = makeLaneDir({ correctionTemplate: 'Lane {{LANE}} needs a fix.\n\n{{RED_GATES}}\n\nFix only that.\n' });
  const world = new FakeWorld(dir, { gatesGreen: [false, true] });
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 0);
  const message = world.implementerPrompts[1]?.message ?? '';
  assert.ok(message.includes('Lane w4a-demo needs a fix.'));
  assert.ok(message.includes('env NODE_ENV=test npm test'));
  assert.ok(message.includes('Fix only that.'));
});

test('prompts use deterministic idempotency keys (a re-sent prompt is a server-side duplicate)', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { gatesGreen: [false, true] });
  await runLane({ laneDir: dir }, deps(world));
  const keys = world.prompts.map((prompt) => prompt.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => key.startsWith('lane:w4a-demo:')));
});

// ─── resume after a simulated kill at every step boundary ───────────────────

interface Run { exitCodes: number[]; world: FakeWorld; dir: string }

async function runWithKills(scenario: Scenario, killAt: string | undefined, phase: 'after-step' | 'after-call', first: { continueCorrection?: boolean } = {}, preludeDir?: string): Promise<Run> {
  const { dir } = preludeDir ? { dir: preludeDir } : makeLaneDir();
  const world = new FakeWorld(dir, scenario);
  const exitCodes: number[] = [];
  let killed = false;
  const hook = (step: string) => {
    if (!killed && killAt === step) {
      killed = true;
      throw new SimulatedKill(`kill at ${step}`);
    }
  };
  const hooks: Partial<LaneDeps> = phase === 'after-step' ? { afterStep: hook } : { afterCall: hook };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await runLane({ laneDir: dir, ...first }, deps(world, hooks));
      exitCodes.push(result.exitCode);
      break;
    } catch (error) {
      assert.ok(error instanceof SimulatedKill, `only the simulated kill may escape: ${String(error)}`);
      exitCodes.push(-1);
    }
  }
  return { exitCodes, world, dir };
}

function stepKeys(dir: string): string[] {
  return readJournal(dir).filter((record) => record.step !== 'exit').map((record) => String(record.step));
}

const summarise = (run: Run) => ({
  final: run.exitCodes.at(-1),
  spawns: run.world.spawns.map((entry) => `${entry.role}:${entry.id}`),
  prompts: run.world.prompts.map((prompt) => `${prompt.role}:${prompt.key}`),
  goalStarts: run.world.goalStarts.length,
});

test('resume: a kill after EVERY completed step boundary reaches the same end with no duplicate spawn or prompt', async () => {
  const scenario: Scenario = { gatesGreen: [false, true] }; // exercises the correction path too
  const baseline = await runWithKills(scenario, undefined, 'after-step');
  assert.equal(baseline.exitCodes.at(-1), 0);
  const steps = [...new Set(stepKeys(baseline.dir))];
  assert.ok(steps.length >= 12, `expected the full step list, got ${steps.join(',')}`);
  for (const step of steps) {
    const run = await runWithKills(scenario, step, 'after-step');
    assert.deepEqual(run.exitCodes.slice(0, -1), [-1], `exactly one kill at ${step}`);
    assert.deepEqual(summarise(run), summarise(baseline), `kill after ${step} diverged`);
    assert.equal(readJson(join(run.dir, 'runner-exit.json')).code, 0);
  }
});

test('resume: the --continue correction path survives a kill at every step boundary too', async () => {
  const scenario: Scenario = { verdicts: ['REJECT', 'ACCEPT'] };
  // baseline: first run → 42, then continue
  const baselineDir = makeLaneDir().dir;
  const baselineWorld = new FakeWorld(baselineDir, scenario);
  assert.equal((await runLane({ laneDir: baselineDir }, deps(baselineWorld))).exitCode, 42);
  const before = readJournal(baselineDir).length;
  assert.equal((await runLane({ laneDir: baselineDir, continueCorrection: true }, deps(baselineWorld))).exitCode, 0);
  const continued = [...new Set(readJournal(baselineDir).slice(before).filter((record) => record.step !== 'exit').map((record) => String(record.step)))];
  assert.ok(continued.length >= 5, `continue steps: ${continued.join(',')}`);
  for (const step of continued) {
    const dir = makeLaneDir().dir;
    const world = new FakeWorld(dir, scenario);
    assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 42);
    let killed = false;
    const hooks = { afterStep: (key: string) => { if (!killed && key === step) { killed = true; throw new SimulatedKill(key); } } };
    let final = -1;
    let kills = 0;
    for (let attempt = 0; attempt < 10 && final === -1; attempt += 1) {
      try {
        final = (await runLane({ laneDir: dir, continueCorrection: true }, deps(world, hooks))).exitCode;
      } catch (error) {
        assert.ok(error instanceof SimulatedKill);
        kills += 1;
      }
    }
    assert.equal(kills, 1, `kill at ${step}`);
    assert.equal(final, 0, `kill at ${step}`);
    assert.deepEqual(world.prompts.map((prompt) => prompt.key), baselineWorld.prompts.map((prompt) => prompt.key), `kill after ${step}`);
    assert.equal(world.spawns.length, 2);
  }
});

test('resume: a kill AFTER the prompt call but BEFORE its receipt is persisted re-sends only a server-side duplicate', async () => {
  const baseline = await runWithKills({ gatesGreen: [false, true] }, undefined, 'after-call');
  for (const step of ['dispatch', 'correction', 'dispatch_review']) {
    const run = await runWithKills({ gatesGreen: [false, true] }, step, 'after-call');
    assert.equal(run.exitCodes.at(-1), 0, step);
    assert.deepEqual(summarise(run), summarise(baseline), `after-call kill at ${step}`);
  }
});

test('resume: a kill after a spawn/goal-start call but before its receipt is persisted is refused (43) with a reconcile hint, never a second child', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  let killed = false;
  const hooks = { afterCall: (key: string) => { if (!killed && key === 'spawn_implementer') { killed = true; throw new SimulatedKill(key); } } };
  await assert.rejects(runLane({ laneDir: dir }, deps(world, hooks)), SimulatedKill);
  const result = await runLane({ laneDir: dir }, deps(world, hooks));
  assert.equal(result.exitCode, 43);
  assert.match(result.stderr ?? '', /reconcile/i);
  assert.match(result.stderr ?? '', /orch-test-12345678-w4a/, 'names the owner to reconcile by');
  assert.equal(world.spawns.length, 1, 'no second child');
});

test('resume: a registered-but-unrecorded watch is reused, not registered twice', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  let killed = false;
  const hooks = { afterCall: (key: string) => { if (!killed && key === 'watch_implementer') { killed = true; throw new SimulatedKill(key); } } };
  await assert.rejects(runLane({ laneDir: dir }, deps(world, hooks)), SimulatedKill);
  const registerCalls: string[] = [];
  const base = world.client();
  const counting = { ...base, registerWatch: async (sessionId: string, input: any) => { registerCalls.push(sessionId); return base.registerWatch(sessionId, input); } };
  const result = await runLane({ laneDir: dir }, { client: counting as unknown as LaneDeps['client'], now: () => 't' });
  assert.equal(result.exitCode, 0);
  assert.ok(!registerCalls.includes('s-implementer-1'), 'the existing watch was reused');
});

// ─── lane.json validation, dry-run, lock ────────────────────────────────────

test('loadLane validates strictly: unknown keys, bad types and missing GATES are config errors', () => {
  const bad = (overrides: Record<string, unknown>, options: Parameters<typeof makeLaneDir>[0] = {}) => {
    const { dir } = makeLaneDir({ ...options, laneOverrides: overrides });
    assert.throws(() => loadLane(dir), LaneConfigError, JSON.stringify(overrides));
  };
  bad({ surprise: true });
  bad({ implementer: { runtime: 'pi', selector: 'x', thinking: 'high', extra: 1 } });
  bad({ mode: 'nope' });
  bad({ maxCorrections: 2 });
  bad({ ttlSeconds: 0 });
  bad({ cwd: 'relative/path' });
  bad({ lane: '../escape' });
  bad({ parentSessionId: '' });
  bad({ implementer: { runtime: 'bogus', selector: 'x', thinking: 'high' } });
  bad({ budgetTokens: 5 }, { mode: 'prompt' }); // a goal budget on a prompt lane
  bad({ objective: 'two\nlines' }, { mode: 'goal' });
  const noGates = makeLaneDir({ brief: '# Brief without gates\n' });
  assert.throws(() => loadLane(noGates.dir), /GATES/);
  const malformed = makeLaneDir({ brief: '# B\n\nGATES:\n- npm test\n' });
  assert.throws(() => loadLane(malformed.dir), /malformed|GATES/i);
  const noReview = makeLaneDir({ noReviewBrief: true });
  assert.throws(() => loadLane(noReview.dir), /review-brief/);
  const missing = join(noReview.dir, 'nowhere');
  assert.throws(() => loadLane(missing), LaneConfigError);
});

test('loadLane accepts a complete lane and resolves the verdict-file path from review-brief.md', () => {
  const { dir } = makeLaneDir();
  const lane = loadLane(dir);
  assert.equal(lane.config.lane, 'w4a-demo');
  assert.equal(lane.gates.length, 2);
  assert.equal(lane.verdictFile, join(dir, 'verdict.md'));
  const absolute = makeLaneDir({ reviewBrief: 'Review.\nVERDICT FILE: /abs/place/verdict.md\n' });
  assert.equal(loadLane(absolute.dir).verdictFile, '/abs/place/verdict.md');
});

test('--dry-run prints the plan and validates inputs with no API call and no files written', async () => {
  const { dir } = makeLaneDir();
  const forbidden = new Proxy({}, { get: (_target, name) => { throw new Error(`dry-run made a client call: ${String(name)}`); } });
  const before = readdirSync(dir).sort();
  const result = await runLane({ laneDir: dir, dryRun: true }, { client: forbidden as unknown as LaneDeps['client'], now: () => 't' });
  assert.equal(result.exitCode, 0);
  for (const step of ['spawn_implementer', 'watch_implementer', 'dispatch', 'wait', 'gates', 'spawn_reviewer', 'verdict']) {
    assert.ok((result.stdout ?? '').includes(step), `plan names ${step}`);
  }
  assert.deepEqual(readdirSync(dir).sort(), before, 'no state/journal/lock written');
  // dry-run on an invalid lane is still a validation failure
  const broken = makeLaneDir({ laneOverrides: { surprise: 1 } });
  await assert.rejects(runLane({ laneDir: broken.dir, dryRun: true }, { client: forbidden as unknown as LaneDeps['client'], now: () => 't' }), LaneConfigError);
});

test('a second runner on a live lock is refused (43); a stale lock is taken over; the lock is released on exit', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  writeFileSync(join(dir, 'runner.lock'), `${process.pid}\n`);
  const refused = await runLane({ laneDir: dir }, deps(world));
  assert.equal(refused.exitCode, 43);
  assert.match(refused.stderr ?? '', /another runner|lock/i);
  assert.equal(world.spawns.length, 0);
  writeFileSync(join(dir, 'runner.lock'), '2147483646\n'); // not a live pid
  const taken = await runLane({ laneDir: dir }, deps(world));
  assert.equal(taken.exitCode, 0, taken.stderr);
  assert.equal(existsSync(join(dir, 'runner.lock')), false, 'lock released');
});

test('the wait deadline option reaches the client wait', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir);
  await runLane({ laneDir: dir, deadlineMs: 12_345_000 }, deps(world));
  assert.ok(world.waitCalls.every((call) => call.options.deadlineMs === 12_345_000));
});

test('W4a review: an antigravity route needs no thinking (the level is in the selector); other runtimes still do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-agy-'));
  writeFileSync(join(dir, 'brief.md'), '# b\n\nGATES:\n- true → 0\n');
  writeFileSync(join(dir, 'review-brief.md'), '# r\n');
  const base = { lane: 'l', cwd: dir, owner: 'o', mode: 'prompt', ttlSeconds: 600, parentSessionId: 'p', maxCorrections: 1, implementer: { runtime: 'pi', selector: 'x/y', thinking: 'high' } };
  writeFileSync(join(dir, 'lane.json'), JSON.stringify({ ...base, reviewer: { runtime: 'antigravity', selector: 'gemini-3.8-flash-medium' } }));
  assert.equal(loadLane(dir).config.reviewer.thinking, undefined);
  writeFileSync(join(dir, 'lane.json'), JSON.stringify({ ...base, reviewer: { runtime: 'pi', selector: 'x/z' } }));
  assert.throws(() => loadLane(dir), LaneConfigError);
});

test('W4a review-1: a sentinel question with its file is reported once; the answered question never re-exits 40', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, { waitKinds: { implementer: ['question'] }, questionFileAtWait: { wait: 1, file: '01-question.md' } });
  const first = await runLane({ laneDir: dir }, deps(world));
  assert.equal(first.exitCode, 40);
  const second = await runLane({ laneDir: dir }, deps(world));
  assert.notEqual(second.exitCode, 40, 'the already-reported 01-question.md must not trigger a second exit 40');
});

test('W4a review-3: the question sentinel is an end-anchored line pattern, not a substring a quoted directive can trip', async () => {
  const { dir } = makeLaneDir();
  const world = new FakeWorld(dir, {});
  await runLane({ laneDir: dir }, deps(world));
  const conditions = (world.watches.get('s-implementer-1')?.conditions ?? []) as Array<Record<string, unknown>>;
  const sentinel = conditions.find((c) => c.type === 'text');
  assert.ok(sentinel, 'a text condition is registered');
  assert.equal(sentinel?.contains, undefined);
  const re = new RegExp(String(sentinel?.pattern), String(sentinel?.patternFlags ?? ''));
  assert.ok(re.test(`thinking...\n${QUESTION_SENTINEL}\n`));
  assert.ok(!re.test(`print the line ${QUESTION_SENTINEL} on its own line, and end your turn.`));
});
