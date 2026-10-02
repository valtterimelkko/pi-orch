import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 03-correction [minor]: a per-test temp spawn-ledger path. Tests that
 * construct real clients pass this as spawnLedgerPath so a suite run never
 * writes to the real ~/.pi-orch/spawn-ledger.json (programme evidence — the
 * E2 population ledger). The suite-level belt is the `npm test` script, which
 * sets PI_ORCH_SPAWN_LEDGER to a per-RUN temp path for every file at once.
 */
export function tempLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'piorch-test-ledger-')), 'spawn-ledger.json');
}
