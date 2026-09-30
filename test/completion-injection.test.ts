import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateBody, buildPromptBody } from '../src/builders.ts';
import { COMPLETION_REPORT_INSTRUCTION, applyCompletionTemplate } from '../src/completion-template.ts';

/**
 * C3b item 1: the template rides by default on every `prompt` message and on a
 * goal objective at `spawn`; `completionTemplate: false` (CLI
 * `--no-completion-template`) opts out. Injection lives in the pure builders,
 * so the client and CLI stay thin and the conformance tests stay server-free.
 */

test('create: a goal objective carries the template by default', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  const goal = body.goal as { objective: string };
  assert.equal(goal.objective, `Ship the fix\n\n${COMPLETION_REPORT_INSTRUCTION}`);
});

test('create: completionTemplate:false leaves the goal objective untouched', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', completionTemplate: false, goal: { objective: 'Ship the fix' } });
  const goal = body.goal as { objective: string };
  assert.equal(goal.objective, 'Ship the fix');
});

test('create: an objective that would overflow the server 4000-char limit with the template fails with a clear opt-out error', () => {
  const long = 'x'.repeat(3400);
  assert.throws(
    () => buildCreateBody({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: long } }),
    /completionTemplate|no-completion-template/,
  );
});

test('create: a non-goal spawn carries no template (there is no task text at spawn)', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/w' });
  assert.equal('goal' in body, false);
});

test('prompt: the message carries the template by default', () => {
  const body = buildPromptBody({ message: 'Please run the suite' }, () => 'k1');
  assert.equal(body.message, `Please run the suite\n\n${COMPLETION_REPORT_INSTRUCTION}`);
});

test('prompt: completionTemplate:false leaves the message untouched', () => {
  const body = buildPromptBody({ message: 'status?', completionTemplate: false }, () => 'k1');
  assert.equal(body.message, 'status?');
});

test('prompt: a message that already contains the template is not double-appended', () => {
  const message = applyCompletionTemplate('Please run the suite');
  const body = buildPromptBody({ message }, () => 'k1');
  assert.equal(body.message, message);
  assert.equal([...body.message.matchAll(/END-OF-TASK REPORT/g)].length, 1);
});
