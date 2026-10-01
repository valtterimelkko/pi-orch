import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPLETION_REPORT_INSTRUCTION, COMPLETION_FIELD_SHAPES, GOAL_MARKER_INSTRUCTION, GOAL_REPORT_INSTRUCTION, applyCompletionTemplate, applyGoalObjectiveTemplate } from '../src/completion-template.ts';
import { loadSnapshot } from '../src/snapshot.ts';
import { resolveCompletion, type CompletionBlock } from '../src/completion.ts';

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

/** Keys + required-ness + enum literals of an `Array<{ ... }>` snapshot type string. */
function itemShape(typeString: string): { keys: string[]; required: Set<string>; enums: Map<string, Set<string>> } {
  const inner = /\{(.*)\}/.exec(typeString)?.[1];
  assert.ok(inner, `cannot parse item shape from: ${typeString}`);
  const keys: string[] = [];
  const required = new Set<string>();
  const enums = new Map<string, Set<string>>();
  for (const part of inner.split(';').map((p) => p.trim()).filter(Boolean)) {
    const match = /^([A-Za-z]\w*)(\?)?: (.+)$/.exec(part);
    assert.ok(match, `cannot parse item field from: ${part}`);
    const key = match[1] as string;
    const opt = match[2] as string | undefined;
    const type = match[3] as string;
    keys.push(key);
    if (!opt) required.add(key);
    const literals = [...type.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((m): m is string => m !== undefined);
    if (literals.length > 0) enums.set(key, new Set(literals));
  }
  return { keys, required, enums };
}

 test('I5: a block written exactly as the goal template shows conforms to the snapshot schema and parses with the client resolver', () => {
  const { snapshot } = loadSnapshot({ env: {} });
  const fields = snapshot.types.CompletionBlock!.fields as Record<string, { type: string; optional?: boolean }>;
  const specOf = (key: string): { type: string; optional?: boolean } => {
    const spec = fields[key];
    assert.ok(spec, `snapshot CompletionBlock has no field '${key}'`);
    return spec;
  };
  // The fenced example the plain template shows (summary/commands/filesChanged):
  const baseMatch = /```completion\n([\s\S]*?)```/.exec(COMPLETION_REPORT_INSTRUCTION);
  assert.ok(baseMatch, 'the template carries its fenced example');
  const baseExample = JSON.parse(baseMatch[1] as string) as Record<string, unknown>;
  // …plus every field shape the goal form shows, merged into ONE candidate block.
  const shown = shownExamples(COMPLETION_FIELD_SHAPES);
  assert.ok(shown.length >= 7, `the shapes text shows ${shown.length} fields`);
  const block = Object.assign({}, ...shown, baseExample, { schema: 'pi-completion/v1', status: 'done' }) as Record<string, unknown>;

  // 1. every key is a field the snapshot schema knows; required ones present.
  for (const key of Object.keys(block)) {
    assert.ok(fields[key], `block field '${key}' does not exist on the snapshot CompletionBlock`);
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (!spec.optional) assert.ok(key in block, `required field '${key}' missing`);
  }
  // 2. each array-of-objects field matches the snapshot item shape exactly.
  for (const key of ['commands', 'tests', 'commits'] as const) {
    const shape = itemShape(specOf(key).type);
    assert.ok(Array.isArray(block[key]), `${key} is an array (never a string)`);
    for (const item of block[key] as Array<Record<string, unknown>>) {
      for (const itemKey of Object.keys(item)) {
        assert.ok(shape.keys.includes(itemKey), `${key} item key '${itemKey}' is not in the snapshot shape (${shape.keys.join(', ')})`);
      }
      for (const requiredKey of shape.required) assert.ok(requiredKey in item, `${key} item misses required '${requiredKey}'`);
      for (const [enumKey, allowed] of shape.enums) {
        assert.ok(allowed.has(String(item[enumKey])), `${key}.${enumKey}='${item[enumKey]}' not in {${[...allowed].join(', ')}}`);
      }
    }
  }
  for (const key of ['summary', 'filesChanged', 'openIssues', 'blockedReason'] as const) {
    if (block[key] !== undefined) {
      const type = specOf(key).type;
      if (type.endsWith('[]') || type === 'string[]') assert.ok(Array.isArray(block[key]), `${key} must be an array`);
      else assert.equal(typeof block[key], 'string', `${key} must be a string`);
    }
  }
  // 3. the client's own machinery accepts it: typed as CompletionBlock and
  // resolved through resolveCompletion (the receipt path) with no error.
  const resolved = resolveCompletion(
    { runId: 'r1', sessionId: 's1', completion: block as unknown as CompletionBlock, completionDelimiter: 'completion' },
    undefined,
  );
  assert.equal(resolved?.source, 'receipt');
  assert.deepEqual(resolved?.completion, block);
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
