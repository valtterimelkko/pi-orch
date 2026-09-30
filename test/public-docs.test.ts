import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../src/credentials.ts';

/**
 * Item 5 invariants: the public face must stay linked to Pi Web UI, the two
 * agent guides must stay byte-identical, and the package metadata must stay
 * publication-ready. These are the cheap guards; the release checklist in
 * AGENTS.md carries the rest.
 */

const README = readFileSync(join(packageRoot(), 'README.md'), 'utf8');

test('AGENTS.md and CLAUDE.md are byte-identical', () => {
  const agents = readFileSync(join(packageRoot(), 'AGENTS.md'), 'utf8');
  const claude = readFileSync(join(packageRoot(), 'CLAUDE.md'), 'utf8');
  assert.equal(agents, claude);
  assert.ok(agents.length > 1000, 'the maintainer guide is substantive');
});

test('the README is visibly linked to Pi Web UI (first screen, Requirements, See also)', () => {
  const link = 'https://github.com/valtterimelkko/pi-web-ui';
  const firstScreen = README.slice(0, 1500);
  assert.ok(firstScreen.includes(link), 'first screen links to Pi Web UI');
  const requirements = README.slice(README.indexOf('## Requirements'), README.indexOf('## Install'));
  assert.ok(requirements.includes(link), 'Requirements repeats the link');
  const seeAlso = README.slice(README.indexOf('## See also'));
  assert.ok(seeAlso.includes(link), 'See also repeats the link');
});

test('the README points at the public skill pack', () => {
  assert.ok(README.includes('https://github.com/valtterimelkko/agent-workflow-skills'));
});

test('the README states the security guard and that .gitignore is not the protection', () => {
  assert.ok(README.includes('CREDENTIAL_IN_REPO'));
  assert.match(README, /belt and braces, not the protection/);
  assert.match(README, /no `.env` file of any kind/);
});

test('LICENSE is MIT for Valtteri Melkko', () => {
  const licence = readFileSync(join(packageRoot(), 'LICENSE'), 'utf8');
  assert.match(licence, /^MIT License/);
  assert.match(licence, /Copyright \(c\) 2026 Valtteri Melkko/);
});

test('package.json is publication-ready metadata', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository && (pkg.repository as { url: string }).url.includes('github.com/valtterimelkko/pi-orch'), true);
  assert.equal(typeof pkg.homepage, 'string');
  assert.equal(typeof pkg.bugs, 'object');
  assert.equal(typeof pkg.engines, 'object');
  assert.ok(Array.isArray(pkg.keywords) && (pkg.keywords as string[]).length > 0);
  assert.equal(pkg.bin && (pkg.bin as Record<string, string>)['pi-orch'], 'bin/pi-orch');
  assert.equal((pkg.scripts as Record<string, string>).typecheck, 'node scripts/typecheck.mjs');
  assert.equal((pkg.devDependencies as Record<string, string>).typescript?.startsWith('^5.'), true);
  assert.equal((pkg.dependencies ?? undefined), undefined, 'zero runtime dependencies');
});
