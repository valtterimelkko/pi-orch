import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPLETION_REPORT_INSTRUCTION, COMPLETION_FIELD_SHAPES, GOAL_MARKER_INSTRUCTION, GOAL_REPORT_INSTRUCTION, applyCompletionTemplate, applyGoalObjectiveTemplate } from '../src/completion-template.ts';
import { loadSnapshot } from '../src/snapshot.ts';

/**
 * I5 (R4 interim): a goal child must write `Status: GOAL_ACHIEVED` on its own
 * line immediately BEFORE the report block, so the goal engine's verifier
 * sees the marker (it accepts the last status line anywhere in the message)
 * while the block stays the last thing — the two instructions no longer
 * conflict. And the goal form must show each optional field's exact shape,
 * so children stop writing schema-invalid blocks (IV: 7/7 blocks rejected
 * SCHEMA_VIOLATION fieldPath tests — `"tests": "4 pass / 0 fail"`, a string).
 * PLAIN prompts keep today's template text byte-identical (pinned above).
 */

/**
 * C3b item 1: the dispatch template is ONE module constant, and the test pins
 * it to the paragraph C3a recorded verbatim (C3a.md correction 01 §1) — the
 * exact instruction live-proven at 16/16 parse rate on the server side. Two
 * pins: a verbatim in-test copy (readable) and a committed fixture that keeps
 * the byte-pin after the C3a worktree is deleted (item 3: no host paths in
 * tests). The fixture carries its provenance in its own `source` field.
 */

const VERBATIM_FROM_C3A = [
  'END-OF-TASK REPORT (required): the LAST thing in your final answer must be exactly this kind of fenced block (info string `completion`, JSON body):',
  '',
  '```completion',
  '{"schema":"pi-completion/v1","status":"done","summary":"<one line>","commands":[{"command":"<a command you ran>","exitCode":0}],"filesChanged":["<path>"]}',
  '```',
  '',
  'Fill in the real values; add "tests", "commits", "openIssues" or "blockedReason" fields only if they apply. Do not end your turn with only a tool call: after your final tool call, always write a short final answer that ends with the report block. Nothing after the closing fence.',
].join('\n');

const FIXTURE = new URL('./fixtures/completion-instruction.json', import.meta.url);

test('the template constant is the paragraph C3a recorded verbatim', () => {
  assert.equal(COMPLETION_REPORT_INSTRUCTION, VERBATIM_FROM_C3A);
});

test('the constant matches the committed fixture byte for byte (drift-proof after the C3a worktree is gone)', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { source: string; paragraph: string };
  assert.ok(fixture.source.length > 0, 'the fixture carries its provenance');
  assert.equal(COMPLETION_REPORT_INSTRUCTION, fixture.paragraph);
});

test('the template names the schema, the fence info string and the last-thing rule', () => {
  assert.ok(COMPLETION_REPORT_INSTRUCTION.includes('pi-completion/v1'));
  assert.ok(COMPLETION_REPORT_INSTRUCTION.includes('```completion'));
  assert.ok(COMPLETION_REPORT_INSTRUCTION.includes('the LAST thing'));
});

test('applyCompletionTemplate appends the paragraph as its own trailing paragraph', () => {
  const out = applyCompletionTemplate('Fix the flaky test in module X.');
  assert.equal(out, `Fix the flaky test in module X.\n\n${COMPLETION_REPORT_INSTRUCTION}`);
  assert.ok(out.startsWith('Fix the flaky test in module X.\n\nEND-OF-TASK REPORT'));
});

test('applyCompletionTemplate is idempotent: an already-templated task is not double-appended', () => {
  const once = applyCompletionTemplate('Do the thing');
  assert.equal(applyCompletionTemplate(once), once);
});

test('applyCompletionTemplate rejects empty tasks', () => {
  assert.throws(() => applyCompletionTemplate(''), /non-empty/);
});

test('the template is bounded (a goal objective plus template must fit the server 4000-char limit)', () => {
  assert.ok(COMPLETION_REPORT_INSTRUCTION.length < 1000, `template is ${COMPLETION_REPORT_INSTRUCTION.length} chars`);
});

// ─── I5: the goal forms carry the marker instruction; plain form unchanged ───

test('I5: the PLAIN template stays free of the goal marker (plain prompts unchanged)', () => {
  assert.ok(!COMPLETION_REPORT_INSTRUCTION.includes('GOAL_ACHIEVED'), 'plain template must not mention the goal marker');
  assert.ok(!COMPLETION_REPORT_INSTRUCTION.includes('CONTINUING'), 'plain template must not mention CONTINUING');
});

test('I5: GOAL_MARKER_INSTRUCTION names both exact status lines, own line, immediately before the report block, plain text', () => {
  assert.ok(GOAL_MARKER_INSTRUCTION.includes('Status: GOAL_ACHIEVED'), 'exact achieved form');
  assert.ok(GOAL_MARKER_INSTRUCTION.includes('Status: CONTINUING'), 'exact continuing form');
  assert.ok(/immediately before the report block/i.test(GOAL_MARKER_INSTRUCTION), 'placement: immediately before the block');
  assert.ok(/own line/i.test(GOAL_MARKER_INSTRUCTION), 'must start its own line');
  assert.ok(/backtick|quote|bullet/i.test(GOAL_MARKER_INSTRUCTION), 'forbids decoration the verifier would not match');
});

test('I5: the goal objective pointer carries the marker instruction, still single-line and objective-first', () => {
  const out = applyGoalObjectiveTemplate('Ship the fix');
  assert.ok(out.includes('Status: GOAL_ACHIEVED'), 'pointer carries the exact achieved form');
  assert.ok(out.includes('Status: CONTINUING'), 'pointer carries the exact continuing form');
  assert.ok(/immediately before the report block/i.test(out), 'pointer states the placement');
  assert.ok(!out.includes('\n'), 'still single line (server rule)');
  assert.ok(out.startsWith('Ship the fix '), 'objective still comes first');
  assert.ok(out.includes('pi-completion/v1'), 'pointer still names the schema');
});

test('I5: the goal pointer is idempotent and stays in the 4000-char budget for realistic objectives', () => {
  const objective = 'x'.repeat(2700);
  const out = applyGoalObjectiveTemplate(objective);
  assert.ok(out.length <= 4000, `pointer is ${out.length} chars, server limit 4000`);
  assert.equal(applyGoalObjectiveTemplate(out), out, 'already-templated objective unchanged');
});

// ─── I5 correction 01: keep the objective budget (review minor, 2026-10-01) ──

test('I5 correction 01: the goal pointer suffix stays within a 700-character budget', () => {
  // The I5 pointer initially carried the flattened template + the full marker
  // instruction: 1,280 chars of suffix, shrinking the largest accepted raw
  // objective from 3,335 to 2,720. The pointer is a POINTER — the verbatim
  // instructions ride in the follow-up — so the suffix keeps only a concise
  // marker reminder plus the schema name and the follow-up promise.
  const out = applyGoalObjectiveTemplate('x');
  const suffix = out.length - 1;
  assert.ok(suffix <= 700, `pointer suffix is ${suffix} chars (budget 700)`);
});

test('I5 correction 01: the concise pointer still carries the marker reminder, schema name and follow-up promise', () => {
  const out = applyGoalObjectiveTemplate('Ship the fix');
  assert.ok(out.includes('Status: GOAL_ACHIEVED'), 'exact achieved form');
  assert.ok(out.includes('Status: CONTINUING'), 'exact continuing form');
  assert.ok(/immediately before the report block/i.test(out), 'placement');
  assert.ok(out.includes('pi-completion/v1'), 'schema name');
  assert.ok(out.includes('follow-up'), 'follow-up promise');
});

// ─── I5: the goal report instruction (follow-up) shows each field's shape ────

test('I5: GOAL_REPORT_INSTRUCTION = the verbatim template + the marker instruction + the field shapes', () => {
  assert.ok(GOAL_REPORT_INSTRUCTION.includes(COMPLETION_REPORT_INSTRUCTION), 'still carries the C3a-proven paragraph verbatim');
  assert.ok(GOAL_REPORT_INSTRUCTION.includes(GOAL_MARKER_INSTRUCTION), 'carries the marker instruction');
  assert.ok(GOAL_REPORT_INSTRUCTION.includes(COMPLETION_FIELD_SHAPES), 'carries the field shapes');
});

/** Each line of the shapes text that starts with `{` is one complete JSON object. */
function shownExamples(text: string): Array<Record<string, unknown>> {
  return text.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * I5 correction 01 — a recursive validator for the DISPLAYED examples, driven
 * by the bundled snapshot's CompletionBlock type descriptions (the snapshot's
 * zodSchemas cover only request bodies, so the type DSL is the schema view we
 * have; the server's zod parser is not a client dependency). Checks unknown
 * keys, required member keys inside displayed object/array items, scalar
 * member types (string/number), literal-union members (status, result) and
 * array-ness, field by field, recursively. Unlike the previous version of
 * this check, examples are validated ON THEIR OWN (no merging, so the shapes
 * text's own summary/commands/filesChanged specimens are actually checked)
 * and nothing is "validated" by casting to a type and selecting it with
 * resolveCompletion — the resolver only picks an already-typed object.
 */
function makeSnapshotValidator(fields: Record<string, { type: string; optional?: boolean }>) {
  const problems: string[] = [];
  function walk(value: unknown, type: string, path: string): void {
    const t = type.trim();
    if (t === 'typeof COMPLETION_SCHEMA_NAME') {
      // The snapshot carries the type reference, not the literal; the wire
      // literal is the schema name pi-completion/v1 (server constant).
      if (value !== 'pi-completion/v1') problems.push(`${path}: expected 'pi-completion/v1', got ${JSON.stringify(value)}`);
      return;
    }
    if (/^(?:'[^']*'\s*\|\s*)+'[^']*'$/.test(t)) {
      const literals = [...t.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((m): m is string => m !== undefined);
      if (!literals.includes(String(value))) problems.push(`${path}: ${JSON.stringify(value)} not in {${literals.join(' | ')}}`);
      return;
    }
    if (t === 'string') {
      if (typeof value !== 'string') problems.push(`${path}: expected string, got ${typeof value}`);
      return;
    }
    if (t === 'number') {
      if (typeof value !== 'number') problems.push(`${path}: expected number, got ${typeof value}`);
      return;
    }
    if (t === 'string[]') {
      if (!Array.isArray(value)) { problems.push(`${path}: expected array, got ${typeof value}`); return; }
      value.forEach((el, i) => walk(el, 'string', `${path}[${i}]`));
      return;
    }
    const arrayMatch = /^Array<([\s\S]+)>$/.exec(t);
    if (arrayMatch) {
      if (!Array.isArray(value)) { problems.push(`${path}: expected array, got ${typeof value}`); return; }
      value.forEach((el, i) => walk(el, arrayMatch[1] as string, `${path}[${i}]`));
      return;
    }
    const objectMatch = /^\{([\s\S]+)\}$/.exec(t);
    if (objectMatch) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`${path}: expected object, got ${typeof value}`);
        return;
      }
      const members = new Map<string, { opt: boolean; type: string }>();
      for (const part of (objectMatch[1] as string).split(';').map((s) => s.trim()).filter(Boolean)) {
        const match = /^([A-Za-z]\w*)(\?)?:\s*([\s\S]+)$/.exec(part);
        if (!match) { problems.push(`${path}: unparsable shape part '${part}'`); continue; }
        members.set(match[1] as string, { opt: match[2] === '?', type: match[3] as string });
      }
      const record = value as Record<string, unknown>;
      for (const [key, spec] of members) {
        if (!(key in record)) {
          if (!spec.opt) problems.push(`${path}.${key}: required by the schema, missing from the displayed example`);
          continue;
        }
        walk(record[key], spec.type, `${path}.${key}`);
      }
      for (const key of Object.keys(record)) {
        if (!members.has(key)) problems.push(`${path}.${key}: not part of the schema shape`);
      }
      return;
    }
    problems.push(`${path}: unparsable snapshot type '${t}'`);
  }
  return { walk, problems };
}

 test('I5 correction 01: every displayed example validates recursively against the snapshot schema, field by field', () => {
  const { snapshot } = loadSnapshot({ env: {} });
  const fields = snapshot.types.CompletionBlock!.fields as Record<string, { type: string; optional?: boolean }>;
  const { walk, problems } = makeSnapshotValidator(fields);
  // The fenced example the plain template shows (a complete block: schema,
  // status, summary, commands, filesChanged):
  const baseMatch = /```completion\n([\s\S]*?)```/.exec(COMPLETION_REPORT_INSTRUCTION);
  assert.ok(baseMatch, 'the template carries its fenced example');
  const baseExample = JSON.parse(baseMatch[1] as string) as Record<string, unknown>;
  // …and each field-shape line of the goal form, each validated ON ITS OWN —
  // no merging, so the shapes text's own summary/commands/filesChanged
  // specimens are checked (they used to be silently overwritten).
  const shown = shownExamples(COMPLETION_FIELD_SHAPES);
  assert.ok(shown.length >= 7, `the shapes text shows ${shown.length} fields`);
  const examples: Array<{ where: string; value: Record<string, unknown>; completeBlock: boolean }> = [
    { where: 'plain-template fenced example', value: baseExample, completeBlock: true },
    ...shown.map((value, i) => ({ where: `shapes line ${i + 1}`, value, completeBlock: false })),
  ];
  for (const { where, value, completeBlock } of examples) {
    for (const key of Object.keys(value)) {
      if (!fields[key]) problems.push(`${where}: field '${key}' does not exist on the snapshot CompletionBlock`);
    }
    // Required-field completeness only applies to the complete-block specimen;
    // each shapes line deliberately shows ONE field's shape.
    if (completeBlock) {
      for (const [key, spec] of Object.entries(fields)) {
        if (!spec.optional && !(key in value)) problems.push(`${where}: required field '${key}' missing`);
      }
    }
    for (const [key, v] of Object.entries(value)) {
      if (fields[key]) walk(v, fields[key].type, `${where}.${key}`);
    }
  }
  assert.deepEqual(problems, [], `displayed shapes violate the snapshot: ${problems.join('; ')}`);
});

test('I5 correction 01: the validator is sensitive — a deliberately wrong displayed shape is reported', () => {
  // Proves the walker checks scalar member types and enums, not just key
  // names: the exact escapes the previous merged-and-cast check allowed.
  const { snapshot } = loadSnapshot({ env: {} });
  const fields = snapshot.types.CompletionBlock!.fields as Record<string, { type: string; optional?: boolean }>;
  const first = makeSnapshotValidator(fields);
  first.walk([{ command: 7, exitCode: '0' }], fields.commands!.type, 'probe');
  assert.ok(first.problems.some((p) => p.includes('probe[0].exitCode') && p.includes('string')), `exitCode-as-string not caught: ${first.problems.join('; ')}`);
  assert.ok(first.problems.some((p) => p.includes('probe[0].command') && p.includes('number')), `numeric command not caught: ${first.problems.join('; ')}`);
  const second = makeSnapshotValidator(fields);
  second.walk([{ name: 'x', result: 'PASS' }], fields.tests!.type, 'probe2');
  assert.ok(second.problems.some((p) => p.includes('probe2[0].result')), `wrong enum literal not caught: ${second.problems.join('; ')}`);
});

test('I5: negative control — a string "tests" value (the live IV failure) fails the shape the template shows', () => {
  const bad = { schema: 'pi-completion/v1', status: 'done', tests: '4 pass / 0 fail' };
  assert.ok(!Array.isArray(bad.tests), 'the observed failure: tests as a string');
  const { snapshot } = loadSnapshot({ env: {} });
  const fields = snapshot.types.CompletionBlock!.fields as Record<string, { type: string }>;
  const testsType = fields.tests?.type;
  assert.ok(testsType, 'snapshot CompletionBlock has a tests field');
  assert.ok(testsType.startsWith('Array<'), 'the snapshot requires tests to be an array');
  const shapesShowArray = /"tests":\[\{"name"/.test(COMPLETION_FIELD_SHAPES);
  assert.ok(shapesShowArray, 'the template shows tests as an array of objects with a name field');
});

test('I5: the shapes text warns against the string form in plain words', () => {
  assert.ok(/never[\s\S]{0,40}string/i.test(COMPLETION_FIELD_SHAPES), 'says tests is never a string');
  assert.ok(/omit/i.test(COMPLETION_FIELD_SHAPES), 'says to omit fields that do not apply');
});

test('I5 (live round 1 finding): the goal form pins the fence format — JSON on its own line after a bare ```completion fence line', () => {
  // Live evidence (I5 round 1, 2026-10-01): 2/4 fixed-arm children wrote the
  // JSON on the SAME line as the opening fence ("```completion {json}"); the
  // server's opening-fence rule (/^[ ]{0,3}(`{3,})[ \t]*([a-z0-9_-]*)[ \t]*$/,
  // server/src/internal-api/completion/completion-parser.ts) never matches a
  // line with content after the info string, so no block was captured at all
  // (no completion, no error) — 2/4 fixed children lost their completion.
  assert.ok(/```completion[\s\S]{0,80}own line/i.test(GOAL_REPORT_INSTRUCTION), 'says the fence line must be exactly ```completion on its own');
  assert.ok(/next line/i.test(GOAL_REPORT_INSTRUCTION), 'says the JSON goes on the next line');
  // The PLAIN template already shows the correct multi-line fence; the new
  // sentence lives in the goal-form shapes text only (plain byte-pin holds).
  assert.ok(!COMPLETION_REPORT_INSTRUCTION.includes('own line'));
});
