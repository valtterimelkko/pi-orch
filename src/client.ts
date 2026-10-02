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
import { GOAL_REPORT_INSTRUCTION } from './completion-template.ts';

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
import { waitOnChild, waitOnChildren, type WaitOutcome, type WaitDeps, type WaitOnChildrenResult, type WaitChild } from './wait.ts';
import { limitFor, liveReason, resolveRouteLimits, routeOfSession, validateLimitValue, RouteLimitError, RouteLimitWaitDeadlineError } from './route-limits.ts';
import { SpawnLedger, defaultLedgerPath } from './spawn-ledger.ts';
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

  /** The cap for one spawn/prompt call: the per-call value wins; 0 lifts the cap.
    * A bad value is a usage-class error, never a silent unlimited (correction 01 item 6). */
  private effectiveLimit(route: string | undefined, perCall: number | undefined): number | undefined {
    if (perCall !== undefined) {
      validateLimitValue(route ?? '(per-call)', perCall, 'route-limit');
      return perCall > 0 ? perCall : undefined;
    }
    return limitFor(route, this.routeLimits);
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
  ): Promise<void> {
    const watchBefore = await Promise.all(live.map((entry) => this.getWatch(entry.sessionId).catch(() => null)));
    const watchable = live.filter((_, index) => !(watchBefore[index] !== null && watchBefore[index]?.status === 'active'));
    if (watchable.length === 0) {
      // Every live child carries an unremovable foreign watch: there is no
      // watchable settle to wait for. Refuse with the normal over-limit error
      // so the caller can act now.
      throw new RouteLimitError(route, limit, live);
    }
    const oursToClean = watchable.map((entry) => entry.sessionId);
    const waited = await this.waitMany({ mode: 'any', children: watchable.map((entry) => ({ sessionId: entry.sessionId })), deadlineMs: remainingMs });
    await Promise.all(oursToClean.map((sessionId) => this.deleteWatch(sessionId).catch(() => undefined)));
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

  async spawn(input: CreateInput & { modelMatch?: string; routeLimit?: number; waitForSlotMs?: number }): Promise<{
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
    const routeLimit = modelSelector ? this.effectiveLimit(modelSelector, input.routeLimit) : undefined;
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
      if (recordLedger) {
        const recorded = this.spawnLedger.record({
          sessionId,
          route: modelSelector,
          ownerId: input.retention?.ownerId,
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
    const created = routeLimit !== undefined && modelSelector
      ? await this.spawnUnderRouteGate(modelSelector, owner, routeLimit, input.waitForSlotMs, runCreate)
      : await runCreate(!this.parentSessionId);
    const { raw, retention, sessionId } = created;
    // C3b: a templated GOAL child gets the verbatim instruction paragraph as a
    // queued follow_up (the server keeps objectives single-line, so the
    // objective carries only the flattened pointer). follow_up queues on the
    // busy arm turn and delivers after it — the C3a live-proven sequencing.
    let templateFollowUpRunId: string | undefined;
    if (input.goal && input.completionTemplate !== false) {
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
    limit: number,
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
      const outcome = await withRouteLock({ dir: this.spawnLockDir, key, timeoutMs: this.routeLockTimeoutMs, staleMs: this.routeLockStaleMs }, async (): Promise<{ action: 'wait'; live: Array<{ sessionId: string; reason: string }> } | { action: 'create'; response: { raw: Record<string, unknown>; retention: { leaseId?: string } | undefined; sessionId: string } }> => {
        const { count, live, countedBy } = await this.countLiveOnRoute(route, owner);
        if (countedBy !== 'none' && count >= limit) return { action: 'wait', live };
        // Record in the ledger whenever the owner ledger is the effective
        // counting domain (bare CLI, or a stale parent falling back to it).
        return { action: 'create', response: await create(countedBy === 'owner') };
      });
      if (outcome.action === 'create') return outcome.response;
      if (waitForSlotMs === undefined) throw new RouteLimitError(route, limit, outcome.live);
      const remaining = (deadline as number) - Date.now();
      if (remaining <= 0) throw new RouteLimitWaitDeadlineError(route, limit, waitForSlotMs);
      await this.waitForRouteSlotOnce(route, limit, outcome.live, remaining);
      // loop: re-count under a fresh lock
    }
  }

  async prompt(sessionId: string, input: PromptInput & { followUpOnBusy?: boolean; routeLimit?: number; routeOwner?: string }): Promise<{
    runId: string;
    sessionId: string;
    detached: boolean;
    duplicate: boolean;
    dispatchMode?: string;
    raw: unknown;
  }> {
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
      if (!(input.followUpOnBusy === true && busyRefusal)) throw error;
      response = await this.transport.request('POST', path, {
        body: { ...body, mode: 'follow_up' },
        headers: this.headers(),
        _idempotent: true,
      });
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
    const limit = this.effectiveLimit(route, perCall);
    if (limit === undefined) return;
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
    const { count, live, countedBy } = await this.countLiveOnRoute(route as string, owner);
    if (countedBy === 'none' || count < limit) return;
    throw new RouteLimitError(route as string, limit, live);
  }

  /**
   * J2 P2: arm a goal on an ALREADY-CREATED session — the H-b parent
   * pattern's create-then-goal order (POST /sessions/:id/goal, action start).
   * The Phase A replay had no way to do this from pi-orch (`pi-orch goal` was
   * an unknown verb). Start-only: pause/resume/clear stay interactive.
   */
  async goalStart(sessionId: string, input: { objective: string; maxTurns?: number; verifyCommand?: string; budgetTokens?: number }): Promise<Record<string, unknown>> {
    if (!input.objective) throw new Error('pi-orch: goal start needs an objective');
    const body: Record<string, unknown> = { action: 'start', objective: input.objective };
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
    return {
      ...raw,
      ...(receipt?.runId ? { runId: receipt.runId } : {}),
      ...(goal && typeof goal === 'object' ? { status: goal.status, objective: goal.objective, goal } : {}),
    };
  }

  async registerWatch(sessionId: string, input: { conditions: WatchConditionSpec[]; label?: string; fireIfSettled?: boolean; pin?: boolean }): Promise<{ watchId: string; status?: string; raw: unknown }> {
    const body = buildWatchBody(input);
    const response = await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
      body,
      headers: this.headers(),
    });
    const raw = response.body as Record<string, unknown>;
    return { watchId: String(raw.watchId), status: typeof raw.status === 'string' ? raw.status : undefined, raw };
  }

  async getWatch(sessionId: string): Promise<{ watchId: string; status?: string; conditions?: Array<{ id?: string; spec?: Record<string, unknown> }>; label?: string; firingCount?: number; allFired?: boolean; firings?: Array<Record<string, unknown>> } | null> {
    try {
      const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
        headers: this.headers(),
      });
      const raw = response.body as Record<string, unknown>;
      return {
        watchId: String(raw.watchId),
        status: typeof raw.status === 'string' ? raw.status : undefined,
        label: typeof raw.label === 'string' ? raw.label : undefined,
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

  async deleteWatch(sessionId: string): Promise<void> {
    await this.transport.request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, { headers: this.headers() });
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
        const body = response.body as { status?: string; objective?: string; pausedReason?: string | null; lastReason?: string | null };
        return { status: body.status, objective: body.objective, pausedReason: body.pausedReason, lastReason: body.lastReason };
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

  async result(runId: string, options: { includeTranscript?: boolean } = {}): Promise<{
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
    if (options.includeTranscript) {
      const transcriptResponse = await this.transport.request(
        'GET',
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?scope=visible_full`,
        { headers: this.headers(), timeoutMs: 60_000 },
      );
      const body = transcriptResponse.body as { items?: Array<{ kind: string; text: string }> };
      transcript = body.items ?? [];
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
      ...(transcript !== undefined ? { transcript } : {}),
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
    return verifyChild(input, deps, loadCompletion);
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
        await this.deleteWatch(sessionId);
        notes.push(`watch ${options.watchId} deleted`);
      } catch (error) {
        notes.push(`watch delete failed: ${(error as Error).message}`);
      }
    }
    if (options.leaseId) {
      try {
        await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/control`, {
          body: { action: 'release_retention', retentionLeaseId: options.leaseId, ...(options.ownerId ? { ownerId: options.ownerId } : {}) },
          headers: this.headers(),
        });
        released = true;
      } catch (error) {
        notes.push(`lease release failed: ${(error as Error).message}`);
      }
    }
    await this.transport.request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() });
    return { released, deleted: true, notes };
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
      lastRun?: { runId?: string; status?: string; errorCode?: string };
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
      const list = await this.transport.request('GET', '/api/v1/sessions', { headers: this.headers() });
      const sessions = (list.body as { sessions?: Array<{ sessionId: string }> }).sessions ?? [];
      const known = new Set(sessions.map((session) => session.sessionId));
      const { sessionIds, pruned, note } = this.spawnLedger.entriesFor(target.owner, known);
      const children: Awaited<ReturnType<PiOrchClient['childStatus']>>[] = [];
      const queue = [...sessionIds];
      const worker = async (): Promise<void> => {
        for (;;) {
          const sessionId = queue.shift();
          if (!sessionId) return;
          children.push(await this.childStatus(sessionId));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return { owner: target.owner, pruned, ...(note ? { note } : {}), children };
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
    lastRun?: { runId?: string; status?: string; errorCode?: string };
  }> {
    // Correction 04 item 6: direct reads derive busy from the session detail.
    const detail = known ?? await this.transport
      .request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: this.headers() })
      .then((response) => response.body as { runtime?: string; busy?: boolean; status?: string })
      .catch(() => ({}) as { runtime?: string; busy?: boolean; status?: string });
    const [goal, evidence] = await Promise.all([
      this.transport
        .request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`, { headers: this.headers() })
        .then((response) => response.body as { status?: string; objective?: string })
        .catch(() => ({ status: 'unknown' as string | undefined, objective: undefined as string | undefined })),
      this.transport
        .request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/evidence`, { headers: this.headers() })
        .then((response) => response.body as { runChronology?: Array<{ runId?: string; status?: string; errorCode?: string }>; status?: string })
        .catch(() => ({ runChronology: [] as Array<{ runId?: string; status?: string; errorCode?: string }>, status: undefined as string | undefined })),
    ]);
    const last = evidence.runChronology?.[0];
    return {
      sessionId,
      runtime: detail.runtime,
      busy: detail.busy,
      status: detail.status ?? evidence.status,
      goalStatus: goal?.status,
      goalObjective: goal?.objective,
      lastRun: last ? { runId: last.runId, status: last.status, errorCode: last.errorCode ?? undefined } : undefined,
    };
  }
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
