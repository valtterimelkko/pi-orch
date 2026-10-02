import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultLedgerPath } from '../src/spawn-ledger.ts';

/**
 * 03-correction [minor]: a test run used to append fake entries (s2, s3,
 * s-goal) to the REAL ~/.pi-orch/spawn-ledger.json — tests that construct
 * real clients and spawn resolved the default ledger path. The suite must
 * never resolve the real ledger: `npm test` sets PI_ORCH_SPAWN_LEDGER to a
 * per-run temp path (package.json), and client-construction tests inject
 * explicit temp paths (test/isolated-ledger.ts). This guard fails any run
 * that bypasses that isolation.
 */
test('03-correction: the test run never resolves the real ~/.pi-orch spawn ledger', () => {
  const realDir = join(homedir(), '.pi-orch');
  const resolved = defaultLedgerPath(process.env);
  assert.ok(
    !resolved.startsWith(`${realDir}/`),
    `this test run resolves the REAL spawn ledger (${resolved}). Run the suite via npm test, which sets PI_ORCH_SPAWN_LEDGER to a per-run temp path — the real ledger is programme evidence (E2 population) and must stay untouched.`,
  );
  assert.equal(process.env.PI_ORCH_SPAWN_LEDGER, resolved, 'the suite-level override is exactly what client construction resolves');
});
