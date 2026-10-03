import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/snapshot.ts';
import {
  buildCreateBody,
  buildPromptBody,
  buildWatchBody,
  agentEnd,
  goalEnd,
  goalPaused,
  questionSentinel,
  deadlineCondition,
  callerObjectiveConditions,
  goalObjectiveConditionForms,
} from '../src/builders.ts';
import { applyGoalObjectiveTemplate } from '../src/completion-template.ts';
import { ZodSpec } from '../src/zod-spec.ts';

/**
 * Request builders must be conformant with the server-derived snapshot's zod
 * descriptions: right keys, right enums, right bounds, no unknown keys (the
 * server schemas are `.strict()` — an extra key is a 400, never a passthrough).
 * The conformance walker itself is exercised here against the real snapshot.
 */

const { snapshot } = loadSnapshot({ env: {} });

const spec = new ZodSpec(snapshot.zodSchemas.createSessionBody!);

test('create body: happy path conforms to the snapshot zod description', () => {
  const body = buildCreateBody({
    runtime: 'pi',
    cwd: '/tmp/work/child-1',
    modelSelector: 'zai/glm-5.3-flash',
    thinkingLevel: 'low',
    retention: { mode: 'durable', ttlSeconds: 3600, ownerId: 'parent-x' },
    goal: { objective: 'Do the bounded thing', maxTurns: 10 },
    preflight: { paths: ['/tmp/work/child-1/brief.md'], tools: ['node'] },
  });
  const problems = spec.check(body);
  assert.deepEqual(problems, [], `conformance problems: ${JSON.stringify(problems)}`);
});

test('create body: every emitted key exists in the schema (strict server schema)', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/x' }) as Record<string, unknown>;
  const schemaKeys = Object.keys(snapshot.zodSchemas.createSessionBody!.fields ?? {});
  for (const key of Object.keys(body)) {
    assert.ok(
      schemaKeys.includes(key),
      `builder emitted '${key}' which the server schema does not accept`,
    );
  }
});

test('create body: rejects goals on runtimes that cannot take them', () => {
  assert.throws(
    () =>
      buildCreateBody({
        runtime: 'opencode',
        cwd: '/tmp/x',
        goal: { objective: 'nope' },
      }),
    /opencode/,
  );
  assert.throws(
    () =>
      buildCreateBody({
        runtime: 'antigravity',
        cwd: '/tmp/x',
        goal: { objective: 'nope' },
      }),
    /antigravity/,
  );
});

test('create body: bounds come from the snapshot, not from memory', () => {
  // objective > 4000 chars must throw (goalSpec max 4000)
  assert.throws(
    () => buildCreateBody({ runtime: 'pi', cwd: '/tmp/x', goal: { objective: 'x'.repeat(4001) } }),
    /objective/,
  );
  // ttlSeconds out of 1..604800 must throw
  assert.throws(
    () =>
      buildCreateBody({
        runtime: 'pi',
        cwd: '/tmp/x',
        retention: { mode: 'durable', ttlSeconds: 0, ownerId: 'o' },
      }),
    /ttlSeconds/,
  );
  assert.throws(
    () =>
      buildCreateBody({
        runtime: 'pi',
        cwd: '/tmp/x',
        retention: { mode: 'durable', ttlSeconds: 7 * 24 * 60 * 60 + 1, ownerId: 'o' },
      }),
    /ttlSeconds/,
  );
  // maxTurns out of 1..100 must throw
  assert.throws(
    () => buildCreateBody({ runtime: 'pi', cwd: '/tmp/x', goal: { objective: 'ok', maxTurns: 0 } }),
    /maxTurns/,
  );
});

test('prompt body: detach requires answers verbosity (server rule)', () => {
  assert.throws(
    () => buildPromptBody({ message: 'go', detach: true, verbosity: 'full' }),
    /detach/,
  );
  const body = buildPromptBody({ message: 'go', detach: true });
  assert.equal(body.verbosity, 'answers');
  assert.equal(body.detach, true);
});

test('prompt body: idempotency key bounds (1..128) and required message', () => {
  assert.throws(() => buildPromptBody({ message: 'x', idempotencyKey: '' }), /idempotencyKey/);
  assert.throws(
    () => buildPromptBody({ message: 'x', idempotencyKey: 'k'.repeat(129) }),
    /idempotencyKey/,
  );
  assert.throws(() => buildPromptBody({ message: '' }), /message/);
});

test('prompt body: defaults are detached-dispatch shaped (C3b: message ends with the completion template)', () => {
  const body = buildPromptBody({ message: 'hello child' });
  assert.equal(body.verbosity, 'answers');
  assert.equal(body.mode, 'prompt');
  assert.ok(typeof body.idempotencyKey === 'string' && body.idempotencyKey.length >= 1);
  assert.ok(
    typeof body.message === 'string' && body.message.startsWith('hello child\n\nEND-OF-TASK REPORT'),
    'C3b: the dispatched message carries the completion template by default',
  );
});

test('watch body: conditions non-empty; goal set uses goal_end + paused with the exact objective', () => {
  assert.throws(() => buildWatchBody({ conditions: [] }), /conditions/);
  const body = buildWatchBody({
    conditions: [goalEnd('Fix the widget'), goalPaused('Fix the widget'), questionSentinel('BLOCKED-NEEDS-INPUT')],
    fireIfSettled: true,
    label: 'c1-wait',
  });
  const conditions = body.conditions as Array<Record<string, unknown>>;
  assert.equal(conditions.length, 3);
  assert.equal(body.fireIfSettled, true);
  assert.equal(conditions[0]?.type, 'event_type');
  assert.deepEqual(conditions[0]?.dataMatch, { objective: 'Fix the widget' });
  assert.deepEqual(conditions[1]?.dataMatch, { objective: 'Fix the widget', status: 'paused' });
  assert.equal(conditions[2]?.type, 'text');
  assert.equal(conditions[2]?.contains, 'BLOCKED-NEEDS-INPUT');
});

test('watch body: deadline condition bounds (1..86400 int) and once:true default', () => {
  assert.throws(() => deadlineCondition(0), /afterSeconds/);
  assert.throws(() => deadlineCondition(86401), /afterSeconds/);
  const condition = deadlineCondition(120);
  assert.equal(condition.type, 'deadline');
  assert.equal(condition.afterSeconds, 120);
  assert.notEqual(condition.once, false);
});

test('watch body: plain agent_end is the default condition shape', () => {
  const condition = agentEnd();
  assert.deepEqual(condition, { id: condition.id, type: 'event_type', eventType: 'agent_end', once: true });
  const goalCondition = goalEnd('obj');
  assert.equal(goalCondition.eventType, 'goal_end');
  assert.equal(goalPaused('obj').eventType, 'goal_state');
});

// ─── I1 criterion 2: a CALLER objective must match BOTH its raw and its ──────
// ─── stored (templated) form ─────────────────────────────────────────────

// Root cause (r4/rootcause-goal-idle.md §2 defect 1): `spawn --goal-objective
// "X"` stores the objective as applyGoalObjectiveTemplate("X") (the flattened
// completion-report pointer rides along), and the server matches goal_end
// dataMatch.objective by strict ===. A wait given the RAW "X" can therefore
// never fire — the G5 parent's goal was in fact achieved at 19:08:41 and the
// driver still ran to its deadline. Fix: the caller-objective condition set
// matches BOTH forms (deterministic — the same pure function spawn used —
// and race-free: it needs no projection read, which can lag the goal
// engine's registration on a fresh spawn). A wait given the exact stored
// form keeps working (single form; the raw variant would never fire and is
// not registered). An auto-DETECTED objective comes from the projection and
// is already the stored form — it keeps the single-form defaultConditions.

test('I1: goalObjectiveConditionForms expands a raw objective to raw + templated forms', () => {
  const raw = 'Ship the fix';
  const forms = goalObjectiveConditionForms(raw);
  assert.deepEqual(forms, [raw, applyGoalObjectiveTemplate(raw)]);
  assert.equal(forms.length, 2, 'raw + stored forms');
  assert.ok(forms.includes(applyGoalObjectiveTemplate(raw)), 'the stored form is registered');
});

test('I1: goalObjectiveConditionForms passes an already-templated objective through as ONE form', () => {
  const stored = applyGoalObjectiveTemplate('Ship the fix');
  assert.deepEqual(goalObjectiveConditionForms(stored), [stored], 'the stored form must not grow a second pointer');
});

test('I1: callerObjectiveConditions registers goal_end + paused + auto-continue for BOTH forms plus the deadline', () => {
  const raw = 'Ship the fix';
  const conditions = callerObjectiveConditions(raw, 120_000);
  const goalEnds = conditions.filter((condition) => condition.eventType === 'goal_end');
  const paused = conditions.filter((condition) => condition.eventType === 'goal_state' && (condition.dataMatch as Record<string, unknown>).status === 'paused');
  const autoContinue = conditions.filter((condition) => condition.eventType === 'goal_state' && (condition.dataMatch as Record<string, unknown>).autoContinued === true);
  const deadlines = conditions.filter((condition) => condition.type === 'deadline');
  assert.deepEqual(goalEnds.map((condition) => (condition.dataMatch as { objective: string }).objective), [raw, applyGoalObjectiveTemplate(raw)]);
  assert.deepEqual(paused.map((condition) => (condition.dataMatch as { objective: string }).objective), [raw, applyGoalObjectiveTemplate(raw)]);
  assert.deepEqual(autoContinue.map((condition) => (condition.dataMatch as { objective: string }).objective), [raw, applyGoalObjectiveTemplate(raw)], 'one Wave K auto-continue condition per objective form');
  assert.equal(deadlines.length, 1, 'one deadline backstop');
  assert.equal(goalEnds[0]?.once, false, 'goal conditions repeat, as before');
});

test('I1: callerObjectiveConditions with an already-templated objective registers ONE goal form (unchanged shape)', () => {
  const stored = applyGoalObjectiveTemplate('Ship the fix');
  const conditions = callerObjectiveConditions(stored, 120_000);
  const goalEnds = conditions.filter((condition) => condition.eventType === 'goal_end');
  assert.equal(goalEnds.length, 1);
  assert.equal((goalEnds[0]?.dataMatch as { objective: string }).objective, stored);
});

test('I1: callerObjectiveConditions without an objective is the plain agent_end + deadline set', () => {
  const conditions = callerObjectiveConditions(undefined, 120_000);
  assert.equal(conditions.filter((condition) => condition.eventType === 'agent_end').length, 1);
  assert.equal(conditions.filter((condition) => condition.type === 'deadline').length, 1);
  assert.equal(conditions.some((condition) => condition.eventType === 'goal_end'), false);
});

// ─── J2 P1: goal budgetTokens ────────────────────────────────────────────────
// The I1–I4 lesson and hb5 (DeepSeek needed ~40M): the 5M default budget
// pauses long goals mid-run. Phase A live receipt: --goal-budget-tokens was
// silently dropped (exit 0, projection showed budget.tokens 5,000,000). The
// builder must carry the caller's budget and validate it loudly.

test('J2 P1: goal budgetTokens reaches the create-goal body (60M zai lanes)', () => {
  const body = buildCreateBody({
    runtime: 'pi',
    cwd: '/tmp/work/child-1',
    goal: { objective: 'Ship the fix', maxTurns: 40, budgetTokens: 60_000_000 },
  });
  const goal = body.goal as { budgetTokens?: number };
  assert.equal(goal.budgetTokens, 60_000_000);
  const problems = new ZodSpec(snapshot.zodSchemas.goalSpec!).check(body.goal);
  assert.deepEqual(problems, [], 'the budgeted goal body still conforms to the server goalSpec');
});

test('J2 P1: goal budgetTokens validation — integer, positive, typo-proof ceiling', () => {
  assert.throws(() => buildCreateBody({ runtime: 'pi', cwd: '/tmp/x', goal: { objective: 'o', budgetTokens: 0 } }));
  assert.throws(() => buildCreateBody({ runtime: 'pi', cwd: '/tmp/x', goal: { objective: 'o', budgetTokens: -5 } }));
  assert.throws(() => buildCreateBody({ runtime: 'pi', cwd: '/tmp/x', goal: { objective: 'o', budgetTokens: 1.5 } }));
  assert.throws(() => buildCreateBody({ runtime: 'pi', cwd: '/tmp/x', goal: { objective: 'o', budgetTokens: 1_000_000_000_000 } }), /ceiling/);
});

test('J2 P1: without budgetTokens the key stays absent (server default applies untouched)', () => {
  const body = buildCreateBody({ runtime: 'pi', cwd: '/tmp/x', goal: { objective: 'o' } });
  const goal = body.goal as Record<string, unknown>;
  assert.equal('budgetTokens' in goal, false);
});
