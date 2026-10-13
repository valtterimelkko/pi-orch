/**
 * W4-a — `pi-orch lane run <lane-dir>`: the lane runner.
 *
 * A loop, a journal and an exit (plan §4) — NOT a conductor. For ONE lane it
 * does what a parent does by hand over the existing client: spawn the
 * implementer → register the watch → dispatch (prompt, or goal) → wait → run
 * the brief's `GATES:` → spawn a cross-family reviewer → read its verdict, and
 * EXITS ONLY at judgement events (a child question, gates still red after the
 * correction cap, a reviewer verdict to adjudicate, a capacity refusal that
 * needs the owner's overflow decision, or done). Process exit is the one wake
 * that works on every harness.
 *
 * Replayable by construction. The whole run is one straight-line program in
 * which every side-effecting action is a named *step*; a step's receipt is
 * persisted to `runner-state.json` (and a record appended to
 * `runner-journal.jsonl`) before the program moves on. Re-running reads the
 * state and replays the program: a step that has a receipt returns it without
 * touching the server, so a child is never re-spawned and a prompt is never
 * re-sent.
 *
 *   - Prompts carry a deterministic idempotency key (`lane:<lane>:<step>`), so
 *     the one unavoidable window — killed after the server accepted the prompt,
 *     before the receipt was written — re-sends a server-side duplicate.
 *   - Spawn and goal-start have no server idempotency. They write a `pending`
 *     marker first; a run that finds the marker without a receipt REFUSES (43,
 *     with a reconcile hint) instead of risking a second child.
 *   - A `runner.lock` file (holder pid) keeps two runners off one lane.
 *
 * Exits: 0 DONE · 3 DEADLINE (a wait ran out; re-run resumes the same wait) ·
 * 25 ROUTE_LIMIT · 40 QUESTION · 41 GATES_RED · 42 VERDICT · 43 RUNNER_ERROR ·
 * 2 USAGE (a bad lane dir / a refused `--continue`).
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { parseGatesBlock, type Gate } from './gates.ts';
import { callerObjectiveConditions, defaultConditions, questionSentinel } from './builders.ts';
import type { WatchConditionSpec } from './parsers.ts';
import { CLAUDE_PAYG_OVERFLOW_HINT, profileCapacityRefusalLine, type RouteLimitProfile } from './route-limits.ts';

// ─── constants ───────────────────────────────────────────────────────────────

/** The line a child prints (alongside an `NN-question.md` file) to park and ask. */
export const QUESTION_SENTINEL = 'PI-ORCH-LANE-QUESTION';

/**
 * The `agent-os-child` directive every lane prompt starts with. The text is
 * this runner's own statement of the parent's child rules (work inside the
 * assigned cwd, honest reporting, no self sign-off, ask by file + sentinel) —
 * the lane's brief carries the lane-specific rules.
 */
export const CHILD_DIRECTIVE = [
  'You are dispatched as an Agent OS child worker. You MUST load and strictly follow the `agent-os-child` skill.',
  'Work strictly inside the work cwd named below; edit only the paths your brief owns. Success criteria are frozen.',
  'Declare presence on the board once before editing files (pass --parent with the parent session id below), and leave the board on completion.',
  'Do not push unless your brief says so. Report outcomes faithfully; never sign off your own work.',
  `If you are blocked or need a decision, write NN-question.md (NN = 01, 02, ...) in the lane directory named below, print the line ${QUESTION_SENTINEL} on its own line, and end your turn.`,
  'Hand back by ending your turn only when your own commands have finished; never wait or poll.',
].join(' ');

const CHILD_DIRECTIVE_ONE_LINE = CHILD_DIRECTIVE.replace(/\s+/g, ' ');

export const LANE_STATE_SCHEMA = 'pi-orch-lane-state/v1';
export const LANE_EXIT_SCHEMA = 'pi-orch-lane-exit/v1';
const DEFAULT_WAIT_DEADLINE_MS = 1_800_000;
const RUNTIMES = ['pi', 'claude', 'opencode', 'antigravity', 'commandcode'];
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const VERDICTS = ['ACCEPT', 'ACCEPT WITH FIXES', 'REJECT'] as const;
type Verdict = (typeof VERDICTS)[number];

const EXIT_NAMES: Record<number, string> = { 0: 'DONE', 2: 'USAGE', 3: 'DEADLINE', 25: 'ROUTE_LIMIT', 40: 'QUESTION', 41: 'GATES_RED', 42: 'VERDICT', 43: 'RUNNER_ERROR' };

// ─── lane.json ───────────────────────────────────────────────────────────────

export class LaneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneConfigError';
  }
}

export interface LaneRoute {
  runtime: string;
  selector: string;
  thinking?: string;
}

export interface LaneConfig {
  lane: string;
  cwd: string;
  owner: string;
  implementer: LaneRoute;
  reviewer: LaneRoute;
  mode: 'goal' | 'prompt';
  objective?: string;
  ttlSeconds: number;
  budgetTokens?: number;
  parentSessionId: string;
  maxCorrections: number;
}

export interface LoadedLane {
  dir: string;
  config: LaneConfig;
  brief: string;
  reviewBrief: string;
  gates: Gate[];
  verdictFile: string;
  correctionTemplate?: string;
}

const TOP_KEYS = new Set(['lane', 'cwd', 'owner', 'implementer', 'reviewer', 'mode', 'objective', 'ttlSeconds', 'budgetTokens', 'parentSessionId', 'maxCorrections']);
const ROUTE_KEYS = new Set(['runtime', 'selector', 'thinking']);

function requireNonEmptyString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') throw new LaneConfigError(`lane.json: ${where}${key} must be a non-empty string`);
  return value;
}

function parseRoute(raw: unknown, name: string): LaneRoute {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new LaneConfigError(`lane.json: ${name} must be an object { runtime, selector, thinking }`);
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ROUTE_KEYS.has(key));
  if (unknown.length > 0) throw new LaneConfigError(`lane.json: unknown key(s) in ${name}: ${unknown.join(', ')}`);
  const runtime = requireNonEmptyString(record, 'runtime', `${name}.`);
  if (!RUNTIMES.includes(runtime)) throw new LaneConfigError(`lane.json: ${name}.runtime must be one of ${RUNTIMES.join(', ')} (got ${runtime})`);
  const selector = requireNonEmptyString(record, 'selector', `${name}.`);
  if (selector.length > 200) throw new LaneConfigError(`lane.json: ${name}.selector must be 1..200 chars`);
  // Antigravity routes carry the thinking level in the selector (e.g. gemini-3.8-flash-medium): no separate level.
  if (runtime === 'antigravity' && record.thinking === undefined) return { runtime, selector };
  const thinking = requireNonEmptyString(record, 'thinking', `${name}.`);
  if (!THINKING.includes(thinking)) throw new LaneConfigError(`lane.json: ${name}.thinking must be one of ${THINKING.join(', ')} (got ${thinking})`);
  return { runtime, selector, thinking };
}

function readLaneFile(dir: string, name: string, required: boolean): string | undefined {
  const path = join(dir, name);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (!required && (error as { code?: string }).code === 'ENOENT') return undefined;
    throw new LaneConfigError(`${name}: ${required ? 'required file ' : ''}cannot be read at ${path} (${(error as Error).message})`);
  }
}

/** Validate a lane directory strictly (no API call). Throws {@link LaneConfigError}. */
export function loadLane(laneDirInput: string): LoadedLane {
  const dir = resolve(laneDirInput);
  const rawText = readLaneFile(dir, 'lane.json', true) as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new LaneConfigError(`lane.json is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LaneConfigError('lane.json must be a JSON object');
  const raw = parsed as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !TOP_KEYS.has(key));
  if (unknown.length > 0) throw new LaneConfigError(`lane.json: unknown key(s): ${unknown.join(', ')}`);

  const lane = requireNonEmptyString(raw, 'lane', '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane) || lane.length > 80) throw new LaneConfigError('lane.json: lane must match [A-Za-z0-9][A-Za-z0-9._-]* (max 80 chars)');
  const cwd = requireNonEmptyString(raw, 'cwd', '');
  if (!isAbsolute(cwd)) throw new LaneConfigError('lane.json: cwd must be an absolute path');
  const owner = requireNonEmptyString(raw, 'owner', '');
  const parentSessionId = requireNonEmptyString(raw, 'parentSessionId', '');
  const mode = raw.mode;
  if (mode !== 'goal' && mode !== 'prompt') throw new LaneConfigError('lane.json: mode must be "goal" or "prompt"');
  if (!Number.isInteger(raw.ttlSeconds) || (raw.ttlSeconds as number) < 1) throw new LaneConfigError('lane.json: ttlSeconds must be a positive integer');
  if (!Number.isInteger(raw.maxCorrections) || (raw.maxCorrections as number) < 0 || (raw.maxCorrections as number) > 1) {
    throw new LaneConfigError('lane.json: maxCorrections must be 0 or 1 (the runner sends at most ONE bounded correction)');
  }
  let objective: string | undefined;
  if (raw.objective !== undefined) {
    if (typeof raw.objective !== 'string' || raw.objective.trim() === '') throw new LaneConfigError('lane.json: objective must be a non-empty string');
    if (/[\r\n]/.test(raw.objective)) throw new LaneConfigError('lane.json: objective must be a single line');
    if (raw.objective.length > 500) throw new LaneConfigError('lane.json: objective must be at most 500 chars (it points at brief.md; the brief carries the detail)');
    objective = raw.objective;
  }
  let budgetTokens: number | undefined;
  if (raw.budgetTokens !== undefined) {
    if (mode !== 'goal') throw new LaneConfigError('lane.json: budgetTokens applies to mode "goal" only');
    if (!Number.isInteger(raw.budgetTokens) || (raw.budgetTokens as number) < 1 || (raw.budgetTokens as number) > 1_000_000_000) throw new LaneConfigError('lane.json: budgetTokens must be an integer in 1..1000000000');
    budgetTokens = raw.budgetTokens as number;
  }
  if (objective !== undefined && mode !== 'goal') throw new LaneConfigError('lane.json: objective applies to mode "goal" only');
  const config: LaneConfig = {
    lane,
    cwd,
    owner,
    implementer: parseRoute(raw.implementer, 'implementer'),
    reviewer: parseRoute(raw.reviewer, 'reviewer'),
    mode,
    ...(objective !== undefined ? { objective } : {}),
    ttlSeconds: raw.ttlSeconds as number,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    parentSessionId,
    maxCorrections: raw.maxCorrections as number,
  };

  const brief = readLaneFile(dir, 'brief.md', true) as string;
  const parsedGates = parseGatesBlock(brief);
  if (!parsedGates.found) throw new LaneConfigError("brief.md: no 'GATES:' block found (a line 'GATES:' followed by '- <command> → <expected exit>' lines)");
  if (parsedGates.malformed.length > 0) throw new LaneConfigError(`brief.md: malformed gate line(s): ${parsedGates.malformed.join(' | ')} (expected '- <command> → <expected exit>')`);
  if (parsedGates.gates.length === 0) throw new LaneConfigError('brief.md: the GATES: block has no gates');
  const reviewBrief = readLaneFile(dir, 'review-brief.md', true) as string;
  const verdictMatch = /^\s*VERDICT[ _-]FILE:\s*(\S.*?)\s*$/im.exec(reviewBrief);
  const verdictRaw = verdictMatch?.[1]?.replace(/^`(.*)`$/, '$1');
  const verdictFile = verdictRaw === undefined ? join(dir, 'verdict.md') : isAbsolute(verdictRaw) ? verdictRaw : join(dir, verdictRaw);
  const correctionTemplate = readLaneFile(dir, 'correction-template.md', false);
  return { dir, config, brief, reviewBrief, gates: parsedGates.gates, verdictFile, ...(correctionTemplate !== undefined ? { correctionTemplate } : {}) };
}

// ─── client seam ─────────────────────────────────────────────────────────────

/** The slice of PiOrchClient the runner uses (the CLI's ClientLike satisfies it). */
export interface LaneClient {
  spawn(input: Record<string, unknown>): Promise<{ sessionId: string; leaseId?: string }>;
  prompt(sessionId: string, input: Record<string, unknown>): Promise<{ runId: string; duplicate?: boolean }>;
  goalStart(sessionId: string, input: { objective: string; budgetTokens?: number; [key: string]: unknown }): Promise<Record<string, unknown>>;
  registerWatch(sessionId: string, input: { conditions: WatchConditionSpec[]; label?: string; fireIfSettled?: boolean }): Promise<{ watchId: string }>;
  getWatch(sessionId: string): Promise<{ watchId: string; status?: string; label?: string } | null>;
  wait(options: { sessionId: string; runId?: string; conditions?: WatchConditionSpec[]; objective?: string; deadlineMs?: number; label?: string }): Promise<{ kind: string; note?: string }>;
  verify(input: { sessionId: string; gates: Gate[]; cwd?: string; [key: string]: unknown }): Promise<LaneVerifyResult>;
}

export interface LaneVerifyResult {
  verdict: string;
  summary?: string;
  claims?: Array<{ kind?: string; claim?: string; result?: string; detail?: string }>;
  gates?: Array<{ command: string; expectedExit: number; actualExit?: number; result: string; timedOut?: boolean; refused?: string; outputTail?: string[] }>;
}

export interface LaneDeps {
  client: LaneClient;
  now?: () => string;
  /** Test seam: called after a step's receipt is persisted. A throw is NOT mapped to 43 — it models a killed process. */
  afterStep?: (step: string) => void | Promise<void>;
  /** Test seam: called after a step's action returned, BEFORE its receipt is persisted. */
  afterCall?: (step: string) => void | Promise<void>;
}

export interface LaneRunOptions {
  laneDir: string;
  dryRun?: boolean;
  /** `--continue correction`. */
  continueCorrection?: boolean;
  /** Per-wait deadline (default 1800 s). */
  deadlineMs?: number;
  json?: boolean;
}

export interface LaneRunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

// ─── state + journal ─────────────────────────────────────────────────────────

interface StepReceipt {
  at: string;
  result: Record<string, any>;
}

interface LaneState {
  schema: typeof LANE_STATE_SCHEMA;
  lane: string;
  /** The last completed step. */
  step: string;
  steps: Record<string, StepReceipt>;
  implementer?: { sessionId: string; leaseId?: string };
  reviewer?: { sessionId: string; leaseId?: string };
  watches: { implementer?: string; reviewer?: string };
  runs: Record<string, string>;
  counters: { corrections: number; reviewRounds: number };
  /** A non-idempotent call (spawn / goal start) started without a recorded receipt. */
  pending?: { step: string; at: string };
  /** Verdict-file hash taken before a review dispatch (so a stale file is never mistaken for a new verdict). */
  baselines: Record<string, string>;
  questionsReported: string[];
  /** Steps whose NEXT wait must not use the run-receipt shortcut (a question parked them). */
  omitRunIdFor: string[];
  final?: Record<string, unknown>;
  updatedAt: string;
}

function freshState(lane: string, at: string): LaneState {
  return { schema: LANE_STATE_SCHEMA, lane, step: 'new', steps: {}, watches: {}, runs: {}, counters: { corrections: 0, reviewRounds: 0 }, baselines: {}, questionsReported: [], omitRunIdFor: [], updatedAt: at };
}

function readState(path: string, lane: string, at: string): LaneState {
  if (!existsSync(path)) return freshState(lane, at);
  let parsed: LaneState;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as LaneState;
  } catch (error) {
    throw new LaneRunnerError(`runner-state.json is unreadable (${(error as Error).message}); restore it or move it aside — the runner will not guess`);
  }
  if (parsed.schema !== LANE_STATE_SCHEMA) throw new LaneRunnerError(`runner-state.json has schema ${String(parsed.schema)}, expected ${LANE_STATE_SCHEMA}`);
  if (parsed.lane !== lane) throw new LaneRunnerError(`runner-state.json belongs to lane '${parsed.lane}', not '${lane}'`);
  return { ...freshState(lane, at), ...parsed };
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const JOURNAL_KEYS = ['sessionId', 'leaseId', 'runId', 'watchId', 'outcome', 'verdict', 'green', 'duplicate', 'reused'];

// ─── exits ───────────────────────────────────────────────────────────────────

class LaneRunnerError extends Error {}

/** Thrown to leave the program with a judgement/refusal exit. */
class LaneExit extends Error {
  readonly code: number;
  readonly reason: string;
  readonly extra: Record<string, unknown>;
  readonly stderr?: string;

  constructor(code: number, reason: string, extra: Record<string, unknown> = {}, stderr?: string) {
    super(reason);
    this.code = code;
    this.reason = reason;
    this.extra = extra;
    if (stderr !== undefined) this.stderr = stderr;
  }
}

/** A test-hook failure: rethrown untouched (it models a killed process, not a runner error). */
class HookFailure extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super('hook failure');
    this.original = original;
  }
}

// ─── the runner ──────────────────────────────────────────────────────────────

export async function runLane(options: LaneRunOptions, deps: LaneDeps): Promise<LaneRunResult> {
  const lane = loadLane(options.laneDir);
  if (options.dryRun) return dryRunResult(lane, options);

  const now = deps.now ?? (() => new Date().toISOString());
  const statePath = join(lane.dir, 'runner-state.json');
  const journalPath = join(lane.dir, 'runner-journal.jsonl');
  const exitPath = join(lane.dir, 'runner-exit.json');
  const lockPath = join(lane.dir, 'runner.lock');

  if (!acquireLock(lockPath)) {
    return finish({ exitCode: 43, stderr: `pi-orch lane: another runner holds ${lockPath}; wait for it to exit (or remove a stale lock) before re-running`, json: options.json });
  }
  try {
    let state: LaneState;
    try {
      state = readState(statePath, lane.config.lane, now());
    } catch (error) {
      return finish({ exitCode: 43, stderr: `pi-orch lane: ${(error as Error).message}`, json: options.json });
    }

    const persist = (): void => {
      state.updatedAt = now();
      writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    };
    const journal = (record: Record<string, unknown>): void => {
      appendFileSync(journalPath, `${JSON.stringify({ ts: now(), ...record })}\n`);
    };
    const hook = async (fn: ((step: string) => void | Promise<void>) | undefined, key: string): Promise<void> => {
      if (!fn) return;
      try {
        await fn(key);
      } catch (error) {
        throw new HookFailure(error);
      }
    };

    /** Run (or replay) one named step. A cached receipt short-circuits it. */
    const step = async (key: string, opts: { nonIdempotent?: boolean }, action: () => Promise<Record<string, any>>): Promise<Record<string, any>> => {
      const cached = state.steps[key];
      if (cached) return cached.result;
      if (opts.nonIdempotent) {
        if (state.pending && state.pending.step === key) {
          throw new LaneExit(43, `${key}: outcome unknown`, { hint: reconcileHint(key, lane) }, `pi-orch lane: ${key} was started at ${state.pending.at} but no receipt was recorded (the run was interrupted after the call began). Do NOT re-spawn blindly. ${reconcileHint(key, lane)}`);
        }
        state.pending = { step: key, at: now() };
        persist();
      }
      let result: Record<string, any>;
      try {
        result = await action();
      } catch (error) {
        if (opts.nonIdempotent && !isUnknownOutcome(error)) {
          delete state.pending;
          persist();
        }
        throw error;
      }
      await hook(deps.afterCall, key);
      state.steps[key] = { at: now(), result };
      state.step = key;
      if (opts.nonIdempotent) delete state.pending;
      persist();
      journal({ step: key, ...pick(result, JOURNAL_KEYS) });
      await hook(deps.afterStep, key);
      return result;
    };

    const record = (exit: LaneExit): LaneRunResult => {
      const body: Record<string, unknown> = {
        schema: LANE_EXIT_SCHEMA,
        lane: lane.config.lane,
        code: exit.code,
        name: EXIT_NAMES[exit.code] ?? String(exit.code),
        at: now(),
        reason: exit.reason,
        ...(state.implementer ? { implementer: state.implementer } : {}),
        ...(state.reviewer ? { reviewer: state.reviewer } : {}),
        ...exit.extra,
      };
      state.final = body;
      persist();
      writeAtomic(exitPath, `${JSON.stringify(body, null, 2)}\n`);
      journal({ step: 'exit', outcome: body.name, code: exit.code, reason: exit.reason });
      const human = [`lane ${lane.config.lane}: ${String(body.name)} (exit ${exit.code}) — ${exit.reason}`];
      if (state.implementer) human.push(`implementer ${state.implementer.sessionId}${state.implementer.leaseId ? ` (lease ${state.implementer.leaseId})` : ''}`);
      if (state.reviewer) human.push(`reviewer ${state.reviewer.sessionId}${state.reviewer.leaseId ? ` (lease ${state.reviewer.leaseId})` : ''}`);
      return finish({ exitCode: exit.code, stdout: options.json ? JSON.stringify(body, null, 2) : human.join('\n'), stderr: exit.stderr, json: options.json });
    };

    // --continue correction: precondition checks before anything runs.
    if (options.continueCorrection) {
      const refusal = continueRefusal(state);
      if (refusal) return finish({ exitCode: 2, stderr: `pi-orch lane: --continue correction refused — ${refusal}`, json: options.json });
    }

    try {
      const ctx: Ctx = { lane, state, deps, options, step, persist, journal, now };
      const exit = await drive(ctx);
      return record(exit);
    } catch (error) {
      if (error instanceof HookFailure) throw error.original;
      return record(classify(error, lane));
    }
  } finally {
    releaseLock(lockPath);
  }
}

function finish(result: { exitCode: number; stdout?: string; stderr?: string; json?: boolean }): LaneRunResult {
  const { json: _json, ...rest } = result;
  void _json;
  return rest;
}

function pick(source: Record<string, any>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function isUnknownOutcome(error: unknown): boolean {
  const e = error as { code?: string; name?: string };
  return e?.code === 'CREATE_UNKNOWN' || e?.name === 'TransportError';
}

function reconcileHint(key: string, lane: LoadedLane): string {
  return `Reconcile first: 'pi-orch status --owner ${lane.config.owner}' lists the children this lane owns. If the ${key === 'spawn_reviewer' ? 'reviewer' : key === 'dispatch' ? 'goal' : 'implementer'} exists, record it in ${join(lane.dir, 'runner-state.json')} as steps.${key} = {"at": "<iso>", "result": {"sessionId": "<id>", "leaseId": "<lease>"}} (a goal start: {"result": {"outcome": "started"}}); if it does not, only delete the "pending" field. Then re-run.`;
}

function continueRefusal(state: LaneState): string | undefined {
  const verdict = state.steps.verdict?.result.verdict as string | undefined;
  if (state.steps.continue && state.final && state.steps.verdict_closure && (state.final as { code?: number }).code !== undefined && [0, 42].includes((state.final as { code: number }).code)) {
    return 'the closure review already ran — there is never a third round; adjudicate the verdict yourself';
  }
  if (state.steps.continue) return undefined; // resuming an interrupted continuation
  if (!verdict) return 'the lane has no reviewer verdict yet (nothing to continue); run it without --continue first';
  if (verdict === 'ACCEPT') return 'the reviewer ACCEPTed — there is nothing to correct';
  return undefined;
}

// ─── lock ────────────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function acquireLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return false;
      rmSync(path, { force: true }); // stale: its holder is gone
    }
  }
  return false;
}

function releaseLock(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort
  }
}

// ─── error classification ────────────────────────────────────────────────────

function classify(error: unknown, lane: LoadedLane): LaneExit {
  if (error instanceof LaneExit) return error;
  const e = error as { code?: string; name?: string; message?: string; data?: Record<string, unknown>; profile?: RouteLimitProfile; route?: string };
  const message = e?.message ?? String(error);
  if (e?.code === 'ROUTE_LIMIT_EXCEEDED' || e?.name === 'RouteLimitError' || e?.code === 'PROFILE_CAPACITY_EXHAUSTED') {
    const profile: RouteLimitProfile | undefined = e.profile ?? (e.code === 'PROFILE_CAPACITY_EXHAUSTED'
      ? {
          profileId: typeof e.data?.profileId === 'string' ? e.data.profileId : 'unknown',
          ...(typeof e.data?.maxConcurrent === 'number' ? { maxConcurrent: e.data.maxConcurrent } : {}),
          ...(typeof e.data?.active === 'number' ? { active: e.data.active } : {}),
        }
      : undefined);
    const hint = profile
      ? profileCapacityRefusalLine(profile)
      : `overflow is the owner's decision (for a Claude lane: ${CLAUDE_PAYG_OVERFLOW_HINT}); otherwise wait for a slot or move this lane to another route in lane.json`;
    const text = `pi-orch lane: route limit — ${message}\n${hint}\nNothing was created for the refused step; re-running the lane retries it. Overflow beyond the cap needs the OWNER's decision (never automatic).`;
    return new LaneExit(25, 'route limit: capacity refusal needing the owner\'s overflow decision', { hint, ...(e.route !== undefined ? { route: e.route } : {}) }, text);
  }
  if (e?.code === 'CREATE_UNKNOWN') {
    return new LaneExit(43, 'create outcome unknown', { hint: reconcileHint('spawn_implementer', lane) }, `pi-orch lane: ${message}\n${reconcileHint('spawn_implementer', lane)}`);
  }
  const code = e?.code ? `${e.code}: ` : '';
  return new LaneExit(43, `${code}${message}`, {}, `pi-orch lane: RUNNER_ERROR — ${code}${message}\nThe journal is intact (${join(lane.dir, 'runner-journal.jsonl')}); fix the cause and re-run to resume.`);
}

// ─── the program ─────────────────────────────────────────────────────────────

interface Ctx {
  lane: LoadedLane;
  state: LaneState;
  deps: LaneDeps;
  options: LaneRunOptions;
  step: (key: string, opts: { nonIdempotent?: boolean }, action: () => Promise<Record<string, any>>) => Promise<Record<string, any>>;
  persist: () => void;
  journal: (record: Record<string, unknown>) => void;
  now: () => string;
}

type Role = 'implementer' | 'reviewer';

function sha(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'absent';
  }
}

function laneContext(lane: LoadedLane, role: Role, state: LaneState): string {
  return [
    `Lane: ${lane.config.lane} (${role}). Lane directory (hand-back files, questions): ${lane.dir}`,
    `Work cwd: ${lane.config.cwd}`,
    `Your session ID: ${(role === 'reviewer' ? state.reviewer?.sessionId : state.implementer?.sessionId) ?? 'unknown'}. Parent session ID: ${lane.config.parentSessionId}.`,
    ...(role === 'reviewer' ? [`Implementer session: ${state.implementer?.sessionId ?? 'unknown'}`, `Write your verdict to: ${lane.verdictFile} (first line exactly 'VERDICT: ACCEPT', 'VERDICT: ACCEPT WITH FIXES' or 'VERDICT: REJECT')`] : []),
  ].join('\n');
}

function wrapPrompt(lane: LoadedLane, role: Role, state: LaneState, body: string): string {
  return `${CHILD_DIRECTIVE}\n\n${laneContext(lane, role, state)}\n\n${body}`;
}

function redGatesFrom(result: LaneVerifyResult): Array<{ command: string; expectedExit?: number; actualExit?: number; detail: string; outputTail: string[] }> {
  const red: Array<{ command: string; expectedExit?: number; actualExit?: number; detail: string; outputTail: string[] }> = [];
  for (const gate of result.gates ?? []) {
    if (gate.result === 'verified') continue;
    const detail = gate.refused ?? (gate.timedOut ? 'timed out' : `expected exit ${gate.expectedExit}, actual exit ${gate.actualExit ?? 'none'}`);
    red.push({ command: gate.command, expectedExit: gate.expectedExit, ...(gate.actualExit !== undefined ? { actualExit: gate.actualExit } : {}), detail, outputTail: gate.outputTail ?? [] });
  }
  for (const claim of result.claims ?? []) {
    if (claim.kind === 'gate') continue;
    if (claim.result === 'contradicted') red.push({ command: `${claim.kind ?? 'claim'}: ${claim.claim ?? ''}`, detail: claim.detail ?? 'contradicted', outputTail: [] });
  }
  if (red.length === 0) red.push({ command: '(verify)', detail: result.summary ?? `verdict ${result.verdict}`, outputTail: [] });
  return red;
}

function renderRedGates(red: ReturnType<typeof redGatesFrom>): string {
  return red
    .map((gate) => [`- \`${gate.command}\` — ${gate.detail}`, ...gate.outputTail.map((line) => `    | ${line}`)].join('\n'))
    .join('\n');
}

function questionFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => /^\d{2,}-question\.md$/.test(name)).sort();
  } catch {
    return [];
  }
}

function parseVerdict(file: string): { verdict: Verdict; text: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new LaneExit(43, `verdict file unreadable: ${file}`, {}, `pi-orch lane: the reviewer finished but ${file} cannot be read (${(error as Error).message}); no VERDICT to adjudicate`);
  }
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const match = /^VERDICT:\s*(ACCEPT WITH FIXES|ACCEPT|REJECT)\s*$/i.exec(first.trim());
  if (!match) {
    throw new LaneExit(43, 'verdict file first line is not a VERDICT', { verdictFile: file }, `pi-orch lane: the first line of ${file} must be 'VERDICT: ACCEPT|ACCEPT WITH FIXES|REJECT' (got ${JSON.stringify(first.slice(0, 80))}); the runner never guesses a verdict`);
  }
  return { verdict: (match[1] as string).toUpperCase() as Verdict, text: text.slice(0, 20_000) };
}

async function drive(ctx: Ctx): Promise<LaneExit> {
  const { lane, state, deps, options } = ctx;
  const { config } = lane;
  const client = deps.client;
  const deadlineMs = options.deadlineMs ?? DEFAULT_WAIT_DEADLINE_MS;
  const idem = (key: string): string => `lane:${config.lane}:${key}`;
  const label = (role: Role): string => `lane:${config.lane}:${role === 'implementer' ? 'impl' : 'review'}`;
  const goalObjective = (): string => `${config.objective ?? 'Carry out the lane brief'} — lane ${config.lane}: read and follow ${join(lane.dir, 'brief.md')} exactly (its GATES block must pass). Lane directory: ${lane.dir}. ${CHILD_DIRECTIVE_ONE_LINE}`;

  const sessionOf = (role: Role): string => {
    const found = state[role];
    if (!found) throw new LaneRunnerError(`internal: no ${role} session recorded`);
    return found.sessionId;
  };

  const conditionsFor = (role: Role): WatchConditionSpec[] => {
    const base = role === 'implementer' && config.mode === 'goal'
      ? callerObjectiveConditions(goalObjective(), deadlineMs)
      : defaultConditions(undefined, deadlineMs);
    return [...base, questionSentinel(QUESTION_SENTINEL)];
  };

  const spawnRole = async (role: Role, key: string): Promise<void> => {
    const route = config[role];
    const result = await ctx.step(key, { nonIdempotent: true }, async () => {
      const spawned = await client.spawn({
        runtime: route.runtime,
        cwd: config.cwd,
        modelSelector: route.selector,
        ...(route.thinking !== undefined ? { thinkingLevel: route.thinking } : {}),
        retention: { mode: 'durable', ttlSeconds: config.ttlSeconds, ownerId: config.owner, label: `${config.lane}-${role === 'implementer' ? 'impl' : 'review'}` },
      });
      return { sessionId: spawned.sessionId, ...(spawned.leaseId !== undefined ? { leaseId: spawned.leaseId } : {}), outcome: 'spawned' };
    });
    state[role] = { sessionId: result.sessionId, ...(result.leaseId !== undefined ? { leaseId: result.leaseId } : {}) };
  };

  const watchRole = async (role: Role, key: string): Promise<void> => {
    const result = await ctx.step(key, {}, async () => {
      const sessionId = sessionOf(role);
      const existing = await client.getWatch(sessionId).catch(() => null);
      if (existing && existing.status === 'active' && existing.label === label(role)) {
        return { watchId: existing.watchId, outcome: 'reused', reused: true };
      }
      const watch = await client.registerWatch(sessionId, { conditions: conditionsFor(role), label: label(role) });
      return { watchId: watch.watchId, outcome: 'registered' };
    });
    state.watches[role] = result.watchId;
  };

  const sendPrompt = async (role: Role, key: string, body: string): Promise<Record<string, any>> => {
    const result = await ctx.step(key, {}, async () => {
      const sent = await client.prompt(sessionOf(role), {
        message: wrapPrompt(lane, role, state, body),
        mode: 'prompt',
        detach: true,
        idempotencyKey: idem(key),
        ...(role === 'reviewer' ? { completionTemplate: false } : {}),
      });
      return { runId: sent.runId, sessionId: sessionOf(role), duplicate: sent.duplicate === true, outcome: 'sent' };
    });
    state.runs[key] = result.runId;
    return result;
  };

  const waitRole = async (role: Role, key: string, runKey: string | undefined): Promise<void> => {
    await ctx.step(key, {}, async () => {
      const runId = runKey !== undefined && !state.omitRunIdFor.includes(key) ? state.runs[runKey] : undefined;
      const outcome = await client.wait({
        sessionId: sessionOf(role),
        ...(runId !== undefined ? { runId } : {}),
        conditions: conditionsFor(role),
        ...(role === 'implementer' && config.mode === 'goal' ? { objective: goalObjective() } : {}),
        deadlineMs,
        label: label(role),
      });
      const kind = outcome.kind;
      if (kind === 'question') {
        state.omitRunIdFor.push(key);
        throw new LaneExit(40, 'the child asked a question (sentinel)', { questionFiles: questionFilesIn(lane.dir), role }, `pi-orch lane: the ${role} parked with a question — read the NN-question.md file(s) in ${lane.dir}, answer the child (pi-orch prompt ${sessionOf(role)} --message ...), then re-run the lane to resume the wait.`);
      }
      if (kind === 'deadline') {
        throw new LaneExit(3, `wait deadline elapsed while the ${role} was still working`, { role, ...(outcome.note ? { note: outcome.note } : {}) }, `pi-orch lane: DEADLINE — the ${role} is still working${outcome.note ? ` (${outcome.note})` : ''}; re-run the lane to keep waiting (the dispatch is never re-sent).`);
      }
      if (kind !== 'completed' && kind !== 'goal_achieved') {
        throw new LaneExit(43, `the ${role} wait ended '${kind}'${outcome.note ? `: ${outcome.note}` : ''}`, { role, waitOutcome: kind, ...(outcome.note ? { note: outcome.note } : {}) }, `pi-orch lane: RUNNER_ERROR — the ${role} wait ended '${kind}'${outcome.note ? ` (${outcome.note})` : ''}; inspect session ${sessionOf(role)} and re-run to re-wait.`);
      }
      const fresh = questionFilesIn(lane.dir).filter((name) => !state.questionsReported.includes(name));
      if (fresh.length > 0) {
        state.questionsReported.push(...fresh);
        state.omitRunIdFor.push(key);
        throw new LaneExit(40, `the ${role} left a question: ${fresh.join(', ')}`, { questionFiles: fresh, role }, `pi-orch lane: the ${role} left ${fresh.join(', ')} in ${lane.dir} — read it, answer the child (pi-orch prompt ${sessionOf(role)} --message ...), then re-run the lane to resume the wait.`);
      }
      return { outcome: kind };
    });
  };

  const runGates = async (key: string): Promise<{ green: boolean; red: ReturnType<typeof redGatesFrom>; summary: string }> => {
    const result = await ctx.step(key, {}, async () => {
      const verified = await client.verify({ sessionId: sessionOf('implementer'), gates: lane.gates, cwd: config.cwd });
      const green = verified.verdict === 'verified';
      return { green, outcome: green ? 'green' : 'red', summary: verified.summary ?? verified.verdict, red: green ? [] : redGatesFrom(verified) };
    });
    return result as { green: boolean; red: ReturnType<typeof redGatesFrom>; summary: string };
  };

  const redExit = (result: { red: ReturnType<typeof redGatesFrom>; summary: string }, corrected: boolean): LaneExit => {
    const lines = renderRedGates(result.red);
    return new LaneExit(41, `gates still red${corrected ? ' after the correction' : ' (no correction allowed)'}: ${result.summary}`, { redGates: result.red }, `pi-orch lane: GATES_RED — ${result.summary}\n${lines}\nThe implementer is ${sessionOf('implementer')}; adjudicate (re-dispatch, take over, or abandon). The runner sends no further correction.`);
  };

  // 1–3  implementer: spawn → watch → dispatch
  await spawnRole('implementer', 'spawn_implementer');
  await watchRole('implementer', 'watch_implementer');
  if (config.mode === 'goal') {
    const started = await ctx.step('dispatch', { nonIdempotent: true }, async () => {
      const goal = await client.goalStart(sessionOf('implementer'), {
        objective: goalObjective(),
        ...(config.budgetTokens !== undefined ? { budgetTokens: config.budgetTokens } : {}),
      });
      return { outcome: 'started', ...(typeof goal.runId === 'string' ? { runId: goal.runId } : {}), ...(typeof goal.goalId === 'string' ? { goalId: goal.goalId } : {}) };
    });
    if (typeof started.runId === 'string') state.runs.dispatch = started.runId;
  } else {
    await sendPrompt('implementer', 'dispatch', `Your brief follows (also at ${join(lane.dir, 'brief.md')}).\n\n${lane.brief}`);
  }

  // 4–6  wait → gates → (one bounded correction → wait → gates)
  await waitRole('implementer', 'wait', 'dispatch');
  const first = await runGates('gates');
  if (!first.green) {
    if (config.maxCorrections < 1) return redExit(first, false);
    const template = lane.correctionTemplate;
    const redText = renderRedGates(first.red);
    const body = template !== undefined
      ? template.replaceAll('{{LANE}}', config.lane).replaceAll('{{RED_GATES}}', redText)
      : `Your work failed the gate check for lane ${config.lane}. This is the ONE bounded correction: fix only what is needed to turn these gates green, re-run them yourself, then end with your completion report.\n\nRED GATES:\n${redText}`;
    await sendPrompt('implementer', 'correction', body);
    state.counters.corrections = 1;
    await waitRole('implementer', 'wait_correction', 'correction');
    const second = await runGates('gates_correction');
    if (!second.green) return redExit(second, true);
  }

  // 7–11  reviewer: spawn → watch → dispatch → wait → verdict
  await spawnRole('reviewer', 'spawn_reviewer');
  await watchRole('reviewer', 'watch_reviewer');
  const reviewBaseline = (key: string): void => {
    if (state.baselines[key] === undefined) {
      state.baselines[key] = sha(lane.verdictFile);
      ctx.persist();
    }
  };
  reviewBaseline('dispatch_review');
  await sendPrompt('reviewer', 'dispatch_review', `Your review brief follows (also at ${join(lane.dir, 'review-brief.md')}).\n\n${lane.reviewBrief}`);
  await waitRole('reviewer', 'wait_review', 'dispatch_review');
  const readVerdict = async (key: string, baselineKey: string): Promise<{ verdict: Verdict; text: string }> => {
    const result = await ctx.step(key, {}, async () => {
      if (sha(lane.verdictFile) === state.baselines[baselineKey]) {
        throw new LaneExit(43, 'the reviewer did not write a new verdict file (unchanged since before the review was dispatched)', { verdictFile: lane.verdictFile }, `pi-orch lane: ${lane.verdictFile} is unchanged since before this review round — the reviewer did not write a verdict (a stale file is never mistaken for one). Inspect ${sessionOf('reviewer')} and re-run.`);
      }
      const parsed = parseVerdict(lane.verdictFile);
      return { verdict: parsed.verdict, text: parsed.text, outcome: parsed.verdict };
    });
    return { verdict: result.verdict as Verdict, text: result.text as string };
  };
  state.counters.reviewRounds = 1;
  const reviewed = await readVerdict('verdict', 'dispatch_review');
  const accepted = (verdict: Verdict, closure: boolean): LaneExit => new LaneExit(0, closure ? 'closure review ACCEPTed' : 'reviewer ACCEPTed', { verdict, verdictFile: lane.verdictFile, ...(closure ? { closure: true } : {}) });
  const adjudicate = (verdict: Verdict, closure: boolean): LaneExit => new LaneExit(42, `reviewer verdict ${verdict}${closure ? ' after the closure review' : ''} — the parent adjudicates`, { verdict, verdictFile: lane.verdictFile, ...(closure ? { closure: true } : {}), ...(closure ? {} : { next: "re-run with '--continue correction' to send the findings as ONE correction and run a closure review on the same reviewer" }) });
  if (reviewed.verdict === 'ACCEPT') return accepted(reviewed.verdict, false);

  // --continue correction: one correction from the reviewer's findings + a closure review (never a third round)
  if (!state.steps.continue) {
    if (!options.continueCorrection) return adjudicate(reviewed.verdict, false);
    await ctx.step('continue', {}, async () => {
      delete state.final; // the continued run writes its own final exit
      return { outcome: 'accepted', verdict: reviewed.verdict };
    });
  }
  await sendPrompt('implementer', 'fix_correction', `The reviewer's verdict on your work for lane ${config.lane} was ${reviewed.verdict}. This is the ONE bounded correction: address the findings below, re-run the gates yourself, then end with your completion report.\n\n--- reviewer verdict file ---\n${reviewed.text}`);
  await waitRole('implementer', 'wait_fix', 'fix_correction');
  const fixGates = await runGates('gates_fix');
  if (!fixGates.green) return redExit(fixGates, true);
  reviewBaseline('closure_review');
  await sendPrompt('reviewer', 'closure_review', `This is the closure review for lane ${config.lane} — the second and last round. The implementer applied your findings from your previous verdict (${reviewed.verdict}). Re-check ONLY whether those findings are resolved and the gates still hold, then OVERWRITE ${lane.verdictFile} (first line 'VERDICT: ACCEPT', 'VERDICT: ACCEPT WITH FIXES' or 'VERDICT: REJECT'). Original review brief: ${join(lane.dir, 'review-brief.md')}.`);
  await waitRole('reviewer', 'wait_closure', 'closure_review');
  state.counters.reviewRounds = 2;
  const closed = await readVerdict('verdict_closure', 'closure_review');
  return closed.verdict === 'ACCEPT' ? accepted(closed.verdict, true) : adjudicate(closed.verdict, true);
}

// ─── dry run ─────────────────────────────────────────────────────────────────

const PLAN_STEPS = (lane: LoadedLane): Array<{ step: string; detail: string }> => {
  const { config } = lane;
  return [
    { step: 'spawn_implementer', detail: `${config.implementer.runtime} ${config.implementer.selector} (thinking ${config.implementer.thinking ?? 'in selector'}) in ${config.cwd}, owner ${config.owner}, ttl ${config.ttlSeconds}s — a route-cap refusal exits 25 with the overflow hint` },
    { step: 'watch_implementer', detail: `register the watch (${config.mode === 'goal' ? 'goal_end/paused/stalled' : 'agent_end'} + question sentinel + deadline)` },
    { step: 'dispatch', detail: config.mode === 'goal' ? `goal start (one-line objective pointing at brief.md${config.budgetTokens ? `, budget ${config.budgetTokens} tokens` : ''})` : 'prompt: child directive + brief.md' },
    { step: 'wait', detail: 'long-poll wait (this process is the waiter); a child question (NN-question.md or the sentinel) → exit 40; a deadline → exit 3' },
    { step: 'gates', detail: `re-run the ${lane.gates.length} GATES from brief.md in ${config.cwd} (verify --gates-file logic)` },
    { step: 'correction', detail: config.maxCorrections > 0 ? 'only if a gate is red: ONE bounded correction to the SAME implementer → wait_correction → gates_correction; still red → exit 41' : 'maxCorrections is 0: a red gate exits 41 at once' },
    { step: 'spawn_reviewer', detail: `${config.reviewer.runtime} ${config.reviewer.selector} (thinking ${config.reviewer.thinking ?? 'in selector'}), fresh session` },
    { step: 'watch_reviewer', detail: 'register the reviewer watch' },
    { step: 'dispatch_review', detail: `prompt: child directive + review-brief.md (verdict file ${lane.verdictFile})` },
    { step: 'wait_review', detail: 'wait for the reviewer' },
    { step: 'verdict', detail: "read the verdict file's first line: ACCEPT → exit 0 DONE; ACCEPT WITH FIXES / REJECT → exit 42 VERDICT" },
    { step: 'continue (only with --continue correction after exit 42)', detail: 'fix_correction → wait_fix → gates_fix → closure_review → wait_closure → verdict_closure → exit 0 or 42 (never a third round)' },
  ];
};

function dryRunResult(lane: LoadedLane, options: LaneRunOptions): LaneRunResult {
  const steps = PLAN_STEPS(lane);
  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify({ dryRun: true, lane: lane.config.lane, mode: lane.config.mode, gates: lane.gates, verdictFile: lane.verdictFile, steps }, null, 2) };
  }
  const lines = [
    `lane ${lane.config.lane} (mode ${lane.config.mode}) — dry run: inputs validated, no API call made, nothing written`,
    `lane dir ${lane.dir}; brief.md (${lane.gates.length} gate(s)); review-brief.md; verdict file ${lane.verdictFile}${lane.correctionTemplate !== undefined ? '; correction-template.md' : ''}`,
    'plan:',
    ...steps.map((entry, index) => `  ${index + 1}. ${entry.step} — ${entry.detail}`),
    'exits: 0 DONE · 3 DEADLINE · 25 ROUTE_LIMIT · 40 QUESTION · 41 GATES_RED · 42 VERDICT · 43 RUNNER_ERROR',
  ];
  return { exitCode: 0, stdout: lines.join('\n') };
}
