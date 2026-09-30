/**
 * G1: per-route child concurrency. Pure decision logic for the client gate:
 *
 * - R3 measured that zai GLM 5.3 Flash stops returning completions above
 *   roughly 5–8 concurrent children, so the built-in default limits that
 *   route to 5 and leaves every other route unlimited unless configured.
 * - Configuration: `PI_ORCH_ROUTE_LIMITS` (a JSON map of model selector →
 *   limit) plus per-call overrides; the override wins. A value of 0 (or the
 *   CLI spelling "unlimited") removes the cap for that route.
 * - A malformed limit map throws: silently running unlimited is exactly the
 *   provider overload this feature exists to prevent.
 * - "Live" means the child can still be generating: busy, a nonterminal run
 *   receipt, or a goal running/wrapping_up — decided from the server's own
 *   list/detail (`busy`), goal projection (`status`) and run evidence
 *   (`runChronology[0].status`) fields. A finished idle child never counts.
 */

export const DEFAULT_ROUTE_LIMITS: Record<string, number> = {
  'zai/glm-5.3-flash': 5,
};

export interface ResolveRouteLimitsOptions {
  /** Environment source; defaults to no env (tests pass process.env or a fixture). */
  env?: Record<string, string | undefined>;
  /** Per-call / flag overrides; win over the env and the defaults. */
  overrides?: Record<string, number>;
}

/**
 * Merge the built-in defaults, the PI_ORCH_ROUTE_LIMITS JSON map and the
 * per-call overrides into one effective limit map. 0 = unlimited (no cap).
 */
export function resolveRouteLimits(options: ResolveRouteLimitsOptions = {}): Record<string, number> {
  const merged: Record<string, number> = { ...DEFAULT_ROUTE_LIMITS };
  const raw = options.env?.PI_ORCH_ROUTE_LIMITS;
  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RouteLimitsConfigError(`PI_ORCH_ROUTE_LIMITS is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RouteLimitsConfigError('PI_ORCH_ROUTE_LIMITS must be a JSON object of { "model selector": limit }');
    }
    for (const [route, value] of Object.entries(parsed as Record<string, unknown>)) {
      merged[route] = parseLimitValue(route, value, 'PI_ORCH_ROUTE_LIMITS');
    }
  }
  if (options.overrides) {
    for (const [route, value] of Object.entries(options.overrides)) {
      merged[route] = parseLimitValue(route, value, 'route-limit override');
    }
  }
  return merged;
}

function parseLimitValue(route: string, value: unknown, source: string): number {
  return validateLimitValue(route, value, source);
}

/**
 * One limit value validated by the shared rules (integer >= 0; 0 = unlimited).
 * Used by the environment map, the CLI flags and the module-API per-call
 * override alike — a bad value is always a usage-class error, never a silent
 * fallback (G1 correction 01 item 6).
 */
export function validateLimitValue(route: string, value: unknown, source: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new RouteLimitsConfigError(`${source}: limit for '${route}' must be an integer >= 0 (0 = unlimited), got ${value}`);
    }
    return value;
  }
  throw new RouteLimitsConfigError(`${source}: limit for '${route}' must be a number, got ${JSON.stringify(value)}`);
}

export class RouteLimitsConfigError extends Error {
  constructor(message: string) {
    super(`pi-orch: ${message}`);
    this.name = 'RouteLimitsConfigError';
  }
}

/** The effective cap for a route; undefined = unlimited / not enforced. */
export function limitFor(route: string | undefined, limits: Record<string, number>): number | undefined {
  if (!route) return undefined;
  const value = limits[route];
  if (value === undefined || value <= 0) return undefined;
  return value;
}

/** The route key a session counts against: its model selector, else its model. */
export function routeOfSession(info: { modelSelector?: string; model?: string }): string | undefined {
  const selector = typeof info.modelSelector === 'string' && info.modelSelector.trim() !== '' ? info.modelSelector : undefined;
  const model = typeof info.model === 'string' && info.model.trim() !== '' ? info.model : undefined;
  return selector ?? model;
}

export type LiveReason = 'busy' | 'goal_running' | 'goal_wrapping_up' | 'run_active';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/**
 * Why a child is still live (can still be generating), or null when it is
 * settled. busy wins, then an active goal, then a nonterminal last receipt —
 * matching the brief's rule, decided only from server-provided fields.
 */
export function liveReason(child: {
  busy?: boolean;
  goalStatus?: string;
  lastRunStatus?: string;
}): LiveReason | null {
  if (child.busy === true) return 'busy';
  if (child.goalStatus === 'running') return 'goal_running';
  if (child.goalStatus === 'wrapping_up') return 'goal_wrapping_up';
  if (typeof child.lastRunStatus === 'string' && child.lastRunStatus !== '' && !TERMINAL_RUN_STATUSES.has(child.lastRunStatus)) {
    return 'run_active';
  }
  return null;
}

/** Refusal thrown BEFORE any child is created when a route is at its cap. */
export class RouteLimitError extends Error {
  readonly code = 'ROUTE_LIMIT_EXCEEDED';
  readonly route: string;
  readonly limit: number;
  readonly live: Array<{ sessionId: string; reason: string }>;

  constructor(route: string, limit: number, live: Array<{ sessionId: string; reason: string }>) {
    const listed = live.map((entry) => `${entry.sessionId} (${entry.reason})`).join(', ');
    super(
      `route '${route}' is at its limit of ${limit} live children: ${listed}. Wait for one to settle, re-run with --wait-for-slot <seconds>, or spread the children across another route`,
    );
    this.name = 'RouteLimitError';
    this.route = route;
    this.limit = limit;
    this.live = live;
  }
}

/** Thrown when --wait-for-slot ran out of time without a slot freeing up. */
export class RouteLimitWaitDeadlineError extends Error {
  readonly code = 'ROUTE_LIMIT_WAIT_DEADLINE';
  readonly route: string;
  readonly limit: number;
  readonly waitedMs: number;

  constructor(route: string, limit: number, waitedMs: number) {
    super(`no slot on route '${route}' (limit ${limit}) within the --wait-for-slot budget (${Math.round(waitedMs / 1000)}s); the children are still working — retry, raise the limit, or use another route`);
    this.name = 'RouteLimitWaitDeadlineError';
    this.route = route;
    this.limit = limit;
    this.waitedMs = waitedMs;
  }
}
