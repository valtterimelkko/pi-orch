import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ApiBaseRefusedError, assertApiBaseAllowed, isLoopbackHost } from '../src/api-base.ts';
import { Transport } from '../src/transport.ts';
import { runCli } from '../src/cli.ts';
import { packageRoot } from '../src/credentials.ts';

/**
 * Correction 01 item 2: the bearer token must not leave the machine by
 * accident. The Unix socket is the default. An HTTP API base is accepted only
 * for loopback hosts; any other host is refused with exit 24 unless
 * PI_ORCH_ALLOW_REMOTE_API_BASE=1 is set explicitly, and even then only https:
 * is accepted (plain http to a remote host would send the token in clear).
 */

const REPO = packageRoot();

test('loopback API bases are allowed (localhost, 127.0.0.0/8, ::1)', () => {
  for (const base of ['http://127.0.0.1:8080', 'http://127.255.255.254:1', 'http://localhost:8080', 'http://[::1]:8080', 'https://127.0.0.1:8443']) {
    assert.equal(assertApiBaseAllowed(base), base, `${base} is loopback`);
  }
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('a remote host over http is refused, with or without the opt-in', () => {
  for (const allowRemote of [false, true]) {
    assert.throws(
      () => assertApiBaseAllowed('http://example.com:8080', { allowRemote }),
      (error: unknown) => error instanceof ApiBaseRefusedError && error.code === 'REMOTE_API_BASE_REFUSED',
      `allowRemote=${allowRemote} still refuses remote http`,
    );
  }
});

test('a remote host over https is refused without the opt-in', () => {
  assert.throws(
    () => assertApiBaseAllowed('https://example.com', { allowRemote: false }),
    (error: unknown) => error instanceof ApiBaseRefusedError && /PI_ORCH_ALLOW_REMOTE_API_BASE/.test((error as Error).message),
  );
});

test('a remote host over https is allowed only with the explicit opt-in', () => {
  assert.equal(assertApiBaseAllowed('https://example.com', { allowRemote: true }), 'https://example.com');
});

test('a malformed API base is refused loudly', () => {
  assert.throws(() => assertApiBaseAllowed('not a url'), ApiBaseRefusedError);
});

test('the Transport enforces the guard at construction', () => {
  assert.throws(() => new Transport({ apiBase: 'http://example.com', token: 'x' }), ApiBaseRefusedError);
  assert.throws(() => new Transport({ apiBase: 'https://example.com', token: 'x' }), ApiBaseRefusedError);
  assert.throws(() => new Transport({ apiBase: 'http://example.com', token: 'x', allowRemoteApiBase: true }), ApiBaseRefusedError);
  const transport = new Transport({ apiBase: 'https://example.com', token: 'x', allowRemoteApiBase: true });
  assert.ok(transport);
  const loopback = new Transport({ apiBase: 'http://127.0.0.1:1', token: 'x' });
  assert.ok(loopback);
});

test('the CLI maps the refusal to exit 24 with a clear message', async () => {
  const result = await runCli(['capabilities'], {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'x',
    client: () => {
      throw new ApiBaseRefusedError('refusing API base with non-loopback host');
    },
  });
  assert.equal(result.exitCode, 24);
  assert.match(result.stderr ?? '', /REMOTE_API_BASE_REFUSED/);
});

test('bin/pi-orch refuses a remote API base end to end (exit 24, no connection)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-api-base-'));
  try {
    const token = join(dir, 'token');
    writeFileSync(token, 'test-token\n');
    const run = spawnSync(
      process.execPath,
      [join(REPO, 'bin', 'pi-orch'), 'capabilities', '--api-base', 'http://example.com:9', '--token-path', token],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 24, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /REMOTE_API_BASE_REFUSED/);
    assert.match(run.stderr, /PI_ORCH_ALLOW_REMOTE_API_BASE/);

    const optIn = spawnSync(
      process.execPath,
      [join(REPO, 'bin', 'pi-orch'), 'capabilities', '--api-base', 'http://example.com:9', '--token-path', token],
      { encoding: 'utf8', env: { ...process.env, PI_ORCH_ALLOW_REMOTE_API_BASE: '1' } },
    );
    assert.equal(optIn.status, 24, 'remote http stays refused even with the opt-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
