/**
 * HTTP transport over the Internal API: Unix socket (or an http base for
 * tests/odd deployments), bearer-token auth, bounded Retry-After budget for
 * 429/503 admission refusals. Zero runtime dependencies — node:http only.
 *
 * Retry policy: a 429/503 that carries Retry-After is "wait and retry" (the
 * refusal happens before any receipt/runtime work, and prompt dispatches carry
 * idempotency keys, so retrying is safe). The budget is bounded both in
 * attempts and total waited time; exhaustion raises the ADMISSION_REFUSED
 * outcome instead of looping.
 */

import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { ApiError, parseApiError } from './parsers.ts';
import { assertCredentialPathOutsideRepo } from './credentials.ts';
import { assertApiBaseAllowed } from './api-base.ts';

export interface TransportConfig {
  socketPath?: string;
  /** Alternative to the socket, e.g. http://127.0.0.1:8080 (loopback only; see api-base.ts). */
  apiBase?: string;
  /**
   * Correction 01 item 2: explicitly opt in to a non-loopback https API base
   * (the PI_ORCH_ALLOW_REMOTE_API_BASE=1 escape hatch; remote http is never
   * allowed). Defaults to the environment variable's value.
   */
  allowRemoteApiBase?: boolean;
  token: string;
  /** Per-request timeout in ms (long-poll requests override this). */
  requestTimeoutMs?: number;
  retry?: { maxAttempts?: number; maxTotalWaitMs?: number; capPerWaitMs?: number; sleep?: (ms: number) => Promise<void> };
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  raw: string;
}

export class TransportError extends Error {
  readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'TransportError';
    this.cause = cause;
  }
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Internal: used by the retry loop to avoid re-sleeping. */
  _skipRetry?: boolean;
  /**
   * Correction 04 item 3: the request is safe to retry after a TRANSPORT
   * failure because it carries an idempotency key (or is a safe method).
   * POST /sessions must never be marked: the server has no create idempotency.
   */
  _idempotent?: boolean;
}

export class Transport {
  private readonly socketPath?: string;
  private readonly apiBase?: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly retry: { maxAttempts: number; maxTotalWaitMs: number; capPerWaitMs: number; sleep?: (ms: number) => Promise<void> };

  /**
   * G1 correction 03: the longest duration a single guarded request can
   * legitimately take — one request timeout plus the full Retry-After wait
   * budget. Consumers that guard request spans with local locks derive their
   * staleness ceiling from this instead of hard-coding one.
   */
  get guardedRequestCeilingMs(): number {
    return this.requestTimeoutMs + this.retry.maxTotalWaitMs;
  }

  constructor(config: TransportConfig) {
    if (!config.apiBase && !config.socketPath) {
      throw new Error('pi-orch: transport needs a socket path or an api base');
    }
    this.socketPath = config.socketPath;
    this.apiBase = config.apiBase === undefined
      ? undefined
      : assertApiBaseAllowed(config.apiBase, {
          allowRemote: config.allowRemoteApiBase ?? process.env.PI_ORCH_ALLOW_REMOTE_API_BASE === '1',
        });
    this.token = config.token;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.retry = { maxAttempts: 3, maxTotalWaitMs: 120_000, capPerWaitMs: 30_000, ...config.retry };
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<TransportResponse> {
    const retry = this.retry;
    const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
    let totalWaited = 0;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      let response: TransportResponse;
      try {
        response = await this.requestOnce(method, path, options);
      } catch (error) {
        // Correction 04 item 3: a transport failure (lost connection or
        // response) gives NO server verdict. Retry only requests that are
        // provably safe to repeat: safe methods, or requests carrying an
        // idempotency key. A non-idempotent POST is surfaced immediately —
        // the caller reconciles instead of duplicating the action.
        const safeToRepeat = options._idempotent === true || method === 'GET' || method === 'DELETE' || method === 'HEAD';
        if (safeToRepeat && attempt < retry.maxAttempts && totalWaited < retry.maxTotalWaitMs) {
          await sleep(500);
          continue;
        }
        throw new TransportError(`pi-orch: ${method} ${path} failed after ${attempt} attempt(s): ${(error as Error).message}`, error as Error);
      }
      const retryAfter = parseRetryAfter(response.headers['retry-after']);
      const retryable = (response.status === 429 || response.status === 503) && retryAfter !== undefined;
      if (retryable && attempt < retry.maxAttempts && !options._skipRetry) {
        // Correction 04 item 8: never retry EARLIER than the server asked.
        // The delay is waited in full unless the remaining budget cannot cover
        // it — then the refusal is returned with its retry hint instead.
        const delayMs = retryAfter * 1000;
        const remainingBudget = retry.maxTotalWaitMs - totalWaited;
        if (delayMs > remainingBudget) {
          throw parseApiError(response.status, response.body, retryAfter);
        }
        totalWaited += delayMs;
        await sleep(delayMs);
        continue;
      }
      if (response.status >= 400) {
        const retryAfterSeconds = retryAfter ?? undefined;
        throw parseApiError(response.status, response.body, retryAfterSeconds);
      }
      return response;
    }
  }

  private requestOnce(method: string, path: string, options: RequestOptions): Promise<TransportResponse> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      ...(options.headers ?? {}),
    };

    return new Promise<TransportResponse>((resolvePromise, rejectPromise) => {
      const failure = (error: Error): void => {
        clearTimeout(timer);
        rejectPromise(error);
      };
      const timer = setTimeout(() => {
        outgoing.destroy(new Error(`request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const basePath = this.apiBase ? new URL(this.apiBase).pathname.replace(/\/$/, '') : '';
      const fullPath = `${basePath}${path}`;
      const outgoing = request(
        this.apiBase
          ? { ...urlOptions(this.apiBase), path: fullPath, method, headers }
          : { socketPath: this.socketPath, path: fullPath, method, headers },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            clearTimeout(timer);
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: unknown = undefined;
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw);
              } catch {
                body = raw;
              }
            }
            resolvePromise({ status: incoming.statusCode ?? 0, headers: incoming.headers, body, raw });
          });
          incoming.on('error', failure);
        },
      );
      outgoing.on('error', failure);
      if (payload !== undefined) outgoing.write(payload);
      outgoing.end();
    });
  }
}

function urlOptions(apiBase: string): { host: string; port?: number; protocol?: string } {
  const url = new URL(apiBase);
  return { host: url.hostname, port: url.port === '' ? undefined : Number(url.port) };
}

export function parseRetryAfter(headerValue: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function readToken(tokenPath: string): string {
  // Public-repo guard: a token path inside this repository is refused before
  // any read (typed CREDENTIAL_IN_REPO refusal, exit code 23).
  assertCredentialPathOutsideRepo(tokenPath);
  try {
    return readFileSync(tokenPath, 'utf8').trim();
  } catch (error) {
    throw new TransportError(`pi-orch: cannot read Internal API token at ${tokenPath}`, error as Error);
  }
}
