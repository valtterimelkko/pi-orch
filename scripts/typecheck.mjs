#!/usr/bin/env node
// `npm run typecheck` — local devDependency TypeScript when installed, host
// `tsc` fallback otherwise (see src/tsc-resolver.ts). Zero runtime deps.
import { spawnSync } from 'node:child_process';
import { resolveTsc } from '../src/tsc-resolver.ts';

let invocation;
try {
  invocation = resolveTsc();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (invocation.source !== 'local') {
  console.error(
    `pi-orch typecheck: using the ${invocation.source === 'env' ? 'PI_ORCH_TSC' : 'host PATH'} TypeScript; ` +
      'run `npm install` to use the pinned devDependency instead.',
  );
}

const extra = invocation.typeRoots === undefined ? [] : ['--typeRoots', invocation.typeRoots];
const result = spawnSync(
  invocation.command,
  [...invocation.args, '--noEmit', '-p', 'tsconfig.json', ...extra, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
if (result.error) {
  console.error(`pi-orch typecheck: could not run TypeScript: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
