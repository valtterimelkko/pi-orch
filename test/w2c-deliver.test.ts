import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.ts';
import { PiOrchClient } from '../src/client.ts';
import { tempLedgerPath } from './isolated-ledger.ts';
import { apiError, fakeDeps, ok, routedTransport, type Call, type Handler } from './w2c-helpers.ts';

/**
 * W2c verb 3: `prompt --mode deliver` — one atomic choice between steer (the
 * child has a live turn and the runtime supports steering) and follow_up
 * (anything else), reporting what was done. Provenance: SendPromptRequest.mode
 * and RuntimeCapabilities.supportsSteer/supportsSteerWhileBusy in snapshot
 * 1.61.0; PromptResponse.dispatchMode is what the server actually did.
 */

function client(transport: never): PiOrchClient {
  return new PiOrchClient({ transportInstance: transport, spawnLedgerPath: tempLedgerPath(), randomId: () => 'k1' });
}

function deliverRoutes(options: { busy: boolean; status?: string; runtimes?: Record<string, unknown>; prompt?: Handler }): Record<string, Handler> {
  return {
    'GET /api/v1/sessions/s1': () => ok({ sessionId: 's1', runtime: 'pi', busy: options.busy, status: options.status ?? (options.busy ? 'running' : 'idle'), modelSelector: 'm/x' }),
    'GET /api/v1/capabilities': () => ok({ runtimes: options.runtimes ?? { pi: { supportsSteer: true, supportsSteerWhileBusy: true, supportsFollowUp: true } } }),
    'GET /api/v1/sessions/s1/goal': () => ok({ status: 'idle' }),
    'GET /api/v1/sessions/s1/evidence': () => ok({ runChronology: [] }),
    'POST /api/v1/sessions/s1/prompt': options.prompt ?? ((call: Call) => ok({ sessionId: 's1', runId: 'r1', detached: true, dispatchMode: call.body?.mode })),
  };
}

const posted = (calls: Call[]): Record<string, unknown> => calls.find((call) => call.method === 'POST')?.body ?? {};

test('W2c deliver: a busy child on a steer-capable runtime is STEERED with requireActiveTurn', async () => {
  const { transport, calls } = routedTransport(deliverRoutes({ busy: true }));
  const result = await client(transport).prompt('s1', { message: 'change course', mode: 'deliver' as never, completionTemplate: false });
  assert.equal(posted(calls).mode, 'steer');
  assert.equal(posted(calls).requireActiveTurn, true);
  assert.equal(result.deliver?.chosen, 'steer');
  assert.equal(result.deliver?.busy, true);
  assert.equal(result.dispatchMode, 'steer');
});

test('W2c deliver: an idle child gets follow_up (it starts a new turn)', async () => {
  const { transport, calls } = routedTransport(deliverRoutes({ busy: false }));
  const result = await client(transport).prompt('s1', { message: 'next job', mode: 'deliver' as never, completionTemplate: false });
  assert.equal(posted(calls).mode, 'follow_up');
  assert.equal(posted(calls).requireActiveTurn, undefined);
  assert.equal(result.deliver?.chosen, 'follow_up');
  assert.equal(result.deliver?.busy, false);
});

test('W2c deliver: a busy child whose runtime cannot steer gets follow_up (queued) with the reason', async () => {
  const { transport, calls } = routedTransport(deliverRoutes({ busy: true, runtimes: { pi: { supportsSteer: false, supportsFollowUp: true } } }));
  const result = await client(transport).prompt('s1', { message: 'queue me', mode: 'deliver' as never, completionTemplate: false });
  assert.equal(posted(calls).mode, 'follow_up');
  assert.equal(result.deliver?.chosen, 'follow_up');
  assert.match(result.deliver?.reason ?? '', /steer/i);
});

test('W2c deliver: steer refused because the turn ended meanwhile (409) falls back to ONE follow_up', async () => {
  let attempts = 0;
  const { transport, calls } = routedTransport(deliverRoutes({
    busy: true,
    prompt: (call: Call) => {
      attempts += 1;
      if (call.body?.mode === 'steer') throw apiError(409, 'NO_ACTIVE_TURN', 'no active turn to steer');
      return ok({ sessionId: 's1', runId: 'r2', detached: true, dispatchMode: 'follow_up' });
    },
  }));
  const result = await client(transport).prompt('s1', { message: 'late', mode: 'deliver' as never, completionTemplate: false });
  assert.equal(attempts, 2);
  assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.body?.mode), ['steer', 'follow_up']);
  assert.equal(result.deliver?.chosen, 'follow_up');
  assert.match(result.deliver?.reason ?? '', /fell back|ended/i);
});

test('W2c deliver: a non-409 steer failure propagates (no silent fallback)', async () => {
  const { transport } = routedTransport(deliverRoutes({ busy: true, prompt: () => { throw apiError(400, 'INVALID', 'bad'); } }));
  await assert.rejects(() => client(transport).prompt('s1', { message: 'x', mode: 'deliver' as never, completionTemplate: false }), /bad/);
});

test('W2c deliver: queue depth is reported when the server reports it', async () => {
  const { transport } = routedTransport(deliverRoutes({
    busy: true,
    runtimes: { pi: { supportsSteer: false } },
    prompt: () => ok({ sessionId: 's1', runId: 'r1', detached: true, dispatchMode: 'follow_up', queueDepth: 3 }),
  }));
  const result = await client(transport).prompt('s1', { message: 'x', mode: 'deliver' as never, completionTemplate: false });
  assert.equal(result.queueDepth, 3);
});

test('W2c deliver CLI: --mode deliver is accepted, other bad modes still rejected, human output names what was done', async () => {
  const stub = {
    prompt: async (_sessionId: string, input: { mode?: string }) => ({
      runId: 'r9', sessionId: 's1', detached: true, duplicate: false, dispatchMode: 'steer', queueDepth: 2,
      deliver: { chosen: 'steer', busy: true, reason: 'live turn' }, seenMode: input.mode,
    }),
  };
  const deps = fakeDeps(() => stub as never);
  const human = await runCli(['prompt', 's1', '--message', 'hi', '--mode', 'deliver'], deps);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout ?? '', /delivered steer/);
  assert.match(human.stdout ?? '', /queue depth 2/);
  const json = await runCli(['prompt', 's1', '--message', 'hi', '--mode', 'deliver', '--json'], deps);
  assert.equal((JSON.parse(json.stdout ?? '{}') as { seenMode?: string }).seenMode, 'deliver');
});

test('W2c deliver: builders still reject an unknown mode', async () => {
  const { transport } = routedTransport({ 'GET /api/v1/sessions/s1': () => { throw apiError(404, 'SESSION_NOT_FOUND'); } });
  await assert.rejects(() => client(transport).prompt('s1', { message: 'x', mode: 'bogus' as never }), /mode must be/);
});
