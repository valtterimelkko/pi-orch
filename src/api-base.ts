/**
 * API-base destination guard (correction 01 item 2).
 *
 * The Internal API bearer token must not leave the machine by accident. The
 * default and normal transport is the same-host Unix socket. When an HTTP API
 * base is used instead, it is accepted only when it targets a loopback host:
 * `localhost`, an address in `127.0.0.0/8`, or `::1`.
 *
 * Any other host is refused with the typed `REMOTE_API_BASE_REFUSED` refusal
 * and exit code 24, unless the user sets `PI_ORCH_ALLOW_REMOTE_API_BASE=1`
 * explicitly — and even then only `https:` is accepted: plain `http:` to a
 * remote host would put the token on the wire in clear text.
 */

/** Distinct, documented exit code for a refused API base. */
export const REMOTE_API_BASE_EXIT_CODE = 24;

export class ApiBaseRefusedError extends Error {
  readonly code = 'REMOTE_API_BASE_REFUSED';

  constructor(message: string) {
    super(`pi-orch: ${message}`);
    this.name = 'ApiBaseRefusedError';
  }
}

/** True for localhost, 127.0.0.0/8 (any), and ::1 (URL-normalised forms included). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return ipv4 !== null && Number(ipv4[1]) === 127;
}

/**
 * Refuse an API base whose host is not loopback (and, under the explicit
 * opt-in, anything that is not https). Returns the base unchanged when it may
 * be used, so it can be applied inline at resolution sites.
 */
export function assertApiBaseAllowed(apiBase: string, options: { allowRemote?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new ApiBaseRefusedError(`refusing API base '${apiBase}': not a valid URL`);
  }
  if (isLoopbackHost(url.hostname)) return apiBase;
  if (options.allowRemote !== true) {
    throw new ApiBaseRefusedError(
      `refusing API base with non-loopback host '${url.hostname}': the bearer token may only go to a loopback host or the Unix socket. ` +
        'Set PI_ORCH_ALLOW_REMOTE_API_BASE=1 to opt in to a remote https: base.',
    );
  }
  if (url.protocol !== 'https:') {
    throw new ApiBaseRefusedError(
      `refusing API base with non-loopback host '${url.hostname}' over ${url.protocol || 'an unknown protocol'}: ` +
        'a remote API base must use https: (plain http would send the token in clear).',
    );
  }
  return apiBase;
}
