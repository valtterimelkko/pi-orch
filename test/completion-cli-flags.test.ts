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
