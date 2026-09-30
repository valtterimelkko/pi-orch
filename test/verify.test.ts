import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyChild, makeNodeVerifyDeps, type VerifyInput } from '../src/verify.ts';
import type { CompletionBlock } from '../src/completion.ts';

/**
 * C3b item 3: `verify` re-checks cheap facts from a completion block against
 * the filesystem with READ-ONLY git — commits exist in their claimed repos
 * (and are reachable when --since names a base), filesChanged files show
 * evidence of change, commands/tests are recorded, and a claimed test is
 * re-run ONLY when the parent names the exact command (--rerun). Verdicts:
 * verified (exit 0) / contradicted (exit 20) / unverifiable (exit 21).
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** A throwaway repo with two commits on main (a, then b) and a side-branch commit off the base.
 *  File contents and messages embed the repo name so two sibling fixtures can NEVER produce
 *  byte-identical (same-sha) commit objects — that once made a 'wrong repo' claim verify true. */
function fixtureRepo(name: string): { root: string; base: string; shaA: string; shaB: string; sideSha: string } {
  const root = join(mkFixtureDir(), name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--initial-branch', 'main');
  git(root, 'config', 'user.email', `fixture-${name}@example.com`);
  git(root, 'config', 'user.name', `Fixture ${name}`);
  writeFileSync(join(root, 'a.txt'), `alpha ${name}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', `add a (${name})`);
  const shaA = git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'b.txt'), `beta ${name}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', `add b (${name})`);
  const shaB = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-qb', 'side');
  writeFileSync(join(root, 'side.txt'), `side ${name}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', `side work (${name})`);
  const sideSha = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', 'main');
  return { root, base: shaA, shaA, shaB, sideSha };
}

let fixtureRoot: string | undefined;
function mkFixtureDir(): string {
  if (!fixtureRoot) fixtureRoot = mkdtempSync(join(tmpdir(), 'piorch-verify-'));
  return fixtureRoot;
}

function block(overrides: Partial<CompletionBlock> = {}): CompletionBlock {
  return { schema: 'pi-completion/v1', status: 'done', ...overrides };
}

function deps() {
  return makeNodeVerifyDeps();
}

function input(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return { sessionId: 's1', ...overrides };
}

const COMPLETION_OK: CompletionBlock = block(); // replaced per-test

test('true claims verify: commit exists, worktree file, deleted file, rerun passes', async () => {
  const repo = fixtureRepo('true-claims');
  // Commit c deletes a.txt (b.txt still present).
  writeFileSync(join(repo.root, 'c.txt'), 'gamma\n');
  rmSync(join(repo.root, 'a.txt'));
  git(repo.root, 'add', '-A');
  git(repo.root, 'commit', '-qm', 'delete a, add c');
  const shaC = git(repo.root, 'rev-parse', 'HEAD').trim();

  const result = await verifyChild(
    input({ cwd: repo.root, rerun: 'echo rerun-ok', rerunTimeoutMs: 30_000 }),
    deps(),
    async () => ({
      block: block({
        commands: [{ command: 'git commit', exitCode: 0 }],
        commits: [
          { sha: repo.shaA, repo: repo.root },
          { sha: repo.shaB, repo: repo.root },
          { sha: shaC, repo: repo.root },
        ],
        filesChanged: ['b.txt', 'a.txt'],
        tests: [{ name: 'fixture-suite', result: 'pass' }],
      }),
      source: 'receipt' as const,
    }),
  );
  const verdicts = Object.fromEntries(result.claims.map((claim) => [`${claim.kind}:${claim.claim}`, claim.result]));
  assert.equal(verdicts[`commit:${repo.shaA}`], 'verified');
  assert.equal(verdicts[`commit:${shaC}`], 'verified');
  assert.equal(verdicts['file:b.txt'], 'verified');
  assert.equal(verdicts['file:a.txt'], 'verified', 'a.txt was deleted in a named commit');
  assert.equal(verdicts['test:fixture-suite'], 'verified', 'parent-named rerun exited 0');
  assert.equal(verdicts['command:git commit'], 'recorded');
  assert.equal(result.verdict, 'verified');
});

test('a non-existent sha is contradicted', async () => {
  const repo = fixtureRepo('no-such-sha');
  const result = await verifyChild(
    input({ cwd: repo.root }),
    deps(),
    async () => ({ block: block({ commits: [{ sha: 'deadbeef', repo: repo.root }], filesChanged: [] }), source: 'receipt' as const }),
  );
  const row = result.claims.find((claim) => claim.kind === 'commit');
  assert.equal(row?.result, 'contradicted');
  assert.equal(result.verdict, 'contradicted');
});

test('a sha in the WRONG repo is contradicted', async () => {
  const repoA = fixtureRepo('wrong-repo-a');
  const repoB = fixtureRepo('wrong-repo-b');
  const result = await verifyChild(
    input({ cwd: repoB.root }),
    deps(),
    async () => ({ block: block({ commits: [{ sha: repoA.shaA, repo: repoB.root }], filesChanged: [] }), source: 'receipt' as const }),
  );
  const row = result.claims.find((claim) => claim.kind === 'commit');
  assert.equal(row?.result, 'contradicted');
  assert.ok(row?.detail?.includes(repoB.root));
  assert.equal(result.verdict, 'contradicted');
});

test('a file with no evidence of change is contradicted', async () => {
  const repo = fixtureRepo('no-file-evidence');
  const result = await verifyChild(
    input({ cwd: repo.root }),
    deps(),
    async () => ({ block: block({ commits: [{ sha: repo.shaB, repo: repo.root }], filesChanged: ['never/existed.txt'] }), source: 'receipt' as const }),
  );
  const row = result.claims.find((claim) => claim.kind === 'file');
  assert.equal(row?.result, 'contradicted');
  assert.equal(result.verdict, 'contradicted');
});

test('--since: a sha reachable FROM the base verifies; an unreachable side-branch sha is contradicted', async () => {
  const repo = fixtureRepo('since-base');
  // Reachable: shaA (the base itself) is reachable from shaB (a descendant).
  const reachable = await verifyChild(
    input({ cwd: repo.root, since: repo.shaB }),
    deps(),
    async () => ({ block: block({ commits: [{ sha: repo.shaA, repo: repo.root }], filesChanged: [] }), source: 'receipt' as const }),
  );
  assert.equal(reachable.claims.find((claim) => claim.kind === 'commit')?.result, 'verified');
  assert.equal(reachable.verdict, 'verified');

  // Unreachable: the side-branch commit is NOT reachable from main.
  const unreachable = await verifyChild(
    input({ cwd: repo.root, since: 'main' }),
    deps(),
    async () => ({ block: block({ commits: [{ sha: repo.sideSha, repo: repo.root }], filesChanged: [] }), source: 'receipt' as const }),
  );
  assert.equal(unreachable.claims.find((claim) => claim.kind === 'commit')?.result, 'contradicted');
  assert.equal(unreachable.verdict, 'contradicted');
});

test('--rerun: a parent-named command that fails contradicts every claimed pass', async () => {
  const repo = fixtureRepo('failing-rerun');
  const result = await verifyChild(
    input({ cwd: repo.root, rerun: 'node -e "process.exit(3)"', rerunTimeoutMs: 30_000 }),
    deps(),
    async () => ({ block: block({ tests: [{ name: 'suite', result: 'pass' }] }), source: 'receipt' as const }),
  );
  const row = result.claims.find((claim) => claim.kind === 'test');
  assert.equal(row?.result, 'contradicted');
  assert.ok(row?.detail?.includes('3'));
  assert.equal(result.verdict, 'contradicted');
});

test('--rerun: an honest fail claim is CONFIRMED by a failing rerun (verified, not contradicted)', async () => {
  const repo = fixtureRepo('honest-fail');
  const result = await verifyChild(
    input({ cwd: repo.root, rerun: 'node -e "process.exit(1)"', rerunTimeoutMs: 30_000 }),
    deps(),
    async () => ({ block: block({ tests: [{ name: 'suite', result: 'fail' }] }), source: 'receipt' as const }),
  );
  assert.equal(result.claims.find((claim) => claim.kind === 'test')?.result, 'verified');
  assert.equal(result.verdict, 'verified');
});

test('--rerun timeout counts as failure (a hanging named command contradicts claimed passes)', async () => {
  const repo = fixtureRepo('rerun-timeout');
  const result = await verifyChild(
    input({ cwd: repo.root, rerun: 'sleep 5', rerunTimeoutMs: 400 }),
    deps(),
    async () => ({ block: block({ tests: [{ name: 'suite', result: 'pass' }] }), source: 'receipt' as const }),
  );
  assert.equal(result.claims.find((claim) => claim.kind === 'test')?.result, 'contradicted');
  assert.equal(result.verdict, 'contradicted');
});

test('status blocked without blockedReason is contradicted; with it, verified', async () => {
  const repo = fixtureRepo('blocked-reason');
  const bad = await verifyChild(input({ cwd: repo.root }), deps(), async () => ({
    block: block({ status: 'blocked', commits: [], filesChanged: [] }),
    source: 'receipt' as const,
  }));
  assert.equal(bad.claims.find((claim) => claim.kind === 'status')?.result, 'contradicted');
  assert.equal(bad.verdict, 'contradicted');

  const good = await verifyChild(input({ cwd: repo.root }), deps(), async () => ({
    block: block({ status: 'blocked', blockedReason: 'upstream API down', commits: [], filesChanged: [] }),
    source: 'receipt' as const,
  }));
  assert.equal(good.claims.find((claim) => claim.kind === 'status')?.result, 'verified');
  assert.equal(good.verdict, 'verified');
});

test('no completion at all is unverifiable, with the reason', async () => {
  const result = await verifyChild(input(), deps(), async () => ({ source: undefined }));
  assert.equal(result.verdict, 'unverifiable');
  assert.ok(result.summary.includes('no completion'));
});

test('a malformed block (typed parse error) is unverifiable and names the error code', async () => {
  const result = await verifyChild(input(), deps(), async () => ({
    source: 'receipt' as const,
    error: { code: 'SCHEMA_VIOLATION', message: 'bad schema', fieldPath: 'schema' },
  }));
  assert.equal(result.verdict, 'unverifiable');
  assert.ok(result.summary.includes('SCHEMA_VIOLATION'));
});

test('a block with only recorded claims (commands) is unverifiable: nothing independently checkable', async () => {
  const repo = fixtureRepo('commands-only');
  const result = await verifyChild(input({ cwd: repo.root }), deps(), async () => ({
    block: block({ commands: [{ command: 'ls', exitCode: 0 }] }),
    source: 'receipt' as const,
  }));
  assert.equal(result.verdict, 'unverifiable');
});

test('unsafe paths in filesChanged are unverifiable rows, never followed', async () => {
  const repo = fixtureRepo('unsafe-path');
  const result = await verifyChild(input({ cwd: repo.root }), deps(), async () => ({
    block: block({ commits: [{ sha: repo.shaB, repo: repo.root }], filesChanged: ['../../etc/passwd'] }),
    source: 'receipt' as const,
  }));
  const row = result.claims.find((claim) => claim.kind === 'file');
  assert.equal(row?.result, 'unverifiable');
  assert.ok(row?.detail?.includes('unsafe'));
});

test('verify never runs a mutating git command (read-only subcommand allow-list)', async () => {
  const deps = makeNodeVerifyDeps();
  await assert.rejects(() => deps.git(['push', 'origin', 'main'], { repo: '/tmp' }), /read-only/);
  await assert.rejects(() => deps.git(['commit', '-m', 'x'], { repo: '/tmp' }), /read-only/);
  await assert.rejects(() => deps.git(['clean', '-fd'], { repo: '/tmp' }), /read-only/);
  const okRead = await deps.git(['rev-parse', '--is-inside-work-tree'], { repo: fixtureRepo('allowlist').root });
  assert.equal(okRead.exitCode, 0);
});

test('missing repo directory is an unverifiable row, not a throw', async () => {
  const result = await verifyChild(input(), deps(), async () => ({
    block: block({ commits: [{ sha: 'abcdef1234567', repo: '/nonexistent/repo/path' }], filesChanged: [] }),
    source: 'receipt' as const,
  }));
  const row = result.claims.find((claim) => claim.kind === 'commit');
  assert.equal(row?.result, 'unverifiable');
  assert.equal(result.verdict, 'unverifiable');
});

// CLI surface: verdict → distinct exit codes.

test('CLI verify maps verdicts to exit codes 0/20/21', async () => {
  const { runCli } = await import('../src/cli.ts');
  const makeDeps = (verifyResult: Promise<Record<string, unknown>>) => ({
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'k',
    client: () => ({
      verify: () => verifyResult,
    }) as never,
  });
  const verified = await runCli(['verify', 's1', '--json'], makeDeps(Promise.resolve({ sessionId: 's1', verdict: 'verified', claims: [] })));
  assert.equal(verified.exitCode, 0);
  const contradicted = await runCli(['verify', 's1', '--json'], makeDeps(Promise.resolve({ sessionId: 's1', verdict: 'contradicted', claims: [] })));
  assert.equal(contradicted.exitCode, 20);
  const unverifiable = await runCli(['verify', 's1', '--json'], makeDeps(Promise.resolve({ sessionId: 's1', verdict: 'unverifiable', claims: [] })));
  assert.equal(unverifiable.exitCode, 21);
});

process.on('exit', () => {
  if (fixtureRoot && existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
});

// Keep the unused-var lint honest: COMPLETION_OK is a shape reference.
void COMPLETION_OK;
