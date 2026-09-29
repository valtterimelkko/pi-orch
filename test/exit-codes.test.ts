import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXIT_CODES, OUTCOME_EXIT_CODES, exitCodeFor, nameFor } from '../src/exit-codes.ts';

/**
 * The exit-code table is a documented contract with the shell-calling model.
 * It has a single source in code (EXIT_CODES / OUTCOME_EXIT_CODES) and the
 * README table must stay in sync with it — this test is that guard.
 */

test('exit codes are unique and stable for the reserved values', () => {
  const seen = new Map<number, string>();
  for (const entry of EXIT_CODES) {
    const existing = seen.get(entry.code);
    assert.equal(existing, undefined, `duplicate exit code ${entry.code}: ${existing} vs ${entry.name}`);
    seen.set(entry.code, entry.name);
  }
  assert.equal(nameFor(0), 'OK');
  assert.equal(nameFor(2), 'USAGE');
});

test('every wait outcome has a mapped exit code', () => {
  for (const [kind, code] of Object.entries(OUTCOME_EXIT_CODES)) {
    assert.equal(typeof code, 'number', `outcome ${kind} maps to a number`);
    assert.ok(nameFor(code), `exit code ${code} for ${kind} is documented in EXIT_CODES`);
  }
});

test('the README exit-code table matches the code table exactly', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Exit codes'));
  for (const entry of EXIT_CODES) {
    assert.ok(
      section.includes(`| ${entry.code} | \`${entry.name}\` |`),
      `README exit-code table is missing | ${entry.code} | \`${entry.name}\` | — update README when changing exit codes`,
    );
  }
  // And the other direction: no documented code that the table does not know.
  const rows = [...section.matchAll(/^\| (\d+) \| `([A-Z_]+)` \|/gm)].map((match) => ({
    code: Number(match[1]),
    name: match[2],
  }));
  assert.equal(rows.length, EXIT_CODES.length, 'README documents a different number of exit codes than the table defines');
});

test('exitCodeFor maps outcomes through the table', () => {
  assert.equal(exitCodeFor({ kind: 'completed' }), 0);
  assert.equal(exitCodeFor({ kind: 'never_started' }), OUTCOME_EXIT_CODES.never_started);
});
