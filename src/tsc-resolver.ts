/**
 * TypeScript resolver for `npm run typecheck` (item 4: an outside adopter
 * must be able to typecheck the client).
 *
 *   1. the local devDependency (`node_modules/typescript`), installed by
 *      `npm install` — the normal adopter path;
 *   2. `PI_ORCH_TSC` — an explicit path to a tsc entry point (pinned hosts);
 *   3. a `tsc` on the host PATH — the "host TypeScript" fallback, so a machine
 *      that intentionally installs nothing can still typecheck;
 *   4. otherwise a clear error telling the user to run `npm install`.
 *
 * When the fallback is used and the repo has no local `node_modules/@types`,
 * Node typings are taken from `~/pi-web-ui/node_modules/@types` if that
 * checkout is present — the same conventional location the contract snapshot
 * falls back to (see snapshot.ts). Runtime dependencies stay zero: TypeScript
 * and @types/node are devDependencies only.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface TscInvocation {
  command: string;
  args: string[];
  source: 'local' | 'env' | 'path';
  /** Extra `--typeRoots` for the host fallback; undefined means tsc defaults. */
  typeRoots?: string;
}

export interface ResolveTscOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** HOME override for tests; defaults to the real home directory. */
  home?: string;
}

export function resolveTsc(options: ResolveTscOptions = {}): TscInvocation {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const local = join(cwd, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(local)) {
    return { command: process.execPath, args: [local], source: 'local' };
  }

  const override = env.PI_ORCH_TSC;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`pi-orch typecheck: PI_ORCH_TSC is set to ${override} but that file does not exist`);
    }
    return { command: process.execPath, args: [override], source: 'env' };
  }

  const executable = platform === 'win32' ? 'tsc.cmd' : 'tsc';
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, executable);
    if (existsSync(candidate)) {
      const typeRoots = hostTypeRoots(cwd, options.home ?? homedir());
      return { command: candidate, args: [], source: 'path', ...(typeRoots === undefined ? {} : { typeRoots }) };
    }
  }

  throw new Error(
    'pi-orch typecheck: TypeScript was not found. Run `npm install` (typescript and @types/node are devDependencies), ' +
      'or set PI_ORCH_TSC to a tsc entry point, or put a `tsc` on PATH.',
  );
}

function hostTypeRoots(cwd: string, home: string): string | undefined {
  if (existsSync(join(cwd, 'node_modules', '@types'))) return undefined; // tsc's default resolution finds it
  const conventional = join(home, 'pi-web-ui', 'node_modules', '@types');
  return existsSync(conventional) ? conventional : undefined;
}
