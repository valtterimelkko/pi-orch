import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot, SNAPSHOT_SEARCH_PATHS } from '../src/snapshot.ts';

/**
 * Snapshot loading: the client validates its builders and parsers against the
 * server-derived contract snapshot. Resolution order is explicit and testable:
 *   1. PI_ORCH_SNAPSHOT_PATH (explicit override)
 *   2. PI_WEB_UI_REPO, when set — it must carry the snapshot (loud error if not)
 *   3. ~/pi-web-ui, when that checkout carries the snapshot (adopter default)
 *   4. the bundled copy in this repo (contract/), which keeps the client usable
 *      (and its tests green) before a server checkout carries the file.
 * The loader reports WHICH source served the snapshot, so tests and operators
 * can always tell how fresh the contract view is. No host-specific path is
 * hard-coded: adopters set PI_WEB_UI_REPO, or keep a checkout at ~/pi-web-ui.
 */

test('loads the bundled snapshot by default', () => {
  // Hermetic: an empty HOME has no ~/pi-web-ui, so the bundled copy is the
  // only source left (item 3: `npm test` must pass with no Pi Web UI checkout).
  const empty = mkdtempSync(join(tmpdir(), 'piorch-empty-'));
  try {
    const loaded = loadSnapshot({ env: {}, home: empty });
    assert.equal(loaded.source, 'bundled');
    assert.ok(loaded.snapshot.contractVersion.match(/^\d+\.\d+\.\d+$/));
    assert.equal(loaded.snapshot.$schema, 'pi-orch-contract-snapshot/v1');
    assert.ok(Object.keys(loaded.snapshot.routes).length >= 16);
    assert.ok(Object.keys(loaded.snapshot.types).length >= 20);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('prefers PI_WEB_UI_REPO when it carries the snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-repo-env-'));
  try {
    const contractDir = join(dir, 'docs', 'contract');
    mkdirSync(contractDir, { recursive: true });
    const base = loadSnapshot({ env: {}, home: join(dir, 'no-home') }).snapshot;
    writeFileSync(join(contractDir, 'internal-api-client-snapshot.json'), JSON.stringify({ ...base, contractVersion: '8.8.8' }));
    const loaded = loadSnapshot({ env: { PI_WEB_UI_REPO: dir }, home: join(dir, 'no-home') });
    assert.equal(loaded.source, 'repo-env');
    assert.equal(loaded.snapshot.contractVersion, '8.8.8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a set PI_WEB_UI_REPO without a snapshot is a loud error, not a silent fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-repo-bad-'));
  try {
    assert.throws(() => loadSnapshot({ env: { PI_WEB_UI_REPO: dir }, home: dir }), /PI_WEB_UI_REPO/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to ~/pi-web-ui when it carries the snapshot', () => {
  const home = mkdtempSync(join(tmpdir(), 'piorch-home-'));
  try {
    const contractDir = join(home, 'pi-web-ui', 'docs', 'contract');
    mkdirSync(contractDir, { recursive: true });
    const base = loadSnapshot({ env: {}, home: join(home, 'empty') }).snapshot;
    writeFileSync(join(contractDir, 'internal-api-client-snapshot.json'), JSON.stringify({ ...base, contractVersion: '7.7.7' }));
    const loaded = loadSnapshot({ env: {}, home });
    assert.equal(loaded.source, 'home-checkout');
    assert.equal(loaded.snapshot.contractVersion, '7.7.7');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prefers PI_ORCH_SNAPSHOT_PATH over everything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-snap-'));
  try {
    const override = join(dir, 'custom.json');
    const base = loadSnapshot({ env: {} }).snapshot;
    writeFileSync(override, JSON.stringify({ ...base, contractVersion: '9.9.9' }));
    const loaded = loadSnapshot({ env: { PI_ORCH_SNAPSHOT_PATH: override } });
    assert.equal(loaded.source, 'env');
    assert.equal(loaded.snapshot.contractVersion, '9.9.9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uses the server checkout copy when it exists and no override is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-server-'));
  try {
    const contractDir = join(dir, 'docs', 'contract');
    mkdirSync(contractDir, { recursive: true });
    const base = loadSnapshot({ env: {} }).snapshot;
    writeFileSync(join(contractDir, 'internal-api-client-snapshot.json'), JSON.stringify(base));
    const loaded = loadSnapshot({ env: {}, serverCheckoutRoot: dir });
    assert.equal(loaded.source, 'server-checkout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing PI_ORCH_SNAPSHOT_PATH is a loud error, not a silent fallback', () => {
  assert.throws(
    () => loadSnapshot({ env: { PI_ORCH_SNAPSHOT_PATH: '/nonexistent/snapshot.json' } }),
    /PI_ORCH_SNAPSHOT_PATH/,
  );
});

test('a malformed snapshot is rejected with the path in the message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-bad-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"contractVersion": "1.0.0"}'); // missing required members
    assert.throws(() => loadSnapshot({ env: { PI_ORCH_SNAPSHOT_PATH: bad } }), /bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search paths are exported so operators can see the resolution order', () => {
  assert.ok(Array.isArray(SNAPSHOT_SEARCH_PATHS));
  assert.ok(SNAPSHOT_SEARCH_PATHS.length >= 2);
  assert.ok(SNAPSHOT_SEARCH_PATHS[0].includes('PI_ORCH_SNAPSHOT_PATH'));
  assert.ok(SNAPSHOT_SEARCH_PATHS.some((entry) => entry.includes('PI_WEB_UI_REPO')), 'names the env repo override');
  assert.ok(SNAPSHOT_SEARCH_PATHS.some((entry) => entry.includes('~/pi-web-ui')), 'names the adopter home fallback');
  assert.ok(!SNAPSHOT_SEARCH_PATHS.some((entry) => entry.includes('/root/')), 'no host-specific path');
});
