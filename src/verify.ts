/**
 * C3b item 3 — `verify`: re-check the cheap facts of a child's completion
 * block against the filesystem. READ-ONLY by construction:
 *   - git runs through an allow-list of read-only subcommands, spawned with
 *     argv arrays (never a shell), so block content can never inject anything;
 *   - claimed files are only ever probed (change evidence from claimed-commit
 *     diffs and the working tree), never written;
 *   - the ONLY command ever executed is the one the PARENT names explicitly
 *     with `--rerun "<cmd>"` (run in the child's cwd, bounded by a timeout) —
 *     commands claimed by the child are recorded, never re-run automatically;
 *   - no network, no writes, no mutation of any repository state.
 *
 * Verdict precedence: any contradicted claim → `contradicted` (exit 20);
 * else any unverifiable claim (or nothing independently checkable) →
 * `unverifiable` (exit 21); else `verified` (exit 0).
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { CompletionBlock, CompletionParseError } from './completion.ts';

export interface VerifyInput {
  sessionId: string;
  runId?: string;
  /** Claimed commits must be reachable from this base (a ref/sha the parent names; the schema has no branch field). */
  since?: string;
  /** The ONE command verify may execute — the parent names it, verbatim. */
  rerun?: string;
  rerunTimeoutMs?: number;
  /** The child's cwd: default repo for filesChanged and cwd for --rerun. */
  cwd?: string;
  /** Explicit repo override for filesChanged resolution. */
  repo?: string;
}

export type VerifyClaimResult = 'verified' | 'contradicted' | 'unverifiable' | 'recorded';

export interface VerifyClaim {
  kind: 'commit' | 'file' | 'command' | 'test' | 'status';
  claim: string;
  check: string;
  result: VerifyClaimResult;
  detail?: string;
}

export interface VerifyResult {
  sessionId: string;
  runId?: string;
  verdict: 'verified' | 'contradicted' | 'unverifiable';
  completionSource?: 'receipt' | 'session_surface';
  claims: VerifyClaim[];
  summary: string;
}

export interface CompletionLoad {
  block?: CompletionBlock;
  error?: CompletionParseError;
  source?: 'receipt' | 'session_surface';
}

export interface VerifyDeps {
  /** Read-only git: `-C <repo> <args...>`; rejects non-read-only subcommands. */
  git(args: string[], options: { repo: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  fileExists(path: string): boolean;
  /** Runs the parent-named command via `bash -c` in the given cwd, bounded. */
  runCommand(command: string, options: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
}

const READ_ONLY_GIT = new Set([
  'cat-file', 'merge-base', 'diff-tree', 'log', 'rev-parse', 'ls-files', 'status', 'show', 'branch', 'tag', 'describe', 'shortlog',
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RERUN_TIMEOUT_MS = 120_000;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export function makeNodeVerifyDeps(): VerifyDeps {
  return {
    git(args, options) {
      const subcommand = (args[0] ?? '').split(' ')[0] ?? '';
      if (!READ_ONLY_GIT.has(subcommand)) {
        return Promise.reject(new Error(`pi-orch verify: git subcommand '${subcommand}' is not on the read-only allow-list`));
      }
      return new Promise((resolvePromise) => {
        execFile(
          'git',
          ['-C', options.repo, ...args],
          { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const exitCode = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
            resolvePromise({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          },
        );
      });
    },
    fileExists(path) {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    runCommand(command, options) {
      return new Promise((resolvePromise) => {
        execFile(
          '/bin/bash',
          ['-c', command],
          { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGTERM' },
          (error, stdout, stderr) => {
            if (error === null) {
              resolvePromise({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
              return;
            }
            const err = error as { code?: unknown; killed?: boolean; signal?: string };
            const timedOut = err.killed === true;
            const exitCode = typeof err.code === 'number' ? err.code : timedOut ? 124 : 1;
            resolvePromise({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(timedOut ? { timedOut } : {}) });
          },
        );
      });
    },
  };
}

function claimRow(kind: VerifyClaim['kind'], claim: string, check: string, result: VerifyClaimResult, detail?: string): VerifyClaim {
  return { kind, claim, check, result, ...(detail !== undefined ? { detail } : {}) };
}

/** A path is safe to probe only when it is relative and stays inside the repo. */
function safeRelativePath(candidate: string, repo: string): boolean {
  if (!candidate || candidate.length === 0) return false;
  if (candidate.startsWith('/') || candidate.includes('\0')) return false;
  const resolved = resolve(repo, candidate);
  const repoRoot = resolve(repo);
  return resolved === repoRoot || resolved.startsWith(repoRoot + sep);
}

export async function verifyChild(
  input: VerifyInput,
  deps: VerifyDeps,
  loadCompletion: (input: VerifyInput) => Promise<CompletionLoad>,
): Promise<VerifyResult> {
  const claims: VerifyClaim[] = [];
  let loaded: CompletionLoad;
  try {
    loaded = await loadCompletion(input);
  } catch (error) {
    return {
      sessionId: input.sessionId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      verdict: 'unverifiable',
      claims: [],
      summary: `unverifiable: the completion could not be loaded (${(error as Error).message})`,
    };
  }
  const base = {
    sessionId: input.sessionId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(loaded.source !== undefined ? { completionSource: loaded.source } : {}),
    claims,
  } as const;
  if (!loaded.block) {
    const reason = loaded.error ? `${loaded.error.code} from the ${loaded.source ?? 'unknown'} record` : 'no completion was captured (neither on the receipt nor on the session surface)';
    return { ...base, verdict: 'unverifiable', summary: `unverifiable: ${reason}` };
  }
  const block = loaded.block;

  // ── status structure ────────────────────────────────────────────────────────
  if (block.status === 'blocked') {
    if (block.blockedReason && block.blockedReason.length > 0) {
      claims.push(claimRow('status', 'blocked', 'blocked status carries blockedReason', 'verified', block.blockedReason));
    } else {
      claims.push(claimRow('status', 'blocked', 'blocked status carries blockedReason', 'contradicted', 'status is "blocked" but blockedReason is missing'));
    }
  } else {
    claims.push(claimRow('status', block.status, 'status recorded', 'recorded'));
  }

  // ── commits ────────────────────────────────────────────────────────────────
  const reposOfCommits = new Set<string>();
  for (const commit of block.commits ?? []) reposOfCommits.add(commit.repo);
  for (const commit of block.commits ?? []) {
    const label = commit.sha;
    void label;
    if (!SHA_PATTERN.test(commit.sha)) {
      claims.push(claimRow('commit', label, `git -C ${commit.repo} cat-file -e ${commit.sha}^{commit}`, 'contradicted', `sha does not match the pi-completion/v1 shape: ${commit.sha}`));
      continue;
    }
    if (!commit.repo || !commit.repo.startsWith('/')) {
      claims.push(claimRow('commit', label, 'repo must be an absolute path', 'unverifiable', `repo is not absolute: ${commit.repo}`));
      continue;
    }
    try {
      statSync(commit.repo);
    } catch {
      claims.push(claimRow('commit', label, `git -C ${commit.repo} cat-file -e ${commit.sha}^{commit}`, 'unverifiable', `repo path does not exist: ${commit.repo}`));
      continue;
    }
    const cat = await deps.git(['cat-file', '-e', `${commit.sha}^{commit}`], { repo: commit.repo });
    if (cat.exitCode !== 0) {
      claims.push(claimRow('commit', label, `git -C ${commit.repo} cat-file -e ${commit.sha}^{commit}`, 'contradicted', `no such commit in ${commit.repo}: ${cat.stderr.trim().slice(0, 200)}`));
      continue;
    }
    if (input.since !== undefined) {
      const ancestor = await deps.git(['merge-base', '--is-ancestor', commit.sha, input.since], { repo: commit.repo });
      if (ancestor.exitCode !== 0) {
        claims.push(claimRow('commit', label, `git -C ${commit.repo} merge-base --is-ancestor ${commit.sha} ${input.since}`, 'contradicted', `commit exists but is NOT reachable from ${input.since}`));
        continue;
      }
      claims.push(claimRow('commit', label, `git -C ${commit.repo} cat-file -e + merge-base --is-ancestor ${input.since}`, 'verified'));
    } else {
      claims.push(claimRow('commit', label, `git -C ${commit.repo} cat-file -e ${commit.sha}^{commit}`, 'verified'));
    }
  }

  // ── filesChanged ───────────────────────────────────────────────────────────
  const repoCandidates = [input.repo, reposOfCommits.size === 1 ? [...reposOfCommits][0] : undefined, input.cwd].filter(Boolean) as string[];
  let filesRepo: string | undefined;
  for (const candidate of repoCandidates) {
    const inside = await deps.git(['rev-parse', '--is-inside-work-tree'], { repo: candidate }).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    if (inside.exitCode === 0 && inside.stdout.trim() === 'true') {
      filesRepo = candidate;
      break;
    }
  }
  for (const file of block.filesChanged ?? []) {
    if (filesRepo === undefined) {
      claims.push(claimRow('file', file, 'resolve a repo (from --repo, the claimed commits, or the child cwd)', 'unverifiable', 'no git repository available to check against'));
      continue;
    }
    if (!safeRelativePath(file, filesRepo)) {
      claims.push(claimRow('file', file, 'path safety (relative, inside the repo)', 'unverifiable', 'unsafe path: not a relative path inside the repo'));
      continue;
    }
    // Correction 01 item 4 (parent decision): filesChanged means CHANGED.
    // Evidence is (a) the path appears in a claimed commit's diff, or (b) the
    // working tree shows it modified/added/deleted/untracked. A path that
    // exists but is clean and absent from every claimed commit is contradicted.
    let evidence: string | undefined;
    for (const commit of block.commits ?? []) {
      if (commit.repo !== filesRepo) continue;
      const nameStatus = await deps.git(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', commit.sha], { repo: filesRepo });
      if (nameStatus.exitCode === 0) {
        const changed = nameStatus.stdout.split('\n').some((line) => {
          const [status, ...pathParts] = line.trim().split('\t');
          return status !== undefined && status.length > 0 && pathParts.join('\t') === file;
        });
        if (changed) {
          evidence = `changed in ${commit.sha.slice(0, 12)}`;
          break;
        }
      }
    }
    if (evidence === undefined) {
      const status = await deps.git(['status', '--porcelain', '--', file], { repo: filesRepo });
      const line = status.stdout.split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 0)[0];
      if (line !== undefined) {
        evidence = `working tree: ${line}`;
      }
    }
    if (evidence !== undefined) {
      claims.push(claimRow('file', file, `change evidence in ${filesRepo}`, 'verified', evidence));
    } else if (deps.fileExists(join(filesRepo, file))) {
      claims.push(claimRow('file', file, `change evidence in ${filesRepo}`, 'contradicted', 'exists but unchanged: clean in the working tree and absent from every claimed commit diff'));
    } else {
      claims.push(claimRow('file', file, `change evidence in ${filesRepo}`, 'contradicted', 'no change evidence: the file is absent and no claimed commit changed it'));
    }
  }

  // ── commands: recorded, never re-run from the child's block ────────────────
  for (const command of block.commands ?? []) {
    claims.push(claimRow('command', command.command, 'recorded from the block (never re-run automatically)', 'recorded', `claimed exit ${command.exitCode}`));
  }

  // ── tests: recorded; re-run ONLY the parent-named command ──────────────────
  const passClaims = (block.tests ?? []).filter((entry) => entry.result === 'pass');
  const failClaims = (block.tests ?? []).filter((entry) => entry.result === 'fail');
  if (input.rerun !== undefined) {
    const cwd = input.cwd ?? filesRepo;
    if (!cwd) {
      for (const entry of block.tests ?? []) {
        claims.push(claimRow('test', entry.name, `--rerun '${input.rerun}'`, 'unverifiable', 'no cwd available to run the parent-named command in'));
      }
    } else {
      const rerun = await deps.runCommand(input.rerun, { cwd, timeoutMs: input.rerunTimeoutMs ?? DEFAULT_RERUN_TIMEOUT_MS });
      const detail = rerun.timedOut
        ? `parent-named rerun '${input.rerun}' TIMED OUT after ${input.rerunTimeoutMs ?? DEFAULT_RERUN_TIMEOUT_MS}ms in ${cwd}`
        : `parent-named rerun '${input.rerun}' exited ${rerun.exitCode} in ${cwd}`;
      for (const entry of block.tests ?? []) {
        if (entry.result === 'pass') {
          claims.push(claimRow('test', entry.name, `--rerun '${input.rerun}'`, rerun.exitCode === 0 ? 'verified' : 'contradicted', detail));
        } else if (entry.result === 'fail') {
          claims.push(claimRow('test', entry.name, `--rerun '${input.rerun}'`, rerun.exitCode === 0 ? 'contradicted' : 'verified', detail));
        } else {
          claims.push(claimRow('test', entry.name, 'recorded from the block', 'recorded', 'skip'));
        }
      }
    }
  } else {
    for (const entry of block.tests ?? []) {
      claims.push(claimRow('test', entry.name, 'recorded from the block (re-run only with the parent-named --rerun)', 'recorded', `claimed ${entry.result}`));
    }
  }
  void passClaims;
  void failClaims;

  // ── verdict ────────────────────────────────────────────────────────────────
  const contradicted = claims.filter((entry) => entry.result === 'contradicted');
  const unverifiable = claims.filter((entry) => entry.result === 'unverifiable');
  const verified = claims.filter((entry) => entry.result === 'verified');
  let verdict: VerifyResult['verdict'];
  let summary: string;
  if (contradicted.length > 0) {
    verdict = 'contradicted';
    summary = `contradicted: ${contradicted.length} claim(s) contradicted, ${verified.length} verified, ${unverifiable.length} unverifiable, ${claims.length - contradicted.length - verified.length - unverifiable.length} recorded — first: ${contradicted[0]?.kind} '${contradicted[0]?.claim}': ${contradicted[0]?.detail ?? contradicted[0]?.check ?? ''}`;
  } else if (verified.length === 0 || unverifiable.length > 0) {
    verdict = 'unverifiable';
    summary = `unverifiable: ${verified.length} verified, ${unverifiable.length} unverifiable, ${claims.length - verified.length - unverifiable.length} recorded${unverifiable.length > 0 ? ` — first: ${unverifiable[0]?.kind} '${unverifiable[0]?.claim}': ${unverifiable[0]?.detail ?? ''}` : ' — nothing independently checkable in the block'}`;
  } else {
    verdict = 'verified';
    summary = `verified: ${verified.length} claim(s) verified against the filesystem, ${claims.length - verified.length} recorded, 0 contradicted`;
  }
  return { ...base, verdict, summary };
}
