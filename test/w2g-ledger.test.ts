import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnLedger } from '../src/spawn-ledger.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * W2-e (plan): the spawn ledger is an append-only JSONL event log with a
 * derived VIEW. Pruning / removal change the view only — a record is never
 * deleted. An existing JSON-array ledger is migrated on first read (.bak kept).
 */

const lines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);

test('record appends one JSONL `spawned` event per spawn and never rewrites earlier lines', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's1', ownerId: 'o', route: 'r', leaseId: 'l1', at: '2026-10-13T00:00:00Z' });
  const first = readFileSync(path, 'utf8');
  book.record({ sessionId: 's2', ownerId: 'o', at: '2026-10-13T00:00:01Z' });
  const second = readFileSync(path, 'utf8');
  assert.ok(second.startsWith(first), 'the earlier bytes are untouched');
  const events = lines(path);
  assert.deepEqual(events.map((event) => [event.event, event.sessionId]), [['spawned', 's1'], ['spawned', 's2']]);
  assert.equal(events[0]?.leaseId, 'l1');
  assert.equal(typeof events[0]?.ts, 'string');
});

test('remove appends a `deleted` event: the record stays on disk, the view drops it', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's1', ownerId: 'o', at: 'a' });
  book.record({ sessionId: 's2', ownerId: 'o', at: 'b' });
  book.remove('s1');
  assert.deepEqual(lines(path).map((event) => [event.event, event.sessionId]), [['spawned', 's1'], ['spawned', 's2'], ['deleted', 's1']]);
  assert.deepEqual(book.entries().map((entry) => entry.sessionId), ['s2']);
  assert.deepEqual(book.entriesOf('o').map((entry) => entry.sessionId), ['s2']);
  assert.equal(book.leaseOf('s1'), undefined);
  assert.deepEqual(book.events().map((event) => event.event), ['spawned', 'spawned', 'deleted'], 'events() keeps the full history');
});

test('entriesFor prunes the VIEW only: a `pruned` event is appended and no record is removed', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's-live', ownerId: 'o', at: 'a' });
  book.record({ sessionId: 's-gone', ownerId: 'o', at: 'b' });
  const result = book.entriesFor('o', new Set(['s-live']));
  assert.deepEqual(result.sessionIds, ['s-live']);
  assert.equal(result.pruned, 1);
  const events = lines(path);
  assert.equal(events.filter((event) => event.event === 'spawned').length, 2, 'both spawned records are still on disk');
  assert.ok(events.some((event) => event.event === 'pruned' && event.sessionId === 's-gone'));
  assert.deepEqual(book.entries().map((entry) => entry.sessionId), ['s-live']);
  // pruning again does not append again
  book.entriesFor('o', new Set(['s-live']));
  assert.equal(lines(path).filter((event) => event.event === 'pruned').length, 1);
});

test('a re-recorded session shows again after a delete (latest event wins); lease events update the view', () => {
  const path = tempLedgerPath();
  const book = new SpawnLedger(path);
  book.record({ sessionId: 's1', ownerId: 'o', at: 'a' });
  book.remove('s1');
  book.record({ sessionId: 's1', ownerId: 'o2', leaseId: 'l9', at: 'c' });
  assert.equal(book.ownerOf('s1'), 'o2');
  assert.equal(book.leaseOf('s1'), 'l9');
  book.noteLease('s1', 'l9', 'released');
  assert.ok(lines(path).some((event) => event.event === 'lease' && event.sessionId === 's1' && event.leaseId === 'l9' && event.action === 'released'));
  assert.equal(book.leaseOf('s1'), undefined, 'a released lease no longer counts as releasable');
});

test('migration: a legacy JSON-array ledger becomes JSONL on first read and the original is kept as .bak', () => {
  const path = tempLedgerPath();
  const legacy = `${JSON.stringify([{ sessionId: 'old1', ownerId: 'o', leaseId: 'l', at: '2026-01-01T00:00:00Z' }, { sessionId: 'old2', at: '2026-01-02T00:00:00Z' }], null, 1)}\n`;
  writeFileSync(path, legacy);
  const book = new SpawnLedger(path);
  assert.deepEqual(book.entriesOf('o').map((entry) => entry.sessionId), ['old1']);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), legacy, 'byte-identical backup');
  const events = lines(path);
  assert.deepEqual(events.map((event) => [event.event, event.sessionId]), [['spawned', 'old1'], ['spawned', 'old2']]);
  assert.equal(events[0]?.at, '2026-01-01T00:00:00Z');
  book.record({ sessionId: 'new', at: 'n' });
  assert.equal(lines(path).length, 3);
  // a second reader does not re-migrate or overwrite the backup
  new SpawnLedger(path).entries();
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), legacy);
});

test('garbage and truncated lines are skipped; an unterminated last line does not swallow the next append', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-ledger-'));
  const path = join(dir, 'spawn-ledger.json');
  writeFileSync(path, `not json\n{"event":"spawned","sessionId":"a","at":"x"}\n{"event":"spawned","sessionId":"b"`);
  const book = new SpawnLedger(path);
  assert.deepEqual(book.entries().map((entry) => entry.sessionId), ['a']);
  book.record({ sessionId: 'c', at: 'y' });
  assert.deepEqual(new SpawnLedger(path).entries().map((entry) => entry.sessionId), ['a', 'c']);
  assert.ok(!existsSync(`${path}.bak`), 'no backup for a file that was never legacy JSON');
});

test('a ledger with no path records nothing and reads empty', () => {
  const book = new SpawnLedger(undefined);
  assert.deepEqual(book.record({ sessionId: 's', at: 'a' }), { recorded: false, note: 'no ledger path' });
  assert.deepEqual(book.entries(), []);
  assert.deepEqual(book.events(), []);
  book.remove('s');
  appendFileSync(tempLedgerPath(), '');
});
