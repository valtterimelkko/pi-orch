/**
 * C3b — completion-block client types and resolution (mirrors of the server's
 * contract 1.58.0 shapes; the bundled snapshot pins them — see
 * test/completion-snapshot.test.ts).
 */

export interface CompletionBlock {
  schema: 'pi-completion/v1';
  status: 'done' | 'blocked' | 'partial';
  summary?: string;
  commands?: Array<{ command: string; exitCode: number; note?: string }>;
  tests?: Array<{ name: string; result: 'pass' | 'fail' | 'skip'; note?: string }>;
  commits?: Array<{ sha: string; repo: string; subject?: string }>;
  filesChanged?: string[];
  openIssues?: string[];
  blockedReason?: string;
}

export interface CompletionParseError {
  code: 'NO_BLOCK' | 'UNCLOSED_FENCE' | 'OVERSIZED_BLOCK' | 'MALFORMED_JSON' | 'SCHEMA_VIOLATION';
  message: string;
  fieldPath?: string;
}

export type CompletionDelimiter = 'completion' | 'json-tagged';

export type CompletionCaptureSource = { runId: string } | { kind: 'session_turn'; agentEndAt: string };

export interface SessionCompletionSurface {
  source: CompletionCaptureSource;
  capturedAt: string;
  runtime?: string;
  completion?: CompletionBlock;
  delimiter?: CompletionDelimiter;
  completionError?: CompletionParseError;
}

/** The receipt fields C3a added (additive on the pre-C3a receipt). */
export type ReceiptWithCompletion = {
  runId: string;
  sessionId: string;
  completion?: CompletionBlock;
  completionError?: CompletionParseError;
  completionDelimiter?: CompletionDelimiter;
} & Record<string, unknown>;

/** The session-detail fields C3a added (additive on the pre-C3a detail). */
export type SessionDetailWithCompletion = {
  sessionId?: string;
  latestCompletion?: SessionCompletionSurface;
} & Record<string, unknown>;

export interface ResolvedCompletion {
  /** The parsed block, when one was captured. */
  completion?: CompletionBlock;
  /** The parse/validate error, when the block failed (exactly one of the two is set). */
  error?: CompletionParseError;
  /** Which delimiter matched the block (present with `completion`). */
  delimiter?: CompletionDelimiter;
  /** Which record the completion (or error) came from. */
  source: 'receipt' | 'session_surface';
  /** Surface provenance, when the block came from the session surface. */
  capturedAt?: string;
  capturedBy?: CompletionCaptureSource;
}

/**
 * C3b resolution rule: the run receipt is authoritative when it captured
 * anything at all (block or typed error) — it is the run-level record. Only a
 * receipt that captured NOTHING (the receipt-less goal/extension-turn class)
 * falls back to the session's `latestCompletion`, which is the only capture
 * path for turns that hold no receipt.
 */
export function resolveCompletion(
  receipt: ReceiptWithCompletion,
  sessionDetail?: SessionDetailWithCompletion,
): ResolvedCompletion | undefined {
  if (receipt.completion) {
    return {
      completion: receipt.completion,
      ...(receipt.completionDelimiter !== undefined ? { delimiter: receipt.completionDelimiter } : {}),
      source: 'receipt',
    };
  }
  if (receipt.completionError) {
    return { error: receipt.completionError, source: 'receipt' };
  }
  const surface = sessionDetail?.latestCompletion;
  if (!surface) return undefined;
  if (surface.completion) {
    return {
      completion: surface.completion,
      ...(surface.delimiter !== undefined ? { delimiter: surface.delimiter } : {}),
      source: 'session_surface',
      capturedAt: surface.capturedAt,
      capturedBy: surface.source,
    };
  }
  if (surface.completionError) {
    return { error: surface.completionError, source: 'session_surface', capturedAt: surface.capturedAt, capturedBy: surface.source };
  }
  return undefined;
}
