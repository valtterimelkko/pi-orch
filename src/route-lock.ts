/**
 * G1 correction 01: cross-process serialisation of the count→create span.
 * G1 correction 03 item 1: the stale-lock steal must never take a LIVE
 * holder's lock — the guarded section can legitimately outlast any fixed
 * mtime window (the create's Retry-After budget alone is 120 s).
 *
 * A per-(caller, route) exclusive lock file under the pi-orch state dir is
 * held ONLY across the count and the create POST (the correction's rule),
 * with a bounded wait and a clear error on lock timeout. The holder records
 * its PID and token in the file. A lock is stolen only when the recorded
 * holder PID is DEAD (`process.kill(pid, 0)` → ESRCH), or the lock is older
 * than a ceiling well above the maximum guarded duration, derived from the
 * transport config (request timeout + retry budget; the client adds the
 * margin). It never spans a --wait-for-slot wait — the wait happens OUTSIDE
 * the lock and the next attempt re-counts under a fresh lock.
 */

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const POLL_MS = 25;
/** Margin over the transport's guarded-request ceiling (timeout + retry budget). */
export const ROUTE_LOCK_STALE_MARGIN_MS = 30_000;
/** Fallback ceiling when the transport does not expose one (defaults: 30 s request timeout + 120 s retry budget). */
export const ROUTE_LOCK_STALE_DEFAULT_CEILING_MS = 150_000;

export class RouteLockTimeoutError extends Error {
  readonly code = 'ROUTE_LOCK_TIMEOUT';
  readonly key: string;
  readonly lockPath: string;
  readonly waitedMs: number;

  constructor(key: string, lockPath: string, waitedMs: number) {
    super(`pi-orch: another spawn of this caller on the same route holds the route lock (${Math.round(waitedMs / 100) / 10}s wait; key ${key}). If this repeats with nothing running, remove the stale lock file ${lockPath}`);
    this.name = 'RouteLockTimeoutError';
    this.key = key;
    this.lockPath = lockPath;
    this.waitedMs = waitedMs;
  }
}

export function routeLockPath(dir: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return join(dir, `route-${digest}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — treat as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function withRouteLock<T>(
  options: { dir: string; key: string; timeoutMs: number; staleMs?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const { dir, key, timeoutMs } = options;
  const staleMs = options.staleMs ?? ROUTE_LOCK_STALE_DEFAULT_CEILING_MS;
  mkdirSync(dir, { recursive: true });
  const path = routeLockPath(dir, key);
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  const started = Date.now();
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(path, 'wx');
      writeFileSync(fd, `${JSON.stringify({ token, pid: process.pid, at: new Date().toISOString(), key })}\n`);
      break;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } fd = undefined; }
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST') throw error;
      // Steal only from a DEAD holder (correction 03 item 1) — never from a
      // live one, whatever its age. As a last resort, a lock older than the
      // guarded-duration ceiling (timeout + retry budget + margin) is
      // presumed wedged and stolen even if its PID were somehow probeable.
      let stolen = false;
      try {
        const holder = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
        if (typeof holder.pid === 'number') {
          if (!pidAlive(holder.pid)) stolen = true;
        }
      } catch { /* unreadable file: fall through to the age rule */ }
      if (!stolen) {
        try {
          const age = Date.now() - statSync(path).mtimeMs;
          if (age > staleMs) stolen = true;
        } catch { /* vanished already: retry immediately */ }
      }
      if (stolen) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new RouteLockTimeoutError(key, path, Date.now() - started);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    // Release only if we still own it (it may have been stolen and re-created).
    try {
      const current = readFileSync(path, 'utf8');
      if (current.includes(token)) unlinkSync(path);
    } catch { /* already gone */ }
  }
}
