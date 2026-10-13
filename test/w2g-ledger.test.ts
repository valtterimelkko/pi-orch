import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * W2-e (plan): the spawn ledger is an append-only JSONL event log with a
 * derived VIEW. Pruning / removal change the view only — a record is never
 * deleted. An existing JSON-array ledger is migrated on first read (.bak kept).
 */

/**
 * Correction 01: `spawn-ledger.json` stays a JSON ARRAY (a frozen interface —
 * other programmes read it directly) and is the derived VIEW, rewritten
 * atomically after every append. The append-only event log is the separate
 * `spawn-ledger.events.jsonl` next to it; records are only ever appended.
 */

const eventsPath = (path: string): string => path.replace(/\.json$/, '.events.jsonl');
const view = (path: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
const lines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(eventsPath(path), 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);

test('after spawn / prune / cleanup the .json file is a JSON array of the entries with ownerId and leaseId', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's1', ownerId: 'o', route: 'r', leaseId: 'l1', at: 'a' });
  book.record({ sessionId: 's2', ownerId: 'o', leaseId: 'l2', at: 'b' });
  book.record({ sessionId: 's3', ownerId: 'o', at: 'c' });
  assert.ok(Array.isArray(view(path)));
  assert.deepEqual(view(path).map((entry) => [entry.sessionId, entry.ownerId, entry.leaseId]), [['s1', 'o', 'l1'], ['s2', 'o', 'l2'], ['s3', 'o', undefined]]);
  book.entriesFor('o', new Set(['s1', 's2'])); // prunes s3
  assert.deepEqual(view(path).map((entry) => entry.sessionId), ['s1', 's2']);
  book.remove('s1'); // cleanup
  book.noteLease('s2', 'l2', 'released');
  assert.deepEqual(view(path), [{ sessionId: 's2', ownerId: 'o', at: 'b' }]);
});

test('the events file only grows: byte length never shrinks across record / prune / remove / lease', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  let last = 0;
  const grew = () => { const size = statSync(eventsPath(path)).size; assert.ok(size > last, `grew ${last} -> ${size}`); last = size; };
  book.record({ sessionId: 's1', ownerId: 'o', leaseId: 'l1', at: 'a' }); grew();
  book.record({ sessionId: 's2', ownerId: 'o', at: 'b' }); grew();
  book.entriesFor('o', new Set(['s1'])); grew();
  book.noteLease('s1', 'l1', 'released'); grew();
  book.remove('s1'); grew();
  assert.deepEqual(lines(path).map((event) => [event.event, event.sessionId]), [['spawned', 's1'], ['spawned', 's2'], ['pruned', 's2'], ['lease', 's1'], ['deleted', 's1']]);
  assert.equal(typeof lines(path)[0]?.ts, 'string');
});

test('remove / prune change the view only; events() keeps the full history; a no-op prune appends nothing', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's-live', ownerId: 'o', at: 'a' });
  book.record({ sessionId: 's-gone', ownerId: 'o', at: 'b' });
  assert.equal(book.entriesFor('o', new Set(['s-live'])).pruned, 1);
  assert.equal(book.entriesFor('o', new Set(['s-live'])).pruned, 0);
  assert.equal(lines(path).filter((event) => event.event === 'pruned').length, 1);
  assert.equal(lines(path).filter((event) => event.event === 'spawned').length, 2);
  book.remove('s-live');
  assert.deepEqual(book.entriesOf('o'), []);
  assert.deepEqual(book.events().map((event) => event.event), ['spawned', 'spawned', 'pruned', 'deleted']);
});

test('a re-recorded session shows again after a delete; a released lease is no longer releasable', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's1', ownerId: 'o', at: 'a' });
  book.remove('s1');
  book.record({ sessionId: 's1', ownerId: 'o2', leaseId: 'l9', at: 'c' });
  assert.equal(book.ownerOf('s1'), 'o2');
  assert.equal(book.leaseOf('s1'), 'l9');
  book.noteLease('s1', 'l9', 'released');
  assert.equal(book.leaseOf('s1'), undefined);
});

test('seeding: an existing JSON-array ledger with no events file is seeded (migrated:true) and left byte-identical, no .bak', () => {
  const path = tempLedgerPath();
  const legacy = `${JSON.stringify([{ sessionId: 'old1', ownerId: 'o', leaseId: 'l', at: '2026-01-01T00:00:00Z' }, { sessionId: 'old2', at: '2026-01-02T00:00:00Z' }], null, 1)}\n`;
  writeFileSync(path, legacy);
  const book = new SpawnLedger(path);
  assert.deepEqual(book.entriesOf('o').map((entry) => entry.sessionId), ['old1']);
  assert.equal(readFileSync(path, 'utf8'), legacy, 'reading changes nothing in the view file');
  assert.ok(!existsSync(`${path}.bak`));
  const events = lines(path);
  assert.deepEqual(events.map((event) => [event.event, event.sessionId, event.migrated]), [['spawned', 'old1', true], ['spawned', 'old2', true]]);
  assert.equal(events[0]?.leaseId, 'l');
  book.record({ sessionId: 'new', at: 'n' });
  assert.deepEqual(view(path).map((entry) => entry.sessionId), ['old1', 'old2', 'new']);
  assert.equal(lines(path).length, 3, 'seeding happens once');
  new SpawnLedger(path).entries();
  assert.equal(lines(path).length, 3);
});

test('a missing or corrupt events file falls back to the JSON view — no entry is lost', () => {
  for (const corrupt of [undefined, 'garbage\n{"truncated":']) {
    const path = tempLedgerPath();
    const book = new SpawnLedger(path);
    book.record({ sessionId: 'a', ownerId: 'o', at: '1' });
    book.record({ sessionId: 'b', ownerId: 'o', at: '2' });
    if (corrupt === undefined) {
      rmSync(eventsPath(path));
    } else {
      writeFileSync(eventsPath(path), corrupt);
    }
    const fresh = new SpawnLedger(path);
    assert.deepEqual(fresh.entries().map((entry) => entry.sessionId), ['a', 'b']);
    fresh.record({ sessionId: 'c', ownerId: 'o', at: '3' });
    assert.deepEqual(view(path).map((entry) => entry.sessionId), ['a', 'b', 'c']);
    assert.deepEqual(new SpawnLedger(path).entries().map((entry) => entry.sessionId), ['a', 'b', 'c']);
  }
});

test('the events file name follows PI_ORCH_SPAWN_LEDGER: <name>.json -> <name>.events.jsonl in the same directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-ledger-'));
  const path = join(dir, 'custom-name.json');
  new SpawnLedger(path).record({ sessionId: 's', at: 'a' });
  assert.ok(existsSync(join(dir, 'custom-name.events.jsonl')));
  const odd = join(dir, 'ledger');
  new SpawnLedger(odd).record({ sessionId: 's', at: 'a' });
  assert.ok(existsSync(`${odd}.events.jsonl`));
});

test('a ledger with no path records nothing and reads empty', () => {
  const book = new SpawnLedger(undefined);
  assert.deepEqual(book.record({ sessionId: 's', at: 'a' }), { recorded: false, note: 'no ledger path' });
  assert.deepEqual(book.entries(), []);
  assert.deepEqual(book.events(), []);
  book.remove('s');
});

test('W2g review-1: the migration marker never leaks into the frozen JSON view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2g-rev1-'));
  const path = join(dir, 'spawn-ledger.json');
  writeFileSync(path, JSON.stringify([{ sessionId: 's-old', ownerId: 'o', createdAt: '2026-10-13T00:00:00Z' }]));
  const ledger = new SpawnLedger(path);
  ledger.record({ sessionId: 's-new', ownerId: 'o', createdAt: '2026-10-13T01:00:00Z' } as never);
  const view = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
  assert.equal(view.length, 2);
  for (const entry of view) assert.equal('migrated' in entry, false);
});
