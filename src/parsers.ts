/**
 * Response parsing. Tolerant of additive server fields (a newer server must not
 * break an older client), strict about the fields the client's decisions depend
 * on. Classification maps terminal receipt states into the documented
 * outcome/exit-code vocabulary, with C2's NEVER_STARTED / RUN_TRANSPORT_LOST
 * and B3b's RUN_BUDGET_EXCEEDED as first-class, distinct outcomes.
 */

export interface Receipt {
  runId: string;
  sessionId: string;
  runtime?: string;
  status: string;
  errorCode?: string;
  interruptionReason?: 'server_restart' | 'drain_timeout' | string;
  finalText?: string;
  finalTextTruncated?: boolean;
  servedModel?: string;
  modelRebound?: boolean;
  dispatchMode?: string;
  mode?: string;
  workState?: string;
  acceptedAt?: string;
  startedAt?: string;
  agentEndAt?: string;
  terminalAt?: string;
  cessation?: { state: string; basis: string; observedAt: string };
  outputEvidence?: { disposition?: string; assistantMessages?: number };
  liveness?: Record<string, unknown>;
  [key: string]: unknown;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Mirror of the server's watch condition spec (snapshot type WatchConditionSpec). */
export interface WatchConditionSpec {
  id?: string;
  type: 'event_type' | 'tool' | 'text' | 'deadline';
  eventType?: string;
  dataMatch?: Record<string, string | number | boolean>;
  toolName?: string;
  phase?: 'start' | 'end';
  argIncludes?: string;
  contains?: string;
  pattern?: string;
  patternFlags?: string;
  source?: 'assistant' | 'any';
  afterSeconds?: number;
  once?: boolean;
}

export function isTerminalReceipt(receipt: Receipt): boolean {
  return TERMINAL_STATUSES.has(receipt.status);
}

export function parseReceipt(value: unknown): Receipt {
  if (typeof value !== 'object' || value === null) throw new Error('pi-orch: receipt is not an object');
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    throw new Error('pi-orch: receipt has no runId');
  }
  if (typeof record.status !== 'string' || record.status.length === 0) {
    throw new Error('pi-orch: receipt has no status');
  }
  return record as Receipt;
}

export type ReceiptClassification =
  | { kind: 'running' }
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'interrupted'; interruptedByRestart: boolean; reason?: string }
  | { kind: 'failed' }
  | { kind: 'never_started' }
  | { kind: 'budget_exceeded' }
  | { kind: 'transport_lost' }
  | { kind: 'prompt_not_executed' }
  | { kind: 'turn_stalled' };

export function classifyReceipt(receipt: Receipt): ReceiptClassification {
  switch (receipt.status) {
    case 'completed':
      return { kind: 'completed' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'interrupted': {
      const byRestart = receipt.interruptionReason === 'server_restart' || receipt.interruptionReason === 'drain_timeout';
      return { kind: 'interrupted', interruptedByRestart: byRestart, reason: receipt.interruptionReason };
    }
    case 'failed':
      return classifyFailure(receipt.errorCode);
    default:
      return { kind: 'running' };
  }
}

function classifyFailure(errorCode: string | undefined): ReceiptClassification {
  switch (errorCode) {
    case 'NEVER_STARTED':
      return { kind: 'never_started' };
    case 'RUN_BUDGET_EXCEEDED':
      return { kind: 'budget_exceeded' };
    case 'RUN_TRANSPORT_LOST':
      return { kind: 'transport_lost' };
    case 'PROMPT_NOT_EXECUTED':
      return { kind: 'prompt_not_executed' };
    case 'TURN_STALLED':
      return { kind: 'turn_stalled' };
    default:
      return { kind: 'failed' };
  }
}

// ─── I1 (H2 item 1): run OUTPUT classification ─────────────────────────────

export type RunOutputClassification =
  | { kind: 'command'; basis: string }
  | { kind: 'final_text' }
  | { kind: 'no_text' };

/**
 * Classify what a terminal run OUTPUT, from the receipt's own evidence.
 * `command` = the run is a slash-command handler return (status completed at
 * the command boundary: cessation.basis 'documented_handler_return', no
 * assistant text, no finalText — the `/goal` arm-prompt shape). G5's receipt
 * instrument counted these as "empty final" (6 of its 13 bad receipts), but
 * nothing was returned empty by a provider: a command has no final text BY
 * DESIGN. `final_text` = the receipt carries final text. `no_text` = neither —
 * the genuinely unexplained class (assistant messages but no text).
 *
 * The public receipt mirrors liveness.cessation to a top-level `cessation`
 * (run-receipts/run-receipt-manager.ts); read both, the stored receipts used
 * by offline instruments carry only the liveness copy.
 */
export function classifyRunOutput(receipt: Receipt): RunOutputClassification {
  const basis = receipt.cessation?.basis
    ?? (receipt.liveness as { cessation?: { basis?: string } } | undefined)?.cessation?.basis;
  if (receipt.status === 'completed' && basis === 'documented_handler_return') {
    return { kind: 'command', basis };
  }
  if (typeof receipt.finalText === 'string' && receipt.finalText.trim() !== '') {
    return { kind: 'final_text' };
  }
  return { kind: 'no_text' };
}

// ─── /watches/wait ───────────────────────────────────────────────────────────

export interface WatchFiring {
  conditionId: string;
  firedAt: number;
  eventType: string;
  evidence?: string;
  reconciled?: boolean;
}

export interface WatchesWaitParsed {
  watches: Array<{ watchId: string; sessionId: string; firings: WatchFiring[]; firingCount: number }>;
  nextCursor: string;
  waitedMs: number;
}

export function parseWatchesWait(value: unknown): WatchesWaitParsed {
  if (typeof value !== 'object' || value === null) throw new Error('pi-orch: watches/wait response is not an object');
  const record = value as Record<string, unknown>;
  if (record.fired !== true) throw new Error('pi-orch: watches/wait response without fired:true');
  if (typeof record.nextCursor !== 'string') throw new Error('pi-orch: watches/wait response without nextCursor');
  const watches = Array.isArray(record.watches) ? record.watches : [];
  return {
    nextCursor: record.nextCursor,
    waitedMs: typeof record.waitedMs === 'number' ? record.waitedMs : 0,
    watches: watches.map((entry) => {
      const watch = entry as Record<string, unknown>;
      return {
        watchId: String(watch.watchId ?? ''),
        sessionId: String(watch.sessionId ?? ''),
        firingCount: typeof watch.firingCount === 'number' ? watch.firingCount : 0,
        firings: (Array.isArray(watch.firings) ? watch.firings : []).map((firing) => {
          const item = firing as Record<string, unknown>;
          return {
            conditionId: String(item.conditionId ?? ''),
            firedAt: typeof item.firedAt === 'number' ? item.firedAt : 0,
            eventType: String(item.eventType ?? ''),
            evidence: typeof item.evidence === 'string' ? item.evidence : undefined,
            reconciled: item.reconciled === true,
          };
        }),
      };
    }),
  };
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: string;
  readonly failures?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, options: { details?: string; failures?: unknown; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.failures = options.failures;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function parseApiError(status: number, body: unknown, retryAfterSeconds?: number): ApiError {
  if (typeof body !== 'object' || body === null) {
    return new ApiError(status, 'UNKNOWN', `HTTP ${status} with non-JSON body`);
  }
  const record = body as Record<string, unknown>;
  if (typeof record.code !== 'string') {
    throw new Error(`pi-orch: error response without a code field (HTTP ${status})`);
  }
  return new ApiError(status, record.code, typeof record.error === 'string' ? record.error : `HTTP ${status}`, {
    details: typeof record.details === 'string' ? record.details : undefined,
    failures: record.failures,
    retryAfterSeconds,
  });
}
