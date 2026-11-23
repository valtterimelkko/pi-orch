/**
 * J3 (native-parent-linkage): who is THIS process's own agent session?
 *
 * A parent that is neither a Pi Web UI session nor Claude Code — Devin, the
 * Antigravity CLI, the Command Code CLI, a bare `pi` CLI in tmux — names its
 * session in no variable pi-orch knows, so its children used to be linked to
 * nobody ("Children (parent unknown)"). The Agent OS board already records each
 * active entry's harness pid and `join.sessionRef`, and `agent-os board self
 * --json` walks the caller's /proc ancestry against those pids and prints the
 * answer as one JSON line (the programme's frozen interface):
 *
 *   found:     {"found":true,"entryId":"…","harness":"…","sessionRef":"…","harnessPid":123}
 *   not found: {"found":false,"reason":"…"}                       (exit 1)
 *
 * pi-orch declares that bare `sessionRef` as the child's native parent (create
 * body `parentSessionId` + `parentKind: "native"`, persisted as `declared`).
 *
 * The resolver is a courtesy, never a dependency: ANY failure — a missing
 * binary, a non-zero exit, the hard timeout, unparseable output, `found:false`,
 * or a ref Pi Web UI would refuse — means no native parent and at most one
 * short stderr note. It never fails, delays past its timeout, or aborts a
 * spawn, and it is never consulted when an identity is already known.
 */
import { spawnSync } from 'node:child_process';
import { NATIVE_PARENT_ID_PATTERN } from './builders.ts';

/** The default resolver program (argv, never a shell string). */
export const SELF_RESOLVER_PROGRAM = 'agent-os';
export const SELF_RESOLVER_ARGS: readonly string[] = ['board', 'self', '--json'];
/** Hard ceiling on one resolution: a spawn must not hang on bookkeeping. */
export const SELF_RESOLVER_TIMEOUT_MS = 3000;
/** Set this to a program path to replace {@link SELF_RESOLVER_PROGRAM}, or to `off` to disable the resolver. */
export const SELF_RESOLVER_ENV = 'PI_ORCH_SELF_RESOLVER';
export const SELF_RESOLVER_DISABLED = 'off';
/** Pi Web UI's native-id rule (the same pattern the create schema enforces). */
export const SELF_SESSION_REF_PATTERN = NATIVE_PARENT_ID_PATTERN;
const STDOUT_LIMIT = 64 * 1024;
const NOTE_REASON_LIMIT = 120;

/** One resolver run, as the seam returns it (nothing here throws). */
export interface SelfResolverRun {
  /** The process exit status, or null when it never ran to completion. */
  status: number | null;
  stdout: string;
  timedOut?: boolean;
  /** A spawn-level failure code, e.g. ENOENT or ETIMEDOUT. */
  errorCode?: string;
}

/** The injectable runner (tests inject a fake; production uses {@link runSelfResolverProcess}). */
export type SelfResolverRunner = (program: string, args: readonly string[], timeoutMs: number) => SelfResolverRun;

export interface SelfSessionResolution {
  /** The bare native parent id to declare, when the resolver produced a usable one. */
  sessionRef?: string;
  /** At most one short stderr note, when the resolver ran and produced nothing usable. */
  note?: string;
}

/** The real runner: argv, no shell, hard timeout, bounded output, never throws. */
export const runSelfResolverProcess: SelfResolverRunner = (program, args, timeoutMs) => {
  const result = spawnSync(program, [...args], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: STDOUT_LIMIT,
    encoding: 'utf8',
  });
  const errorCode = result.error === undefined || result.error === null ? undefined : (result.error as NodeJS.ErrnoException).code;
  return {
    status: result.status ?? null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorCode === 'ETIMEDOUT' ? { timedOut: true } : {}),
  };
};

/** The one stderr line an unresolved resolver produces (short, single line, no dynamic host data). */
function unresolved(reason: string): SelfSessionResolution {
  return { note: `pi-orch: SELF_RESOLVER_UNRESOLVED — ${reason}; declaring no native parent (set ${SELF_RESOLVER_ENV}=off to silence this)` };
}

function shortReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return cleaned === '' ? undefined : cleaned.slice(0, NOTE_REASON_LIMIT);
}

/** The board's one JSON line: the last parseable object line that carries a boolean `found`. */
function parseBoardLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '' || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && typeof (parsed as { found?: unknown }).found === 'boolean') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not a JSON line: keep looking
    }
  }
  return undefined;
}

/**
 * Resolve this process's own agent session. Returns a bare ref only when the
 * board reported `found:true` AND the ref is one Pi Web UI will persist; every
 * other outcome is `{}` or a single note.
 */
export function resolveSelfSession(options: {
  env: Record<string, string | undefined>;
  run: SelfResolverRunner;
  timeoutMs?: number;
}): SelfSessionResolution {
  const configured = (options.env[SELF_RESOLVER_ENV] ?? '').trim();
  if (configured === SELF_RESOLVER_DISABLED) return {};
  const program = configured === '' ? SELF_RESOLVER_PROGRAM : configured;
  let run: SelfResolverRun;
  try {
    run = options.run(program, SELF_RESOLVER_ARGS, options.timeoutMs ?? SELF_RESOLVER_TIMEOUT_MS);
  } catch (error) {
    return unresolved(`the resolver could not be run (${shortReason((error as Error).message) ?? 'unknown error'})`);
  }
  if (run.timedOut === true || run.errorCode === 'ETIMEDOUT') return unresolved(`the resolver did not answer within ${options.timeoutMs ?? SELF_RESOLVER_TIMEOUT_MS} ms`);
  if (run.errorCode !== undefined) return unresolved(`the resolver could not be run (${run.errorCode})`);
  if (run.status !== 0) return unresolved(`the resolver exited ${String(run.status)}`);
  const parsed = parseBoardLine(run.stdout);
  if (parsed === undefined) return unresolved('the resolver printed no usable JSON');
  if (parsed.found !== true) {
    const reason = shortReason(parsed.reason);
    return unresolved(reason === undefined ? 'the resolver found no session for this process' : `the resolver found no session for this process (${reason})`);
  }
  const sessionRef = parsed.sessionRef;
  if (typeof sessionRef !== 'string' || !SELF_SESSION_REF_PATTERN.test(sessionRef)) {
    // Never echo the value: it is not a native id, so it cannot be used anyway.
    return unresolved('the resolver reported a session reference that is not a bare native id');
  }
  return { sessionRef };
}
