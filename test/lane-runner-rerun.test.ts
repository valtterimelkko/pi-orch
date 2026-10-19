import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLane, QUESTION_SENTINEL, type LaneDeps } from '../src/lane-runner.ts';
import { defaultConditions } from '../src/builders.ts';
import { makeLaneDir } from './lane-runner-helpers.ts';

/**
 * D18 (plan) — two lane-runner defects found in live use, reproduced against a
 * server-faithful fake.
 *
 * The real server keeps ONE watch per session and a cumulative firing LEDGER;
 * a long poll that carries no `cursor` is served every firing the watch has
 * already recorded (docs/INTERNAL-API.md, `GET /watches/wait?cursor`, and
 * `docs/INTERNAL-API.md` "replacement registration … resets the ledger"). The
 * lane runner registers its watch once as a step and the wait reuses it by
 * label, so on a re-run the parked attempt's firings are served AGAIN:
 *
 *   1. after exit 3 the already-fired `deadline` condition is replayed → exit 3
 *      at once, every time (the live evidence: twelve exit-3 runs in one second,
 *      /root/orch-ops/channel/store/runner.log);
 *   2. after exit 40 the already-reported question firing is replayed → exit 40
 *      at once, every time, even after the parent answered and the child
 *      finished (/root/orch-ops/channel/inbox/runner.log 18:03–18:09Z).
 *
 * The fake below is a lean rewrite of test/lane-runner-helpers.ts's one, plus
 * that ledger: the lane fixtures come from `makeLaneDir`, watches live
 * server-side across `runLane` calls, a registration replaces the watch and
 * resets its ledger, and a wait with no cursor replays what is recorded before
 * anything new happens. Nothing here touches the network, a real watch, a real
 * ledger or a token.
 */

type Role = 'implementer' | 'reviewer';

interface Firing {
  conditionId: string;
  eventType: string;
  evidence?: string;
}

interface ServerWatch {
  watchId: string;
  generation: string;
  label?: string;
  conditions: Array<Record<string, unknown>>;
  firings: Firing[];
  status: 'active';
}

export interface RerunScenario {
  /** Scripted outcome per wait call on a role (1-based); default `completed`. */
  waitKinds?: { implementer?: string[]; reviewer?: string[] };
  /** A question file the child writes during the Nth implementer wait (1-based). */
  questionFileAtWait?: { wait: number; file: string };
}

/**
 * The behaviour-affecting fields of a watch condition, ids excluded — the same
 * compatibility rule the client's own register-or-reuse applies
 * (`conditionShape` in src/wait.ts).
 */
function shapeOf(condition: Record<string, unknown>): string {
  const keys = ['type', 'eventType', 'dataMatch', 'toolName', 'phase', 'argIncludes', 'contains', 'pattern', 'patternFlags', 'source', 'afterSeconds', 'once'];
  const out: Record<string, unknown> = {};
  for (const key of keys) if (condition[key] !== undefined) out[key] = condition[key];
  return JSON.stringify(Object.keys(out).sort().map((key) => [key, out[key]]));
}

const shapes = (conditions: Array<Record<string, unknown>>): string[] => conditions.map(shapeOf).sort();

class ServerWorld {
  readonly spawns: Array<{ id: string; role: Role; input: Record<string, unknown> }> = [];
  readonly prompts: Array<{ sessionId: string; role: Role; message: string; key: string }> = [];
  readonly goalStarts: Array<{ sessionId: string; input: Record<string, unknown> }> = [];
  /** Server-side watches: they outlive one `runLane` call, exactly like the real ledger. */
  readonly watches = new Map<string, ServerWatch>();
  readonly waitCalls: Array<{ sessionId: string; role: Role; watchId: string; replayed: number; options: Record<string, unknown> }> = [];
  /** Every watch registration, in order, with who asked for it. */
  readonly registrations: Array<{ sessionId: string; watchId: string; by: 'lane' | 'wait' }> = [];
  private sequence = 0;
  readonly laneDir: string;
  readonly scenario: RerunScenario;

  constructor(laneDir: string, scenario: RerunScenario = {}) {
    this.laneDir = laneDir;
    this.scenario = scenario;
  }

  roleOf(sessionId: string): Role {
    const found = this.spawns.find((entry) => entry.id === sessionId);
    if (!found) throw new Error(`fake: unknown session ${sessionId}`);
    return found.role;
  }

  private replaceWatch(sessionId: string, conditions: Array<Record<string, unknown>>, label: string | undefined, by: 'lane' | 'wait'): ServerWatch {
    this.sequence += 1;
    const watch: ServerWatch = {
      watchId: `watch-${sessionId}-gen${this.sequence}`,
      generation: `gen${this.sequence}`,
      ...(label !== undefined ? { label } : {}),
      conditions,
      firings: [], // "Accepted replacement changes generation and resets the ledger"
      status: 'active',
    };
    this.watches.set(sessionId, watch);
    this.registrations.push({ sessionId, watchId: watch.watchId, by });
    return watch;
  }

  /** The lane runner's own attempt at waiting a role again. */
  refreshCalls(): Array<{ sessionId: string; watchId: string }> {
    return this.registrations.filter((entry) => entry.by === 'lane');
  }

  watchById(watchId: string | undefined): ServerWatch | undefined {
    for (const watch of this.watches.values()) if (watch.watchId === watchId) return watch;
    return undefined;
  }

  /** Plant a server-side watch with a non-empty ledger (a parked previous attempt). */
  seedWatch(sessionId: string, conditions: Array<Record<string, unknown>>, firings: Firing[]): string {
    const watch = this.replaceWatch(sessionId, conditions, `lane:w4a-demo:${sessionId.includes('review') ? 'review' : 'impl'}`, 'lane');
    watch.firings.push(...firings);
    return watch.watchId;
  }

  client() {
    const world = this;
    return {
      async spawn(input: Record<string, unknown>) {
        const label = String((input.retention as { label?: string } | undefined)?.label ?? '');
        const role: Role = label.endsWith('-review') ? 'reviewer' : 'implementer';
        const id = `s-${role}-${world.spawns.filter((entry) => entry.role === role).length + 1}`;
        world.spawns.push({ id, role, input });
        return { sessionId: id, leaseId: `lease-${id}` };
      },
      async prompt(sessionId: string, input: Record<string, unknown>) {
        const role = world.roleOf(sessionId);
        const key = String(input.idempotencyKey ?? '');
        if (key === '') throw new Error('fake: the lane runner must send a deterministic idempotencyKey');
        const prior = world.prompts.find((entry) => entry.key === key);
        if (prior) return { runId: `run-of-${key}`, sessionId, duplicate: true };
        world.prompts.push({ sessionId, role, message: String(input.message), key });
        return { runId: `run-${world.prompts.length}`, sessionId, duplicate: false };
      },
      async goalStart(sessionId: string, input: Record<string, unknown>) {
        world.goalStarts.push({ sessionId, input });
        return { status: 'running', objective: String(input.objective), goalId: `goal-${world.goalStarts.length}`, runId: `run-goal-${world.goalStarts.length}` };
      },
      async registerWatch(sessionId: string, input: { conditions: unknown[]; label?: string }) {
        const watch = world.replaceWatch(sessionId, input.conditions as Array<Record<string, unknown>>, input.label, 'lane');
        return { watchId: watch.watchId, status: 'active' as const };
      },
      async getWatch(sessionId: string) {
        const watch = world.watches.get(sessionId);
        return watch ? { watchId: watch.watchId, status: watch.status, label: watch.label, conditions: watch.conditions.map((spec) => ({ spec })) } : null;
      },
      async deleteWatch(sessionId: string) {
        const watch = world.watches.get(sessionId);
        world.watches.delete(sessionId);
        return { success: true, watchId: watch?.watchId, generation: watch?.generation };
      },
      async wait(options: Record<string, unknown>) {
        const sessionId = String(options.sessionId);
        const role = world.roleOf(sessionId);
        const wanted = (options.conditions ?? []) as Array<Record<string, unknown>>;
        const callNumber = world.waitCalls.filter((entry) => entry.role === role).length + 1;
        // Register-or-reuse, as the client does: an active watch with
        // semantically equal conditions is reused; otherwise our own labelled
        // watch is replaced (a replacement resets the ledger).
        const existing = world.watches.get(sessionId);
        const watch = existing && shapes(existing.conditions).join('|') === shapes(wanted).join('|')
          ? existing
          : world.replaceWatch(sessionId, wanted, options.label as string | undefined, 'wait');
        const record = { sessionId, role, watchId: watch.watchId, replayed: watch.firings.length, options };
        world.waitCalls.push(record);
        // No cursor: every firing already in the ledger is served immediately.
        for (const firing of watch.firings) {
          const outcome = outcomeOf(firing, wanted);
          if (outcome) return { kind: outcome, note: 'served from the watch ledger (no cursor)' };
        }
        // Nothing recorded: the child acts during this wait, and the watch records it.
        const kind = world.scenario.waitKinds?.[role]?.[callNumber - 1] ?? 'completed';
        if (kind === 'question') {
          const ask = world.scenario.questionFileAtWait;
          if (ask && ask.wait === callNumber) writeFileSync(join(world.laneDir, ask.file), '# Question\n\nWhich option?\n');
          watch.firings.push({ conditionId: 'question', eventType: 'message_update', evidence: `...\n${QUESTION_SENTINEL}\n` });
        } else if (kind === 'deadline') {
          watch.firings.push({ conditionId: 'deadline', eventType: 'deadline' });
        } else if (kind === 'completed') {
          if (role === 'reviewer') {
            const round = world.prompts.filter((entry) => entry.role === 'reviewer').length;
            writeFileSync(join(world.laneDir, 'verdict.md'), `VERDICT: ACCEPT\n\nFindings for round ${round}.\n`);
          }
          watch.firings.push({ conditionId: 'done', eventType: 'agent_end' });
        }
        return { kind, ...(kind === 'completed' ? {} : { note: `scripted ${kind}` }) };
      },
      async verify(input: Record<string, unknown>) {
        const gates = (input.gates as Array<{ command: string; expectedExit: number }>).map((gate) => ({ command: gate.command, expectedExit: gate.expectedExit, actualExit: gate.expectedExit, result: 'verified', outputTail: [] as string[] }));
        return { sessionId: String(input.sessionId), verdict: 'verified', claims: [], gates, summary: 'verified' };
      },
    };
  }
}

/** Classify a recorded firing the way the wait verb does (condition id → our spec). */
function outcomeOf(firing: Firing, wanted: Array<Record<string, unknown>>): string | null {
  const spec = wanted.find((condition) => condition.id === firing.conditionId);
  if (spec?.type === 'deadline' || firing.eventType === 'deadline') return 'deadline';
  if (spec?.type === 'text') return 'question';
  if (firing.eventType === 'agent_end' || firing.eventType === 'goal_end') return 'completed';
  if (firing.conditionId === 'question') return 'question';
  if (firing.conditionId === 'deadline') return 'deadline';
  return null;
}

const deps = (world: ServerWorld): LaneDeps => ({
  client: world.client() as unknown as LaneDeps['client'],
  now: () => '2026-10-19T00:00:00.000Z',
});

const implementsWaits = (world: ServerWorld) => world.waitCalls.filter((entry) => entry.role === 'implementer');

// ─── defect 1: a re-run after exit 3 must get a FRESH wait window ────────────

test('D18-1 a re-run after exit 3 waits in a fresh window instead of replaying the fired deadline', async () => {
  const { dir } = makeLaneDir();
  const world = new ServerWorld(dir, { waitKinds: { implementer: ['deadline', 'completed'] } });

  const first = await runLane({ laneDir: dir }, deps(world));
  assert.equal(first.exitCode, 3, 'the first wait ran out of time');
  assert.equal(implementsWaits(world).length, 1);

  const second = await runLane({ laneDir: dir }, deps(world));
  assert.equal(second.exitCode, 0, `a re-run after exit 3 must keep waiting, not exit 3 again: ${second.stderr ?? ''}`);
  const waits = implementsWaits(world);
  assert.equal(waits.length, 2, 'the lane waited a second time');
  assert.notEqual(waits[1]?.watchId, waits[0]?.watchId, 'the second wait must not be served the parked attempt\'s watch ledger');
  assert.equal(waits[1]?.replayed, 0, 'the second wait is served no recorded firing');
  // The re-run registers the fresh watch itself (i.e. the wait is not left on a
  // ledger whose deadline condition has already fired), and the wait that
  // follows uses exactly that registration. Two lane registrations: the first
  // run's `watch_implementer` step, then the resuming attempt's own.
  const refreshed = world.refreshCalls().filter((entry) => entry.sessionId === 's-implementer-1');
  assert.equal(refreshed.length, 2, 'one registration from the watch step, one from the resuming wait');
  assert.equal(waits[1]?.watchId, refreshed.at(-1)?.watchId, 'the second wait used the watch the re-run registered');
  const conditions = (world.watchById(waits[1]?.watchId)?.conditions ?? []) as Array<Record<string, unknown>>;
  assert.ok(conditions.some((condition) => condition.type === 'deadline' && condition.afterSeconds === 1800), 'the fresh watch carries its own 1800 s deadline condition');
  assert.equal(waits[1]?.options.deadlineMs, 1_800_000, 'and the fresh client-side window');
  // and the dispatch is still never re-sent
  assert.equal(world.prompts.filter((entry) => entry.role === 'implementer').length, 1);
  assert.equal(world.spawns.filter((entry) => entry.role === 'implementer').length, 1);
});

test('D18-1b a re-run after exit 3 with the child still working waits again (exit 3 twice, never at once)', async () => {
  const { dir } = makeLaneDir();
  const world = new ServerWorld(dir, { waitKinds: { implementer: ['deadline', 'deadline', 'completed'] } });
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 3);
  const second = await runLane({ laneDir: dir }, deps(world));
  assert.equal(second.exitCode, 3, 'still working → a second deadline, from its own new window');
  const waits = implementsWaits(world);
  assert.equal(waits.length, 2);
  assert.notEqual(waits[1]?.watchId, waits[0]?.watchId);
  assert.equal(waits[1]?.replayed, 0);
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 0, 'third attempt completes');
  assert.equal(world.prompts.filter((entry) => entry.role === 'implementer').length, 1, 'dispatch never re-sent');
});

test('D18-1c a reviewer wait deadline re-run also gets a fresh window (both roles share the path)', async () => {
  const { dir } = makeLaneDir();
  const world = new ServerWorld(dir, { waitKinds: { reviewer: ['deadline', 'completed'] } });
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 3);
  const second = await runLane({ laneDir: dir }, deps(world));
  assert.equal(second.exitCode, 0, second.stderr);
  const reviewWaits = world.waitCalls.filter((entry) => entry.role === 'reviewer');
  assert.equal(reviewWaits.length, 2);
  assert.notEqual(reviewWaits[1]?.watchId, reviewWaits[0]?.watchId, 'the reviewer re-wait is not served the parked deadline');
  assert.equal(reviewWaits[1]?.replayed, 0);
  assert.equal(world.spawns.length, 2, 'no extra children');
  assert.equal(world.prompts.filter((entry) => entry.role === 'implementer').length, 1, 'no re-dispatch');
  assert.equal(world.prompts.filter((entry) => entry.role === 'reviewer').length, 1, 'the review brief is not re-sent');
});

// ─── defect 2: an ANSWERED question must not exit 40 again ──────────────────

test('D18-2 an answered question does not exit 40 again; the wait resumes and the lane continues', async () => {
  const { dir } = makeLaneDir();
  const world = new ServerWorld(dir, {
    waitKinds: { implementer: ['question', 'completed'] },
    questionFileAtWait: { wait: 1, file: '01-question.md' },
  });

  const first = await runLane({ laneDir: dir }, deps(world));
  assert.equal(first.exitCode, 40, 'the child parked with a question');
  // the parent answered out of band; the child resumed and finished its turn
  const second = await runLane({ laneDir: dir }, deps(world));
  assert.notEqual(second.exitCode, 40, 'the already-reported 01-question.md must not trigger a second exit 40');
  assert.equal(second.exitCode, 0, second.stderr);
  const waits = implementsWaits(world);
  assert.equal(waits.length, 2);
  assert.notEqual(waits[1]?.watchId, waits[0]?.watchId, 'the re-run must not replay the reported question firing');
  assert.equal(waits[1]?.replayed, 0);
  assert.equal(world.prompts.filter((entry) => entry.role === 'implementer').length, 1, 'the dispatch is never re-sent');
  assert.equal(world.waitCalls.filter((entry) => entry.role === 'implementer')[1]?.options.runId, undefined, 'no run-receipt shortcut after a question');
});

test('D18-2b a NEW question still exits 40 — with its own file, and on a fresh watch', async () => {
  const { dir } = makeLaneDir();
  const world = new ServerWorld(dir, {
    waitKinds: { implementer: ['question', 'question', 'completed'] },
    questionFileAtWait: { wait: 2, file: '02-question.md' },
  });
  const first = await runLane({ laneDir: dir }, deps(world));
  assert.equal(first.exitCode, 40);
  const second = await runLane({ laneDir: dir }, deps(world));
  assert.equal(second.exitCode, 40, 'a new question still parks the lane');
  const exit = JSON.parse(readFileSync(join(dir, 'runner-exit.json'), 'utf8')) as Record<string, any>;
  assert.deepEqual(exit.questionFiles, ['02-question.md'], 'the new question file is reported, not the answered one');
  assert.equal((await runLane({ laneDir: dir }, deps(world))).exitCode, 0, 'answered again → the lane continues');
  assert.equal(world.prompts.filter((entry) => entry.role === 'implementer').length, 1);
});

test('D18-2c a re-run after a question does not re-register a second child or prompt, and keeps the journal additive', async () => {
  const { dir } = makeLaneDir();
  const world = new ServerWorld(dir, { waitKinds: { implementer: ['question', 'completed'] }, questionFileAtWait: { wait: 1, file: '01-question.md' } });
  await runLane({ laneDir: dir }, deps(world));
  const journalBefore = readFileSync(join(dir, 'runner-journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  await runLane({ laneDir: dir }, deps(world));
  const journalAfter = readFileSync(join(dir, 'runner-journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  // Every record keeps the same keys the earlier runs wrote (additive only:
  // the wait receipt may name the watch it used, nothing may appear or vanish).
  const keys = (record: Record<string, unknown>) => Object.keys(record).sort().join(',');
  const known = new Set(journalBefore.map(keys));
  for (const record of journalAfter) {
    const set = Object.keys(record).sort();
    assert.ok(known.has(set.join(',')) || set.every((key) => ['ts', 'step', 'sessionId', 'leaseId', 'runId', 'watchId', 'outcome', 'verdict', 'green', 'duplicate', 'reused'].includes(key)), `unexpected journal keys: ${set.join(',')}`);
  }
  const state = JSON.parse(readFileSync(join(dir, 'runner-state.json'), 'utf8')) as Record<string, any>;
  assert.equal(state.schema, 'pi-orch-lane-state/v1');
  assert.equal(state.implementer.sessionId, 's-implementer-1');
});

// ─── a state file written before D18 must be migrated, not replayed ──────────

test('D18-5 a pre-D18 runner-state.json resumes on a fresh watch instead of reading its park back', async () => {
  const { dir } = makeLaneDir();
  // The shape the runner wrote before it tracked parked waits: three steps
  // receipted, the wait parked (three live runs exited 40 from here with no
  // `wait` receipt at all), and no `staleWatches` field.
  writeFileSync(join(dir, 'runner-state.json'), `${JSON.stringify({
    schema: 'pi-orch-lane-state/v1',
    lane: 'w4a-demo',
    step: 'dispatch',
    steps: {
      spawn_implementer: { at: '2026-10-19T15:54:28.984Z', result: { sessionId: 's-implementer-1', leaseId: 'lease-s-implementer-1', outcome: 'spawned' } },
      watch_implementer: { at: '2026-10-19T15:54:28.995Z', result: { watchId: 'watch-old', outcome: 'registered' } },
      dispatch: { at: '2026-10-19T15:54:29.764Z', result: { runId: 'run-old', sessionId: 's-implementer-1', duplicate: false, outcome: 'sent' } },
    },
    implementer: { sessionId: 's-implementer-1', leaseId: 'lease-s-implementer-1' },
    watches: { implementer: 'watch-old' },
    runs: { dispatch: 'run-old' },
    counters: { corrections: 0, reviewRounds: 0 },
    baselines: {},
    questionsReported: ['01-question.md'],
    omitRunIdFor: ['wait', 'wait', 'wait'],
    updatedAt: '2026-10-19T16:19:32.494Z',
  }, null, 2)}\n`);
  const world = new ServerWorld(dir, { waitKinds: { implementer: ['completed'] } });
  world.spawns.push({ id: 's-implementer-1', role: 'implementer', input: {} });
  // The parked attempt's watch, still on the server with the answered question
  // in its ledger and the conditions the runner asks for (ids differ, shape is equal).
  const parkedConditions = [...defaultConditions(undefined, 1_800_000), { id: 'question', type: 'text', pattern: `(^|\\n)${QUESTION_SENTINEL}\\s*$`, patternFlags: '', once: false }] as unknown as Array<Record<string, unknown>>;
  const parked = world.seedWatch('s-implementer-1', parkedConditions, [{ conditionId: 'question', eventType: 'message_update', evidence: QUESTION_SENTINEL }]);

  const result = await runLane({ laneDir: dir }, deps(world));
  assert.equal(result.exitCode, 0, `the answered question must not be read back from the parked ledger: ${result.stderr ?? ''}`);
  const wait = world.waitCalls.find((entry) => entry.role === 'implementer');
  assert.ok(wait, 'the resumed wait ran');
  assert.notEqual(wait?.watchId, parked, 'the resumed wait did not reuse the parked watch');
  assert.equal(wait?.replayed, 0, 'no recorded firing was served');
  assert.equal(world.prompts.filter((entry) => entry.role === 'implementer').length, 0, 'the dispatch is never re-sent');
  assert.equal(world.spawns.filter((entry) => entry.role === 'implementer').length, 1, 'no second implementer');
  const state = JSON.parse(readFileSync(join(dir, 'runner-state.json'), 'utf8')) as Record<string, any>;
  assert.ok(!state.staleWatches.includes('wait'), 'the parked marker is cleared once the wait is receipted (wait steps this run never reached stay seeded and simply refresh on their first attempt)');
});
