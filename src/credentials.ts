/**
 * Credential-path containment guard.
 *
 * The Internal API token is the one secret this client uses, and it must never
 * come from inside the repository tree: a token committed even once is leaked,
 * and `.gitignore` does not protect a path a user can still point at. This
 * module is the enforcement point — every place that reads a credential calls
 * `assertCredentialPathOutsideRepo` first — and `readToken` refuses a path that
 * resolves inside the package root (via realpath, so a symlink cannot bypass
 * it) with the typed `CREDENTIAL_IN_REPO` refusal and exit code 23.
 *
 * The package root is resolved from this module's own location, so a clone, a
 * copy or an installation all guard their own tree.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Distinct, documented exit code for a credential path inside the repo. */
export const CREDENTIAL_IN_REPO_EXIT_CODE = 23;

/** The repository (package) root that credential paths may not resolve into. */
export function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export class CredentialPathError extends Error {
  readonly code = 'CREDENTIAL_IN_REPO';
  readonly credentialPath: string;
  readonly repoRoot: string;

  constructor(credentialPath: string, repoRoot: string) {
    super(
      `pi-orch: refusing a credential path inside the repository: ${credentialPath} resolves inside ${repoRoot}. ` +
        'The Internal API token must live outside this repo (for example under ~/.pi-web-ui/); ' +
        'point PI_WEB_UI_TOKEN_PATH at it. .gitignore is not the protection.',
    );
    this.name = 'CredentialPathError';
    this.credentialPath = credentialPath;
    this.repoRoot = repoRoot;
  }
}

/**
 * Canonicalise a path even when it does not exist: realpath the nearest
 * existing ancestor and re-append the missing tail. This makes a symlinked
 * directory or a not-yet-created file resolve to the same place the read
 * eventually would.
 */
function canonicalise(candidate: string): string {
  const absolute = resolve(candidate);
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    // Not resolvable (permissions, races): keep the lexical ancestor.
  }
  return missing.length > 0 ? join(real, ...missing) : real;
}

/** True when `candidate` resolves inside `repoRoot` (or is the root itself). */
export function isInsideRepo(candidate: string, repoRoot: string = packageRoot()): boolean {
  const repo = canonicalise(repoRoot);
  const target = canonicalise(candidate);
  return target === repo || target.startsWith(repo + sep);
}

/**
 * Refuse a credential path that lies inside the repository; return the path
 * unchanged otherwise (so it can be used inline at resolution sites).
 */
export function assertCredentialPathOutsideRepo(candidate: string, repoRoot: string = packageRoot()): string {
  const repo = canonicalise(repoRoot);
  if (isInsideRepo(candidate, repo)) {
    throw new CredentialPathError(candidate, repo);
  }
  return candidate;
}
