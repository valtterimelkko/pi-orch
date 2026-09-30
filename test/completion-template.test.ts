import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { COMPLETION_REPORT_INSTRUCTION, applyCompletionTemplate } from '../src/completion-template.ts';

/**
 * C3b item 1: the dispatch template is ONE module constant, and the test pins
 * it to the paragraph C3a recorded verbatim (C3a.md correction 01 §1) — the
 * exact instruction live-proven at 16/16 parse rate on the server side. Two
 * pins: a verbatim in-test copy (portable) and, when the C3a evidence bundle
 * is reachable at its canonical lane path, the file itself (drift-proof).
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

const C3A_MD = '/root/.worktrees/orch-scaling/c3b-pi-web-ui/docs/plans/execution-reports/orchestration-scaling/C3a.md';

test('the template constant is the paragraph C3a recorded verbatim', () => {
  assert.equal(COMPLETION_REPORT_INSTRUCTION, VERBATIM_FROM_C3A);
});

test('when the C3a evidence bundle is reachable, the constant matches the FILE, not just the copy', () => {
  if (!existsSync(C3A_MD)) return; // portable pin above still holds
  const text = readFileSync(C3A_MD, 'utf8');
  const start = text.indexOf('```text\nEND-OF-TASK REPORT');
  assert.ok(start !== -1, 'C3a.md correction 01 carries the verbatim paragraph');
  const bodyStart = start + '```text\n'.length;
  const endSentinel = 'Nothing after the closing fence.';
  const end = text.indexOf(endSentinel, bodyStart);
  assert.ok(end !== -1);
  const fromFile = text.slice(bodyStart, end + endSentinel.length);
  assert.equal(COMPLETION_REPORT_INSTRUCTION, fromFile);
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
