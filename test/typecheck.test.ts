import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTsc } from '../src/tsc-resolver.ts';

/**
 * Item 4: `npm run typecheck` must work for an outside adopter. It runs the
 * local devDependency TypeScript after `npm install`, and falls back to a host
 * `tsc` when it is not installed. Runtime dependencies stay zero.
 */

function makeRepo(dir: string, options: { localTypescript?: boolean; pathTsc?: boolean; localTypes?: boolean } = {}): void {
  if (options.localTypescript) {
    mkdirSync(join(dir, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '// tsc');
  }
  if (options.localTypes) {
    mkdirSync(join(dir, 'node_modules', '@types', 'node'), { recursive: true });
  }
  if (options.pathTsc) {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'tsc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
}

test('prefers the local devDependency TypeScript after npm install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-tsc-local-'));
  try {
    makeRepo(dir, { localTypescript: true, localTypes: true });
    const resolved = resolveTsc({ cwd: dir, env: {}, platform: 'linux' });
    assert.equal(resolved.source, 'local');
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.args, [join(dir, 'node_modules', 'typescript', 'bin', 'tsc')]);
    assert.equal(resolved.typeRoots, undefined, 'tsc default resolution finds the local @types');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to a host tsc on PATH when nothing is installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-tsc-path-'));
  try {
    makeRepo(dir, { pathTsc: true });
    const bin = join(dir, 'bin');
    const resolved = resolveTsc({ cwd: dir, env: { PATH: bin }, platform: 'linux', home: join(dir, 'nowhere') });
    assert.equal(resolved.source, 'path');
    assert.equal(resolved.command, join(bin, 'tsc'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the host fallback points tsc at ~/pi-web-ui @types when the repo has no local install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-tsc-home-'));
  try {
    makeRepo(dir, { pathTsc: true });
    const home = join(dir, 'home');
    mkdirSync(join(home, 'pi-web-ui', 'node_modules', '@types', 'node'), { recursive: true });
    const resolved = resolveTsc({ cwd: dir, env: { PATH: join(dir, 'bin') }, platform: 'linux', home });
    assert.equal(resolved.typeRoots, join(home, 'pi-web-ui', 'node_modules', '@types'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PI_ORCH_TSC pins an explicit TypeScript, loudly failing on a missing path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-tsc-env-'));
  try {
    const pinned = join(dir, 'pinned-tsc');
    writeFileSync(pinned, '// pinned');
    const resolved = resolveTsc({ cwd: dir, env: { PI_ORCH_TSC: pinned, PATH: '' }, platform: 'linux' });
    assert.equal(resolved.source, 'env');
    assert.deepEqual(resolved.args, [pinned]);
    assert.throws(() => resolveTsc({ cwd: dir, env: { PI_ORCH_TSC: join(dir, 'missing') }, platform: 'linux' }), /PI_ORCH_TSC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without any TypeScript the error tells the adopter to npm install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-tsc-none-'));
  try {
    assert.throws(() => resolveTsc({ cwd: dir, env: { PATH: '' }, platform: 'linux' }), /npm install/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
