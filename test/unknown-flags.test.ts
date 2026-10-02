import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, type CliDeps, HELP, parseArgs, allowedFlagsFor } from '../src/cli.ts';

/**
 * J2 P3: unknown flags must be a LOUD usage error (exit 2), never a silent
 * passthrough. Phase A live receipt: `spawn --goal-budget-tokens 60000000`
 * exited 0 while the flag was dropped and the goal armed with the 5M default
 * (replay/04 + the projection in 01-design.md §2) — parseArgs stored a flag no
 * verb reads. The rejection happens before the client factory, so a typo can
 * never reach the wire.
 *
 * The same test file pins the docs to the parser (01-answer.md guard): every
 * `pi-orch …` command line in README.md parses for its verb, and every flag
 * named in HELP is accepted by some verb — the docs cannot drift into usage
 * errors.
 */

function fakeDeps(): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'test-key-123',
    client: () => {
      throw new Error('no client expected: rejection must happen before the client factory');
    },
  };
}

test('unknown flag on a known verb exits 2 naming the flag, before any client use', async () => {
  const result = await runCli(['capabilities', '--budget-tokens', '5'], fakeDeps());
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? '', /--budget-tokens/);
});

test('the Phase A footgun shape now fails loudly: misspelled budget flag on spawn', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/x', '--goal-objective', 'O', '--goal-budgget-tokens', '60000000'],
    fakeDeps(),
  );
  assert.equal(result.exitCode, 2, 'the typo must be a usage error, not a silent 5M default');
  assert.match(result.stderr ?? '', /--goal-budgget-tokens/);
});

test('flags valid on one verb are rejected on verbs that do not read them', async () => {
  const result = await runCli(['capabilities', '--route-limit', 'zai/glm-5.3-flash=2'], fakeDeps());
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? '', /--route-limit/);
});

test('common connection flags are accepted on every verb (capabilities probe)', async () => {
  const result = await runCli(
    ['capabilities', '--socket', '/tmp/nope.sock', '--token-path', '/tmp/nope-token', '--api-base', 'http://127.0.0.1:1', '--json'],
    fakeDeps(),
  );
  // The client factory fails on a dead transport — that is AFTER validation,
  // which is all this test pins (exit 1 transport-style failure, not exit 2).
  assert.notEqual(result.exitCode, 2);
});

// ─── docs guard ──────────────────────────────────────────────────────────────

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fenced-block `pi-orch …` command lines from README.md, comments stripped. */
function readmeCommandLines(): string[] {
  const md = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const lines: string[] = [];
  let inFence = false;
  for (const raw of md.split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const line = raw.trim();
    if (!line.startsWith('pi-orch ') || line.includes('#')) continue; // skip comment-bearing snippets
    lines.push(line);
  }
  return lines;
}

test('docs guard: every README command line parses for its verb with no unknown flags', () => {
  const lines = readmeCommandLines();
  assert.ok(lines.length >= 5, `expected the README to show real commands, found ${lines.length}`);
  for (const line of lines) {
    const args = parseArgs(line.split(/\s+/).slice(1));
    assert.ok(allowedFlagsFor(args.verb) !== undefined, `README names unknown verb '${args.verb}': ${line}`);
    const allowed = allowedFlagsFor(args.verb) as Set<string>;
    const offenders = [...args.flags.keys(), ...args.repeatable.keys()].filter((name) => !allowed.has(name));
    assert.deepEqual(offenders, [], `README command uses flags its verb rejects (${offenders.join(', ')}): ${line}`);
  }
});

test('docs guard: every flag named in HELP is accepted by some verb', () => {
  const everyFlag = new Set<string>();
  for (const verb of ['capabilities', 'capacity', 'models', 'spawn', 'prompt', 'wait', 'result', 'verify', 'cleanup', 'status', 'goal', 'watch']) {
    for (const name of allowedFlagsFor(verb) as Set<string>) everyFlag.add(name);
  }
  const named = [...HELP.matchAll(/--([a-z][a-z0-9-]+)/g)].map((match) => match[1] as string);
  assert.ok(named.length >= 25, 'HELP documents a real flag surface');
  const drift = [...new Set(named)].filter((name) => !everyFlag.has(name));
  assert.deepEqual(drift, [], `HELP names flags no verb accepts: ${drift.map((f) => `--${f}`).join(', ')}`);
});
