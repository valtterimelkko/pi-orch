import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditRecordFor, appendAuditRecord, defaultAuditPath } from '../src/audit.ts';
import { main } from '../src/cli.ts';
import { tempAuditPath } from './isolated-ledger.ts';

/**
 * W2-e: every CLI invocation appends ONE JSONL record to the audit log:
 * {ts, verb, subverb?, owner?, parentSession?, sessionId?, exitCode, durationMs}
 * — never message bodies, objectives or tokens. A failing audit write never
 * fails the command.
 */

function fakeProcess(argv: string[], env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const proc = {
    argv: ['node', 'pi-orch', ...argv],
    env,
    stdout: { write: (chunk: string) => { out.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { err.push(chunk); return true; } },
    exitCode: undefined as number | undefined,
  };
  return { proc: proc as unknown as NodeJS.Process, out, err, state: proc };
}

const records = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

test('defaultAuditPath: PI_ORCH_AUDIT_PATH wins, else ~/.pi-orch/audit.jsonl', () => {
  assert.equal(defaultAuditPath({ PI_ORCH_AUDIT_PATH: '/tmp/x/a.jsonl' }), '/tmp/x/a.jsonl');
  assert.equal(defaultAuditPath({}), join(homedir(), '.pi-orch', 'audit.jsonl'));
});

test('auditRecordFor: verb, subverb, owner, parent session, session id and exit code — nothing else', () => {
  const record = auditRecordFor(
    ['goal', 's-1', 'start', '--goal-objective', 'TOP SECRET OBJECTIVE', '--owner', 'orch-r1', '--parent-session', 'parent-9'],
    { exitCode: 0, stdout: 'goal running' },
    {},
    42,
    new Date('2026-10-13T10:00:00Z'),
  );
  assert.deepEqual(record, { ts: '2026-10-13T10:00:00.000Z', verb: 'goal', subverb: 'start', owner: 'orch-r1', parentSession: 'parent-9', sessionId: 's-1', exitCode: 0, durationMs: 42 });
  assert.ok(!JSON.stringify(record).includes('SECRET'));
});

test('auditRecordFor: parent session falls back to the environment; spawn learns the new session id from its output', () => {
  const human = auditRecordFor(['spawn', '--runtime', 'pi', '--cwd', '/w'], { exitCode: 0, stdout: 'session s-new\nlease l1' }, { PI_ORCH_PARENT_SESSION: 'envparent' }, 5);
  assert.equal(human.sessionId, 's-new');
  assert.equal(human.parentSession, 'envparent');
  const idOnly = auditRecordFor(['spawn', '--runtime', 'pi', '--cwd', '/w', '--id-only'], { exitCode: 0, stdout: 's-idonly' }, {}, 5);
  assert.equal(idOnly.sessionId, 's-idonly');
  const json = auditRecordFor(['spawn', '--runtime', 'pi', '--cwd', '/w', '--json'], { exitCode: 0, stdout: '{"sessionId":"s-json"}' }, {}, 5);
  assert.equal(json.sessionId, 's-json');
});

test('auditRecordFor: an unknown verb is recorded as "unknown", never the raw text', () => {
  const record = auditRecordFor(['sk-ant-notaverb'], { exitCode: 2 }, {}, 1);
  assert.equal(record.verb, 'unknown');
});

test('main() appends one record per invocation to PI_ORCH_AUDIT_PATH, with the real exit code', async () => {
  const path = tempAuditPath();
  const ok = fakeProcess(['template'], { PI_ORCH_AUDIT_PATH: path });
  await main(ok.proc);
  assert.equal(ok.state.exitCode, 0);
  const bad = fakeProcess(['prompt', 's-2'], { PI_ORCH_AUDIT_PATH: path });
  await main(bad.proc);
  assert.equal(bad.state.exitCode, 2);
  const list = records(path);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((record) => [record.verb, record.exitCode]), [['template', 0], ['prompt', 2]]);
  assert.equal(list[1]?.sessionId, 's-2');
  assert.equal(typeof list[0]?.durationMs, 'number');
});

test('main(): message bodies and objectives never reach the audit log', async () => {
  const path = tempAuditPath();
  const run = fakeProcess(['spawn', '--runtime', 'pi', '--goal-objective', 'PRIVATE-OBJECTIVE-TEXT'], { PI_ORCH_AUDIT_PATH: path });
  await main(run.proc); // usage error (no --cwd): exit 2
  assert.equal(run.state.exitCode, 2);
  assert.ok(!readFileSync(path, 'utf8').includes('PRIVATE-OBJECTIVE-TEXT'));
});

test('main(): an audit path that cannot be written never fails the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-audit-'));
  const blocker = join(dir, 'is-a-directory');
  mkdirSync(blocker);
  const run = fakeProcess(['template'], { PI_ORCH_AUDIT_PATH: blocker });
  await main(run.proc);
  assert.equal(run.state.exitCode, 0);
  assert.ok(run.out.join('').includes('pi-completion/v1'));
});

test('appendAuditRecord creates the directory and swallows every failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piorch-audit-'));
  const path = join(dir, 'nested', 'audit.jsonl');
  appendAuditRecord(path, { ts: 't', verb: 'status', exitCode: 0, durationMs: 1 });
  assert.equal(records(path).length, 1);
  assert.doesNotThrow(() => appendAuditRecord(dir, { ts: 't', verb: 'status', exitCode: 0, durationMs: 1 }));
});

test('the real binary appends an audit record (end to end)', () => {
  const path = tempAuditPath();
  const bin = new URL('../bin/pi-orch', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, 'template'], { encoding: 'utf8', env: { ...process.env, PI_ORCH_AUDIT_PATH: path }, timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(path));
  assert.equal(records(path)[0]?.verb, 'template');
});
