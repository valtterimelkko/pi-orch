import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, type CliDeps } from '../src/cli.ts';

/** C3b: the CLI exposes the template opt-out on spawn and prompt. */

function fakeDeps(client: Record<string, unknown>): CliDeps {
  return {
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    randomId: () => 'k',
    client: () => client as never,
  };
}

test('spawn passes completionTemplate:false only when --no-completion-template is given', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const client = {
    async spawn(input: Record<string, unknown>) {
      captured.push(input);
      return { sessionId: 's1' };
    },
  };
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--no-completion-template'], fakeDeps(client));
  await runCli(['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'], fakeDeps(client));
  assert.equal(captured[0]?.completionTemplate, false);
  assert.equal(captured[1]?.completionTemplate, undefined);
});

test('prompt passes completionTemplate:false only when --no-completion-template is given', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const client = {
    async prompt(_sessionId: string, input: Record<string, unknown>) {
      captured.push(input);
      return { runId: 'r1', sessionId: 's1', detached: true, duplicate: false };
    },
  };
  await runCli(['prompt', 's1', '--message', 'go', '--no-completion-template'], fakeDeps(client));
  await runCli(['prompt', 's1', '--message', 'go'], fakeDeps(client));
  assert.equal(captured[0]?.completionTemplate, false);
  assert.equal(captured[1]?.completionTemplate, undefined);
});

// ─── Correction 01 item 5: a failed template delivery is visible and non-zero ─

test('spawn exits 22 with a warning when the goal-template follow-up could not be delivered', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--goal-objective', 'Ship it'],
    fakeDeps({
      async spawn() {
        return { sessionId: 's1', raw: { __templateFollowUpError: 'RUNTIME_ERROR: refused mid-arm-turn' } };
      },
    } as never),
  );
  assert.equal(result.exitCode, 22, `exit: ${result.exitCode}`);
  assert.ok((result.stderr ?? '').includes('TEMPLATE_NOT_DELIVERED') || (result.stderr ?? '').includes('template NOT delivered'), `stderr: ${result.stderr}`);
  assert.ok((result.stdout ?? '').includes('session s1'), 'human output still names the session');
});

test('spawn --json with a failed template keeps the raw fields AND exits 22', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w', '--goal-objective', 'Ship it', '--json'],
    fakeDeps({
      async spawn() {
        return { sessionId: 's1', raw: { __templateFollowUpError: 'boom' } };
      },
    } as never),
  );
  assert.equal(result.exitCode, 22);
  const parsed = JSON.parse(result.stdout ?? '{}') as { raw?: { __templateFollowUpError?: string } };
  assert.equal(parsed.raw?.__templateFollowUpError, 'boom');
});

test('spawn exits 0 when the template follow-up is fine', async () => {
  const result = await runCli(
    ['spawn', '--runtime', 'pi', '--cwd', '/tmp/w'],
    fakeDeps({
      async spawn() {
        return { sessionId: 's1', raw: {} };
      },
    } as never),
  );
  assert.equal(result.exitCode, 0);
});

// ─── Correction 01 item 6: no branch promise in verify docs (README/section) ─
