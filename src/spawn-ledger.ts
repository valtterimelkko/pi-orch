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

import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface LedgerEntry {
  sessionId: string;
  route?: string;
  ownerId?: string;
  /** W2c: the retention lease the spawn acquired, so cleanup can release it without a lookup. */
  leaseId?: string;
  parentSessionId?: string;
  at: string;
}

/**
 * W2-e: the ledger file is an append-only JSONL event log. One line per event;
 * the VIEW (what record/entriesOf/leaseOf/ownerOf answer from) is derived by
 * folding the events in order. Nothing ever rewrites or deletes a line:
 * `deleted` (cleanup / confirmed gone) and `pruned` (the server no longer
 * lists it) only change the view; `lease` notes a lease transition.
 */
export type LedgerEvent =
  | ({ event: 'spawned'; ts: string } & LedgerEntry)
  | { event: 'deleted'; ts: string; sessionId: string }
  | { event: 'pruned'; ts: string; sessionId: string }
  | { event: 'lease'; ts: string; sessionId: string; leaseId: string; action: 'acquired' | 'released' };

export function defaultLedgerPath(env: Record<string, string | undefined> = process.env): string {
  return env.PI_ORCH_SPAWN_LEDGER ?? join(homedir(), '.pi-orch', 'spawn-ledger.json');
}

export class SpawnLedger {
  readonly path: string | undefined;

  constructor(path: string | undefined) {
    this.path = path;
  }

  /** Best-effort append of one `spawned` event; never throws into the spawn path. */
  record(entry: LedgerEntry): { recorded: boolean; note?: string } {
    if (!this.path) return { recorded: false, note: 'no ledger path' };
    try {
      this.migrateIfLegacy();
      this.append({ event: 'spawned', ts: new Date().toISOString(), ...entry });
      return { recorded: true };
    } catch (error) {
      return { recorded: false, note: `ledger write failed: ${(error as Error).message}` };
    }
  }

  /** SessionIds recorded for an owner, minus the ones the server no longer knows (view-only prune). */
  entriesFor(ownerId: string, knownSessionIds: Set<string>): { sessionIds: string[]; pruned: number; note?: string } {
    if (!this.path) return { sessionIds: [], pruned: 0, note: 'no ledger path' };
    try {
      const mine = this.entries().filter((entry) => entry.ownerId === ownerId);
      const live = mine.filter((entry) => knownSessionIds.has(entry.sessionId));
      const gone = mine.filter((entry) => !knownSessionIds.has(entry.sessionId));
      for (const entry of gone) this.append({ event: 'pruned', ts: new Date().toISOString(), sessionId: entry.sessionId });
      return { sessionIds: live.map((entry) => entry.sessionId), pruned: gone.length };
    } catch (error) {
      return { sessionIds: [], pruned: 0, note: `ledger read failed: ${(error as Error).message}` };
    }
  }

  /**
   * W2c: every viewed entry of one owner. Existence is the caller's question
   * (a per-session read; only a 404 means gone) — the sessions LIST can be
   * limited and must never decide that a child vanished.
   */
  entriesOf(ownerId: string): LedgerEntry[] {
    return this.entries().filter((entry) => entry.ownerId === ownerId);
  }

  /** W2c: hide one session from the view (cleaned up, or confirmed gone). Appends `deleted`; best-effort; never throws. */
  remove(sessionId: string): void {
    if (!this.path) return;
    try {
      if (this.entries().some((entry) => entry.sessionId === sessionId)) {
        this.append({ event: 'deleted', ts: new Date().toISOString(), sessionId });
      }
    } catch {
      // best effort: a stale entry is harmless (a later 404 prunes it)
    }
  }

  /** W2-e: note a lease transition (e.g. released by cleanup). Best-effort; never throws. */
  noteLease(sessionId: string, leaseId: string, action: 'acquired' | 'released'): void {
    if (!this.path) return;
    try {
      this.append({ event: 'lease', ts: new Date().toISOString(), sessionId, leaseId, action });
    } catch {
      // best effort
    }
  }

  /** W2c: the lease a spawn recorded for a session (none once it was released). */
  leaseOf(sessionId: string): string | undefined {
    return this.entries().find((entry) => entry.sessionId === sessionId)?.leaseId;
  }

  /** The retention owner a child was spawned with (G1 correction 01: the bare-CLI prompt gate counts that owner's siblings). */
  ownerOf(sessionId: string): string | undefined {
    return this.entries().find((entry) => entry.sessionId === sessionId)?.ownerId;
  }

  /** The derived VIEW: live (not deleted / pruned) entries in spawn order. */
  entries(): LedgerEntry[] {
    const view = new Map<string, LedgerEntry>();
    for (const event of this.events()) {
      if (event.event === 'spawned') {
        const { event: _kind, ts: _ts, ...entry } = event;
        view.delete(entry.sessionId); // a re-record moves to the end, like the old filter-then-push
        view.set(entry.sessionId, entry);
      } else if (event.event === 'deleted' || event.event === 'pruned') {
        view.delete(event.sessionId);
      } else if (event.event === 'lease') {
        const existing = view.get(event.sessionId);
        if (!existing) continue;
        if (event.action === 'released') {
          if (existing.leaseId === event.leaseId) {
            const { leaseId: _released, ...rest } = existing;
            view.set(event.sessionId, rest);
          }
        } else {
          view.set(event.sessionId, { ...existing, leaseId: event.leaseId });
        }
      }
    }
    return [...view.values()];
  }

  /** The full history, oldest first. Unparseable lines are skipped. */
  events(): LedgerEvent[] {
    if (!this.path) return [];
    try {
      this.migrateIfLegacy();
    } catch {
      // read what is there
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return []; // no ledger yet
    }
    return parseEvents(raw);
  }

  private append(event: LedgerEvent): void {
    const path = this.path as string;
    mkdirSync(dirname(path), { recursive: true });
    const prefix = endsMidLine(path) ? '\n' : '';
    appendFileSync(path, `${prefix}${JSON.stringify(event)}\n`);
  }

  /** Convert a legacy JSON-array ledger to JSONL in place, keeping the original as `<path>.bak`. */
  private migrateIfLegacy(): void {
    const path = this.path as string;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    if (!raw.trimStart().startsWith('[')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // not a valid legacy ledger: leave it alone
    }
    if (!Array.isArray(parsed)) return;
    const backup = existsSync(`${path}.bak`) ? `${path}.bak.${Date.now()}` : `${path}.bak`;
    copyFileSync(path, backup);
    const body = (parsed as LedgerEntry[])
      .filter((entry) => entry && typeof entry.sessionId === 'string')
      .map((entry) => JSON.stringify({ event: 'spawned', ts: entry.at ?? new Date().toISOString(), ...entry }))
      .join('\n');
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body.length > 0 ? `${body}\n` : '');
    renameSync(tmp, path);
  }
}

function parseEvents(raw: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { event?: unknown; sessionId?: unknown };
      if (typeof parsed.sessionId !== 'string') continue;
      if (parsed.event === 'spawned' || parsed.event === 'deleted' || parsed.event === 'pruned' || parsed.event === 'lease') out.push(parsed as LedgerEvent);
    } catch {
      // skip a garbage / truncated line
    }
  }
  return out;
}

/** True when the file exists, is non-empty and its last byte is not a newline (an unterminated last line). */
function endsMidLine(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size === 0) return false;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(1);
      readSync(fd, buffer, 0, 1, size - 1);
      return buffer[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
