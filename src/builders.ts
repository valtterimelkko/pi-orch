/**
 * Request-body builders. Lightweight runtime validation for fast, clear
 * failures; the snapshot conformance (right keys, right bounds, right enums —
 * the server schemas are strict) is proven against the generated snapshot in
 * test/builders.test.ts, which is what actually catches server drift.
 */

import type { WatchConditionSpec } from './parsers.ts';

const RUNTIMES = ['pi', 'claude', 'opencode', 'antigravity', 'commandcode'] as const;
export type Runtime = (typeof RUNTIMES)[number];

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const GOALLESS_RUNTIMES: readonly Runtime[] = ['opencode', 'antigravity'];

export interface CreateInput {
  runtime: Runtime;
  cwd: string;
  /** Exact selector from the live GET /models — copy, never construct. */
  modelSelector?: string;
  thinkingLevel?: ThinkingLevel;
  retention?: { mode: 'durable' | 'resident'; ttlSeconds?: number; ownerId: string; label?: string };
  goal?: { objective: string; maxTurns?: number; verifyCommand?: string };
  preflight?: { paths?: string[]; tools?: string[] };
  parentSessionId?: string;
  agentOsCapture?: 'enabled' | 'disabled';
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
    if (!input.goal.objective || input.goal.objective.length > 4000) {
      throw new Error('pi-orch: goal.objective must be 1..4000 chars');
    }
    if (input.goal.maxTurns !== undefined && (!Number.isInteger(input.goal.maxTurns) || input.goal.maxTurns < 1 || input.goal.maxTurns > 100)) {
      throw new Error('pi-orch: goal.maxTurns must be an integer in 1..100');
    }
    body.goal = { ...input.goal };
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
}

export function buildPromptBody(input: PromptInput, randomId: () => string = defaultRandomId): Record<string, unknown> {
  if (!input.message) throw new Error('pi-orch: message is required');
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
  const body: Record<string, unknown> = { message: input.message, verbosity, mode, idempotencyKey };
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
