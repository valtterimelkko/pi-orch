import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CredentialPathError, assertCredentialPathOutsideRepo, packageRoot } from '../src/credentials.ts';
import { readToken } from '../src/transport.ts';
import { runCli } from '../src/cli.ts';

/**
 * Public-repo rule (owner, 2026-09-30): the Internal API token must never come
 * from inside this repository. `.gitignore` is belt and braces only; the code
 * itself refuses a credential path that resolves inside the package root
 * (via realpath, so a symlink cannot bypass it) with the distinct exit code 23.
 */

const REPO = packageRoot();

test('a credential path inside the repository is refused with the distinct code', () => {
  const inside = join(REPO, 'internal-api-token');
  let caught: unknown;
  try {
    assertCredentialPathOutsideRepo(inside);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof CredentialPathError, 'throws the typed refusal');
  assert.equal((caught as CredentialPathError).code, 'CREDENTIAL_IN_REPO');
  assert.match((caught as Error).message, /inside the repository/);
  assert.match((caught as Error).message, /PI_WEB_UI_TOKEN_PATH/);
});

test('a symlink pointing into the repository does not bypass the guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-cred-sym-'));
  try {
    const link = join(dir, 'repo-link');
    symlinkSync(REPO, link, 'dir');
    assert.throws(() => assertCredentialPathOutsideRepo(join(link, 'token')), CredentialPathError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a credential path outside the repository passes (positive control)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-cred-out-'));
  try {
    const outside = join(dir, 'token');
    assert.equal(assertCredentialPathOutsideRepo(outside), outside);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readToken refuses an inside-repo token path (even when the file does not exist)', () => {
  assert.throws(
    () => readToken(join(REPO, 'does-not-exist-token')),
    (error: unknown) => error instanceof CredentialPathError && error.code === 'CREDENTIAL_IN_REPO',
  );
});

test('readToken still reads a token outside the repository (positive control)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-cred-read-'));
  try {
    const outside = join(dir, 'token');
    writeFileSync(outside, 'test-token-value\n');
    assert.equal(readToken(outside), 'test-token-value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI maps the refusal to exit 23 with a clear message', async () => {
  const result = await runCli(['capabilities'], {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'x',
    client: () => {
      throw new CredentialPathError(join(REPO, 'token'), REPO);
    },
  });
  assert.equal(result.exitCode, 23);
  assert.match(result.stderr ?? '', /CREDENTIAL_IN_REPO/);
});

test('bin/pi-orch refuses an inside-repo token path end to end (exit 23)', () => {
  const run = spawnSync(process.execPath, [join(REPO, 'bin', 'pi-orch'), 'capabilities'], {
    env: {
      ...process.env,
      PI_WEB_UI_TOKEN_PATH: join(REPO, '.piorch-inside-token'),
      PI_WEB_UI_SOCKET: join(tmpdir(), 'piorch-does-not-exist.sock'),
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 23, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /CREDENTIAL_IN_REPO/);
  assert.match(run.stderr, /inside the repository/);
});

test('no source file loads a .env file (credentials never come from repo-tree dotfiles)', () => {
  const files = [join(REPO, 'src'), join(REPO, 'bin')].flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(dir, entry.name)),
  );
  assert.ok(files.length > 10, 'scanned the source tree');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.equal(
      /dotenv|loadEnvFile|\bprocess\.loadEnv\b/.test(text),
      false,
      `${file} loads a dotfile — .env loading of any kind is forbidden`,
    );
  }
});
