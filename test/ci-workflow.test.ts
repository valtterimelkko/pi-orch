import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../src/credentials.ts';

/**
 * Owner CI cost rule (2026-09-30): CI only in public repos, ubuntu-latest
 * only, push + pull_request only, every job bounded by a timeout and a
 * cancelling concurrency group, minimal matrix. This test is that guard.
 */

const WORKFLOW = join(packageRoot(), '.github', 'workflows', 'ci.yml');

function workflowText(): string {
  return readFileSync(WORKFLOW, 'utf8');
}

/** Job blocks of a GitHub Actions workflow, by indentation (no YAML dep). */
function jobBlocks(text: string): Array<{ name: string; body: string }> {
  const jobsStart = text.indexOf('\njobs:');
  assert.notEqual(jobsStart, -1, 'workflow has a jobs: section');
  const jobsText = text.slice(jobsStart);
  const starts = [...jobsText.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < starts.length ? (starts[index + 1]?.index ?? jobsText.length) : jobsText.length;
    return { name: match[1] as string, body: jobsText.slice(start, end) };
  });
}

test('CI triggers on push and pull_request only — never a schedule or workflow_run', () => {
  const text = workflowText();
  assert.match(text, /^on:\n {2}push:/m);
  assert.match(text, /^ {2}pull_request:/m);
  assert.equal(/^ {2}schedule:/m.test(text), false, 'no cron jobs (owner CI cost rule)');
  assert.equal(/workflow_run/.test(text), false, 'no workflow_run chains');
});

test('every CI job is bounded: ubuntu-latest, a timeout, and group cancellation', () => {
  const text = workflowText();
  const jobs = jobBlocks(text);
  assert.ok(jobs.length >= 2, `test + gitleaks jobs; found ${jobs.length}`);
  for (const job of jobs) {
    assert.match(job.body, /^ {4}runs-on: ubuntu-latest$/m, `${job.name} runs on ubuntu-latest`);
    assert.match(job.body, /^ {4}timeout-minutes: \d+$/m, `${job.name} has a timeout-minutes`);
  }
  assert.match(text, /^concurrency:\n {2}group: .+\n {2}cancel-in-progress: true$/m);
  assert.equal(/self-hosted|macos|windows|larger/.test(text), false, 'no paid or self-hosted runners');
});

test('the test job covers Node 22 and 24, and nothing more', () => {
  const text = workflowText();
  const testJob = jobBlocks(text).find((job) => job.name === 'test');
  assert.ok(testJob, 'a test job exists');
  const versions = [...testJob.body.matchAll(/'(\d+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(versions)].sort(), ['22', '24']);
});

test('the gitleaks job scans the full history', () => {
  const text = workflowText();
  const job = jobBlocks(text).find((entry) => entry.name === 'gitleaks');
  assert.ok(job, 'a gitleaks job exists');
  assert.match(job.body, /fetch-depth: 0/, 'full history is fetched');
  assert.match(job.body, /gitleaks git --redact/, 'the scan is redacted');
});

test('the gitleaks download is pinned to the official sha256 and verified before extracting', () => {
  // Correction 01 item 3: checksum from the official
  // gitleaks_8.30.1_checksums.txt release asset, verified with sha256sum -c.
  const job = jobBlocks(workflowText()).find((entry) => entry.name === 'gitleaks');
  assert.ok(job, 'a gitleaks job exists');
  assert.match(job.body, /gitleaks_8\.30\.1_linux_x64\.tar\.gz/, 'pinned release asset');
  assert.match(
    job.body,
    /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/,
    'the official sha256 digest is present',
  );
  assert.match(job.body, /sha256sum -c/, 'the digest is checked before extracting');
  const checksumAt = job.body.indexOf('sha256sum -c');
  const extractAt = job.body.indexOf('tar -xzf');
  assert.ok(checksumAt !== -1 && extractAt !== -1 && checksumAt < extractAt, 'verification precedes extraction');
});
