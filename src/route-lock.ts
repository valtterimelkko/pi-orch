/**
 * G1 correction 01: cross-process serialisation of the count→create span.
 *
 * Two concurrent spawns at the cap must not both observe a free slot and both
 * create. A per-(caller, route) exclusive lock file under the pi-orch state
 * dir is held ONLY across the count and the create POST (the correction's
 * rule), with a bounded wait and a clear error on lock timeout.
 *
 * The lock is a best-effort local mutex: O_EXCL create + token-verified
 * unlink, stale-lock stealing at 60 s (a crashed holder must not wedge the
 * route forever). It never spans a --wait-for-slot wait — the wait happens
 * OUTSIDE the lock and the next attempt re-counts under a fresh lock.
 */

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STALE_MS = 60_000;
const POLL_MS = 25;

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

export async function withRouteLock<T>(
  options: { dir: string; key: string; timeoutMs: number },
  fn: () => Promise<T>,
): Promise<T> {
  const { dir, key, timeoutMs } = options;
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
      // Stale holder (crashed process): steal the lock after STALE_MS.
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch { /* vanished already: retry immediately */ }
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
