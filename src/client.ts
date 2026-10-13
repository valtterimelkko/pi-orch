/**
 * PiOrchClient — the importable module surface. Every call sends
 * X-Parent-Session when the caller's session identity is known (flag >
 * PI_ORCH_PARENT_SESSION > PI_WEB_UI_SESSION_ID > PI_SESSION_ID), so parent
 * linkage and `?parent=` lineage work without extra effort (C5), and bare-CLI
 * parents pass --parent-session explicitly.
 */

import { Transport, TransportError, type TransportConfig } from './transport.ts';
import {
  buildCreateBody,
  buildPromptBody,
  buildWatchBody,
  deadlineCondition,
  agentEnd,
  goalEnd,
  goalPaused,
  questionSentinel,
  type CreateInput,
  type PromptInput,
} from './builders.ts';
import { parseReceipt, ApiError, classifyRunOutput, type RunOutputClassification, type Receipt, type WatchConditionSpec } from './parsers.ts';
import { resolveCompletion, type CompletionBlock, type CompletionParseError, type CompletionDelimiter, type CompletionCaptureSource, type ReceiptWithCompletion, type SessionDetailWithCompletion } from './completion.ts';
import { GOAL_REPORT_INSTRUCTION, applyGoalObjectiveTemplate } from './completion-template.ts';

/**
 * I1 (H2 item 2) + correction 01: does the first template receipt warrant the
 * ONE re-send? `failed` (any code, incl. NEVER_STARTED) always does — nothing
 * was delivered. `cancelled`/`interrupted` only WITHOUT `startedAt`: the
 * server marks the follow-up started at the matching user message_start, so a
 * startedAt on those receipts proves the template's user message WAS observed
 * before a restart/cancel cut the run off — resending would duplicate the
 * template, the exact defect I1 removes. Everything else — queued, accepted,
 * started, completed, unknown — is healthy and never re-sent.
 */
function templateReceiptWantsRetry(status: string | undefined, startedAt: string | undefined): boolean {
  if (status === 'failed') return true;
  if (status === 'cancelled' || status === 'interrupted') return startedAt === undefined;
  return false;
}
import { verifyChild, makeNodeVerifyDeps, type VerifyInput, type VerifyResult, type CompletionLoad } from './verify.ts';
import { waitOnChild, waitOnChildren, type WaitOutcome, type WaitDeps, type WaitOnChildrenResult, type WaitChild, type GoalInterruptionFacts } from './wait.ts';
import { limitFor, liveReason, resolveRouteLimits, routeOfSession, validateLimitValue, RouteLimitError, RouteLimitWaitDeadlineError, advertisedProfileCapacity, profileCapacityFull, profileIdOfSelector, type RouteLimitProfile } from './route-limits.ts';
import { SpawnLedger, defaultLedgerPath } from './spawn-ledger.ts';
import { validateGoalFields, GoalFieldValidationError } from './builders.ts';
import { withRouteLock, ROUTE_LOCK_STALE_MARGIN_MS } from './route-lock.ts';
import { dirname } from 'node:path';

export interface ClientConfig {
  /** Socket/http transport options; omit when `transportInstance` is given. */
  transport?: TransportConfig;
  /** Pre-built transport (tests); overrides `transport`. */
  transportInstance?: Transport;
  parentSessionId?: string;
  /** Default idempotency-key factory; injectable for tests. */
  randomId?: () => string;
  waitDeadlineMs?: number;
  waitSliceMs?: number;
  /** C3b: delay before the goal-template follow-up health check (default 3000; tests inject small values). */
  templateFollowUpCheckDelayMs?: number;
  /** G1: effective per-route limits (an explicit map wins over the environment). */
  routeLimits?: Record<string, number>;
  /** G1: environment source for PI_ORCH_ROUTE_LIMITS (tests inject a fixture; default process.env). */
  env?: Record<string, string | undefined>;
  /** G1: where the bare-CLI spawn ledger lives (default PI_ORCH_SPAWN_LEDGER or ~/.pi-orch/spawn-ledger.json). */
  spawnLedgerPath?: string;
  /** G1 correction 01: directory for the per-(caller, route) spawn locks (default the ledger's directory). */
  spawnLockDir?: string;
  /** G1 correction 01: how long a spawn waits for the route lock before failing (default 30 000 ms). */
  routeLockTimeoutMs?: number;
  /** G1: warning sink (default a line on stderr). */
  onWarn?: (line: string) => void;
}

/**
 * W0d: how one spawn/prompt is gated.
 * - `local` — an explicit limit (per-call value or PI_ORCH_ROUTE_LIMITS entry):
 *   refuse when THIS caller's live children on the route reach the limit.
 * - `profile_active` — no explicit limit and the server advertises a Claude
 *   profile capacity: the decision is the SERVER's own predicate
 *   (`active >= maxConcurrent`, correction 01). `active` already counts this
 *   parent's live turns, so the local count is NOT added or compared — it is
 *   listed in the refusal as context only.
 */
type RouteGate =
  | { kind: 'local'; limit: number; profile: RouteLimitProfile | undefined }
  | { kind: 'profile_active'; limit: number; maxConcurrent: number; active: number; profile: RouteLimitProfile };

/** The local live-children reading a gate refusal's message rides on. */
interface CountedLive {
  count: number;
  live: Array<{ sessionId: string; reason: string }>;
  countedBy: 'parent' | 'owner' | 'none';
}

/**
 * 02-correction 2: the server refused a generation-guarded watch delete
 * (409 WATCH_GENERATION_MISMATCH). Carries BOTH generations so a caller can
 * report exactly what happened; the watch is unchanged server-side.
 */
export class WatchGenerationMismatchError extends Error {
  readonly expectedGeneration: string | undefined;
  readonly currentGeneration: string | undefined;
  readonly watchId: string | undefined;
  code = 'WATCH_GENERATION_MISMATCH';

  constructor(expectedGeneration: string | undefined, currentGeneration: string | undefined, watchId: string | undefined) {
    super(`pi-orch: WATCH_GENERATION_MISMATCH — deleted nothing; the watch was replaced since it was read (expected ${expectedGeneration ?? 'unknown'}, current ${currentGeneration ?? 'unknown'})`);
    this.name = 'WatchGenerationMismatchError';
    this.expectedGeneration = expectedGeneration;
    this.currentGeneration = currentGeneration;
    this.watchId = watchId;
  }
}

/**
 * 04-correction A2: the server answered a watch delete, but the
 * acknowledgement does not confirm THIS delete (success:false, a missing
 * watchId, or a different generation). Nothing may be reported as deleted.
 */
export class WatchDeleteAcknowledgementError extends Error {
  readonly ack: Record<string, unknown> | undefined;
  code = 'WATCH_DELETE_ACK_FAILED';

  constructor(detail: string, ack?: Record<string, unknown>) {
    super(`pi-orch: WATCH_DELETE_ACK_FAILED — the server answered, but the acknowledgement does not confirm this delete (${detail}); reporting NOTHING as deleted`);
    this.name = 'WatchDeleteAcknowledgementError';
    this.ack = ack;
  }
}

export class PiOrchClient {
  readonly transport: Transport;
  readonly parentSessionId?: string;
  private readonly randomId: () => string;
  private readonly waitDeadlineMs: number;
  private readonly waitSliceMs: number;
  private readonly templateFollowUpCheckDelayMs: number;
  readonly routeLimits: Record<string, number>;
  private readonly spawnLedger: SpawnLedger;
  private readonly spawnLockDir: string;
  private readonly routeLockTimeoutMs: number;
  private readonly onWarn: (line: string) => void;
  private readonly warned = new Set<string>();
  /** Correction 03 item 2: parent ids discovered stale (404 on the ?parent= lookup). */
  private readonly staleParentIds = new Set<string>();

  constructor(config: ClientConfig) {
    if (config.transportInstance === undefined && config.transport === undefined) {
      throw new Error('pi-orch: client needs transport options or a transportInstance');
    }
    this.transport = config.transportInstance ?? new Transport(config.transport as TransportConfig);
    this.parentSessionId = config.parentSessionId;
    this.randomId = config.randomId ?? defaultRandomId;
    this.waitDeadlineMs = config.waitDeadlineMs ?? 30 * 60_000;
    this.waitSliceMs = config.waitSliceMs ?? 45_000;
    this.templateFollowUpCheckDelayMs = config.templateFollowUpCheckDelayMs ?? 3_000;
    this.routeLimits = config.routeLimits ?? resolveRouteLimits({ env: config.env ?? process.env });
    this.onWarn = config.onWarn ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    const ledgerPath = config.spawnLedgerPath ?? defaultLedgerPath(config.env ?? process.env);
    this.spawnLedger = new SpawnLedger(ledgerPath);
    this.spawnLockDir = config.spawnLockDir ?? dirname(ledgerPath);
    this.routeLockTimeoutMs = config.routeLockTimeoutMs ?? 30_000;
  }

  private warnOnce(line: string): void {
    const key = line.length > 120 ? line.slice(0, 120) : line;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onWarn(line);
  }

  /**
   * Correction 03 item 1: how long an unattended lock file may sit before it
   * is considered wedged — the transport's guarded-request ceiling (request
   * timeout + Retry-After budget) plus a margin. Stealing still requires the
   * recorded holder PID to be dead first.
   */
  private get routeLockStaleMs(): number {
    const ceiling = (this.transport as { guardedRequestCeilingMs?: number }).guardedRequestCeilingMs;
    return (typeof ceiling === 'number' ? ceiling : 30_000 + 120_000) + ROUTE_LOCK_STALE_MARGIN_MS;
  }

  /** The gate for one spawn/prompt call, with the Claude profile it belongs to
    * (W0d: the profile facts ride on the exit-25 refusal so a parent is told
    * the cap and the overflow route instead of learning them from a failure).
    * Priority: the per-call value wins; then an explicit map entry (both keep
    * the local-count semantics, and an explicit 0 = unlimited wins outright);
    * then — on a Claude `profile:<id>` route only — the SERVER's advertised
    * profile capacity, which is decided from the server's own numbers. A bad
    * per-call value is a usage-class error, never a silent unlimited
    * (correction 01 item 6). */
  private async resolveRouteGate(runtime: string | undefined, route: string | undefined, perCall: number | undefined): Promise<RouteGate | undefined> {
    if (perCall !== undefined) {
      validateLimitValue(route ?? '(per-call)', perCall, 'route-limit');
      if (perCall <= 0) return undefined; // explicit unlimited
      return { kind: 'local', limit: perCall, profile: await this.profileRouteFacts(runtime, route) };
    }
    // An EXPLICIT entry (the env map / module config) always wins — including
    // an explicit 0, which means "unlimited" and must not be re-capped by the
    // server's advertised profile default (and needs no capacity read).
    if (route !== undefined && Object.prototype.hasOwnProperty.call(this.routeLimits, route)) {
      const limit = limitFor(route, this.routeLimits);
      if (limit === undefined) return undefined;
      return { kind: 'local', limit, profile: await this.profileRouteFacts(runtime, route) };
    }
    const profile = await this.profileRouteFacts(runtime, route);
    if (profile !== undefined && profile.maxConcurrent !== undefined && profile.active !== undefined) {
      // W0d correction 01: no explicit limit, a Claude profile route, and the
      // server does advertise → refuse from the server's numbers alone.
      return { kind: 'profile_active', limit: profile.maxConcurrent, maxConcurrent: profile.maxConcurrent, active: profile.active, profile };
    }
    return undefined;
  }

  /**
   * W0d: does this gate refuse a new turn? A `local` gate compares THIS
   * caller's live children against its limit. An advertised profile gate
   * refuses exactly when the server says the profile is full
   * (`active >= maxConcurrent`, the server's own predicate) — the local count
   * is returned purely as message context.
   */
  private gateRefusal(gate: RouteGate, counted: CountedLive): { limit: number; live: Array<{ sessionId: string; reason: string }> } | undefined {
    if (gate.kind === 'profile_active') {
      return profileCapacityFull(gate) ? { limit: gate.limit, live: counted.live } : undefined;
    }
    if (counted.countedBy === 'none') return undefined; // cannot count locally → today's behaviour
    return counted.count >= gate.limit ? { limit: gate.limit, live: counted.live } : undefined;
  }

  /**
   * The local live children a refusal lists. An advertised profile's decision
   * does not need them, so a caller with no identity and no owner reads nothing
   * (and raises no ROUTE_LIMIT_UNCOUNTED warning for a count that is not
   * load-bearing).
   */
  private async countedForGate(route: string, owner: string | undefined, gate: RouteGate): Promise<CountedLive> {
    if (gate.kind === 'profile_active' && !this.parentSessionId && !owner) {
      return { count: 0, live: [], countedBy: 'none' };
    }
    return this.countLiveOnRoute(route, owner);
  }

  /**
   * W0d: the advertised Claude profile facts for a `profile:<id>` route under
   * runtime `claude`. Undefined for every other route (costing no request). An
   * older server without `claudeProfiles`, or an unreadable `/capacity`,
   * yields the profile id WITHOUT numbers — named in a refusal, but never a
   * cap the server did not state.
   */
  private async profileRouteFacts(runtime: string | undefined, selector: string | undefined): Promise<RouteLimitProfile | undefined> {
    if (runtime !== 'claude') return undefined;
    const profileId = profileIdOfSelector(selector);
    if (profileId === undefined) return undefined;
    try {
      const response = await this.transport.request('GET', '/api/v1/capacity', { headers: this.headers() });
      const advertised = advertisedProfileCapacity(response.body, profileId);
      if (!advertised) return { profileId };
      return { profileId, maxConcurrent: advertised.maxConcurrent, active: advertised.active };
    } catch {
      return { profileId }; // capacity unreadable: name the profile, claim no numbers
    }
  }

  private get capsConfigured(): boolean {
    return Object.values(this.routeLimits).some((value) => value > 0);
  }

  // ── G1: per-route live-children accounting ──────────────────────────────

  private async goalStatusOf(sessionId: string): Promise<{ value?: string; failed: boolean }> {
    try {
      const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { headers: this.headers() });
      return { value: (response.body as { status?: string }).status, failed: false };
    } catch {
      return { failed: true }; // unreadable projection: liveness unknown
    }
  }

  private async lastRunStatusOf(sessionId: string): Promise<{ value?: string; failed: boolean }> {
    try {
      const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/evidence`, { headers: this.headers() });
      return { value: (response.body as { runChronology?: Array<{ status?: string }> }).runChronology?.[0]?.status, failed: false };
    } catch {
      return { failed: true }; // unreadable evidence: liveness unknown
    }
  }

  /**
   * Which of these sessions (on `route`) are still live, with the reason each
   * is. A child whose goal/evidence reads FAIL counts as live with reason
   * 'unknown' — fail closed (correction 01 item 2): an unknown child is never
   * treated as settled.
   */
  private async liveAmong(
    sessions: Array<Record<string, unknown>>,
    route: string,
  ): Promise<Array<{ sessionId: string; reason: string }>> {
    const candidates = sessions.filter((session) => routeOfSession(session as { modelSelector?: string; model?: string }) === route);
    const live: Array<{ sessionId: string; reason: string }> = [];
    const queue = [...candidates];
    const worker = async (): Promise<void> => {
      for (;;) {
        const session = queue.shift();
        if (!session) return;
        const sessionId = String(session.sessionId);
        const busy = session.busy === true;
        const [goal, evidence] = await Promise.all([this.goalStatusOf(sessionId), this.lastRunStatusOf(sessionId)]);
        const reason = liveReason({
          busy,
          goalStatus: goal.failed ? undefined : goal.value,
          lastRunStatus: evidence.failed ? undefined : evidence.value,
        });
        if (reason) {
          live.push({ sessionId, reason });
        } else if (!busy && (goal.failed || evidence.failed)) {
          // All KNOWN evidence says settled, but a read failed: liveness is
          // unknown — count it as live so the cap stays honest.
          live.push({ sessionId, reason: 'unknown' });
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return live;
  }

  /**
   * Live children of THIS caller on `route`. Counted from the server by the
   * caller's session identity (`GET /sessions?parent=…`, authoritative); a
   * bare-CLI caller counts by its retention owner through the local spawn
   * ledger (the server has no owner filter). When the parent identity is
   * STALE (404) but an owner is available, the owner ledger is used instead
   * of giving up (correction 01 item 5). With neither, the limit cannot be
   * applied: warn once and proceed (brief rule).
   */
  private async countLiveOnRoute(
    route: string,
    owner: string | undefined,
  ): Promise<{ count: number; live: Array<{ sessionId: string; reason: string }>; countedBy: 'parent' | 'owner' | 'none' }> {
    if (this.parentSessionId) {
      try {
        const response = await this.transport.request('GET', `/api/v1/sessions?parent=${encodeURIComponent(this.parentSessionId)}`, { headers: this.headers() });
        const sessions = (response.body as { sessions?: Array<Record<string, unknown>> }).sessions ?? [];
        const live = await this.liveAmong(sessions, route);
        return { count: live.length, live, countedBy: 'parent' };
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        // Correction 03 item 2: remember the stale identity so the gate locks
        // and records in the OWNER scope from the next attempt on.
        this.staleParentIds.add(this.parentSessionId);
        if (!owner) {
          this.warnOnce(`pi-orch: ROUTE_LIMIT_UNCOUNTED — parent session ${this.parentSessionId} is not known to this server; cannot count live children on route '${route}'; proceeding without the limit`);
          return { count: 0, live: [], countedBy: 'none' };
        }
        // stale identity + an owner: fall back to the ledger below
      }
    }
    if (owner) {
      const response = await this.transport.request('GET', '/api/v1/sessions', { headers: this.headers() });
      const sessions = (response.body as { sessions?: Array<Record<string, unknown>> }).sessions ?? [];
      const known = new Set(sessions.map((session) => String(session.sessionId)));
      const ledger = this.spawnLedger.entriesFor(owner, known);
      if (ledger.note) this.warnOnce(`pi-orch: ${ledger.note}`);
      const mine = sessions.filter((session) => ledger.sessionIds.includes(String(session.sessionId)));
      const live = await this.liveAmong(mine, route);
      return { count: live.length, live, countedBy: 'owner' };
    }
    this.warnOnce(`pi-orch: ROUTE_LIMIT_UNCOUNTED — no parent session identity and no retention owner: cannot count live children on route '${route}'; proceeding without the limit (set --parent-session or spawn with --owner)`);
    return { count: 0, live: [], countedBy: 'none' };
  }

  /**
   * G1 --wait-for-slot, ONE wait attempt (the caller's loop owns the deadline
   * and the re-count). Waits only on WATCHABLE children: a child that already
   * carries an active watch is skipped (registering would conflict with a
   * foreign or differently-shaped watch). Watches this attempt creates are
   * removed afterwards (live-found in the G1 proof: a leftover slot-watch
   * made the parent's own later wait fail with WATCH_CONFLICT). A child that
   * vanished (session_not_found) is simply reported back: the caller
   * re-counts instead of refusing (correction 01 item 3).
   */
  private async waitForRouteSlotOnce(
    route: string,
    limit: number,
    live: Array<{ sessionId: string; reason: string }>,
    remainingMs: number,
    profile?: RouteLimitProfile,
  ): Promise<void> {
    const watchBefore = await Promise.all(live.map((entry) => this.getWatch(entry.sessionId).catch(() => null)));
    const watchable = live.filter((_, index) => !(watchBefore[index] !== null && watchBefore[index]?.status === 'active'));
    if (watchable.length === 0) {
      // Every live child carries an unremovable foreign watch: there is no
      // watchable settle to wait for. Refuse with the normal over-limit error
      // so the caller can act now.
      throw new RouteLimitError(route, limit, live, profile);
    }
    const oursToClean = watchable.map((entry) => entry.sessionId);
    const waited = await this.waitMany({ mode: 'any', children: watchable.map((entry) => ({ sessionId: entry.sessionId })), deadlineMs: remainingMs });
    // 04-correction A3: conditional deletes — the generation is read and sent
    // as the precondition; a replaced watch is skipped, never deleted.
    await Promise.all(oursToClean.map((sessionId) => this.deleteOwnWatchConditionally(sessionId).catch(() => ({ deleted: false }))));
    // session_not_found (a vanished child) is NOT a refusal: the caller
    // re-counts and the next attempt uses the fresh live set.
    void waited;
  }

  private headers(): Record<string, string> {
    return this.parentSessionId ? { 'X-Parent-Session': this.parentSessionId } : {};
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const response = await this.transport.request('GET', '/api/v1/capabilities', { headers: this.headers() });
    return response.body as Record<string, unknown>;
  }

  async capacity(): Promise<Record<string, unknown>> {
    const response = await this.transport.request('GET', '/api/v1/capacity', { headers: this.headers() });
    return response.body as Record<string, unknown>;
  }

  async models(runtime?: string): Promise<Array<Record<string, unknown>>> {
    const query = runtime ? `?runtime=${encodeURIComponent(runtime)}` : '';
    const response = await this.transport.request('GET', `/api/v1/models${query}`, { headers: this.headers() });
    const body = response.body as { models?: Record<string, Array<Record<string, unknown>>> };
    const all: Array<Record<string, unknown>> = [];
    for (const list of Object.values(body.models ?? {})) all.push(...(list ?? []));
    return all;
  }

  /** Resolve a model selector from the live catalogue by substring — exactly one match required. */
  async resolveModel(runtime: string, match: string): Promise<string> {
    const entries = (await this.models(runtime)).filter((entry) =>
      typeof entry.selector === 'string' && (entry.selector as string).includes(match),
    );
    if (entries.length !== 1) {
      throw new Error(
        `pi-orch: --model-match '${match}' resolved ${entries.length} live selectors (need exactly one); inspect 'pi-orch models --runtime ${runtime}'`,
      );
    }
    return entries[0]?.selector as string;
  }

  async spawn(input: CreateInput & { templateFollowUp?: boolean; modelMatch?: string; routeLimit?: number; waitForSlotMs?: number }): Promise<{
    sessionId: string;
    leaseId?: string;
    parentId?: string;
    resolvedModel?: string;
    raw: unknown;
  }> {
    const modelSelector = input.modelSelector ?? (input.modelMatch ? await this.resolveModel(input.runtime, input.modelMatch) : undefined);
    const body = buildCreateBody({ ...input, modelSelector });
    // G1 correction 01 (accepted finding): caps apply only to spawns that
    // name --model-selector. Say so once per client when caps are configured
    // and this spawn carries no selector.
    if (!modelSelector && this.capsConfigured) {
      this.warnOnce('pi-orch: ROUTE_LIMIT_UNCOUNTED — this spawn names no --model-selector, so it is not counted against any per-route cap (caps apply only to spawns that name --model-selector)');
    }
    const gate = modelSelector ? await this.resolveRouteGate(input.runtime, modelSelector, input.routeLimit) : undefined;
    const owner = input.retention?.ownerId;
    // The create itself, so the gate can hold the route lock ACROSS the
    // count and the create POST (correction 01 item 1: two concurrent spawns
    // at the cap must not both create).
    const runCreate = async (recordLedger: boolean): Promise<{
      raw: Record<string, unknown>;
      retention: { leaseId?: string } | undefined;
      sessionId: string;
    }> => {
      let response: Awaited<ReturnType<Transport['request']>>;
      try {
        response = await this.transport.request('POST', '/api/v1/sessions', { body, headers: this.headers() });
      } catch (error) {
        // Correction 04 item 3: POST /sessions has no server idempotency, so a
        // lost connection/response is NEVER retried — the server may have created
        // the session. Surface an explicit unknown outcome with a reconcile hint.
        if (error instanceof TransportError) {
          throw new ApiError(0, 'CREATE_UNKNOWN', `create outcome unknown: ${error.message}`, {
            details: JSON.stringify({
              outcome: 'unknown',
              hint: `do NOT blindly re-spawn. Reconcile first: pi-orch status --parent <your sessionId> (children carry your ownerId${input.retention?.label ? ` / label '${input.retention.label}'` : ''}); delete an orphaned child if you find one, then re-spawn`,
            }),
          });
        }
        throw error;
      }
      const raw = response.body as Record<string, unknown>;
      const retention = raw.retention as { leaseId?: string } | undefined;
      const sessionId = String(raw.sessionId);
      // G1: bare-CLI bookkeeping — the spawn ledger is how a caller with no
      // session identity counts its own children by retention owner later.
      // Written when the caller has no identity, or when counting ran in the
      // OWNER scope (correction 03 item 2: a stale parent that falls back to
      // the owner ledger must also record there, or the cap never sees the
      // new child). With a healthy identity, ?parent= counting is
      // server-authoritative and the ledger would be a second, weaker copy.
      // W2c: an owner-tagged child is ALWAYS recorded — `status --owner` and
      // `cleanup --owner` find children only through this ledger, and a parent
      // that carries a session identity (PI_ORCH_PARENT_SESSION) used to skip
      // the write, leaving its owner with 0 listed children (R1 card test).
      if (recordLedger || input.retention?.ownerId !== undefined) {
        const recorded = this.spawnLedger.record({
          sessionId,
          route: modelSelector,
          ownerId: input.retention?.ownerId,
          ...(retention?.leaseId !== undefined ? { leaseId: retention.leaseId } : {}),
          at: new Date().toISOString(),
        });
        if (recorded.note) this.warnOnce(`pi-orch: ${recorded.note}`);
      }
      return { raw, retention, sessionId };
    };
    // G1: per-route concurrency gate — refuse BEFORE creating anything when
    // this caller already has the limit's worth of LIVE children on the
    // route, or wait for a slot when --wait-for-slot asks for that. The
    // count→create span is serialised across processes with an exclusive
    // route lock (correction 01 item 1); the lock is held only across the
    // count and the create POST — a --wait-for-slot wait happens OUTSIDE it.
    const created = gate !== undefined && modelSelector
      ? await this.spawnUnderRouteGate(modelSelector, owner, gate, input.waitForSlotMs, runCreate)
      : await runCreate(!this.parentSessionId);
    const { raw, retention, sessionId } = created;
    // C3b: an OPT-IN (templateFollowUp, W2-g) templated GOAL child gets the verbatim instruction paragraph as a
    // queued follow_up (the server keeps objectives single-line, so the
    // objective carries only the flattened pointer). follow_up queues on the
    // busy arm turn and delivers after it — the C3a live-proven sequencing.
    let templateFollowUpRunId: string | undefined;
    if (input.goal && input.completionTemplate !== false && input.templateFollowUp === true) {
      const delivery = await this.deliverGoalTemplate(sessionId, input.goal.objective, raw);
      templateFollowUpRunId = delivery;
    }
    return {
      sessionId,
      leaseId: retention?.leaseId,
      parentId: typeof raw.parentSessionId === 'string' ? raw.parentSessionId : undefined,
      resolvedModel: typeof raw.resolvedModel === 'string' ? raw.resolvedModel : undefined,
      ...(templateFollowUpRunId !== undefined ? { templateFollowUpRunId } : {}),
      raw,
    };
  }

  /**
   * G1 correction 01 item 1: the gated create. Every count→create span runs
   * under the exclusive per-(caller, route) route lock, so two concurrent
   * spawns at the cap cannot both create. A --wait-for-slot wait happens
   * OUTSIDE the lock (the lock is held only across the count and the create
   * POST); after each wait the next attempt re-counts under a fresh lock.
   */
  private async spawnUnderRouteGate(
    route: string,
    owner: string | undefined,
    gate: RouteGate,
    waitForSlotMs: number | undefined,
    create: (recordLedger: boolean) => Promise<{ raw: Record<string, unknown>; retention: { leaseId?: string } | undefined; sessionId: string }>,
  ): Promise<{ raw: Record<string, unknown>; retention: { leaseId?: string } | undefined; sessionId: string }> {
    // Correction 03 item 2: lock in the EFFECTIVE counting scope — the owner
    // ledger once the parent identity is known stale (or absent), the parent
    // identity otherwise.
    const useOwnerScope = owner !== undefined && (!this.parentSessionId || this.staleParentIds.has(this.parentSessionId));
    const key = `${useOwnerScope ? `owner:${owner}` : this.parentSessionId ?? 'no-identity'}|${route}`;
    const deadline = waitForSlotMs !== undefined ? Date.now() + waitForSlotMs : undefined;
    for (;;) {
      const outcome = await withRouteLock({ dir: this.spawnLockDir, key, timeoutMs: this.routeLockTimeoutMs, staleMs: this.routeLockStaleMs }, async (): Promise<{ action: 'wait'; limit: number; live: Array<{ sessionId: string; reason: string }> } | { action: 'create'; response: { raw: Record<string, unknown>; retention: { leaseId?: string } | undefined; sessionId: string } }> => {
        const counted = await this.countedForGate(route, owner, gate);
        const refusal = this.gateRefusal(gate, counted);
        if (refusal) return { action: 'wait', limit: refusal.limit, live: refusal.live };
        // Record in the ledger whenever the owner ledger is the effective
        // counting domain (bare CLI, or a stale parent falling back to it).
        return { action: 'create', response: await create(counted.countedBy === 'owner') };
      });
      if (outcome.action === 'create') return outcome.response;
      // W0d correction 01: an advertised profile cap is a SERVER-wide
      // condition — the turns holding it may belong to another parent — so no
      // local watch reliably signals a free slot. --wait-for-slot refuses at
      // once instead of promising a wait it cannot honour (documented); an
      // explicit local limit keeps the watch-based wait.
      if (gate.kind === 'profile_active' || waitForSlotMs === undefined) {
        throw new RouteLimitError(route, outcome.limit, outcome.live, gate.profile);
      }
      const remaining = (deadline as number) - Date.now();
      if (remaining <= 0) throw new RouteLimitWaitDeadlineError(route, outcome.limit, waitForSlotMs);
      await this.waitForRouteSlotOnce(route, outcome.limit, outcome.live, remaining, gate.profile);
      // loop: re-count under a fresh lock
    }
  }

  /**
   * W2c verb 3: `mode: 'deliver'` is one atomic choice. A child with a live
   * turn on a runtime that can steer is STEERED (requireActiveTurn, so a turn
   * that ended in between is refused rather than silently queued); anything
   * else — idle child, runtime without steer — gets follow_up. The choice and
   * its reason ride back on `deliver`; the server's own dispatchMode and queue
   * depth are reported as-is.
   */
  private async chooseDelivery(sessionId: string): Promise<DeliveryChoice> {
    const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
    const detail = (response.body ?? {}) as { runtime?: string; busy?: boolean; status?: string };
    const busy = detail.busy === true || (detail.busy === undefined && detail.status === 'running');
    if (!busy) return { chosen: 'follow_up', busy: false, reason: 'child is idle: follow_up starts its next turn' };
    let canSteer = false;
    try {
      const capabilities = (await this.transport.request('GET', '/api/v1/capabilities', { headers: this.headers() })).body as { runtimes?: Record<string, { supportsSteer?: boolean; supportsSteerWhileBusy?: boolean }> };
      const runtime = detail.runtime !== undefined ? capabilities.runtimes?.[detail.runtime] : undefined;
      canSteer = runtime?.supportsSteer === true && runtime.supportsSteerWhileBusy !== false;
    } catch {
      canSteer = false; // capabilities unreadable: queue rather than guess
    }
    return canSteer
      ? { chosen: 'steer', busy: true, reason: 'child has a live turn and its runtime supports steer' }
      : { chosen: 'follow_up', busy: true, reason: 'child has a live turn but its runtime cannot steer one (or capabilities were unreadable): queued as follow_up' };
  }

  async prompt(sessionId: string, rawInput: Omit<PromptInput, 'mode'> & { mode?: PromptInput['mode'] | 'deliver'; followUpOnBusy?: boolean; routeLimit?: number; routeOwner?: string }): Promise<{
    runId: string;
    sessionId: string;
    detached: boolean;
    duplicate: boolean;
    dispatchMode?: string;
    queueDepth?: number;
    deliver?: DeliveryChoice;
    raw: unknown;
  }> {
    let deliver: DeliveryChoice | undefined;
    let input = rawInput as PromptInput & { followUpOnBusy?: boolean; routeLimit?: number; routeOwner?: string };
    if (rawInput.mode === 'deliver') {
      deliver = await this.chooseDelivery(sessionId);
      input = { ...rawInput, mode: deliver.chosen, ...(deliver.chosen === 'steer' ? { requireActiveTurn: true } : {}) };
    }
    // G1: a prompt that would START a new turn on an IDLE child of a limited
    // route adds one concurrent generation to that route — it is gated like a
    // spawn. A prompt to a LIVE child is never gated: follow_up queues after
    // the current turn and a plain prompt to a busy child is refused by the
    // server (409), so it cannot raise route concurrency. steer never starts
    // a turn. Decided and recorded in the G1 evidence bundle.
    if (input.mode !== 'steer') {
      await this.gatePromptStart(sessionId, input.routeLimit, input.routeOwner);
    }
    const body = buildPromptBody(input, this.randomId);
    const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`;
    let response: Awaited<ReturnType<Transport['request']>>;
    try {
      response = await this.transport.request('POST', path, { body, headers: this.headers(), _idempotent: true });
    } catch (error) {
      // Live-found race: a create-time goal arms a detached goal-start turn, so
      // the first prompt to a fresh goal-armed child can hit 409 SESSION_BUSY.
      // followUpOnBusy retries ONCE in follow_up mode (queues on a busy Pi
      // session, delivers after the current turn). Exactly one retry; other
      // 409 codes propagate.
      const apiError = error as ApiError;
      const busyRefusal = apiError instanceof ApiError && apiError.status === 409 && apiError.code === 'SESSION_BUSY';
      // W2c deliver: the steer was refused 409 (the turn ended between the
      // read and the send) — fall back ONCE to follow_up, which starts the
      // next turn on an idle child. Any other failure propagates.
      const steerRefusal = deliver?.chosen === 'steer' && apiError instanceof ApiError && apiError.status === 409;
      if (steerRefusal) {
        const { requireActiveTurn: _dropped, ...rest } = body;
        void _dropped;
        deliver = { chosen: 'follow_up', busy: false, reason: `steer refused (${apiError.code}) — the live turn ended; fell back to follow_up` };
        response = await this.transport.request('POST', path, { body: { ...rest, mode: 'follow_up' }, headers: this.headers(), _idempotent: true });
      } else {
        if (!(input.followUpOnBusy === true && busyRefusal)) throw error;
        response = await this.transport.request('POST', path, {
          body: { ...body, mode: 'follow_up' },
          headers: this.headers(),
          _idempotent: true,
        });
      }
    }
    const raw = response.body as Record<string, unknown>;
    const duplicate = raw.duplicate === true;
    const runId = String(raw.runId ?? (raw.receipt as Record<string, unknown> | undefined)?.runId ?? '');
    if (!runId) throw new Error('pi-orch: prompt response without runId');
    return {
      runId,
      sessionId: String(raw.sessionId ?? sessionId),
      detached: raw.detached === true,
      duplicate,
      dispatchMode: typeof raw.dispatchMode === 'string' ? raw.dispatchMode : undefined,
      ...(queueDepthOf(raw) !== undefined ? { queueDepth: queueDepthOf(raw) } : {}),
      ...(deliver !== undefined ? { deliver } : {}),
      raw,
    };
  }

  /**
   * C3b: deliver the goal-template follow-up and verify it actually ran. A
   * follow_up queued behind the arm turn can still be refused at delivery
   * (live: RUNTIME_ERROR, 'Agent is already processing a prompt' — the C3a
   * round-2 shape), so after a bounded settle the run's receipt is read ONCE;
   * a failed/terminal-bad delivery is retried exactly once after a further
   * settle. Named, never silent: attempts and failures ride on `raw`.
   */
  private async deliverGoalTemplate(sessionId: string, objective: string, raw: Record<string, unknown>): Promise<string | undefined> {
    const send = async (suffix: string): Promise<{ runId: string } | { error: string }> => {
      try {
        // I5: the goal follow-up carries the verbatim paragraph PLUS the marker
        // instruction (write Status: GOAL_ACHIEVED / Status: CONTINUING on its
        // own line immediately before the report block) and every optional
        // field's exact shape (GOAL_REPORT_INSTRUCTION) — see the module docs
        // in completion-template.ts.
        const followUp = await this.prompt(sessionId, {
          message: `Report instructions for your active goal (${objective}):\n\n${GOAL_REPORT_INSTRUCTION}\n\nIf your goal is already complete, reply now: first the status line (Status: GOAL_ACHIEVED), then the report block. Otherwise keep working toward the goal and end your FINAL answer with the status line immediately before the report block.`,
          mode: 'follow_up',
          idempotencyKey: `${this.randomId()}-tpl${suffix}`,
        });
        return { runId: followUp.runId };
      } catch (error) {
        return { error: (error as Error).message };
      }
    };
    const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
    const first = await send('');
    if ('error' in first) {
      (raw as Record<string, unknown>).__templateFollowUpError = first.error;
      return undefined;
    }
    const firstRunId = first.runId;
    await sleep(this.templateFollowUpCheckDelayMs);
    let health: 'unknown' | 'ok' | 'failed' = 'unknown';
    try {
      const response = await this.transport.request('GET', `/api/v1/runs/${encodeURIComponent(firstRunId)}`, { headers: this.headers() });
      const receipt = response.body as { status?: string; startedAt?: string };
      // I1 (H2 item 2): the follow-up sits `queued` (or `accepted`) while the
      // arm turn is busy — that is HEALTHY, not failed. Correction 01: a
      // startedAt on a cancelled/interrupted receipt proves delivery (the
      // message_start was observed before the restart/cancel) — re-sending a
      // delivered template duplicates it. See templateReceiptWantsRetry.
      health = templateReceiptWantsRetry(receipt.status, receipt.startedAt) ? 'failed' : 'ok';
    } catch {
      health = 'unknown'; // unreadable receipt: report the runId, no retry theatre
    }
    if (health !== 'failed') return firstRunId;
    (raw as Record<string, unknown>).__templateFollowUpFirstRunId = firstRunId;
    await sleep(this.templateFollowUpCheckDelayMs);
    const retry = await send('-retry');
    (raw as Record<string, unknown>).__templateFollowUpRetried = true;
    if ('error' in retry) {
      (raw as Record<string, unknown>).__templateFollowUpError = retry.error;
      return firstRunId;
    }
    return retry.runId;
  }

  /** G1: the prompt-side half of the per-route gate (see prompt). */
  private async gatePromptStart(sessionId: string, perCall: number | undefined, routeOwner: string | undefined): Promise<void> {
    let detail: Record<string, unknown>;
    try {
      const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
      detail = response.body as Record<string, unknown>;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return; // unknown child: let the POST answer
      throw error;
    }
    if (typeof detail !== 'object' || detail === null) return; // unreadable detail: let the POST answer
    const route = routeOfSession(detail as { modelSelector?: string; model?: string });
    const runtime = typeof (detail as { runtime?: unknown }).runtime === 'string' ? (detail as { runtime: string }).runtime : undefined;
    const gate = await this.resolveRouteGate(runtime, route, perCall);
    if (gate === undefined) return;
    const [goal, evidence] = await Promise.all([this.goalStatusOf(sessionId), this.lastRunStatusOf(sessionId)]);
    if (liveReason({ busy: detail.busy === true, goalStatus: goal.value, lastRunStatus: evidence.value })) return; // live: no new concurrency
    // Correction 03 item 3: unknown target liveness must FAIL CLOSED — the
    // target may be idle, and the prompt would start a new turn over the
    // cap. Count the siblings and gate normally (an actually-live target is
    // already in the route count; prompting it adds no new generation).
    // Correction 01 item 4: a bare-CLI caller counts the TARGET's owner (from
    // the local spawn ledger), or an explicitly passed routeOwner (--owner on
    // the CLI), so an idle child cannot start a new turn past its owner's cap.
    const owner = routeOwner ?? this.spawnLedger.ownerOf(sessionId);
    const counted = await this.countedForGate(route as string, owner, gate);
    const refusal = this.gateRefusal(gate, counted);
    if (!refusal) return;
    throw new RouteLimitError(route as string, refusal.limit, refusal.live, gate.profile);
  }

  /**
   * J2 P2: arm a goal on an ALREADY-CREATED session — the H-b parent
   * pattern's create-then-goal order (POST /sessions/:id/goal, action start).
   * The Phase A replay had no way to do this from pi-orch (`pi-orch goal` was
   * an unknown verb). Start-only: pause/resume/clear stay interactive.
   */
  async goalStart(sessionId: string, input: { objective: string; maxTurns?: number; verifyCommand?: string; budgetTokens?: number; completionTemplate?: boolean; templateFollowUp?: boolean }): Promise<Record<string, unknown>> {
    // 02-correction 1: the shared validator — the Luna probe sent
    // budgetTokens 1000000000000 because only the create path validated.
    validateGoalFields(input);
    // 02-correction 3: goal children started through the verb are the same
    // receipt-less class as create-time goal children — the objective carries
    // the flattened completion pointer and the verbatim paragraph rides as a
    // follow-up (delivered once, exit 22 when it is not), unless opted out.
    const templated = input.completionTemplate === false
      ? input.objective
      : applyGoalObjectiveTemplate(input.objective);
    if (templated.length > 4000) {
      throw new Error(`pi-orch: goal.objective with the completion template is ${templated.length} chars (server limit 4000); shorten the objective or pass completionTemplate: false / --no-completion-template`);
    }
    const body: Record<string, unknown> = { action: 'start', objective: templated };
    if (input.maxTurns !== undefined) body.maxTurns = input.maxTurns;
    if (input.verifyCommand !== undefined) body.verifyCommand = input.verifyCommand;
    if (input.budgetTokens !== undefined) body.budgetTokens = input.budgetTokens;
    const response = await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { body, headers: this.headers() });
    const raw = response.body as Record<string, unknown>;
    // The wire shape nests the projection and the arm receipt; surface the
    // fields a parent actually reads (accepted/applied, runId, goal status)
    // at the top level and keep the full projection under `goal`.
    const receipt = raw.receipt as { runId?: string } | undefined;
    const goal = raw.goal as Record<string, unknown> | undefined;
    const flattened: Record<string, unknown> = {
      ...raw,
      ...(receipt?.runId ? { runId: receipt.runId } : {}),
      ...(goal && typeof goal === 'object' ? { status: goal.status, objective: goal.objective, goal } : {}),
    };
    if (input.completionTemplate !== false && input.templateFollowUp === true) {
      const delivery = await this.deliverGoalTemplate(sessionId, input.objective, raw);
      if (delivery !== undefined) flattened.templateFollowUpRunId = delivery;
    }
    // raw by REFERENCE (not a spread): deliverGoalTemplate records the
    // delivery outcome (__templateFollowUpError) on it after this point.
    flattened.raw = raw;
    return flattened;
  }
  // ── W2c verb 1: goal pause / resume / show ───────────────────────────────

  private flattenGoal(raw: Record<string, unknown>): Record<string, unknown> {
    const goal = raw.goal as Record<string, unknown> | undefined;
    return { ...raw, ...(goal && typeof goal === 'object' ? { status: goal.status, objective: goal.objective, goal } : {}) };
  }

  /** `reason` is sent for forward compatibility; servers up to contract 1.62.0 ignore it. */
  async goalPause(sessionId: string, input: { reason?: string } = {}): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { action: 'pause' };
    if (input.reason !== undefined) body.reason = input.reason;
    const response = await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { body, headers: this.headers() });
    return this.flattenGoal(response.body as Record<string, unknown>);
  }

  /** `note` is sent for forward compatibility; servers up to contract 1.62.0 ignore it (the child does not see it). */
  async goalResume(sessionId: string, input: { note?: string } = {}): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { action: 'resume' };
    if (input.note !== undefined) body.note = input.note;
    const response = await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { body, headers: this.headers() });
    return this.flattenGoal(response.body as Record<string, unknown>);
  }

  async goalShow(sessionId: string): Promise<Record<string, unknown>> {
    const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { headers: this.headers() });
    return response.body as Record<string, unknown>;
  }

  /**
   * W2c verb 2: reroute a (possibly busy) goal child onto another model.
   * Lesson behind the order: `set_model` on a busy child blocks until it is
   * idle, so the goal is paused FIRST (it will not re-arm a turn), the live
   * turn is aborted, the model/thinking are switched, and the goal resumes
   * with the SAME objective (re-read to prove it). A session with no active
   * goal gets the plain abort + switch with a note. Every step is reported;
   * the first failure stops the sequence, and a goal this call paused gets
   * ONE recovery resume so it is never left stuck paused.
   */
  async reroute(sessionId: string, input: { modelSelector: string; thinking?: string }): Promise<RerouteOutcome> {
    const steps: RerouteStep[] = [];
    const id = encodeURIComponent(sessionId);
    const fail = (step: string, detail: string): RerouteStep => {
      const entry = { step, ok: false, detail };
      steps.push(entry);
      return entry;
    };
    const pass = (step: string, detail: string): void => { steps.push({ step, ok: true, detail }); };
    const describe = (error: unknown): string => {
      const e = error as { code?: string; message?: string };
      return [e.code, e.message].filter((part, index, all) => part && all.indexOf(part) === index).join(': ') || String(error);
    };

    let goal: { status?: string; objective?: string } | undefined;
    try {
      goal = await this.goalShow(sessionId) as { status?: string; objective?: string };
      pass('read_goal', `goal status ${goal.status ?? 'unknown'}`);
    } catch (error) {
      pass('read_goal', `no readable goal (${describe(error)}) — treated as no goal`);
    }
    const hadGoal = goal !== undefined && ['running', 'paused', 'wrapping_up'].includes(goal.status ?? '') && typeof goal.objective === 'string' && goal.objective !== '';
    const objective = hadGoal ? goal?.objective : undefined;
    const outcome = (extra: Partial<RerouteOutcome>): RerouteOutcome => ({
      ok: !steps.some((step) => !step.ok),
      sessionId,
      hadGoal,
      steps,
      ...(objective !== undefined ? { objective } : {}),
      ...extra,
    });

    let paused = false;
    if (hadGoal) {
      if (goal?.status === 'paused') {
        pass('pause_goal', 'goal was already paused');
        paused = true;
      } else {
        try {
          await this.goalPause(sessionId, { reason: `reroute to ${input.modelSelector}` });
          pass('pause_goal', 'goal paused');
          paused = true;
        } catch (error) {
          fail('pause_goal', describe(error));
          return outcome({ ok: false, failedStep: 'pause_goal' });
        }
      }
    }
    const recover = async (failedStep: string): Promise<RerouteOutcome> => {
      if (paused) {
        try {
          await this.goalResume(sessionId, { note: `Reroute to ${input.modelSelector} failed at ${failedStep}; resuming the same objective on the current model.` });
          pass('resume_goal', `recovery resume after ${failedStep} failed — goal running again on the previous model`);
        } catch (error) {
          fail('resume_goal', `recovery resume failed (${describe(error)}) — the goal is left PAUSED, resume it by hand`);
        }
      }
      return outcome({ ok: false, failedStep });
    };

    try {
      await this.transport.request('POST', `/api/v1/sessions/${id}/abort`, { body: {}, headers: this.headers() });
      pass('abort', 'live turn aborted');
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        pass('abort', `nothing to abort (${(error as { code?: string }).code ?? 'session not streaming'})`);
      } else {
        fail('abort', describe(error));
        return recover('abort');
      }
    }
    try {
      await this.transport.request('POST', `/api/v1/sessions/${id}/control`, { body: { action: 'set_model', modelId: input.modelSelector }, headers: this.headers() });
      pass('set_model', `model set to ${input.modelSelector}`);
    } catch (error) {
      fail('set_model', describe(error));
      return recover('set_model');
    }
    if (input.thinking !== undefined) {
      try {
        await this.transport.request('POST', `/api/v1/sessions/${id}/control`, { body: { action: 'set_thinking_level', level: input.thinking }, headers: this.headers() });
        pass('set_thinking_level', `thinking level set to ${input.thinking}`);
      } catch (error) {
        fail('set_thinking_level', describe(error));
        return recover('set_thinking_level');
      }
    }
    if (!hadGoal) {
      return outcome({ note: 'session has no goal: did a plain abort + model switch (nothing to pause or resume)' });
    }
    try {
      await this.goalResume(sessionId, { note: `Rerouted to ${input.modelSelector}${input.thinking ? ` (thinking ${input.thinking})` : ''}; continue the same objective.` });
      pass('resume_goal', 'goal resumed');
    } catch (error) {
      fail('resume_goal', describe(error));
      return outcome({ ok: false, failedStep: 'resume_goal' });
    }
    try {
      const after = await this.goalShow(sessionId) as { status?: string; objective?: string };
      const intact = after.objective === objective;
      const running = after.status !== 'paused';
      if (intact && running) {
        pass('verify_goal', `goal ${after.status ?? 'unknown'} with the same objective`);
        return outcome({ objectiveIntact: true });
      }
      fail('verify_goal', intact ? `goal still ${after.status} after resume` : 'the goal objective changed across the reroute');
      return outcome({ ok: false, failedStep: 'verify_goal', objectiveIntact: intact });
    } catch (error) {
      fail('verify_goal', `could not re-read the goal: ${describe(error)}`);
      return outcome({ ok: false, failedStep: 'verify_goal' });
    }
  }

  async registerWatch(sessionId: string, input: { conditions: WatchConditionSpec[]; label?: string; fireIfSettled?: boolean; pin?: boolean }): Promise<{ watchId: string; status?: string; generation?: string; raw: unknown }> {
    const body = buildWatchBody(input);
    const response = await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
      body,
      headers: this.headers(),
    });
    const raw = response.body as Record<string, unknown>;
    return {
      watchId: String(raw.watchId),
      status: typeof raw.status === 'string' ? raw.status : undefined,
      // 02-correction 2: the CAS generation a later conditional delete needs.
      generation: typeof raw.generation === 'string' ? raw.generation : undefined,
      raw,
    };
  }

  async getWatch(sessionId: string): Promise<{ watchId: string; status?: string; conditions?: Array<{ id?: string; spec?: Record<string, unknown> }>; label?: string; generation?: string; firingCount?: number; allFired?: boolean; firings?: Array<Record<string, unknown>> } | null> {
    try {
      const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
        headers: this.headers(),
      });
      const raw = response.body as Record<string, unknown>;
      return {
        watchId: String(raw.watchId),
        status: typeof raw.status === 'string' ? raw.status : undefined,
        label: typeof raw.label === 'string' ? raw.label : undefined,
        // 02-correction 2: the CAS generation a later conditional delete needs.
        generation: typeof raw.generation === 'string' ? raw.generation : undefined,
        // J2 P4: the wake surface — a bare-CLI parent reads the firing back
        // with `watch list` instead of hand-writing curl against the socket.
        firingCount: typeof raw.firingCount === 'number' ? raw.firingCount : undefined,
        allFired: raw.allFired === true,
        firings: Array.isArray(raw.firings) ? (raw.firings as Array<Record<string, unknown>>) : undefined,
        conditions: Array.isArray(raw.conditions)
          ? (raw.conditions as Array<Record<string, unknown>>).map((condition) => ({
              id: typeof condition.id === 'string' ? condition.id : undefined,
              spec: (condition.spec ?? condition) as Record<string, unknown>,
            }))
          : undefined,
      };
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  /**
   * 02-correction 2: generation-safe delete. The server's DELETE accepts
   * `{expectedGeneration}` (contract 1.35.0 CAS): a stale generation returns
   * 409 WATCH_GENERATION_MISMATCH and leaves the watch (and its ledger,
   * subscriptions and pin claims) unchanged — this client surfaces that as
   * {@link WatchGenerationMismatchError} with BOTH generations named, never
   * an unconditional delete.
   */
  async deleteWatch(sessionId: string, options: { expectedGeneration?: string } = {}): Promise<{ success?: boolean; watchId?: string; generation?: string }> {
    try {
      const response = await this.transport.request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
        ...(options.expectedGeneration !== undefined ? { body: { expectedGeneration: options.expectedGeneration } } : {}),
        headers: this.headers(),
      });
      const raw = response.body as Record<string, unknown>;
      // 04-correction A2: validate the acknowledgement before reporting
      // success — success:true, a watchId, and (when a precondition was sent)
      // the exact generation the server acked (docs/INTERNAL-API.md:
      // "require the exact generation before reporting confirmed cleanup").
      const problems: string[] = [];
      if (raw.success !== true) problems.push(`success is ${JSON.stringify(raw.success)}, expected true`);
      if (typeof raw.watchId !== 'string' || raw.watchId.length === 0) problems.push('watchId missing from the acknowledgement');
      if (options.expectedGeneration !== undefined && raw.generation !== options.expectedGeneration) {
        problems.push(`generation is ${JSON.stringify(raw.generation)}, expected ${options.expectedGeneration}`);
      }
      if (problems.length > 0) throw new WatchDeleteAcknowledgementError(problems.join('; '), raw);
      return {
        success: true,
        watchId: typeof raw.watchId === 'string' ? raw.watchId : undefined,
        generation: typeof raw.generation === 'string' ? raw.generation : undefined,
      };
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError instanceof ApiError && apiError.status === 409 && apiError.code === 'WATCH_GENERATION_MISMATCH') {
        const data = (apiError.data ?? {}) as { expectedGeneration?: unknown; currentGeneration?: unknown; watchId?: unknown };
        throw new WatchGenerationMismatchError(
          typeof data.expectedGeneration === 'string' ? data.expectedGeneration : options.expectedGeneration,
          typeof data.currentGeneration === 'string' ? data.currentGeneration : undefined,
          typeof data.watchId === 'string' ? data.watchId : undefined,
        );
      }
      throw error;
    }
  }

  /**
   * 04-correction A3: the guarded delete every INTERNAL caller uses — the
   * generation is read fresh and sent as the CAS precondition; a missing
   * watch, a missing generation, or a replaced watch is skipped (disclosed),
   * NEVER deleted unconditionally.
   */
  private async deleteOwnWatchConditionally(sessionId: string): Promise<{ deleted: boolean; note?: string }> {
    const watch = await this.getWatch(sessionId).catch(() => null);
    if (!watch) return { deleted: false, note: 'no watch registered (nothing to delete)' };
    if (watch.generation === undefined) return { deleted: false, note: 'watch delete skipped: the read returned no generation (fail-closed, 04-correction A)' };
    try {
      const ack = await this.deleteWatch(sessionId, { expectedGeneration: watch.generation });
      return { deleted: true, note: `watch ${ack.watchId ?? ''} deleted (generation ${ack.generation ?? 'unknown'})`.trim() };
    } catch (error) {
      const mismatch = error as { code?: string };
      if (mismatch.code === 'WATCH_GENERATION_MISMATCH') {
        return { deleted: false, note: 'watch delete skipped: the watch was replaced since it was read — the replacement is not ours to delete' };
      }
      throw error;
    }
  }

  /** Watch-based wait: registers the watch, long-polls, reconciles the receipt. Never polls. */
  async wait(options: {
    sessionId: string;
    runId?: string;
    conditions?: WatchConditionSpec[];
    objective?: string;
    deadlineMs?: number;
    label?: string;
  }): Promise<WaitOutcome> {
    // C3b correction 01 item 1: do NOT pre-fill default conditions here.
    // waitOnChild detects an active goal when neither conditions nor objective
    // were supplied and applies the right defaults AFTER detection; an early
    // defaultConditions() call here would bake in per-turn agent_end and
    // bypass the detection entirely.
    const deps = this.waitDeps();
    return waitOnChild({
      sessionId: options.sessionId,
      runId: options.runId,
      conditions: options.conditions,
      objective: options.objective,
      deadlineMs: options.deadlineMs ?? this.waitDeadlineMs,
      sliceMs: this.waitSliceMs,
      label: options.label,
      deps,
    });
  }

  /**
   * Wait on SEVERAL children in one call (correction 01 item 3): `all` settles
   * every child, `any` returns with the first to settle. One long-poll request
   * covers all watches; fast-fail preflight per child.
   */
  async waitMany(options: {
    mode: 'all' | 'any';
    children: WaitChild[];
    objective?: string;
    deadlineMs?: number;
    label?: string;
  }): Promise<WaitOnChildrenResult> {
    return waitOnChildren({
      mode: options.mode,
      children: options.children,
      objective: options.objective,
      deadlineMs: options.deadlineMs ?? this.waitDeadlineMs,
      sliceMs: this.waitSliceMs,
      label: options.label,
      deps: this.waitDeps(),
    });
  }

  private waitDeps(): WaitDeps {
    return {
      longPoll: async ({ ids, cursor, timeoutMs }) => {
        const params = new URLSearchParams({ ids: ids.join(','), timeout: String(timeoutMs) });
        if (cursor !== undefined) params.set('cursor', cursor);
        try {
          const response = await this.transport.request('GET', `/api/v1/watches/wait?${params.toString()}`, {
            headers: this.headers(),
            timeoutMs: timeoutMs + 15_000,
          });
          if (response.status === 204 || response.body === undefined) return { kind: 'timeout' };
          return { kind: 'fired', body: response.body };
        } catch (error) {
          if ((error as { status?: number }).status === 404) throw error; // watch loss → recovery path
          throw error;
        }
      },
      getReceipt: async (runId) => {
        const response = await this.transport.request('GET', `/api/v1/runs/${encodeURIComponent(runId)}`, { headers: this.headers() });
        return parseReceipt(response.body);
      },
      getSessionEvidence: async (sessionId) => {
        const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/evidence`, {
          headers: this.headers(),
        });
        const body = response.body as { runChronology?: Array<{ runId?: string; status?: string; errorCode?: string }> };
        return { runs: body.runChronology ?? [] };
      },
      getSession: async (sessionId) => {
        try {
          const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
          const body = response.body as { sessionId?: string };
          return { sessionId: String(body.sessionId ?? sessionId) };
        } catch (error) {
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        }
      },
      getGoal: async (sessionId) => {
        const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { headers: this.headers() });
        const body = response.body as { status?: string; objective?: string; pausedReason?: string | null; lastReason?: string | null; interruption?: GoalInterruptionFacts };
        return {
          status: body.status,
          objective: body.objective,
          pausedReason: body.pausedReason,
          lastReason: body.lastReason,
          ...(body.interruption ? { interruption: body.interruption } : {}),
        };
      },
      registerWatch: async (sessionId_, body) => {
        const registered = await this.registerWatch(sessionId_, body as { conditions: WatchConditionSpec[]; label?: string; fireIfSettled?: boolean });
        return { watchId: registered.watchId, status: registered.status };
      },
      getWatch: async (sessionId_) => this.getWatch(sessionId_),
      sleep: (ms) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)),
      now: Date.now,
    };
  }

  async result(runId: string, options: { includeTranscript?: boolean; final?: boolean } = {}): Promise<{
    runId: string;
    sessionId: string;
    status: string;
    /** I1 (H2 item 1): command | final_text | no_text — from the receipt's own evidence. */
    outputClass: 'command' | 'final_text' | 'no_text';
    outputClassBasis?: string;
    finalText?: string;
    finalTextTruncated?: boolean;
    servedModel?: string;
    outputDisposition?: string;
    completion?: CompletionBlock;
    completionError?: CompletionParseError;
    completionDelimiter?: CompletionDelimiter;
    completionSource?: 'receipt' | 'session_surface';
    completionCapturedAt?: string;
    completionCapturedBy?: CompletionCaptureSource;
    evidence: { receipt: string; transcript: string; sessionPath?: string; completion?: string };
    transcript?: Array<{ kind: string; text: string }>;
    final?: FinalResult;
  }> {
    const response = await this.transport.request('GET', `/api/v1/runs/${encodeURIComponent(runId)}`, { headers: this.headers() });
    const receipt = parseReceipt(response.body) as Receipt & ReceiptWithCompletion;
    const sessionId = receipt.sessionId;
    // C3b item 2: resolve the completion block — receipt first, the session's
    // latestCompletion for the receipt-less goal-turn class. One extra session
    // read ONLY when the receipt captured nothing at all.
    let sessionDetail: SessionDetailWithCompletion | undefined;
    if (!receipt.completion && !receipt.completionError) {
      try {
        const detailResponse = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
        sessionDetail = detailResponse.body as SessionDetailWithCompletion;
      } catch {
        sessionDetail = undefined; // best effort: the receipt result stands alone
      }
    }
    const resolved = resolveCompletion(receipt, sessionDetail);
    const evidence: { receipt: string; transcript: string; sessionPath?: string; completion?: string } = {
      receipt: `/api/v1/runs/${encodeURIComponent(runId)}`,
      transcript: `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?scope=visible_full`,
      ...(resolved?.source === 'session_surface' ? { completion: `/api/v1/sessions/${encodeURIComponent(sessionId)}` } : resolved ? { completion: `/api/v1/runs/${encodeURIComponent(runId)}` } : {}),
    };
    let transcript: Array<{ kind: string; text: string }> | undefined;
    if (options.includeTranscript || (options.final === true && !hasText(receipt.finalText) && resolved?.completion === undefined)) {
      try {
        const transcriptResponse = await this.transport.request(
          'GET',
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?scope=visible_full`,
          { headers: this.headers(), timeoutMs: 60_000 },
        );
        const body = transcriptResponse.body as { items?: Array<{ kind: string; text: string }> };
        transcript = body.items ?? [];
      } catch (error) {
        // An explicitly requested transcript keeps failing loudly; the
        // --final lookup is best effort and degrades to source 'none'.
        if (options.includeTranscript) throw error;
      }
    }
    // W2c verb 5: --final is the answer a parent wants — the parsed completion
    // block, else the receipt's final text, else the last substantive
    // ASSISTANT text in the transcript; never a blank tool-call tail.
    let final: FinalResult | undefined;
    if (options.final === true) {
      if (resolved?.completion !== undefined) {
        final = { source: 'completion', completion: resolved.completion, ...(hasText(receipt.finalText) ? { text: receipt.finalText } : {}) };
      } else if (hasText(receipt.finalText)) {
        final = { source: 'receipt', text: receipt.finalText };
      } else {
        const lastAssistant = [...(transcript ?? [])].reverse().find((item) => item.kind === 'assistant' && hasText(item.text));
        final = lastAssistant
          ? { source: 'transcript', text: lastAssistant.text }
          : { source: 'none', note: 'no substantive assistant text on the receipt or in the visible transcript — read the transcript evidence' };
      }
    }
    return {
      runId: receipt.runId,
      sessionId,
      status: receipt.status,
      ...spreadOutputClass(classifyRunOutput(receipt)),
      finalText: receipt.finalText,
      finalTextTruncated: receipt.finalTextTruncated,
      servedModel: receipt.servedModel,
      outputDisposition: receipt.outputEvidence?.disposition,
      ...(resolved?.completion !== undefined ? { completion: resolved.completion } : {}),
      ...(resolved?.error !== undefined ? { completionError: resolved.error } : {}),
      ...(resolved?.delimiter !== undefined ? { completionDelimiter: resolved.delimiter } : {}),
      ...(resolved !== undefined ? { completionSource: resolved.source } : {}),
      ...(resolved?.capturedAt !== undefined ? { completionCapturedAt: resolved.capturedAt } : {}),
      ...(resolved?.capturedBy !== undefined ? { completionCapturedBy: resolved.capturedBy } : {}),
      evidence,
      ...(options.includeTranscript && transcript !== undefined ? { transcript } : {}),
      ...(final !== undefined ? { final } : {}),
    };
  }

  /**
   * C3b item 3: re-check a child's completion claims against the filesystem.
   * Read-only (allow-listed git, no shell, no writes); the only command ever
   * executed is the parent-named `--rerun`. With --run-id the named receipt is
   * authoritative (session-surface fallback, same rule as result()); without
   * it the session's newest capture (latestCompletion) is checked.
   */
  async verify(input: VerifyInput): Promise<VerifyResult> {
    const deps = makeNodeVerifyDeps();
    // C3b correction 01 item 3: a named run must belong to the requested
    // session. A mismatched receipt is a caller mistake (typo, stale id) —
    // never cheque someone else's claims against this child's filesystem.
    // Mirrors wait's correction-04 fast-fail, but as an unverifiable verdict
    // (exit 21), not a wait outcome.
    let prefetched: (Receipt & ReceiptWithCompletion) | undefined;
    if (input.runId) {
      const response = await this.transport.request('GET', `/api/v1/runs/${encodeURIComponent(input.runId)}`, { headers: this.headers() });
      const receipt = parseReceipt(response.body) as Receipt & ReceiptWithCompletion;
      if (receipt.sessionId !== input.sessionId) {
        return {
          sessionId: input.sessionId,
          runId: input.runId,
          verdict: 'unverifiable',
          claims: [],
          summary: `unverifiable: receipt belongs to another session (run ${input.runId} belongs to ${receipt.sessionId}, not ${input.sessionId})`,
        };
      }
      prefetched = receipt;
    }
    const loadCompletion = async (verifyInput: VerifyInput): Promise<CompletionLoad> => {
      if (verifyInput.runId && prefetched) {
        if (prefetched.completion || prefetched.completionError) {
          const resolved = resolveCompletion(prefetched, undefined);
          return resolved ? { ...(resolved.completion !== undefined ? { block: resolved.completion } : {}), ...(resolved.error !== undefined ? { error: resolved.error } : {}), source: resolved.source } : {};
        }
      }
      const detailResponse = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(input.sessionId)}`, { headers: this.headers() });
      const resolvedSurface = resolveCompletion({ runId: verifyInput.runId ?? '', sessionId: input.sessionId } as ReceiptWithCompletion, detailResponse.body as SessionDetailWithCompletion);
      return resolvedSurface
        ? { ...(resolvedSurface.completion !== undefined ? { block: resolvedSurface.completion } : {}), ...(resolvedSurface.error !== undefined ? { error: resolvedSurface.error } : {}), source: resolvedSurface.source }
        : {};
    };
    // W2-g: gates run in the child's cwd — --cwd when given, else the session's own.
    let effective = input;
    if (input.gates !== undefined && input.cwd === undefined) {
      try {
        const detail = (await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(input.sessionId)}`, { headers: this.headers() })).body as { cwd?: unknown };
        if (typeof detail?.cwd === 'string' && detail.cwd.length > 0) effective = { ...input, cwd: detail.cwd };
      } catch {
        // unreadable detail: the gates report 'no cwd available' rather than guess
      }
    }
    return verifyChild(effective, deps, loadCompletion);
  }

  async cleanup(sessionId: string, options: { leaseId?: string; ownerId?: string; watchId?: string } = {}): Promise<{
    released: boolean;
    deleted: boolean;
    notes: string[];
  }> {
    const notes: string[] = [];
    let released = false;
    if (options.watchId !== undefined) {
      try {
        // 04-correction A3: conditional delete with the generation read here;
        // a replaced watch is skipped and disclosed, never deleted blindly.
        const outcome = await this.deleteOwnWatchConditionally(sessionId);
        notes.push(outcome.note ?? (outcome.deleted ? `watch ${options.watchId} deleted` : 'watch delete skipped'));
      } catch (error) {
        notes.push(`watch delete failed: ${(error as Error).message}`);
      }
    }
    // W2c: the spawn ledger stores the lease the spawn acquired, so a single
    // cleanup without --lease releases it too instead of leaving it to expire.
    const leaseId = options.leaseId ?? this.spawnLedger.leaseOf(sessionId);
    if (leaseId) {
      try {
        await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/control`, {
          body: { action: 'release_retention', retentionLeaseId: leaseId, ...(options.ownerId ? { ownerId: options.ownerId } : {}) },
          headers: this.headers(),
        });
        released = true;
      } catch (error) {
        notes.push(`lease release failed: ${(error as Error).message}`);
      }
    }
    await this.transport.request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
    this.spawnLedger.remove(sessionId);
    return { released, deleted: true, notes };
  }

  /**
   * W2c verb 6: clean up EVERY ledger child of one owner — and only that
   * owner's. Per child: cancel its watch first (generation-safe: the
   * generation is read and sent as the CAS precondition, a replaced watch is
   * skipped), release the stored lease (or, for an entry recorded before the
   * ledger kept leases, the leases the session detail reports), then delete.
   * A 404 anywhere means "already gone" and counts as cleaned. One child's
   * failure is reported and never stops the others; a child that could not be
   * deleted stays in the ledger so a re-run finds it again.
   */
  async cleanupOwner(ownerId: string): Promise<CleanupOwnerReport> {
    const children: CleanupOwnerChild[] = [];
    for (const entry of this.spawnLedger.entriesOf(ownerId)) {
      const sessionId = entry.sessionId;
      const id = encodeURIComponent(sessionId);
      const child: CleanupOwnerChild = { sessionId, watchDeleted: false, released: false, deleted: false, notes: [] };
      const fail = (message: string): void => { child.error ??= message; };
      const gone = (error: unknown): boolean => (error as { status?: number }).status === 404;
      try {
        const outcome = await this.deleteOwnWatchConditionally(sessionId);
        child.watchDeleted = outcome.deleted;
        if (outcome.note) child.notes.push(outcome.note);
      } catch (error) {
        child.notes.push(`watch delete failed: ${describeError(error)}`);
        fail(`watch: ${describeError(error)}`);
      }
      let leaseIds: string[] = entry.leaseId !== undefined ? [entry.leaseId] : [];
      if (leaseIds.length === 0) {
        try {
          const detail = (await this.transport.request('GET', `/api/v1/sessions/${id}`, { headers: this.headers() })).body as { retention?: { leases?: Array<{ leaseId?: string }> } };
          leaseIds = (detail.retention?.leases ?? []).map((lease) => lease.leaseId).filter((lease): lease is string => typeof lease === 'string');
          if (leaseIds.length === 0) child.notes.push('no lease recorded or reported (nothing to release)');
        } catch (error) {
          if (!gone(error)) { child.notes.push(`lease lookup failed: ${describeError(error)}`); fail(`lease lookup: ${describeError(error)}`); }
        }
      }
      let releasedAll = leaseIds.length > 0;
      for (const leaseId of leaseIds) {
        try {
          await this.transport.request('POST', `/api/v1/sessions/${id}/control`, {
            body: { action: 'release_retention', retentionLeaseId: leaseId, ownerId },
            headers: this.headers(),
          });
        } catch (error) {
          releasedAll = false;
          if (gone(error)) {
            child.notes.push(`lease ${leaseId}: session not found (already gone)`);
          } else {
            child.notes.push(`lease ${leaseId} release failed: ${describeError(error)}`);
            fail(`lease ${leaseId}: ${describeError(error)}`);
          }
        }
      }
      child.released = releasedAll;
      try {
        await this.transport.request('DELETE', `/api/v1/sessions/${id}`, { headers: this.headers() });
        child.deleted = true;
      } catch (error) {
        if (gone(error)) {
          child.deleted = true;
          child.notes.push('session not found (already gone)');
        } else {
          fail(`delete: ${describeError(error)}`);
        }
      }
      if (child.deleted) this.spawnLedger.remove(sessionId);
      children.push(child);
    }
    return { owner: ownerId, ok: children.every((child) => child.deleted && child.error === undefined), children };
  }

  async status(target: { parent?: string; sessionId?: string; owner?: string }): Promise<{
    parent?: string;
    owner?: string;
    pruned?: number;
    note?: string;
    children: Array<{
      sessionId: string;
      runtime?: string;
      busy?: boolean;
      status?: string;
      goalStatus?: string;
      goalObjective?: string;
      goalInterruption?: GoalInterruptionFacts;
      lastRun?: { runId?: string; status?: string; endedAt?: string | number; errorCode?: string };
      readErrors?: string[];
      missing?: boolean;
    }>;
  }> {
    if (target.sessionId) {
      return { children: [await this.childStatus(target.sessionId)] };
    }
    // J2 P5: the external-parent lineage. A Claude Code parent is not a Pi
    // Web UI session, so ?parent= cannot find its children — the only record
    // is the retention ownerId the spawn carried, which the local spawn
    // ledger noted at spawn time (G1). Per-host, best-effort: children
    // spawned by other clients (hand-written curl) are invisible here.
    if (target.owner) {
      // W2c: the owner's children come from the ledger and each is read by id.
      // The sessions LIST (which can be limited) no longer decides existence —
      // only a 404 on the per-session read prunes (R1 card test: an existing
      // idle child was dropped from the ledger and 0 children were listed).
      const entries = this.spawnLedger.entriesOf(target.owner);
      const found: Array<Awaited<ReturnType<PiOrchClient['childStatus']>>> = [];
      const queue = [...entries];
      let pruned = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const entry = queue.shift();
          if (!entry) return;
          const child = await this.childStatus(entry.sessionId);
          if (child.missing) {
            this.spawnLedger.remove(entry.sessionId);
            pruned += 1;
          } else {
            found.push(child);
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      const order = new Map(entries.map((entry, index) => [entry.sessionId, index]));
      found.sort((left, right) => (order.get(left.sessionId) ?? 0) - (order.get(right.sessionId) ?? 0));
      return { owner: target.owner, pruned, ...(this.spawnLedger.path ? {} : { note: 'no ledger path' }), children: found };
    }
    if (!target.parent) throw new Error('pi-orch: status needs --parent <id>, --owner <id> or a sessionId');
    const query = new URLSearchParams({ parent: target.parent });
    const response = await this.transport.request('GET', `/api/v1/sessions?${query.toString()}`, { headers: this.headers() });
    const body = response.body as { sessions?: Array<{ sessionId: string; runtime?: string; busy?: boolean; status?: string }> };
    const sessions = body.sessions ?? [];
    // Correction 04 item 6: every child is enriched with busy, goal state and
    // its last receipt; bounded parallelism keeps large fan-outs polite.
    const children: Awaited<ReturnType<typeof this.childStatus>>[] = [];
    const queue = [...sessions];
    const worker = async (): Promise<void> => {
      for (;;) {
        const session = queue.shift();
        if (!session) return;
        children.push(await this.childStatus(session.sessionId, session));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { parent: target.parent, children };
  }

  private async childStatus(
    sessionId: string,
    known?: { runtime?: string; busy?: boolean; status?: string },
  ): Promise<{
    sessionId: string;
    runtime?: string;
    busy?: boolean;
    status?: string;
    goalStatus?: string;
    goalObjective?: string;
    goalInterruption?: GoalInterruptionFacts;
    lastRun?: { runId?: string; status?: string; endedAt?: string | number; errorCode?: string };
    readErrors?: string[];
    missing?: boolean;
  }> {
    const readErrors: string[] = [];
    const describe = (error: unknown): string => {
      const e = error as { code?: string; message?: string };
      return [e.code, e.message].filter((part, index, all) => part && all.indexOf(part) === index).join(' ');
    };
    let missing = false;
    // W2c: GET /sessions rows carry busy/status only optionally (SessionInfo),
    // so a row that has neither is not enough — read the detail. A failed read
    // is surfaced in readErrors; it used to vanish into silent nulls.
    let detail: { runtime?: string; busy?: boolean; status?: string } | undefined = known;
    if (detail === undefined || (detail.busy === undefined && detail.status === undefined)) {
      try {
        const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
        detail = { ...detail, ...((response.body ?? {}) as { runtime?: string; busy?: boolean; status?: string }) };
      } catch (error) {
        if ((error as { status?: number }).status === 404) missing = true;
        readErrors.push(`detail: ${describe(error)}`);
        detail ??= {};
      }
    }
    const [goal, evidence] = await Promise.all([
      this.transport
        .request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { headers: this.headers() })
        .then((response) => response.body as { status?: string; objective?: string; interruption?: GoalInterruptionFacts })
        .catch((error: unknown) => {
          if ((error as { status?: number }).status !== 404) readErrors.push(`goal: ${describe(error)}`);
          return { status: 'unknown' as string | undefined, objective: undefined as string | undefined, interruption: undefined as GoalInterruptionFacts | undefined };
        }),
      this.transport
        .request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/evidence`, { headers: this.headers() })
        .then((response) => response.body as { runChronology?: RunChronologyEntry[]; status?: string })
        .catch((error: unknown) => {
          readErrors.push(`evidence: ${describe(error)}`);
          return { runChronology: [] as RunChronologyEntry[], status: undefined as string | undefined };
        }),
    ]);
    const last = newestRun(evidence.runChronology ?? []);
    const status = detail.status ?? evidence.status;
    const busy = detail.busy ?? (status !== undefined ? status === 'running' : undefined);
    return {
      sessionId,
      runtime: detail.runtime,
      busy,
      status,
      goalStatus: goal?.status,
      goalObjective: goal?.objective,
      // Wave K (additive): present only when the server holds interruption facts.
      ...(goal?.interruption ? { goalInterruption: goal.interruption } : {}),
      lastRun: last
        ? {
            runId: last.runId,
            status: last.status,
            ...(runEndedAt(last) !== undefined ? { endedAt: runEndedAt(last) } : {}),
            errorCode: last.errorCode ?? undefined,
          }
        : undefined,
      ...(readErrors.length > 0 ? { readErrors } : {}),
      ...(missing ? { missing: true } : {}),
    };
  }
}

type RunChronologyEntry = { runId?: string; status?: string; errorCode?: string | null; startedAt?: string | number; terminalAt?: string | number; agentEndAt?: string | number; endedAt?: string | number; completedAt?: string | number; finishedAt?: string | number; createdAt?: string | number; acceptedAt?: string | number };

function runEndedAt(run: RunChronologyEntry): string | number | undefined {
  // The server's evidence chronology carries terminalAt / agentEndAt; the rest are tolerated aliases.
  return run.terminalAt ?? run.agentEndAt ?? run.endedAt ?? run.completedAt ?? run.finishedAt ?? undefined;
}

function runTime(run: RunChronologyEntry): number | undefined {
  for (const value of [run.terminalAt, run.agentEndAt, run.endedAt, run.completedAt, run.finishedAt, run.startedAt, run.createdAt, run.acceptedAt]) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * W2c: the newest run of an evidence chronology. The contract does not pin the
 * order, so timestamps decide when entries carry them; without any timestamp
 * the first entry stays the last run (the pre-existing reading).
 */
function newestRun(runs: RunChronologyEntry[]): RunChronologyEntry | undefined {
  let best: RunChronologyEntry | undefined;
  let bestTime = -Infinity;
  for (const run of runs) {
    const time = runTime(run);
    if (time !== undefined && time > bestTime) { best = run; bestTime = time; }
  }
  return best ?? runs[0];
}

export interface CleanupOwnerChild {
  sessionId: string;
  watchDeleted: boolean;
  released: boolean;
  deleted: boolean;
  notes: string[];
  error?: string;
}

export interface CleanupOwnerReport {
  owner: string;
  ok: boolean;
  children: CleanupOwnerChild[];
}

/** W2c: the answer `result --final` selected and where it came from. */
export interface FinalResult {
  source: 'completion' | 'receipt' | 'transcript' | 'none';
  text?: string;
  completion?: CompletionBlock;
  note?: string;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** W2c: a one-line, code-bearing description of a thrown error. */
function describeError(error: unknown): string {
  const e = error as { code?: string; message?: string };
  const parts = [e.code, e.message].filter((part, index, all): part is string => typeof part === 'string' && part !== '' && all.indexOf(part) === index);
  return parts.length > 0 ? parts.join(': ') : String(error);
}

/** W2c: what `prompt --mode deliver` chose and why. */
export interface DeliveryChoice {
  chosen: 'steer' | 'follow_up';
  busy: boolean;
  reason: string;
}

export interface RerouteStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface RerouteOutcome {
  ok: boolean;
  sessionId: string;
  hadGoal: boolean;
  steps: RerouteStep[];
  objective?: string;
  objectiveIntact?: boolean;
  failedStep?: string;
  note?: string;
}

/** The queue depth a dispatch response reports, under any of the names the server has used. */
function queueDepthOf(raw: Record<string, unknown>): number | undefined {
  for (const key of ['queueDepth', 'queuedCount', 'queueLength']) {
    if (typeof raw[key] === 'number') return raw[key] as number;
  }
  const queue = raw.queue as { depth?: unknown } | undefined;
  return queue && typeof queue.depth === 'number' ? queue.depth : undefined;
}

function defaultRandomId(): string {
  return `piorch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** I1: flatten the run-output classification onto the result body. */
function spreadOutputClass(output: RunOutputClassification): { outputClass: 'command' | 'final_text' | 'no_text'; outputClassBasis?: string } {
  return output.kind === 'command'
    ? { outputClass: 'command', outputClassBasis: output.basis }
    : { outputClass: output.kind };
}
