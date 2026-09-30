/**
 * CLI: short verb commands, JSON with --json, human output otherwise,
 * documented exit codes. Testable: runCli takes injected deps (env, io, client
 * factory) so no test needs a server or a real process.
 */

import { PiOrchClient } from './client.ts';
import {
  agentEnd,
  goalEnd,
  goalPaused,
  questionSentinel,
  deadlineCondition,
  buildPreflightSpec,
} from './builders.ts';
import type { WatchConditionSpec } from './parsers.ts';
import { ApiError } from './parsers.ts';
import { ERROR_CODE_EXIT_CODES, exitCodeFor, VERIFY_EXIT_CODES } from './exit-codes.ts';
import { resolveRouteLimits } from './route-limits.ts';
import { defaultSocketPath, defaultTokenPath, loadSnapshot, liveContractVersion } from './snapshot.ts';
import { readToken } from './transport.ts';

export interface ClientLike {
  spawn(input: Record<string, unknown>): Promise<{ sessionId: string; leaseId?: string; parentId?: string; resolvedModel?: string; raw?: unknown }>;
  prompt(sessionId: string, input: Record<string, unknown>): Promise<{ runId: string; sessionId: string; detached: boolean; duplicate: boolean; dispatchMode?: string }>;
  wait(options: { sessionId: string; runId?: string; conditions?: WatchConditionSpec[]; objective?: string; deadlineMs?: number; label?: string }): Promise<{ kind: string; [key: string]: unknown }>;
  result(runId: string, options?: { includeTranscript?: boolean }): Promise<Record<string, unknown>>;
  verify(input: { sessionId: string; runId?: string }): Promise<{ implemented: false; plannedBy: string } | { sessionId: string; verdict: string; claims: Array<Record<string, unknown>>; summary: string }>;
  cleanup(sessionId: string, options?: { leaseId?: string; ownerId?: string; watchId?: string }): Promise<{ released: boolean; deleted: boolean; notes: string[] }>;
  status(target: { parent?: string; sessionId?: string }): Promise<{ parent?: string; children: Array<Record<string, unknown>> }>;
  models(runtime?: string): Promise<Array<Record<string, unknown>>>;
  capabilities(): Promise<Record<string, unknown>>;
  capacity(): Promise<Record<string, unknown>>;
  waitMany(options: { mode: 'all' | 'any'; children: Array<{ sessionId: string; runId?: string }>; objective?: string; deadlineMs?: number; label?: string }): Promise<{ mode: string; children: Array<{ sessionId: string; runId?: string; outcome?: { kind: string } }>; exitCode: number }>;
}

export interface CliDeps {
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  randomId(): string;
  client(config: { parentSessionId?: string }): ClientLike;
}

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

// ─── arg parsing ─────────────────────────────────────────────────────────────

interface ParsedArgs {
  verb: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  repeatable: Map<string, string[]>;
}

const REPEATABLE_FLAGS = new Set(['preflight-path', 'preflight-tool', 'route-limit']);
/** Flags that never consume the following token (so `--all c1@r1` keeps the id positional). */
const BOOLEAN_FLAGS = new Set(['all', 'any', 'json', 'id-only', 'no-detach', 'require-active-turn', 'help', 'transcript', 'no-completion-template']);

function parseArgs(argv: string[]): ParsedArgs {
  const verb = argv[0] ?? '';
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const repeatable = new Map<string, string[]>();
  let index = 1;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token.startsWith('--')) {
      const [rawName, inlineValue] = token.slice(2).split('=', 2);
      const name = rawName ?? '';
      if (REPEATABLE_FLAGS.has(name)) {
        index += 1;
        const value = inlineValue ?? argv[index];
        const list = repeatable.get(name) ?? [];
        if (value !== undefined) list.push(value);
        repeatable.set(name, list);
      } else if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(name, next);
          index += 1;
        } else {
          flags.set(name, true);
        }
      }
    } else {
      positional.push(token);
    }
    index += 1;
  }
  return { verb, positional, flags, repeatable };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number (got ${raw})`);
  return value;
}

function requireString(args: ParsedArgs, name: string, flag: string): string {
  const value = flagString(args, name);
  if (value === undefined) throw new UsageError(`missing required flag ${flag}`);
  return value;
}

function preflightFrom(args: ParsedArgs): ReturnType<typeof buildPreflightSpec> | undefined {
  const paths = args.repeatable.get('preflight-path') ?? [];
  const tools = args.repeatable.get('preflight-tool') ?? [];
  if (paths.length === 0 && tools.length === 0) return undefined;
  return buildPreflightSpec({ paths, tools });
}

/** G1: parse repeatable --route-limit 'selector=N|unlimited' values into an override map. */
export function routeLimitOverrides(values: string[]): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new UsageError(`--route-limit expects '<model-selector>=<limit>' (for example 'zai/glm-5.3-flash=2'), got '${raw}'`);
    }
    const route = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (value === 'unlimited') {
      overrides[route] = 0;
      continue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new UsageError(`--route-limit expects an integer >= 0 (0 = unlimited) or 'unlimited' for '${route}', got '${value}'`);
    }
    overrides[route] = parsed;
  }
  return overrides;
}

/** G1: the effective limit map the CLI passes to the client — flags win over the env, env over the defaults. */
export function mergeRouteLimits(env: Record<string, string | undefined>, overrides: Record<string, number>): Record<string, number> {
  return resolveRouteLimits({ env, overrides });
}

class UsageError extends Error {}

// ─── verbs ───────────────────────────────────────────────────────────────────

const HELP = `usage: pi-orch <verb> [args] [--json]

Verbs:
  capabilities                         read /capabilities (contract version)
  capacity                             read /capacity (admission preflight)
  models [--runtime rt] [--match sub]  list live model selectors
  spawn --runtime rt --cwd dir [...]   create a child (retention, goal, preflight)
  prompt <sessionId> --message text    detached dispatch with idempotency key
  wait <sessionId> [--run-id id]       watch-based wait; never polls; deadline
       [--all|--any id[@runId] ...]    several children in ONE call (no shell loop)
  result <runId> [--transcript]        receipt final text + evidence pointers
  verify <sessionId> [--run-id id]     re-check completion claims (read-only git):
       [--since ref] [--rerun "cmd"]   commits exist in their repos (reachability
       [--cwd dir] [--repo dir]        checked against --since), filesChanged
       [--rerun-timeout S]             CHANGE evidence, blocked needs a reason;
                                       --rerun runs ONLY the command you name, in
                                       the child's cwd. Verdicts: verified (0) /
                                       contradicted (20) / unverifiable (21)
  cleanup <sessionId> [--lease id --owner id] [--watch id]
                                       release the owned lease, then delete
  status [--parent id] | [sessionId]   children by parent: busy, goal, last run

Scripting: use --json for full machine output, or --id-only (spawn: prints the
sessionId; prompt: prints the runId) for $(...) capture. never parse the human-readable output (its wording can change at any time).

Common flags: --socket P --token-path P --api-base URL --parent-session ID --json

Spawn flags: --model-selector SEL | --model-match SUB, --thinking LEVEL,
  --owner ID [--ttl S] [--label L] (durable retention with your ownerId),
  --goal-objective OBJ [--goal-max-turns N] [--goal-verify CMD],
  --preflight-path P (repeatable), --preflight-tool T (repeatable),
  --agent-os-capture enabled|disabled,
  --route-limit 'SEL=N' (repeatable; per-call per-route concurrency cap;
    N=0 or 'unlimited' lifts the cap; wins over PI_ORCH_ROUTE_LIMITS),
  --wait-for-slot S (instead of refusing over the limit, watch the live
    children on that route and spawn when one settles; exit 3 on timeout)

Prompt flags: --mode prompt|follow_up|steer, --no-detach, --idempotency-key K,
  --verbosity answers|tasks|full, --require-active-turn, --preflight-path/--preflight-tool,
  --owner ID (route counting only: the per-route gate counts THIS owner's
    live children when the prompt would start a new turn on an idle child),
  --no-completion-template (both spawn and prompt: skip the C3b END-OF-TASK
  REPORT instruction, which rides by default on every dispatched message and
  on a spawn --goal-objective)

Wait flags: --run-id RUNID, --objective OBJ (goal children: goal_end+paused matched),
  --deadline S (default 1800), --slice S, --conditions a,b
  (agent_end|goal_end|paused|question:TEXT|deadline:S),
  --all|--any <sessionId>[@<runId>] ...  wait several children in one call:
  --all settles every child, --any returns the first to settle. Unknown runs
  or sessions fail fast (exit 16) instead of sitting out the deadline.

Exit codes: 0 ok · 1 error · 2 usage · 3 deadline · 4 run failed · 5 interrupted
  6 never started · 7 budget exceeded · 8 cancelled · 9 transport lost
  10 admission refused · 11 preflight failed · 12 refused busy · 14 prompt not
  executed · 15 turn stalled · 16 wait target not found · 17 goal cleared
  18 create unknown · 19 watch conflict · 20 verify contradicted
  21 verify unverifiable · 22 template not delivered · 23 credential in repo
  · 24 remote api base refused · 25 route limit (G1: spawn refused before any
  child was created; --wait-for-slot waits instead). Full table: README.md
`;

export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  try {
    const result = await dispatch(argv, deps);
    return await withSnapshotStaleness(argv, deps, result);
  } catch (error) {
    if (error instanceof UsageError) {
      const message = `pi-orch: ${error.message}\n\n${HELP}`;
      return { exitCode: 2, stderr: message };
    }
    return mapError(error);
  }
}

/**
 * Correction 04 item 7: the runtime comparison the docs promise. After a
 * successful API verb, compare the loaded snapshot's contractVersion with the
 * live /capabilities version. Stale → a SNAPSHOT_STALE warning on stderr and a
 * `snapshot` field in JSON output; the command itself is never blocked.
 */
async function withSnapshotStaleness(argv: string[], deps: CliDeps, result: CliResult): Promise<CliResult> {
  if (result.exitCode !== 0 || result.stdout === undefined) return result;
  const args = parseArgs(argv);
  const KNOWN_API_VERBS = new Set(['capabilities', 'capacity', 'models', 'spawn', 'prompt', 'wait', 'result', 'cleanup', 'status']);
  if (!KNOWN_API_VERBS.has(args.verb)) return result;
  let snapshot;
  try {
    const envOverride = flagString(args, 'snapshot');
    snapshot = loadSnapshot({ env: { ...deps.env, ...(envOverride ? { PI_ORCH_SNAPSHOT_PATH: envOverride } : {}) } }).snapshot;
  } catch {
    return result; // snapshot unavailable: the command stands on its own
  }
  let serverVersion: string | undefined;
  try {
    const capabilities = await deps.client({}).capabilities();
    serverVersion = liveContractVersion(capabilities);
  } catch {
    return result; // unreachable server: the verb already handled its own errors
  }
  if (serverVersion === undefined) return result;
  const stale = serverVersion !== snapshot.contractVersion;
  if (stale) {
    const warning = `SNAPSHOT_STALE: contract snapshot is ${snapshot.contractVersion} but the server reports ${serverVersion} — set PI_ORCH_SNAPSHOT_PATH or update the bundled contract/ copy (regenerate server-side with scripts/generate-client-snapshot.ts)`;
    deps.stderr(warning);
  }
  if (args.flags.has('json')) {
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      parsed.snapshot = { stale, snapshotVersion: snapshot.contractVersion, serverVersion };
      return { ...result, stdout: `${JSON.stringify(parsed, null, 2)}` };
    } catch {
      return result;
    }
  }
  return result;
}

async function dispatch(argv: string[], deps: CliDeps): Promise<CliResult> {
  const args = parseArgs(argv);
  const json = args.flags.has('json');

  if (args.verb === '' && !args.flags.has('help')) {
    return { exitCode: 2, stderr: HELP };
  }
  if (args.verb === 'help' || args.verb === '-h' || args.verb === '--help' || args.flags.has('help')) {
    // C1 carried-over item: usage on STDOUT with exit 0 (it went to stderr and
    // was dropped by the exit-0 printing rules — `pi-orch help` printed nothing).
    return { exitCode: 0, stdout: HELP };
  }

  // Validate the verb BEFORE touching the client factory (a bad command must
  // be a usage error, not a transport error).
  const KNOWN_VERBS = new Set(['capabilities', 'capacity', 'models', 'spawn', 'prompt', 'wait', 'result', 'verify', 'cleanup', 'status']);
  if (!KNOWN_VERBS.has(args.verb)) {
    throw new UsageError(`unknown verb '${args.verb}'`);
  }
  // Correction 01 item 7: junk --route-limit values must surface as a usage
  // error (exit 2) through runCli — never as an uncaught stack from the real
  // client factory. Validated here (the factory re-parses the same pure
  // function when it builds the actual client).
  if (args.repeatable.has('route-limit')) {
    routeLimitOverrides(args.repeatable.get('route-limit') ?? []);
  }

  const parentSessionId =
    flagString(args, 'parent-session') ??
    deps.env.PI_ORCH_PARENT_SESSION ??
    deps.env.PI_WEB_UI_SESSION_ID ??
    deps.env.PI_SESSION_ID;

  // Lazy: flags must be validated (cheap usage errors) before the client
  // factory runs (which reads tokens and can fail with transport errors).
  let cachedClient: ClientLike | undefined;
  const getClient = (): ClientLike => (cachedClient ??= deps.client({ parentSessionId }));

  switch (args.verb) {
    case 'capabilities': {
      const body = await getClient().capabilities();
      return output(json, body, () => 'capabilities: use --json for the full body');
    }
    case 'capacity': {
      const body = await getClient().capacity();
      return output(json, body, () => 'capacity: use --json for the full body');
    }
    case 'models': {
      const runtime = flagString(args, 'runtime');
      const match = flagString(args, 'match');
      const entries = await getClient().models(runtime);
      const filtered = match ? entries.filter((entry) => String(entry.selector ?? '').includes(match)) : entries;
      const body = {
        count: filtered.length,
        models: filtered.map((entry) => ({ selector: entry.selector, provider: entry.provider, thinkingLevels: entry.thinkingLevels })),
      };
      return output(json, body, () => `${body.count} selector(s); use --json for the list`);
    }
    case 'spawn': {
      const runtime = requireString(args, 'runtime', '--runtime');
      const cwd = requireString(args, 'cwd', '--cwd');
      const owner = flagString(args, 'owner');
      const goalObjective = flagString(args, 'goal-objective');
      const preflight = preflightFrom(args);
      // G1: validate the flag (cheap usage error) BEFORE the client factory runs.
      const waitForSlotMs = args.flags.has('wait-for-slot') ? waitForSlotSeconds(args) : undefined;
      const body = await getClient().spawn({
        runtime,
        cwd,
        modelSelector: flagString(args, 'model-selector'),
        modelMatch: flagString(args, 'model-match'),
        thinkingLevel: flagString(args, 'thinking'),
        retention: owner ? { mode: 'durable', ttlSeconds: flagNumber(args, 'ttl'), ownerId: owner, label: flagString(args, 'label') } : undefined,
        goal: goalObjective
          ? { objective: goalObjective, maxTurns: flagNumber(args, 'goal-max-turns'), verifyCommand: flagString(args, 'goal-verify') }
          : undefined,
        preflight,
        agentOsCapture: flagString(args, 'agent-os-capture'),
        completionTemplate: args.flags.has('no-completion-template') ? false : undefined,
        ...(waitForSlotMs !== undefined ? { waitForSlotMs } : {}),
      });
      const rendered = output(json, body, (value) => {
        const spawned = value as { sessionId: string; leaseId?: string; parentId?: string; resolvedModel?: string };
        if (args.flags.has('id-only')) return spawned.sessionId;
        return [
          `session ${spawned.sessionId}`,
          spawned.leaseId ? `lease ${spawned.leaseId}` : undefined,
          spawned.parentId ? `parent ${spawned.parentId}` : undefined,
          spawned.resolvedModel ? `model ${spawned.resolvedModel}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');
      });
      // Correction 01 item 5: a template that could NOT be delivered (both
      // follow-up attempts failed) is a real failure the parent must see —
      // distinct exit 22 + a clear warning; --json keeps the raw fields.
      const templateError = ((body as { raw?: { __templateFollowUpError?: unknown } }).raw)?.__templateFollowUpError;
      if (templateError === undefined) return rendered;
      return {
        ...rendered,
        exitCode: 22,
        stderr: `pi-orch: TEMPLATE_NOT_DELIVERED — the completion template could not be delivered to ${(body as { sessionId?: string }).sessionId ?? 'the child'}: ${String(templateError)}. The child holds only the pointer objective, not the full report instructions; re-send the template with 'prompt <sessionId> --message <instructions>' or re-dispatch.`,
      };
    }
    case 'prompt': {
      const sessionId = args.positional[0];
      if (!sessionId) throw new UsageError('prompt needs <sessionId>');
      const message = flagString(args, 'message');
      if (message === undefined) throw new UsageError('prompt needs --message');
      const preflight = preflightFrom(args);
      const body = await getClient().prompt(sessionId, {
        message,
        mode: flagString(args, 'mode'),
        detach: !args.flags.has('no-detach'),
        idempotencyKey: flagString(args, 'idempotency-key'),
        verbosity: flagString(args, 'verbosity'),
        requireActiveTurn: args.flags.has('require-active-turn') ? true : undefined,
        preflight,
        completionTemplate: args.flags.has('no-completion-template') ? false : undefined,
        // Correction 01 item 4: counting owner for the prompt-side route gate.
        ...(flagString(args, 'owner') !== undefined ? { routeOwner: flagString(args, 'owner') } : {}),
      });
      return output(json, body, (value) => {
        const prompt = value as { runId: string; duplicate: boolean; dispatchMode?: string };
        if (args.flags.has('id-only')) return prompt.runId;
        return [
          `run ${prompt.runId}${prompt.duplicate ? ' (duplicate: idempotent replay)' : ''}`,
          prompt.dispatchMode ? `dispatch ${prompt.dispatchMode}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');
      });
    }
    case 'wait': {
      const deadlineSeconds = flagNumber(args, 'deadline') ?? 1800;
      const objective = flagString(args, 'objective');
      const conditionsFlag = flagString(args, 'conditions');
      if (args.flags.has('all') || args.flags.has('any')) {
        const mode = args.flags.has('all') ? 'all' as const : 'any' as const;
        if (args.positional.length === 0) throw new UsageError(`wait --${mode} needs at least one <sessionId>[@<runId>]`);
        const children = args.positional.map((token) => {
          const at = token.indexOf('@');
          return at === -1 ? { sessionId: token } : { sessionId: token.slice(0, at), runId: token.slice(at + 1) };
        });
        const body = await getClient().waitMany({ mode, children, objective, deadlineMs: deadlineSeconds * 1000, label: flagString(args, 'label') });
        const stdout = json ? `${JSON.stringify(body, null, 2)}` : body.children
          .map((child) => `${child.sessionId}: ${child.outcome?.kind ?? 'no outcome'}`)
          .join('\n');
        return { exitCode: body.exitCode, stdout };
      }
      const sessionId = args.positional[0];
      if (!sessionId) throw new UsageError('wait needs <sessionId>');
      // C3b correction 01 item 1: no pre-baked default conditions — the client
      // detects an active goal when neither --conditions nor --objective is
      // given and applies goal or plain conditions AFTER detection.
      const conditions = conditionsFlag ? parseConditionList(conditionsFlag, objective) : undefined;
      const outcome = await getClient().wait({
        sessionId,
        runId: flagString(args, 'run-id'),
        conditions,
        objective,
        deadlineMs: deadlineSeconds * 1000,
        label: flagString(args, 'label'),
      });
      const exitCode = exitCodeFor({ kind: outcome.kind });
      const stdout = json ? `${JSON.stringify(outcome, null, 2)}` : `wait: ${outcome.kind}${outcome.note ? ` — ${outcome.note as string}` : ''}`;
      return { exitCode, stdout, ...(exitCode === 0 ? {} : { stderr: stdout }) };
    }
    case 'result': {
      const runId = args.positional[0];
      if (!runId) throw new UsageError('result needs <runId>');
      const body = await getClient().result(runId, { includeTranscript: args.flags.has('transcript') });
      return output(json, body, (value) => {
        const result = value as { status: string; finalText?: string; evidence: { transcript: string } };
        return [
          `status ${result.status}`,
          result.finalText ?? '(no final text on the receipt — read the transcript)',
          `transcript ${result.evidence.transcript}`,
        ].join('\n');
      });
    }
    case 'verify': {
      // C3b: re-check the child's completion claims against the filesystem.
      // Read-only; only the parent-named --rerun command is ever executed.
      const sessionId = args.positional[0];
      if (!sessionId) throw new UsageError('verify needs <sessionId>');
      const rerunTimeout = flagNumber(args, 'rerun-timeout');
      const body = await getClient().verify({
        sessionId,
        ...(flagString(args, 'run-id') !== undefined ? { runId: flagString(args, 'run-id') } : {}),
        ...(flagString(args, 'since') !== undefined ? { since: flagString(args, 'since') } : {}),
        ...(flagString(args, 'rerun') !== undefined ? { rerun: flagString(args, 'rerun') } : {}),
        ...(rerunTimeout !== undefined ? { rerunTimeoutMs: rerunTimeout * 1000 } : {}),
        ...(flagString(args, 'cwd') !== undefined ? { cwd: flagString(args, 'cwd') } : {}),
        ...(flagString(args, 'repo') !== undefined ? { repo: flagString(args, 'repo') } : {}),
      });
      const verdict = (body as { verdict: string }).verdict;
      const exitCode = VERIFY_EXIT_CODES[verdict as 'verified' | 'contradicted' | 'unverifiable'] ?? 1;
      return {
        exitCode,
        stdout: json ? `${JSON.stringify(body, null, 2)}` : renderVerifyHuman(body as unknown as { verdict: string; claims: Array<{ kind: string; claim: string; result: string; detail?: string }>; summary: string }),
      };
    }
    case 'cleanup': {
      const sessionId = args.positional[0];
      if (!sessionId) throw new UsageError('cleanup needs <sessionId>');
      const body = await getClient().cleanup(sessionId, {
        leaseId: flagString(args, 'lease'),
        ownerId: flagString(args, 'owner'),
        watchId: flagString(args, 'watch'),
      });
      return output(json, body, (value) => {
        const cleanup = value as { released: boolean; deleted: boolean; notes: string[] };
        return [`released ${cleanup.released}`, `deleted ${cleanup.deleted}`, ...cleanup.notes].join('\n');
      });
    }
    case 'status': {
      const sessionId = args.positional[0];
      const parent = flagString(args, 'parent');
      if (!sessionId && !parent) throw new UsageError('status needs <sessionId> or --parent <id>');
      const body = await getClient().status({ sessionId, parent });
      return output(json, body, (value) => {
        const status = value as { children: Array<Record<string, unknown>> };
        return status.children
          .map((child) => {
            const lastRun = child.lastRun as { status?: string } | undefined;
            return `${String(child.sessionId)} busy=${String(child.busy)} goal=${String(child.goalStatus)} last=${String(lastRun?.status)}`;
          })
          .join('\n');
      });
    }
    default:
      throw new UsageError(`unknown verb '${args.verb}'`);
  }
}

function renderVerifyHuman(body: { verdict: string; claims: Array<{ kind: string; claim: string; result: string; detail?: string }>; summary: string }): string {
  const lines = body.claims.map((claim) => `  ${claim.kind}\t${claim.claim}\t${claim.result}${claim.detail ? ` — ${claim.detail}` : ''}`);
  return [`verify: ${body.verdict}`, ...lines, body.summary].join('\n');
}

function waitForSlotSeconds(args: ParsedArgs): number {
  const seconds = flagNumber(args, 'wait-for-slot');
  if (seconds === undefined || seconds <= 0) throw new UsageError('--wait-for-slot must be a positive number of seconds');
  return seconds * 1000;
}

function parseConditionList(raw: string, objective: string | undefined): WatchConditionSpec[] {
  return raw.split(',').map((token) => {
    const trimmed = token.trim();
    if (trimmed === 'agent_end') return agentEnd();
    if (trimmed === 'goal_end') return goalEnd(objective ?? '*');
    if (trimmed === 'paused') return goalPaused(objective ?? '*');
    if (trimmed.startsWith('question:')) return questionSentinel(trimmed.slice('question:'.length));
    if (trimmed.startsWith('deadline:')) return deadlineCondition(Number(trimmed.slice('deadline:'.length)));
    throw new UsageError(`unknown condition '${trimmed}' (agent_end|goal_end|paused|question:TEXT|deadline:S)`);
  });
}

function mapError(error: unknown): CliResult {
  const anyError = error as { code?: string; status?: number; httpCode?: string; failures?: unknown; retryAfterSeconds?: number; message?: string; hint?: string; details?: string };
  const code = anyError.httpCode ?? anyError.code;
  // Correction 04 item 3: an unknown create outcome gets a distinct exit code
  // and a machine-readable {outcome, hint} body telling the caller to
  // reconcile — never to blindly re-spawn.
  const rawMessage = anyError.message ?? String(error);
  if (code === 'CREATE_UNKNOWN') {
    let hint = anyError.hint;
    if (!hint && anyError.details) {
      try { hint = (JSON.parse(anyError.details) as { hint?: string }).hint; } catch { hint = anyError.details; }
    }
    return {
      exitCode: 18,
      stdout: `${JSON.stringify({ outcome: 'unknown', hint: hint ?? 'reconcile with status --parent before re-spawning' }, null, 2)}`,
      stderr: `pi-orch: ${rawMessage}`,
    };
  }
  const lines = [code ? `pi-orch: ${code}: ${rawMessage}` : rawMessage.startsWith('pi-orch:') ? rawMessage : `pi-orch: ${rawMessage}`];
  if (anyError.failures !== undefined) lines.push(`failures: ${JSON.stringify(anyError.failures)}`);
  const message = lines.join('\n');
  if (code !== undefined && code in ERROR_CODE_EXIT_CODES) {
    return { exitCode: ERROR_CODE_EXIT_CODES[code] ?? 1, stderr: message };
  }
  if (anyError.status === 429 || anyError.status === 503) {
    if (anyError.retryAfterSeconds !== undefined) {
      return { exitCode: 10, stderr: `${message}\nretry-after: ${anyError.retryAfterSeconds}s` };
    }
    return { exitCode: 10, stderr: message };
  }
  if (anyError.status === 409) return { exitCode: 12, stderr: message };
  return { exitCode: 1, stderr: message };
}

function output<T>(json: boolean, body: T, human: (value: T) => string): CliResult {
  return { exitCode: 0, stdout: json ? `${JSON.stringify(body, null, 2)}` : human(body) };
}

// ─── process entry ───────────────────────────────────────────────────────────

export function makeClientFactory(argv: string[]): (config: { parentSessionId?: string }) => ClientLike {
  const args = parseArgs(argv);
  const socket = flagString(args, 'socket') ?? process.env.PI_WEB_UI_SOCKET ?? defaultSocketPath(process.env);
  const tokenPath = flagString(args, 'token-path') ?? process.env.PI_WEB_UI_TOKEN_PATH ?? defaultTokenPath(process.env);
  const apiBase = flagString(args, 'api-base') ?? process.env.PI_WEB_UI_API_BASE;
  const routeLimits = mergeRouteLimits(process.env, routeLimitOverrides(args.repeatable.get('route-limit') ?? []));
  return ({ parentSessionId }) => {
    const token = readToken(tokenPath);
    return new PiOrchClient({
      transport: { socketPath: apiBase ? undefined : socket, apiBase, token },
      parentSessionId,
      routeLimits,
    }) as unknown as ClientLike;
  };
}

export async function main(processObject: NodeJS.Process): Promise<void> {
  const argv = processObject.argv.slice(2);
  const deps: CliDeps = {
    env: processObject.env,
    stdout: (line) => processObject.stdout.write(`${line}\n`),
    stderr: (line) => processObject.stderr.write(`${line}\n`),
    randomId: () => `piorch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    client: makeClientFactory(argv),
  };
  const result = await runCli(argv, deps);
  if (result.stdout !== undefined) deps.stdout(result.stdout);
  if (result.stderr !== undefined && result.exitCode !== 0 && result.exitCode !== 2) deps.stderr(result.stderr);
  if (result.stderr !== undefined && result.exitCode === 2) deps.stderr(result.stderr);
  processObject.exitCode = result.exitCode;
}

const invokedDirectly = process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('pi-orch');
if (invokedDirectly) void main(process);
