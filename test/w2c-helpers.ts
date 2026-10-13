import type { CliDeps } from '../src/cli.ts';
import type { TransportResponse } from '../src/transport.ts';
import { ApiError } from '../src/parsers.ts';

/** W2c: shared fixtures for the mocked-transport suites (hermetic: no socket, no real ledger). */

export function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

export function apiError(status: number, code: string, message = code): ApiError {
  return new ApiError(status, code, message);
}

export interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export type Handler = (call: Call) => TransportResponse | Promise<TransportResponse>;

/**
 * A routed fake transport. Routes are matched on `METHOD path` exactly; a
 * handler may throw an ApiError. Unmatched requests fail the test loudly.
 */
export function routedTransport(routes: Record<string, Handler>): { transport: never; calls: Call[] } {
  const calls: Call[] = [];
  const transport = {
    request: async (method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      const call: Call = { method, path, ...(options.body !== undefined ? { body: options.body } : {}) };
      calls.push(call);
      const handler = routes[`${method} ${path}`];
      if (!handler) throw new Error(`unexpected ${method} ${path}`);
      return handler(call);
    },
  } as never;
  return { transport, calls };
}

export function fakeDeps(client: NonNullable<CliDeps['client']>): CliDeps {
  return { env: {}, stdout: () => undefined, stderr: () => undefined, randomId: () => 'test-key-123', client };
}
