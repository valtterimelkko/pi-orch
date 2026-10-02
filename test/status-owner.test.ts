import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliDeps } from '../src/cli.ts';
import { PiOrchClient } from '../src/client.ts';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import type { TransportResponse } from '../src/transport.ts';

/**
 * J2 P5: `status --owner` — the Claude Code parent's only lineage. External
 * parents are not Pi Web UI sessions, so `status --parent` cannot find their
 * children (Phase A live receipt: SESSION_NOT_FOUND for the dispatching
 * session). The spawn ledger already records owner→sessionId at spawn (G1);
 * status --owner reads it, prunes children the server no longer knows, and
 * enriches the rest with live busy/goal/lastRun state. Per-host, best-effort —
 * documented, not hidden.
 */

function ok(body: unknown): TransportResponse {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

function fakeDeps(client: NonNullable<CliDeps['client']>): CliDeps {
  return { env: {}, stdout: () => undefined, stderr: () => undefined, randomId: () => 'test-key-123', client };
}

function tempLedger(entries: Array<{ sessionId: string; ownerId?: string; route?: string; at?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-status-owner-'));
  const path = join(dir, 'spawn-ledger.json');
  // Seed through the ledger's own writer so the format is always the real one.
  for (const entry of entries) new SpawnLedger(path).record({ at: '2026-10-02T11:00:00Z', ...entry });
  return path;
}

test('client.status({owner}) lists the ledger children, prunes dead ones, enriches live ones', async () => {
  const ledgerPath = tempLedger([
    { sessionId: 's-live', ownerId: 'orch-j2-parent8-lane', route: 'zai/glm-5.3-flash' },
    { sessionId: 's-dead', ownerId: 'orch-j2-parent8-lane' },
    { sessionId: 's-other', ownerId: 'orch-j2-parent8-otherlane' },
  ]);
  const sessionGets: string[] = [];
  const transport = {
    request: async (method: string, path: string) => {
      // goal/evidence reads must be matched before the generic session-detail
      // prefix — childStatus GETs both for every listed child.
      if (path.endsWith('/goal')) return ok({ status: 'achieved', objective: 'O' });
      if (path.endsWith('/evidence')) return ok({ runChronology: [{ runId: 'r1', status: 'completed' }] });
      if (method === 'GET' && path === '/api/v1/sessions') {
        return ok({ sessions: [{ sessionId: 's-live', runtime: 'pi', busy: false, status: 'idle' }] });
      }
      if (method === 'GET' && path.startsWith('/api/v1/sessions/s-')) {
        sessionGets.push(path);
        return ok({ sessionId: 's-live', runtime: 'pi', busy: false, status: 'idle' });
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ transportInstance: transport, spawnLedgerPath: ledgerPath, randomId: () => 'k1' });
  const body = await client.status({ owner: 'orch-j2-parent8-lane' });
  assert.equal(body.owner, 'orch-j2-parent8-lane');
  assert.equal(body.children.length, 1, 'the other-owner and dead children are not listed');
  const listed = body.children[0];
  assert.ok(listed, 'the live child is listed');
  assert.equal(listed.sessionId, 's-live');
  assert.equal(listed.goalStatus, 'achieved');
  assert.equal(listed.lastRun?.status, 'completed');
  assert.equal(body.pruned, 1, 'the dead ledger entry is pruned');
  // The prune is durable: the ledger on disk no longer names s-dead.
  const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Array<{ sessionId: string }>;
  assert.equal(onDisk.some((entry) => entry.sessionId === 's-dead'), false);
});

test('CLI: status --owner routes to the owner lookup; --json is machine-readable', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runCli(
    ['status', '--owner', 'orch-j2-parent8-lane', '--json'],
    fakeDeps(() => ({
      status: async (target: Record<string, unknown>) => {
        seen.push(target);
        return { owner: 'orch-j2-parent8-lane', pruned: 0, children: [{ sessionId: 's1', busy: false, goalStatus: 'achieved' }] };
      },
    }) as never),
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr ?? ''}`);
  assert.deepEqual(seen[0], { owner: 'orch-j2-parent8-lane' });
  assert.match(result.stdout ?? '', /"owner": "orch-j2-parent8-lane"/);
});

test('CLI: --owner combines with neither a sessionId nor --parent', async () => {
  const withSession = await runCli(['status', 's1', '--owner', 'o'], fakeDeps(() => ({}) as never));
  assert.equal(withSession.exitCode, 2);
  const withParent = await runCli(['status', '--parent', 'p', '--owner', 'o'], fakeDeps(() => ({}) as never));
  assert.equal(withParent.exitCode, 2);
});

test('CLI: status --owner with an empty ledger reports zero children honestly (exit 0)', async () => {
  const ledgerPath = tempLedger([]);
  const transport = {
    request: async () => ok({ sessions: [] }),
  } as never;
  const result = await runCli(
    ['status', '--owner', 'nobody', '--json'],
    fakeDeps(() => new PiOrchClient({ transportInstance: transport, spawnLedgerPath: ledgerPath, randomId: () => 'k1' }) as never),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? '', /"children": \[\]/);
});
