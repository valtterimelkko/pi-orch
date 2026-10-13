import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiOrchClient } from '../src/client.ts';
import { runCli, type CliDeps } from '../src/cli.ts';
import { COMPLETION_REPORT_INSTRUCTION, GOAL_REPORT_INSTRUCTION } from '../src/completion-template.ts';
import { tempLedgerPath } from './isolated-ledger.ts';

/**
 * W2-g item 1: a goal child's full report instructions no longer ride as a
 * queued follow-up by default. The objective keeps the short pointer; the
 * full text is `pi-orch template [--goal]`; `--template-follow-up` /
 * `templateFollowUp: true` restores the C3b follow-up (and with it exit 22).
 */

function ok(body: unknown) {
  return { status: 200, headers: {}, body, raw: JSON.stringify(body) };
}

function recordingClient() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (_method: string, path: string, options: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: options.body ?? {} });
      if (path === '/api/v1/sessions') return ok({ sessionId: 's-goal', retention: {} });
      if (path.endsWith('/goal')) return ok({ sessionId: 's-goal', action: 'start', accepted: true, applied: true, receipt: { runId: 'arm-1' }, goal: { status: 'running' } });
      if (path.endsWith('/prompt')) return ok({ runId: 'r-follow', sessionId: 's-goal', detached: true, dispatchMode: 'follow_up' });
      if (path.startsWith('/api/v1/runs/')) return ok({ runId: 'r-follow', status: 'queued' });
      if (path === '/api/v1/sessions/s-goal') return ok({ sessionId: 's-goal', runtime: 'pi', busy: true });
      throw new Error(`unexpected ${path}`);
    },
  } as never;
  const client = new PiOrchClient({ spawnLedgerPath: tempLedgerPath(), transportInstance: transport, randomId: () => 'k1', templateFollowUpCheckDelayMs: 1 });
  return { calls, client };
}

const prompts = (calls: Array<{ path: string }>) => calls.filter((call) => call.path.endsWith('/prompt'));

test('W2-g: spawn with a goal sends NO template follow-up by default (pointer objective only)', async () => {
  const { calls, client } = recordingClient();
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' } });
  assert.equal(prompts(calls).length, 0, 'no queued follow-up');
  assert.equal((spawned as { templateFollowUpRunId?: string }).templateFollowUpRunId, undefined);
  const goal = (calls[0]?.body as { goal?: { objective?: string } }).goal as { objective: string };
  assert.ok(goal.objective.includes('pi-completion/v1'), 'the short pointer still rides in the objective');
});

test('W2-g: spawn with a goal and templateFollowUp:true restores the verbatim follow-up', async () => {
  const { calls, client } = recordingClient();
  const spawned = await client.spawn({ runtime: 'pi', cwd: '/tmp/w', goal: { objective: 'Ship the fix' }, templateFollowUp: true } as never);
  const followUps = prompts(calls);
  assert.equal(followUps.length, 1);
  assert.ok(String(followUps[0]?.body.message).includes(COMPLETION_REPORT_INSTRUCTION));
  assert.equal((spawned as { templateFollowUpRunId?: string }).templateFollowUpRunId, 'r-follow');
});

test('W2-g: goalStart sends no follow-up by default, one with templateFollowUp:true', async () => {
  const off = recordingClient();
  const offBody = await off.client.goalStart('s-goal', { objective: 'Do it' });
  assert.equal(prompts(off.calls).length, 0);
  assert.equal((offBody as { templateFollowUpRunId?: string }).templateFollowUpRunId, undefined);
  const on = recordingClient();
  const onBody = await on.client.goalStart('s-goal', { objective: 'Do it', templateFollowUp: true } as never);
  assert.equal(prompts(on.calls).length, 1);
  assert.equal((onBody as { templateFollowUpRunId?: string }).templateFollowUpRunId, 'r-follow');
});

function fakeDeps(client: Record<string, unknown>, out: string[] = []): CliDeps {
  return { env: {}, stdout: (line) => out.push(line), stderr: () => undefined, randomId: () => 'k', client: () => { throw new Error('template must not need a client'); } , ...({ __client: client } as object) } as CliDeps;
}

test('W2-g: `template` prints the report instructions without touching a client; --goal prints the goal variant', async () => {
  const plain = await runCli(['template'], fakeDeps({}));
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.stdout, COMPLETION_REPORT_INSTRUCTION);
  const goal = await runCli(['template', '--goal'], fakeDeps({}));
  assert.equal(goal.exitCode, 0);
  assert.equal(goal.stdout, GOAL_REPORT_INSTRUCTION);
});

test('W2-g: spawn/goal CLI pass templateFollowUp:true only with --template-follow-up', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const client = {
    async spawn(input: Record<string, unknown>) { captured.push(input); return { sessionId: 's1' }; },
    async goalStart(_id: string, input: Record<string, unknown>) { captured.push(input); return { sessionId: 's1', status: 'running' }; },
  };
  const deps = { env: {}, stdout: () => undefined, stderr: () => undefined, randomId: () => 'k', client: () => client as never } as CliDeps;
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--goal-objective', 'x', '--template-follow-up'], deps);
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--goal-objective', 'x'], deps);
  await runCli(['goal', 's1', 'start', '--goal-objective', 'x', '--template-follow-up'], deps);
  await runCli(['goal', 's1', 'start', '--goal-objective', 'x'], deps);
  assert.equal(captured[0]?.templateFollowUp, true);
  assert.equal(captured[1]?.templateFollowUp, undefined);
  assert.equal(captured[2]?.templateFollowUp, true);
  assert.equal(captured[3]?.templateFollowUp, undefined);
});

test('W2-g: exit 22 needs the opt-in — without it a result carrying no template error exits 0', async () => {
  const client = { async spawn() { return { sessionId: 's1', raw: {} }; } };
  const deps = { env: {}, stdout: () => undefined, stderr: () => undefined, randomId: () => 'k', client: () => client as never } as CliDeps;
  const result = await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--goal-objective', 'x'], deps);
  assert.equal(result.exitCode, 0);
});
