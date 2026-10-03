import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

// ─── 02-correction [minor] 5: --slice is a deprecated no-op ──────────────────

test('02-correction 5: wait accepts --slice as a deprecated no-op with a stderr note', async () => {
  const result = await runCli(
    ['wait', 's1', '--slice', '30', '--json'],
    {
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      randomId: () => 'k',
      client: () => ({
        wait: async () => ({ kind: 'completed' }),
      }) as never,
    },
  );
  assert.equal(result.exitCode, 0, 'accepted, never a usage error');
  assert.match(result.stderr ?? '', /--slice/, 'the note names the flag');
  assert.match(result.stderr ?? '', /no-op/, 'the note says it does nothing');
});

test('02-correction 5: HELP no longer documents --slice', () => {
  assert.equal(/--slice/.test(HELP), false, 'the dead flag is out of the usage text');
});

// ─── 02-correction [minor] 6: the docs guard gets per-verb teeth ────────────
// The union check above cannot catch a flag documented under the WRONG verb.
// Parse HELP per verb (the Verbs block incl. continuation lines, and the
// Spawn/Prompt/Wait flag sections), scan README fences with backslash
// continuations and $(...) substitutions joined, and scan the canonical
// skills read-only (report-only: the parent fixes skills, not this repo).

type HelpVerbs = Map<string, Set<string>>;

function helpFlagsPerVerb(help: string): HelpVerbs {
  const known = ['capabilities', 'capacity', 'models', 'spawn', 'prompt', 'wait', 'result', 'verify', 'cleanup', 'status', 'goal', 'watch'];
  const perVerb: HelpVerbs = new Map(known.map((verb) => [verb, new Set<string>()]));
  const lines = help.split('\n');
  let currentVerbBlock: string | null = null;
  let currentSection: string | null = null; // 'verbs' | 'spawn' | 'prompt' | 'wait' | 'common' | null
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (line.startsWith('Verbs:')) { currentSection = 'verbs'; continue; }
    if (line.startsWith('Scripting:')) { currentSection = null; continue; }
    if (line.startsWith('Common flags:')) { currentSection = 'common'; continue; }
    if (line.startsWith('Spawn flags:')) { currentSection = 'spawn'; currentVerbBlock = null; continue; }
    if (line.startsWith('Prompt flags:')) { currentSection = 'prompt'; currentVerbBlock = null; continue; }
    if (line.startsWith('Wait flags:')) { currentSection = 'wait'; currentVerbBlock = null; continue; }
    if (line.startsWith('Exit codes:')) { currentSection = null; continue; }
    if (currentSection === null) continue;
    const trimmed = line.trim();
    if (currentSection === 'verbs') {
      const verbMatch = trimmed.match(new RegExp(`^(${known.join('|')})\\b`));
      if (verbMatch) currentVerbBlock = verbMatch[1] as string;
      if (currentVerbBlock && perVerb.has(currentVerbBlock)) {
        for (const match of trimmed.matchAll(/--([a-z][a-z0-9-]+)/g)) perVerb.get(currentVerbBlock)?.add(match[1] as string);
      }
      continue;
    }
    if (currentSection === 'common') {
      // common flags are checked implicitly: every verb's set already includes them
      continue;
    }
    if (currentSection === 'spawn' || currentSection === 'prompt' || currentSection === 'wait') {
      for (const match of trimmed.matchAll(/--([a-z][a-z0-9-]+)/g)) perVerb.get(currentSection)?.add(match[1] as string);
    }
  }
  return perVerb;
}

test('02-correction 6: every flag documented under a verb in HELP is allowed FOR THAT VERB', () => {
  const perVerb = helpFlagsPerVerb(HELP);
  const common = ['socket', 'token-path', 'api-base', 'parent-session', 'json', 'snapshot', 'help'];
  let parsedTokens = 0;
  for (const [verb, documented] of perVerb) {
    const allowed = allowedFlagsFor(verb) as Set<string>;
    const offenders = [...documented].filter((name) => !allowed.has(name) && !common.includes(name));
    assert.deepEqual(offenders, [], `HELP documents flags under '${verb}' that the verb rejects: ${offenders.map((f) => `--${f}`).join(', ')}`);
    parsedTokens += documented.size;
  }
  assert.ok(parsedTokens >= 25, `the per-verb parser read a real flag surface (${parsedTokens} tokens)`);
  // The strict check must have teeth: spawn documents --goal-budget-tokens,
  // and wait must NOT inherit spawn's flags.
  assert.equal(perVerb.get('wait')?.has('goal-budget-tokens'), false);
});

/** README/skills fences: join backslash continuations, keep $(...) lines. */
function fencedLogicalLines(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let buffer = '';
  for (const raw of markdown.split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      inFence = !inFence;
      if (!inFence && buffer) { out.push(buffer); buffer = ''; }
      continue;
    }
    if (!inFence) continue;
    let line = raw.trim();
    if (line.endsWith('\\')) { line = line.slice(0, -1).trim(); buffer += (buffer ? ' ' : '') + line; continue; }
    buffer += (buffer ? ' ' : '') + line;
    out.push(buffer);
    buffer = '';
  }
  if (buffer) out.push(buffer);
  return out.filter((line) => line.includes('pi-orch ') || line.includes('pi-orch\n') || /\$\{?PO\}?/.test(line));
}

/** Extract every pi-orch command (verb + flags) from a logical line. $PO and ${PO} (the skills' alias for the pi-orch binary) are substituted first; ';' separates multiple commands on one line. */
function piOrchCommands(rawLine: string): Array<{ verb: string; flags: string[] }> {
  const line = rawLine.replace(/\$\{PO\}/g, 'pi-orch').replace(/\$PO\b/g, 'pi-orch');
  const commands: Array<{ verb: string; flags: string[] }> = [];
  for (const segment of line.split(';')) {
    for (const match of segment.matchAll(/pi-orch\s+([^;|&`]*?)(?=\s*(?:\)|`|$))/g)) {
      const rest = (match[1] as string).replace(/^\$\(/, '').trim();
      if (!rest) continue;
      const words = rest.split(/\s+/);
      const verb = words[0] as string;
      const flags = [...rest.matchAll(/(?:^|\s)--([a-z][a-z0-9-]+)/g)].map((flag) => flag[1] as string);
      commands.push({ verb, flags });
    }
  }
  return commands;
}

function checkCommands(lines: string[], source: string): string[] {
  const offenders: string[] = [];
  for (const line of lines) {
    for (const command of piOrchCommands(line)) {
      const allowed = allowedFlagsFor(command.verb);
      if (!allowed) { offenders.push(`${source}: unknown verb '${command.verb}' in: ${line}`); continue; }
      const bad = command.flags.filter((name) => !allowed.has(name));
      if (bad.length > 0) offenders.push(`${source}: '${command.verb}' rejects ${bad.map((f) => `--${f}`).join(', ')} in: ${line}`);
    }
  }
  return offenders;
}

test('02-correction 6: README fences parse per verb WITH continuations and $() substitutions', () => {
  const md = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const lines = fencedLogicalLines(md);
  assert.ok(lines.some((line) => line.includes('$(')), 'the README quickstart uses command substitutions and they are scanned');
  assert.ok(lines.some((line) => line.includes(' --owner')), 'multi-line commands are joined before scanning');
  const offenders = checkCommands(lines, 'README');
  assert.deepEqual(offenders, [], `README command lines the parser rejects:\n${offenders.join('\n')}`);
});

test('02-correction 6: canonical skills scan (read-only, report-only, skips when absent)', () => {
  const skillsRoot = '/root/.skills-global/skills-global';
  const targets = [
    'pi-web-ui-internal-api-orchestration/SKILL.md',
    'long-horizon-waiting-strategies/SKILL.md',
    'agent-os-child/SKILL.md',
  ];
  const references = ['pi-web-ui-internal-api-orchestration/references', 'long-horizon-waiting-strategies/references'];
  const files: string[] = [];
  for (const rel of targets) {
    try { readFileSync(join(skillsRoot, rel), 'utf8'); files.push(rel); } catch { /* absent: CI portability */ }
  }
  for (const dir of references) {
    try {
      for (const name of (readdirSync(join(skillsRoot, dir)) as string[]).filter((f) => f.endsWith('.md'))) files.push(`${dir}/${name}`);
    } catch { /* absent */ }
  }
  if (files.length === 0) return; // skip silently on CI (host-independent suite)
  const offenders: string[] = [];
  for (const rel of files) {
    const md = readFileSync(join(skillsRoot, rel), 'utf8');
    offenders.push(...checkCommands(fencedLogicalLines(md), `skills/${rel}`));
  }
  // Report-only BY DECISION (02-correction item 6): the parent fixes skills;
  // this repo must not edit them. Failures are printed and recorded in
  // complete.md, so a drifted skill line is still visible in CI output.
  if (offenders.length > 0) {
    console.error(`PI-ORCH SKILLS SCAN — command lines for the PARENT to fix (${offenders.length}):\n${offenders.join('\n')}`);
  }
});

test('04-correction C: alias invocations ($PO, ${PO}) in the canonical skills parse with 0 unknown flags', () => {
  const skillsRoot = '/root/.skills-global/skills-global';
  const files = ['pi-web-ui-internal-api-orchestration/SKILL.md'];
  const aliasCommands: Array<{ verb: string; flags: string[] }> = [];
  let scanned = 0;
  for (const rel of files) {
    let md: string;
    try { md = readFileSync(join(skillsRoot, rel), 'utf8'); } catch { continue; } // absent: CI portability
    scanned += 1;
    for (const line of fencedLogicalLines(md)) {
      if (!/\$\{?PO\}?/.test(line)) continue;
      // The universal $PO/${PO} substitution inside piOrchCommands maps the
      // alias to pi-orch; each logical line may carry several commands (;).
      for (const command of piOrchCommands(line)) {
        aliasCommands.push(command);
        const allowed = allowedFlagsFor(command.verb);
        if (!allowed) { aliasCommands.push({ verb: `UNKNOWN-${command.verb}`, flags: [] }); continue; }
        const bad = command.flags.filter((name) => !allowed.has(name));
        if (bad.length > 0) aliasCommands.push({ verb: `OFFENDER-${command.verb}`, flags: bad });
      }
    }
  }
  // K4 item 3 (robust assertion, no magic count): the skill's set of $PO
  // examples grows and shrinks with the skill's own edits — the invariant the
  // client owns is that EVERY alias command line parses with 0 unknown
  // verbs/flags, and that the scan actually saw at least one. The skill is
  // never edited to satisfy this test.
  const parsed = aliasCommands.filter((command) => !command.verb.startsWith('UNKNOWN-') && !command.verb.startsWith('OFFENDER-'));
  const offenders = aliasCommands.filter((command) => command.verb.startsWith('UNKNOWN-') || command.verb.startsWith('OFFENDER-'));
  console.error(`PI-ORCH SKILLS ALIAS SCAN: parsed ${parsed.length} alias command(s); offenders: ${offenders.length}`);
  if (scanned > 0) {
    assert.ok(parsed.length >= 1, `expected at least one $PO alias example in the canonical skill to scan and parse, got ${parsed.length}`);
    assert.equal(offenders.length, 0, `alias lines with unknown verbs/flags: ${JSON.stringify(offenders)}`);
  }
});
