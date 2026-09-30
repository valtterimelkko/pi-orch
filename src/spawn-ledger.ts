/**
 * G1: the bare-CLI spawn ledger. The server has no owner filter on the
 * sessions list, so when the caller has no session identity the client counts
 * its live children per route from THIS ledger: every successful spawn records
 * {sessionId, route, ownerId, …}; counting re-checks each recorded child
 * against the live sessions list and prunes entries whose session is gone.
 *
 * Local, best-effort, best around the known race (two processes writing at
 * once — last writer wins per entry merge): the ledger bounds a single host's
 * bare-CLI fan-out; it is not a distributed guard. Identity-based counting
 * (X-Parent-Session) is server-authoritative and never consults the ledger.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface LedgerEntry {
  sessionId: string;
  route?: string;
  ownerId?: string;
  parentSessionId?: string;
  at: string;
}

export function defaultLedgerPath(env: Record<string, string | undefined> = process.env): string {
  return env.PI_ORCH_SPAWN_LEDGER ?? join(homedir(), '.pi-orch', 'spawn-ledger.json');
}

export class SpawnLedger {
  readonly path: string | undefined;

  constructor(path: string | undefined) {
    this.path = path;
  }

  /** Best-effort append/refresh of one entry; never throws into the spawn path. */
  record(entry: LedgerEntry): { recorded: boolean; note?: string } {
    if (!this.path) return { recorded: false, note: 'no ledger path' };
    try {
      const entries = this.readAll();
      const next = [...entries.filter((existing) => existing.sessionId !== entry.sessionId), entry];
      this.writeAll(next);
      return { recorded: true };
    } catch (error) {
      return { recorded: false, note: `ledger write failed: ${(error as Error).message}` };
    }
  }

  /** SessionIds recorded for an owner, minus the ones the server no longer knows. */
  entriesFor(ownerId: string, knownSessionIds: Set<string>): { sessionIds: string[]; pruned: number; note?: string } {
    if (!this.path) return { sessionIds: [], pruned: 0, note: 'no ledger path' };
    try {
      const entries = this.readAll();
      const mine = entries.filter((entry) => entry.ownerId === ownerId);
      const live = mine.filter((entry) => knownSessionIds.has(entry.sessionId));
      const pruned = mine.length - live.length;
      if (pruned > 0) {
        const dropped = new Set(mine.filter((entry) => !knownSessionIds.has(entry.sessionId)).map((entry) => entry.sessionId));
        this.writeAll(entries.filter((entry) => !dropped.has(entry.sessionId)));
      }
      return { sessionIds: live.map((entry) => entry.sessionId), pruned };
    } catch (error) {
      return { sessionIds: [], pruned: 0, note: `ledger read failed: ${(error as Error).message}` };
    }
  }

  /** The retention owner a child was spawned with (G1 correction 01: the bare-CLI prompt gate counts that owner's siblings). */
  ownerOf(sessionId: string): string | undefined {
    if (!this.path) return undefined;
    try {
      return this.readAll().find((entry) => entry.sessionId === sessionId)?.ownerId;
    } catch {
      return undefined; // unreadable ledger: no owner attribution
    }
  }

  private readAll(): LedgerEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path as string, 'utf8');
    } catch {
      return []; // no ledger yet
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
    } catch {
      return []; // unreadable ledger: start clean rather than fail spawns
    }
  }

  private writeAll(entries: LedgerEntry[]): void {
    mkdirSync(dirname(this.path as string), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 1)}\n`);
    renameSync(tmp, this.path as string);
  }
}
