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
  defaultConditions,
  type CreateInput,
  type PromptInput,
} from './builders.ts';
import { parseReceipt, ApiError, type Receipt, type WatchConditionSpec } from './parsers.ts';
import { resolveCompletion, type CompletionBlock, type CompletionParseError, type CompletionDelimiter, type CompletionCaptureSource, type ReceiptWithCompletion, type SessionDetailWithCompletion } from './completion.ts';
import { verifyChild, makeNodeVerifyDeps, type VerifyInput, type VerifyResult, type CompletionLoad } from './verify.ts';
import { waitOnChild, waitOnChildren, type WaitOutcome, type WaitDeps, type WaitOnChildrenResult, type WaitChild } from './wait.ts';

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
}

export class PiOrchClient {
  readonly transport: Transport;
  readonly parentSessionId?: string;
  private readonly randomId: () => string;
  private readonly waitDeadlineMs: number;
  private readonly waitSliceMs: number;

  constructor(config: ClientConfig) {
    if (config.transportInstance === undefined && config.transport === undefined) {
      throw new Error('pi-orch: client needs transport options or a transportInstance');
    }
    this.transport = config.transportInstance ?? new Transport(config.transport as TransportConfig);
    this.parentSessionId = config.parentSessionId;
    this.randomId = config.randomId ?? defaultRandomId;
    this.waitDeadlineMs = config.waitDeadlineMs ?? 30 * 60_000;
    this.waitSliceMs = config.waitSliceMs ?? 45_000;
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

  async spawn(input: CreateInput & { modelMatch?: string }): Promise<{
    sessionId: string;
    leaseId?: string;
    parentId?: string;
    resolvedModel?: string;
    raw: unknown;
  }> {
    const modelSelector = input.modelSelector ?? (input.modelMatch ? await this.resolveModel(input.runtime, input.modelMatch) : undefined);
    const body = buildCreateBody({ ...input, modelSelector });
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
    return {
      sessionId: String(raw.sessionId),
      leaseId: retention?.leaseId,
      parentId: typeof raw.parentSessionId === 'string' ? raw.parentSessionId : undefined,
      resolvedModel: typeof raw.resolvedModel === 'string' ? raw.resolvedModel : undefined,
      raw,
    };
  }

  async prompt(sessionId: string, input: PromptInput & { followUpOnBusy?: boolean }): Promise<{
    runId: string;
    sessionId: string;
    detached: boolean;
    duplicate: boolean;
    dispatchMode?: string;
    raw: unknown;
  }> {
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

  async registerWatch(sessionId: string, input: { conditions: WatchConditionSpec[]; label?: string; fireIfSettled?: boolean; pin?: boolean }): Promise<{ watchId: string; status?: string; raw: unknown }> {
    const body = buildWatchBody(input);
    const response = await this.transport.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
      body,
      headers: this.headers(),
    });
    const raw = response.body as Record<string, unknown>;
    return { watchId: String(raw.watchId), status: typeof raw.status === 'string' ? raw.status : undefined, raw };
  }

  async getWatch(sessionId: string): Promise<{ watchId: string; status?: string; conditions?: Array<{ id?: string; spec?: Record<string, unknown> }>; label?: string } | null> {
    try {
      const response = await this.transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, {
        headers: this.headers(),
      });
      const raw = response.body as Record<string, unknown>;
      return {
        watchId: String(raw.watchId),
        status: typeof raw.status === 'string' ? raw.status : undefined,
        label: typeof raw.label === 'string' ? raw.label : undefined,
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
    const conditions = options.conditions ?? defaultConditions(options.objective, options.deadlineMs ?? this.waitDeadlineMs);
    const deps = this.waitDeps();
    return waitOnChild({
      sessionId: options.sessionId,
      runId: options.runId,
      conditions,
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
    const loadCompletion = async (verifyInput: VerifyInput): Promise<CompletionLoad> => {
      if (verifyInput.runId) {
        const response = await this.transport.request('GET', `/api/v1/runs/${encodeURIComponent(verifyInput.runId)}`, { headers: this.headers() });
        const receipt = parseReceipt(response.body) as ReceiptWithCompletion;
        if (receipt.completion || receipt.completionError) {
          const resolved = resolveCompletion(receipt, undefined);
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

  async status(target: { parent?: string; sessionId?: string }): Promise<{
    parent?: string;
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
    if (!target.parent) throw new Error('pi-orch: status needs --parent <id> or a sessionId');
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
