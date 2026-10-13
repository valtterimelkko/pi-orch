/**
 * W2-e: the verb audit log. Every CLI invocation appends ONE JSONL record to
 * `~/.pi-orch/audit.jsonl` (override: PI_ORCH_AUDIT_PATH) so curl-vs-verb use
 * and per-lane parent effort can be counted without regexing transcripts.
 *
 * The record carries identifiers only — verb, subverb, owner, parent session,
 * session id, exit code, duration. Never message bodies, objectives, tokens or
 * any other flag value. A failure to write never fails the command.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AuditRecord {
  ts: string;
  verb: string;
  subverb?: string;
  owner?: string;
  parentSession?: string;
  sessionId?: string;
  exitCode: number;
  durationMs: number;
}

export const AUDITED_VERBS = new Set(['capabilities', 'capacity', 'models', 'spawn', 'prompt', 'wait', 'result', 'verify', 'cleanup', 'status', 'goal', 'watch', 'reroute', 'template', 'lane', 'help']);

/** Verbs whose first positional argument is a session id. */
const SESSION_POSITIONAL = new Set(['prompt', 'wait', 'result', 'verify', 'cleanup', 'goal', 'watch', 'reroute']);
/** Verbs with a second positional that names the action. */
const SUBVERB_POSITIONAL = new Set(['goal', 'watch', 'lane']);

export function defaultAuditPath(env: Record<string, string | undefined> = process.env): string {
  return env.PI_ORCH_AUDIT_PATH ?? join(homedir(), '.pi-orch', 'audit.jsonl');
}

// Flags that take no value; skipping their following token would swallow a positional.
const BOOLEAN = new Set(['all', 'any', 'json', 'id-only', 'no-detach', 'require-active-turn', 'help', 'transcript', 'no-completion-template', 'template-follow-up', 'goal', 'pin', 'fire-if-settled', 'force-unconditional', 'final', 'dry-run']);

/** Minimal scan: only the named flags are ever read; no other flag value is kept. */
function scanArgs(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [name = '', inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (BOOLEAN.has(name)) flags.set(name, '');
    else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        index += 1;
      }
    }
  }
  return { positional, flags };
}
export function auditRecordFor(
  argv: string[],
  result: { exitCode: number; stdout?: string },
  env: Record<string, string | undefined>,
  durationMs: number,
  now: Date = new Date(),
): AuditRecord {
  const first = argv[0] ?? '';
  const verb = first === '--help' || first === '-h' ? 'help' : AUDITED_VERBS.has(first) ? first : 'unknown';
  const { positional, flags } = scanArgs(argv);
  const owner = flags.get('owner');
  const parentSession = flags.get('parent-session') ?? (verb === 'status' ? flags.get('parent') : undefined) ?? env.PI_ORCH_PARENT_SESSION ?? env.PI_WEB_UI_SESSION_ID ?? env.PI_SESSION_ID;
  let sessionId: string | undefined;
  if (SESSION_POSITIONAL.has(verb)) sessionId = positional[0];
  else if (verb === 'spawn' && result.exitCode === 0 && result.stdout !== undefined) sessionId = spawnedSessionId(result.stdout, flags.has('id-only'));
  // `lane run <dir>`: the action is the first positional; goal/watch take <sessionId> first.
  const subverb = verb === 'lane' ? positional[0] : SUBVERB_POSITIONAL.has(verb) ? positional[1] : undefined;
  return {
    ts: now.toISOString(),
    verb,
    ...(subverb !== undefined ? { subverb } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(parentSession !== undefined ? { parentSession } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    exitCode: result.exitCode,
    durationMs,
  };
}

function spawnedSessionId(stdout: string, idOnly: boolean): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { sessionId?: unknown };
      return typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
    } catch {
      return undefined;
    }
  }
  if (idOnly) return /^\S+$/.test(trimmed) ? trimmed : undefined;
  return /^session (\S+)/m.exec(trimmed)?.[1];
}

/** Append one record; creates the directory; swallows every failure. */
export function appendAuditRecord(path: string, record: AuditRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // the audit log is best-effort: it must never fail the command
  }
}
