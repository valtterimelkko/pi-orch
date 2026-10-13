import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteLimitError } from '../src/route-limits.ts';

/**
 * W4-a test kit: a lane directory on disk and an in-memory fake of the parts
 * of PiOrchClient the lane runner uses. Nothing here touches the network, the
 * real spawn ledger or the real audit log — every path is a fresh temp dir.
 */

export const GATES_BLOCK = 'GATES:\n- `env NODE_ENV=test npm test` → 0\n- npm run typecheck -> 0\n';

export interface LaneFixtureOptions {
  mode?: 'goal' | 'prompt';
  maxCorrections?: number;
  laneOverrides?: Record<string, unknown>;
  brief?: string;
  reviewBrief?: string;
  correctionTemplate?: string;
  noReviewBrief?: boolean;
}

export function makeLaneDir(options: LaneFixtureOptions = {}): { dir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'piorch-lane-test-'));
  const dir = join(root, 'lane');
  const cwd = join(root, 'work');
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const lane = {
    lane: 'w4a-demo',
    cwd,
    owner: 'orch-test-12345678-w4a',
    implementer: { runtime: 'pi', selector: 'zai/glm-5.3', thinking: 'high' },
    reviewer: { runtime: 'claude', selector: 'profile:max', thinking: 'medium' },
    mode: options.mode ?? 'prompt',
    ...(options.mode === 'goal' ? { objective: 'Carry out the lane brief', budgetTokens: 60_000_000 } : {}),
    ttlSeconds: 14_400,
    parentSessionId: 'parent-session-1',
    maxCorrections: options.maxCorrections ?? 1,
    ...(options.laneOverrides ?? {}),
  };
  writeFileSync(join(dir, 'lane.json'), `${JSON.stringify(lane, null, 2)}\n`);
  writeFileSync(join(dir, 'brief.md'), options.brief ?? `# Brief\n\nImplement the thing.\n\n${GATES_BLOCK}`);
  if (!options.noReviewBrief) {
    writeFileSync(join(dir, 'review-brief.md'), options.reviewBrief ?? '# Review\n\nReview the work.\n\nVERDICT FILE: verdict.md\n\nThe first line of the verdict file is VERDICT: ACCEPT|ACCEPT WITH FIXES|REJECT.\n');
  }
  if (options.correctionTemplate !== undefined) writeFileSync(join(dir, 'correction-template.md'), options.correctionTemplate);
  return { dir, cwd };
}

export interface Scenario {
  /** For each implementer round (dispatch = 1, correction = 2, ...): is the gate run green? Default: always green. */
  gatesGreen?: boolean[];
  /** The reviewer's verdict-file first line per review round (1 = first review, 2 = closure). Default ACCEPT. */
  verdicts?: string[];
  /** Throw this from the Nth spawn (1-based). */
  spawnError?: { at: number; error: Error };
  /** Implementer/reviewer wait outcomes by kind, per wait call on that role (1-based); default completed. */
  waitKinds?: { implementer?: string[]; reviewer?: string[] };
  /** Filenames to drop into the lane dir during the Nth implementer wait (1-based). */
  questionFileAtWait?: { wait: number; file: string };
}

export interface PromptRecord { sessionId: string; role: 'implementer' | 'reviewer'; message: string; key: string }

export class FakeWorld {
  readonly spawns: Array<{ id: string; role: 'implementer' | 'reviewer'; input: Record<string, unknown> }> = [];
  readonly prompts: PromptRecord[] = [];
  readonly goalStarts: Array<{ sessionId: string; input: Record<string, unknown> }> = [];
  readonly watches = new Map<string, { watchId: string; label?: string; conditions: unknown[] }>();
  readonly waitCalls: Array<{ sessionId: string; role: 'implementer' | 'reviewer'; options: Record<string, unknown> }> = [];
  readonly verifyCalls: Array<Record<string, unknown>> = [];
  readonly seenKeys = new Map<string, string>();
  spawnAttempts = 0;
  readonly laneDir: string;
  readonly scenario: Scenario;
  constructor(laneDir: string, scenario: Scenario = {}) {
    this.laneDir = laneDir;
    this.scenario = scenario;
  }

  roleOf(sessionId: string): 'implementer' | 'reviewer' {
    const found = this.spawns.find((entry) => entry.id === sessionId);
    if (!found) throw new Error(`fake: unknown session ${sessionId}`);
    return found.role;
  }

  get implementerPrompts(): PromptRecord[] { return this.prompts.filter((entry) => entry.role === 'implementer'); }
  get reviewerPrompts(): PromptRecord[] { return this.prompts.filter((entry) => entry.role === 'reviewer'); }
  get implementerRounds(): number { return this.implementerPrompts.length + this.goalStarts.length; }

  client() {
    const world = this;
    return {
      async spawn(input: Record<string, unknown>) {
        world.spawnAttempts += 1;
        const failure = world.scenario.spawnError;
        if (failure && failure.at === world.spawnAttempts) throw failure.error;
        const label = String((input.retention as { label?: string } | undefined)?.label ?? '');
        const role = label.endsWith('-review') ? 'reviewer' : 'implementer';
        const id = `s-${role}-${world.spawns.filter((entry) => entry.role === role).length + 1}`;
        world.spawns.push({ id, role, input });
        return { sessionId: id, leaseId: `lease-${id}` };
      },
      async prompt(sessionId: string, input: Record<string, unknown>) {
        const role = world.roleOf(sessionId);
        const key = String(input.idempotencyKey ?? '');
        if (key === '') throw new Error('fake: the lane runner must send a deterministic idempotencyKey');
        const prior = world.seenKeys.get(key);
        if (prior !== undefined) return { runId: prior, sessionId, detached: true, duplicate: true };
        const runId = `run-${world.prompts.length + 1}`;
        world.seenKeys.set(key, runId);
        world.prompts.push({ sessionId, role, message: String(input.message), key });
        return { runId, sessionId, detached: true, duplicate: false };
      },
      async goalStart(sessionId: string, input: Record<string, unknown>) {
        world.goalStarts.push({ sessionId, input });
        return { status: 'running', objective: String(input.objective), goalId: `goal-${world.goalStarts.length}`, runId: `run-goal-${world.goalStarts.length}` };
      },
      async registerWatch(sessionId: string, input: { conditions: unknown[]; label?: string }) {
        const watch = { watchId: `watch-${world.watches.size + 1}`, label: input.label, conditions: input.conditions };
        world.watches.set(sessionId, watch);
        return { watchId: watch.watchId, status: 'active' };
      },
      async getWatch(sessionId: string) {
        const watch = world.watches.get(sessionId);
        return watch ? { watchId: watch.watchId, status: 'active', label: watch.label } : null;
      },
      async wait(options: Record<string, unknown>) {
        const sessionId = String(options.sessionId);
        const role = world.roleOf(sessionId);
        world.waitCalls.push({ sessionId, role, options });
        const callNumber = world.waitCalls.filter((entry) => entry.role === role).length;
        if (role === 'implementer' && world.scenario.questionFileAtWait?.wait === callNumber) {
          fs.writeFileSync(`${world.laneDir}/${world.scenario.questionFileAtWait.file}`, '# Question\n\nWhich option?\n');
        }
        if (role === 'reviewer') {
          const round = world.reviewerPrompts.length;
          const verdict = (world.scenario.verdicts ?? [])[round - 1] ?? 'ACCEPT';
          fs.writeFileSync(`${world.laneDir}/verdict.md`, `VERDICT: ${verdict}\n\nFindings for round ${round}: fix the widget.\n`);
        }
        const kind = world.scenario.waitKinds?.[role]?.[callNumber - 1] ?? 'completed';
        return { kind, ...(kind === 'completed' ? {} : { note: `scripted ${kind}` }) };
      },
      async verify(input: Record<string, unknown>) {
        world.verifyCalls.push(input);
        const round = Math.max(1, world.implementerRounds);
        const green = (world.scenario.gatesGreen ?? [])[round - 1] ?? true;
        const gates = (input.gates as Array<{ command: string; expectedExit: number }>).map((gate, index) => (
          green || index > 0
            ? { command: gate.command, expectedExit: gate.expectedExit, actualExit: gate.expectedExit, result: 'verified', outputTail: [] as string[] }
            : { command: gate.command, expectedExit: gate.expectedExit, actualExit: 1, result: 'contradicted', outputTail: ['not ok 3 - widget works', '# fail 1'] }
        ));
        return {
          sessionId: String(input.sessionId),
          verdict: green ? 'verified' : 'contradicted',
          claims: [],
          gates,
          summary: green ? 'verified: 2 claim(s) verified' : 'contradicted: 1 claim(s) contradicted',
        };
      },
    };
  }
}

export function routeLimitError(): Error {
  return new RouteLimitError('profile:max', 3, [], { profileId: 'max', maxConcurrent: 3, active: 3 });
}
