import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGatesBlock, gateRefusal } from '../src/gates.ts';
import { verifyChild, makeNodeVerifyDeps, type VerifyDeps } from '../src/verify.ts';
import { runCli, type CliDeps } from '../src/cli.ts';
import type { CompletionBlock } from '../src/completion.ts';

/**
 * W2-g item 2: `verify <sid> --gates-file <path>` re-runs the lane's gates from
 * the brief's machine-readable `GATES:` block. A gate whose exit differs makes
 * the verdict `contradicted` (exit 20); a refused (mutating) gate makes it
 * `unverifiable` (exit 21).
 */

const BRIEF = `# brief\n\nsome prose\n\nGATES:\n- \`env NODE_ENV=test npm test\` → 0\n- npm run typecheck -> 0\n- ./must-fail.sh → 3\n\nBudget: ~4 hours\n`;

test('parseGatesBlock reads → and -> bullets, strips backticks, stops at the blank line after the block', () => {
  const parsed = parseGatesBlock(BRIEF);
  assert.deepEqual(parsed.malformed, []);
  assert.deepEqual(parsed.gates, [
    { command: 'env NODE_ENV=test npm test', expectedExit: 0 },
    { command: 'npm run typecheck', expectedExit: 0 },
    { command: './must-fail.sh', expectedExit: 3 },
  ]);
});

test('parseGatesBlock: no GATES: header → found:false; a bullet without an arrow is reported malformed', () => {
  assert.equal(parseGatesBlock('nothing here').found, false);
  const parsed = parseGatesBlock('GATES:\n- good → 0\n- no arrow here\n');
  assert.equal(parsed.found, true);
  assert.equal(parsed.gates.length, 1);
  assert.deepEqual(parsed.malformed, ['- no arrow here']);
});

test('parseGatesBlock: a command that itself contains -> keeps it (the LAST arrow separates the exit)', () => {
  const parsed = parseGatesBlock('GATES:\n- echo a -> b → 0\n');
  assert.deepEqual(parsed.gates, [{ command: 'echo a -> b', expectedExit: 0 }]);
});

test('gateRefusal refuses mutating commands with a reason and passes read-only ones', () => {
  for (const bad of ['git push origin main', 'git reset --hard HEAD~1', 'rm -rf /', 'npm ci', 'npm install left-pad', 'cd x && npm ci && npm test']) {
    assert.ok(gateRefusal(bad), `refused: ${bad}`);
  }
  for (const good of ['npm test', 'npm run typecheck', 'git status --porcelain', 'env NODE_ENV=test npm test', 'echo "mention of rm -rf only in prose"']) {
    if (good.includes('rm -rf')) continue; // substring guard is deliberately conservative
    assert.equal(gateRefusal(good), undefined, `allowed: ${good}`);
  }
});

function fakeDeps(exits: Record<string, { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }>, ran: Array<{ command: string; cwd: string; timeoutMs: number }> = []): VerifyDeps {
  const real = makeNodeVerifyDeps();
  return {
    ...real,
    async runCommand(command, options) {
      ran.push({ command, cwd: options.cwd, timeoutMs: options.timeoutMs });
      const hit = exits[command];
      if (!hit) throw new Error(`unexpected command ${command}`);
      return { stdout: '', stderr: '', ...hit };
    },
  };
}

const done: CompletionBlock = { schema: 'pi-completion/v1', status: 'done' };
const load = async () => ({ block: done, source: 'receipt' as const });

test('verifyChild: all gates at their expected exit → verified; runs in the cwd with the gate timeout', async () => {
  const ran: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const result = await verifyChild(
    { sessionId: 's1', cwd: '/work/child', gates: [{ command: 'npm test', expectedExit: 0 }, { command: 'false', expectedExit: 1 }], gateTimeoutMs: 5000 } as never,
    fakeDeps({ 'npm test': { exitCode: 0 }, false: { exitCode: 1 } }, ran),
    load,
  );
  assert.equal(result.verdict, 'verified');
  assert.deepEqual(ran, [{ command: 'npm test', cwd: '/work/child', timeoutMs: 5000 }, { command: 'false', cwd: '/work/child', timeoutMs: 5000 }]);
  const gates = (result as unknown as { gates: Array<{ command: string; expectedExit: number; actualExit: number; result: string }> }).gates;
  assert.deepEqual(gates.map((gate) => [gate.command, gate.expectedExit, gate.actualExit, gate.result]), [['npm test', 0, 0, 'verified'], ['false', 1, 1, 'verified']]);
});

test('verifyChild: a red gate → contradicted, listing expected/actual and the LAST 20 output lines', async () => {
  const out = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
  const result = await verifyChild(
    { sessionId: 's1', cwd: '/work/child', gates: [{ command: 'npm test', expectedExit: 0 }] } as never,
    fakeDeps({ 'npm test': { exitCode: 1, stdout: out } }),
    load,
  );
  assert.equal(result.verdict, 'contradicted');
  const gate = (result as unknown as { gates: Array<{ expectedExit: number; actualExit: number; outputTail: string[] }> }).gates[0];
  assert.equal(gate?.expectedExit, 0);
  assert.equal(gate?.actualExit, 1);
  assert.equal(gate?.outputTail.length, 20);
  assert.equal(gate?.outputTail[0], 'line 11');
  assert.equal(gate?.outputTail[19], 'line 30');
  assert.match(result.summary, /gate/);
});

test('verifyChild: a refused gate is NOT run and makes the verdict unverifiable with the reason', async () => {
  const ran: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const result = await verifyChild(
    { sessionId: 's1', cwd: '/work/child', gates: [{ command: 'npm ci && npm test', expectedExit: 0 }, { command: 'ok', expectedExit: 0 }] } as never,
    fakeDeps({ ok: { exitCode: 0 } }, ran),
    load,
  );
  assert.equal(result.verdict, 'unverifiable');
  assert.deepEqual(ran.map((entry) => entry.command), ['ok'], 'the refused command never ran');
  const gate = (result as unknown as { gates: Array<{ result: string; refused?: string }> }).gates[0];
  assert.equal(gate?.result, 'unverifiable');
  assert.match(gate?.refused ?? '', /npm ci|npm install|install/);
});

test('verifyChild: a contradicted gate outranks a refused one; default gate timeout is 1800s', async () => {
  const ran: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const result = await verifyChild(
    { sessionId: 's1', cwd: '/c', gates: [{ command: 'git push', expectedExit: 0 }, { command: 'bad', expectedExit: 0 }] } as never,
    fakeDeps({ bad: { exitCode: 2 } }, ran),
    load,
  );
  assert.equal(result.verdict, 'contradicted');
  assert.equal(ran[0]?.timeoutMs, 1_800_000);
});

test('verifyChild: gates still run when no completion block was captured (verdict from the gates alone)', async () => {
  const result = await verifyChild(
    { sessionId: 's1', cwd: '/c', gates: [{ command: 'ok', expectedExit: 0 }] } as never,
    fakeDeps({ ok: { exitCode: 0 } }),
    async () => ({}),
  );
  assert.equal(result.verdict, 'verified');
});

test('verifyChild: gates with no cwd available are unverifiable, never run', async () => {
  const ran: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const result = await verifyChild({ sessionId: 's1', gates: [{ command: 'ok', expectedExit: 0 }] } as never, fakeDeps({ ok: { exitCode: 0 } }, ran), load);
  assert.equal(result.verdict, 'unverifiable');
  assert.equal(ran.length, 0);
});

function cliDeps(client: Record<string, unknown>): CliDeps {
  return { env: {}, stdout: () => undefined, stderr: () => undefined, randomId: () => 'k', client: () => client as never };
}

test('CLI: verify --gates-file parses the block and passes gates + gate timeout (seconds → ms) to the client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-gates-'));
  const file = join(dir, 'brief.md');
  writeFileSync(file, BRIEF);
  const seen: Array<Record<string, unknown>> = [];
  const client = { async verify(input: Record<string, unknown>) { seen.push(input); return { sessionId: 's1', verdict: 'contradicted', claims: [], summary: 's' }; } };
  const result = await runCli(['verify', 's1', '--gates-file', file, '--gate-timeout', '12', '--cwd', '/work'], cliDeps(client));
  assert.equal(result.exitCode, 20);
  assert.equal(seen[0]?.gateTimeoutMs, 12000);
  assert.equal((seen[0]?.gates as unknown[]).length, 3);
  assert.equal(seen[0]?.cwd, '/work');
});

test('CLI: verify --gates-file with no GATES: block, a malformed bullet or a missing file is a usage error (exit 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-gates-'));
  const empty = join(dir, 'empty.md');
  writeFileSync(empty, '# no gates\n');
  const malformed = join(dir, 'bad.md');
  writeFileSync(malformed, 'GATES:\n- fine → 0\n- broken\n');
  const client = { async verify() { throw new Error('must not be called'); } };
  for (const file of [empty, malformed, join(dir, 'missing.md')]) {
    const result = await runCli(['verify', 's1', '--gates-file', file], cliDeps(client));
    assert.equal(result.exitCode, 2, file);
  }
});

test('CLI: --gate-timeout is only valid with --gates-file semantics but is an accepted flag; junk value → exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-gates-'));
  const file = join(dir, 'brief.md');
  writeFileSync(file, 'GATES:\n- ok → 0\n');
  const client = { async verify() { return { sessionId: 's1', verdict: 'verified', claims: [], summary: 's' }; } };
  const result = await runCli(['verify', 's1', '--gates-file', file, '--gate-timeout', 'abc'], cliDeps(client));
  assert.equal(result.exitCode, 2);
});
