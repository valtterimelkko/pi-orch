import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPLETION_REPORT_INSTRUCTION, applyCompletionTemplate } from '../src/completion-template.ts';

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
