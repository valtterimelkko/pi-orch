/**
 * Request-body builders. Lightweight runtime validation for fast, clear
 * failures; the snapshot conformance (right keys, right bounds, right enums —
 * the server schemas are strict) is proven against the generated snapshot in
 * test/builders.test.ts, which is what actually catches server drift.
 */

import type { WatchConditionSpec } from './parsers.ts';
import { applyCompletionTemplate, applyGoalObjectiveTemplate, COMPLETION_REPORT_INSTRUCTION } from './completion-template.ts';

const RUNTIMES = ['pi', 'claude', 'opencode', 'antigravity', 'commandcode'] as const;
export type Runtime = (typeof RUNTIMES)[number];

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const GOALLESS_RUNTIMES: readonly Runtime[] = ['opencode', 'antigravity'];

/** 02-correction 1: one validator for goal fields, shared by create-time goals and goalStart. */
export class GoalFieldValidationError extends Error {}

export function validateGoalFields(goal: { objective: string; maxTurns?: number; verifyCommand?: string; budgetTokens?: number }): void {
  if (!goal.objective || goal.objective.length > 4000) {
    throw new GoalFieldValidationError('pi-orch: goal.objective must be 1..4000 chars');
  }
  if (/[\n\r]/.test(goal.objective)) {
    throw new GoalFieldValidationError('pi-orch: goal.objective must be a single line (server rule)');
  }
  if (goal.maxTurns !== undefined && (!Number.isInteger(goal.maxTurns) || goal.maxTurns < 1 || goal.maxTurns > 100)) {
    throw new GoalFieldValidationError('pi-orch: goal.maxTurns must be an integer in 1..100');
  }
  if (goal.verifyCommand !== undefined && (typeof goal.verifyCommand !== 'string' || goal.verifyCommand.length === 0 || goal.verifyCommand.length > 2000)) {
    throw new GoalFieldValidationError('pi-orch: goal.verifyCommand must be a non-empty string (max 2000 chars)');
  }
  if (goal.budgetTokens !== undefined) {
    const { budgetTokens } = goal;
    if (!Number.isInteger(budgetTokens) || budgetTokens < 1 || budgetTokens > 1_000_000_000) {
      throw new GoalFieldValidationError('pi-orch: goal.budgetTokens must be an integer in 1..1000000000 (ceiling is typo defence; the server default is 5000000)');
    }
  }
}

export interface CreateInput {
  runtime: Runtime;
  cwd: string;
  /** Exact selector from the live GET /models — copy, never construct. */
  modelSelector?: string;
  thinkingLevel?: ThinkingLevel;
  retention?: { mode: 'durable' | 'resident'; ttlSeconds?: number; ownerId: string; label?: string };
  goal?: { objective: string; maxTurns?: number; verifyCommand?: string; /** J2 P1: token budget for the goal engine (server default 5,000,000 pauses long goals). */ budgetTokens?: number };
  preflight?: { paths?: string[]; tools?: string[] };
  parentSessionId?: string;
  agentOsCapture?: 'enabled' | 'disabled';
  /** Default true: the goal objective carries the C3b completion-report template. */
  completionTemplate?: boolean;
}

export function buildCreateBody(input: CreateInput): Record<string, unknown> {
  if (!RUNTIMES.includes(input.runtime)) {
    throw new Error(`pi-orch: runtime must be one of ${RUNTIMES.join(', ')}`);
  }
  if (!input.cwd || input.cwd.length > 4096) throw new Error('pi-orch: cwd is required (max 4096 chars)');
  if (input.modelSelector !== undefined && (input.modelSelector.length < 1 || input.modelSelector.length > 200)) {
    throw new Error('pi-orch: modelSelector must be 1..200 chars (copy it from GET /models)');
  }
  if (input.thinkingLevel !== undefined && !THINKING_LEVELS.includes(input.thinkingLevel)) {
    throw new Error(`pi-orch: thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
  }
  const body: Record<string, unknown> = { runtime: input.runtime, cwd: input.cwd };
  if (input.modelSelector !== undefined) body.model = input.modelSelector;
  if (input.thinkingLevel !== undefined) body.thinkingLevel = input.thinkingLevel;
  if (input.retention) {
    const { ttlSeconds } = input.retention;
    if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7 * 24 * 60 * 60)) {
      throw new Error('pi-orch: retention.ttlSeconds must be an integer in 1..604800');
    }
    body.retention = { ...input.retention };
  }
  if (input.goal) {
    if (GOALLESS_RUNTIMES.includes(input.runtime)) {
      throw new Error(`pi-orch: goal is not supported for runtime '${input.runtime}' (server refuses it)`);
    }
    // 02-correction 1: the shared validator (same messages as before).
    validateGoalFields(input.goal);
    // C3b: goal children are the receipt-less class — the completion template
    // must reach them, but the server caps the objective at 4000 chars and
    // requires it SINGLE-LINE, so the objective carries a flattened pointer
    // (applyGoalObjectiveTemplate) and the client delivers the verbatim
    // paragraph as a follow_up prompt after the create (C3a-proven shape).
    const templated = input.completionTemplate === false
      ? input.goal.objective
      : applyGoalObjectiveTemplate(input.goal.objective);
    if (templated.length > 4000) {
      throw new Error(
        `pi-orch: goal.objective with the completion template is ${templated.length} chars (server limit 4000); shorten the objective or pass completionTemplate: false / --no-completion-template`,
      );
    }
    if (templated.includes('\n')) {
      throw new Error('pi-orch: goal.objective must be a single line (server rule)');
    }
    // J2 P1: explicit fields, not a spread — the server schema is .strict(), so
    // an unexpected caller field must never ride into the request body.
    body.goal = {
      objective: templated,
      ...(input.goal.maxTurns !== undefined ? { maxTurns: input.goal.maxTurns } : {}),
      ...(input.goal.verifyCommand !== undefined ? { verifyCommand: input.goal.verifyCommand } : {}),
      ...(input.goal.budgetTokens !== undefined ? { budgetTokens: input.goal.budgetTokens } : {}),
    };
  }
  if (input.preflight) {
    body.preflight = buildPreflightSpec(input.preflight);
  }
  if (input.parentSessionId !== undefined) body.parentSessionId = input.parentSessionId;
  if (input.agentOsCapture !== undefined) body.agentOsCapture = input.agentOsCapture;
  return body;
}

export function buildPreflightSpec(spec: { paths?: string[]; tools?: string[] }): { paths?: string[]; tools?: string[] } {
  const out: { paths?: string[]; tools?: string[] } = {};
  if (spec.paths) {
    for (const path of spec.paths) {
      if (!path.startsWith('/')) throw new Error(`pi-orch: preflight paths must be absolute (got ${JSON.stringify(path)})`);
    }
    out.paths = [...spec.paths];
  }
  if (spec.tools) {
    for (const tool of spec.tools) {
      if (!tool || tool.includes('/')) throw new Error(`pi-orch: preflight tools must be bare names (got ${JSON.stringify(tool)})`);
    }
    out.tools = [...spec.tools];
  }
  return out;
}

export interface PromptInput {
  message: string;
  verbosity?: 'answers' | 'tasks' | 'full';
  mode?: 'prompt' | 'follow_up' | 'steer';
  idempotencyKey?: string;
  requireActiveTurn?: boolean;
  preflight?: { paths?: string[]; tools?: string[] };
  /** Default true: disconnected clients must not cancel the run. */
  detach?: boolean;
  /** Default true: the message carries the C3b completion-report template. */
  completionTemplate?: boolean;
}

export function buildPromptBody(input: PromptInput, randomId: () => string = defaultRandomId): Record<string, unknown> {
  if (!input.message) throw new Error('pi-orch: message is required');
  // C3b: the completion template rides by default on every dispatched prompt
  // (the brief's default-for-prompt rule); opt out per call when the message
  // is not a task (steer/follow_up chatter) with completionTemplate: false.
  const message = input.completionTemplate === false ? input.message : applyCompletionTemplate(input.message);
  if (message.length > 100_000) {
    throw new Error(`pi-orch: message with the completion template is ${message.length} chars (server limit 100000); shorten it or pass completionTemplate: false / --no-completion-template`);
  }
  const detach = input.detach ?? true;
  const verbosity = input.verbosity ?? 'answers';
  if (detach && verbosity !== 'answers') {
    throw new Error('pi-orch: detach is only valid with verbosity=answers (server 400s otherwise)');
  }
  const idempotencyKey = input.idempotencyKey ?? randomId();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
    throw new Error('pi-orch: idempotencyKey must be 1..128 chars');
  }
  const mode = input.mode ?? 'prompt';
  if (!['prompt', 'follow_up', 'steer'].includes(mode)) {
    throw new Error('pi-orch: mode must be prompt, follow_up or steer');
  }
  const body: Record<string, unknown> = { message, verbosity, mode, idempotencyKey };
  if (detach) body.detach = true;
  if (input.requireActiveTurn !== undefined) body.requireActiveTurn = input.requireActiveTurn;
  if (input.preflight) body.preflight = buildPreflightSpec(input.preflight);
  return body;
}

// ─── Watch conditions ────────────────────────────────────────────────────────

let conditionCounter = 0;

function nextId(prefix: string): string {
  conditionCounter += 1;
  return `${prefix}-${conditionCounter}`;
}

export function agentEnd(id: string = nextId('done')): WatchConditionSpec {
  return { id, type: 'event_type', eventType: 'agent_end', once: true };
}

/**
 * goal_end filtered by the EXACT objective string. The filter matters: reusing
 * a session can clear its OLD goal first, and an unfiltered one-shot watcher
 * would consume that stale event and miss the real result.
 */
export function goalEnd(objective: string, id: string = nextId('outcome')): WatchConditionSpec {
  return { id, type: 'event_type', eventType: 'goal_end', dataMatch: { objective }, once: false };
}

export function goalPaused(objective: string, id: string = nextId('paused')): WatchConditionSpec {
  return { id, type: 'event_type', eventType: 'goal_state', dataMatch: { objective, status: 'paused' }, once: false };
}

/**
 * Wave K (contract 1.60.0): the AUTO-CONTINUE `goal_state` — the server
 * carried a restart-interrupted goal child across the stop, the projection
 * stays `running` and carries `autoContinued: true` — is PROGRESS, never a
 * settlement. Filtered by the EXACT objective (the same stale-goal rule
 * goalEnd carries) so an old goal's continue cannot wake a new wait; repeats
 * (`once: false`) so several continues over one long-lived goal are all
 * visible. Keyed exactly as the contract documents the watch form: the
 * event's data carries TOP-LEVEL `autoContinued: true` (K correction C6 —
 * the evaluator's dataMatch is a shallow top-level match, so a dotted key
 * would never fire), plus the objective.
 */
export function goalAutoContinue(objective: string, id: string = nextId('cont')): WatchConditionSpec {
  return { id, type: 'event_type', eventType: 'goal_state', dataMatch: { objective, autoContinued: true }, once: false };
}

/** Question sentinel: the brief must name the exact standalone line. */
export function questionSentinel(text: string, id: string = nextId('question')): WatchConditionSpec {
  if (!text) throw new Error('pi-orch: question sentinel text must be non-empty');
  return { id, type: 'text', contains: text, once: true };
}

/** Server-side model-free backstop: fires once after N seconds, survives restarts. */
export function deadlineCondition(afterSeconds: number, id: string = nextId('deadline')): WatchConditionSpec {
  if (!Number.isInteger(afterSeconds) || afterSeconds < 1 || afterSeconds > 86_400) {
    throw new Error('pi-orch: deadline afterSeconds must be an integer in 1..86400');
  }
  return { id, type: 'deadline', afterSeconds, once: true };
}

function defaultRandomId(): string {
  return `piorch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Default conditions. Plain child: agent_end + a server-side deadline backstop.
 * Goal-armed child (objective given): goal_end + paused + the Wave K
 * auto-continue progress condition, all matched on the EXACT objective, plus
 * the deadline — and deliberately NO per-turn agent_end
 * (goals.md: on a goal child it fires at every turn boundary, producing false
 * wakes that read like completion and burn the wake budget).
 *
 * Use this when the objective is AUTHORITATIVE — read from the goal projection
 * (auto-detect) or handed over as the stored form. For an objective the CALLER
 * typed (the raw form from `spawn --goal-objective`), use
 * {@link callerObjectiveConditions}, which matches both forms.
 */
export function defaultConditions(objective: string | undefined, deadlineMs: number): WatchConditionSpec[] {
  const conditions: WatchConditionSpec[] = objective
    ? [goalEnd(objective), goalPaused(objective), goalAutoContinue(objective)]
    : [agentEnd()];
  return withDeadlineBackstop(conditions, deadlineMs);
}

/**
 * I1 (H2 item 6): the goal conditions for an objective the CALLER supplied.
 * `spawn --goal-objective X` stores `applyGoalObjectiveTemplate(X)` (the
 * flattened completion pointer rides along) and the server matches
 * goal_end/goal_state dataMatch.objective by strict equality, so a wait given
 * the raw X can never fire — the G5 parent's achieved goal still ran to its
 * deadline. The caller-objective set therefore matches BOTH the raw and the
 * stored form. Decided over resolving the stored objective from the goal
 * projection because it is deterministic (the same pure function spawn used,
 * so byte-identical by construction) and race-free: the projection can lag
 * the goal engine's registration on a fresh spawn, which would need the same
 * dual-form fallback anyway. A caller objective that is already the stored
 * form (contains the template pointer) registers once — the raw variant would
 * never fire and is noise. An objective without the pointer that was spawned
 * with completionTemplate:false stores raw; the raw condition matches, the
 * templated variant merely never fires.
 */
export function callerObjectiveConditions(objective: string | undefined, deadlineMs: number): WatchConditionSpec[] {
  if (!objective) return defaultConditions(undefined, deadlineMs);
  const conditions: WatchConditionSpec[] = goalObjectiveConditionForms(objective).flatMap((form) => [goalEnd(form), goalPaused(form), goalAutoContinue(form)]);
  return withDeadlineBackstop(conditions, deadlineMs);
}

/**
 * The objective forms a caller-objective wait must match: the given form, plus
 * its stored (templated) expansion unless the given form already IS the stored
 * form (it carries the template pointer — applyGoalObjectiveTemplate would
 * return it unchanged).
 */
export function goalObjectiveConditionForms(objective: string): string[] {
  if (objective.includes('pi-completion/v1')) return [objective];
  const templated = applyGoalObjectiveTemplate(objective);
  return templated === objective ? [objective] : [objective, templated];
}

function withDeadlineBackstop(conditions: WatchConditionSpec[], deadlineMs: number): WatchConditionSpec[] {
  const deadlineSeconds = Math.floor(deadlineMs / 1000);
  if (deadlineSeconds >= 1 && deadlineSeconds <= 86_400) {
    conditions.push(deadlineCondition(deadlineSeconds));
  }
  return conditions;
}

export interface WatchInput {
  conditions: WatchConditionSpec[];
  label?: string;
  fireIfSettled?: boolean;
  pin?: boolean;
}

export function buildWatchBody(input: WatchInput): Record<string, unknown> {
  if (!input.conditions || input.conditions.length === 0) {
    throw new Error('pi-orch: watch conditions must be non-empty');
  }
  const body: Record<string, unknown> = { conditions: input.conditions };
  if (input.label !== undefined) body.label = input.label;
  if (input.fireIfSettled !== undefined) body.fireIfSettled = input.fireIfSettled;
  if (input.pin !== undefined) body.pin = input.pin;
  return body;
}
