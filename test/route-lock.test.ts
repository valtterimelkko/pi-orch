import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { withRouteLock, routeLockPath } from '../src/route-lock.ts';

/**
 * G1 correction 03 item 1: the stale-lock steal must never take a LIVE
 * holder's lock. The guarded section can legitimately last longer than any
 * fixed mtime window (the create's Retry-After budget alone is 120 s), so a
 * lock is stolen only when the recorded holder PID is DEAD, or the lock is
 * older than a ceiling derived from the transport config (request timeout +
 * retry budget + margin). The holder records its PID and token in the file.
 */

function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sleep', ['30']);
    child.on('spawn', () => {
      child.kill('SIGKILL');
      child.on('exit', () => resolve(child.pid as number));
    });
  });
}

test('a LIVE holder keeps its lock even when its mtime is backdated past the stale window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-lock3-'));
  let firstInside = false;
  let firstDone = false;
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = withRouteLock({ dir, key: 'route-a', timeoutMs: 5_000 }, async () => {
    firstInside = true;
    await gate;
    firstDone = true;
  });
  // Wait until the first holder is inside (lock file exists with its token).
  const lockPath = routeLockPath(dir, 'route-a');
  for (let i = 0; i < 200 && !firstInside; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(firstInside);
  // Backdate the LIVE holder's lock past the OLD 60 s window but well under
  // the new derived ceiling — the mtime alone must not trigger a steal.
  const past = new Date(Date.now() - 70_000);
  utimesSync(lockPath, past, past);

  // A second entrant must WAIT (timeout), never steal the live holder's lock.
  await assert.rejects(
    withRouteLock({ dir, key: 'route-a', timeoutMs: 400 }, async () => 'entered'),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ROUTE_LOCK_TIMEOUT');
      return true;
    },
  );
  assert.equal(firstDone, false, 'the first holder is still inside — its lock was not stolen');
  releaseFirst?.();
  assert.equal(await first, undefined);
  assert.ok(firstDone);

  // After release, the route is free again.
  const result = await withRouteLock({ dir, key: 'route-a', timeoutMs: 5_000 }, async () => 'second-entered');
  assert.equal(result, 'second-entered');
});

test('a DEAD-PID lock is stolen at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-lock3-'));
  const pid = await deadPid();
  const lockPath = routeLockPath(dir, 'route-b');
  // The exact on-disk shape the lock writes: token + holder pid.
  writeFileSync(lockPath, `${JSON.stringify({ token: 'dead-token', pid, at: new Date().toISOString(), key: 'route-b' })}\n`);
  const started = Date.now();
  let onDisk: { token: string; pid: number } | undefined;
  const result = await withRouteLock({ dir, key: 'route-b', timeoutMs: 800 }, async () => {
    // Read the lock INSIDE the held section (it is unlinked on release).
    onDisk = JSON.parse(readFileSync(routeLockPath(dir, 'route-b'), 'utf8')) as { token: string; pid: number };
    return 'stolen-and-entered';
  });
  assert.equal(result, 'stolen-and-entered');
  assert.ok(Date.now() - started < 700, `a dead-PID lock is stolen immediately (took ${Date.now() - started}ms)`);
  assert.ok(onDisk, 'the lock file existed while held');
  assert.notEqual(onDisk?.token, 'dead-token');
  assert.equal(onDisk?.pid, process.pid, 'the new holder recorded its own PID');
});
