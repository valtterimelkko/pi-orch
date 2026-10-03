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
  validateGoalFields,
  GoalFieldValidationError,
} from './builders.ts';
import type { WatchConditionSpec } from './parsers.ts';
import { ApiError } from './parsers.ts';
import { ERROR_CODE_EXIT_CODES, exitCodeFor, VERIFY_EXIT_CODES } from './exit-codes.ts';
import { resolveRouteLimits } from './route-limits.ts';
import { defaultSocketPath, defaultTokenPath, loadSnapshot, liveContractVersion } from './snapshot.ts';
import { readToken } from './transport.ts';

export interface ClientLike {
  goalStart(sessionId: string, input: { objective: string; maxTurns?: number; verifyCommand?: string; budgetTokens?: number; completionTemplate?: boolean }): Promise<Record<string, unknown>>;
  registerWatch(sessionId: string, input: { conditions: WatchConditionSpec[]; label?: string; fireIfSettled?: boolean; pin?: boolean }): Promise<{ watchId: string; status?: string; generation?: string; raw: unknown }>;
  getWatch(sessionId: string): Promise<{ watchId: string; status?: string; label?: string; generation?: string; firingCount?: number; allFired?: boolean; firings?: Array<Record<string, unknown>> } | null>;
  deleteWatch(sessionId: string, options?: { expectedGeneration?: string }): Promise<{ success?: boolean; watchId?: string; generation?: string }>;
  spawn(input: Record<string, unknown>): Promise<{ sessionId: string; leaseId?: string; parentId?: string; resolvedModel?: string; raw?: unknown }>;
  prompt(sessionId: string, input: Record<string, unknown>): Promise<{ runId: string; sessionId: string; detached: boolean; duplicate: boolean; dispatchMode?: string }>;
  wait(options: { sessionId: string; runId?: string; conditions?: WatchConditionSpec[]; objective?: string; deadlineMs?: number; label?: string }): Promise<{ kind: string; [key: string]: unknown }>;
  result(runId: string, options?: { includeTranscript?: boolean }): Promise<Record<string, unknown>>;
  verify(input: { sessionId: string; runId?: string }): Promise<{ implemented: false; plannedBy: string } | { sessionId: string; verdict: string; claims: Array<Record<string, unknown>>; summary: string }>;
  cleanup(sessionId: string, options?: { leaseId?: string; ownerId?: string; watchId?: string }): Promise<{ released: boolean; deleted: boolean; notes: string[] }>;
  status(target: { parent?: string; sessionId?: string; owner?: string }): Promise<{ parent?: string; owner?: string; pruned?: number; children: Array<Record<string, unknown>> }>;
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
const BOOLEAN_FLAGS = new Set(['all', 'any', 'json', 'id-only', 'no-detach', 'require-active-turn', 'help', 'transcript', 'no-completion-template', 'pin', 'fire-if-settled', 'force-unconditional']);

export function parseArgs(argv: string[]): ParsedArgs {
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

export const HELP = `usage: pi-orch <verb> [args] [--json]

Verbs:
  capabilities                         read /capabilities (contract version)
  capacity                             read /capacity (admission preflight)
  models [--runtime rt] [--match sub]  list live model selectors
  spawn --runtime rt --cwd dir [...]   create a child (retention, goal, preflight)
  goal <sessionId> start [...]         arm a goal on a CREATED child (H-b parent
                                       pattern: create, then goal) with budget
  watch <sessionId> register --conditions a,b [--label L] [--pin] [--fire-if-settled]
  watch <sessionId> delete [--generation G] | list
                                       delete is generation-safe (409 mismatch → exit 19,
                                       nothing deleted); with no generation available it
                                       REFUSES unless --force-unconditional (legacy blind
                                       delete — the only unconditional path)
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
  status [--parent id] | [--owner id] | [sessionId]
                                       children by parent OR by retention owner
                                       (Claude Code parents: owner is the only
                                       lineage): busy, goal, last run

Scripting: use --json for full machine output, or --id-only (spawn: prints the
sessionId; prompt: prints the runId; watch register/list: prints the watchId)
for $(...) capture. never parse the human-readable output (its wording can change at any time).

Common flags: --socket P --token-path P --api-base URL --parent-session ID --json
  --snapshot P (compare the live /capabilities against this snapshot copy)

Spawn flags: --model-selector SEL | --model-match SUB, --thinking LEVEL,
  --owner ID [--ttl S] [--label L] (durable retention with your ownerId),
  --goal-objective OBJ [--goal-max-turns N] [--goal-verify CMD]
    [--goal-budget-tokens N] (token budget for the goal engine; the server
    default 5,000,000 pauses long goals mid-run — programme lanes used 60M on
    zai, ~40M DeepSeek),
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
  on a create-time goal objective)

Wait flags: --run-id RUNID, --objective OBJ (goal children: goal_end + paused +
  the Wave K auto-continue progress matched), --deadline S (default 1800),
  --label L, --conditions a,b
  (agent_end|goal_end|paused|question:TEXT|deadline:S),
  --all|--any <sessionId>[@<runId>] ...  wait several children in one call:
  --all settles every child, --any returns the first to settle. Unknown runs
  or sessions fail fast (exit 16) instead of sitting out the deadline.
  Wave K: a server auto-continue of a restart-interrupted goal child is
  progress — the JSON reports autoContinues: <n>; a visible stop the server
  did NOT continue settles as interrupted (exit 5) with the cause, the
  continueCount and a resume/re-dispatch note; provider-aborted goals end
  as before (a failed goal_end); status shows the same facts.

Exit codes: 0 ok · 1 error · 2 usage · 3 deadline · 4 run failed · 5 interrupted
  6 never started · 7 budget exceeded · 8 cancelled · 9 transport lost
  10 admission refused · 11 preflight failed · 12 refused busy · 14 prompt not
  executed · 15 turn stalled · 16 wait target not found · 17 goal cleared
  18 create unknown · 19 watch conflict · 20 verify contradicted
  21 verify unverifiable · 22 template not delivered · 23 credential in repo
  · 24 remote api base refused · 25 route limit (G1: spawn refused before any
  child was created; --wait-for-slot waits instead). Full table: README.md

Parent patterns (J2): a Claude Code parent is not a Pi Web UI session — its
  children carry only the --owner id (convention:
  orch-<programme>-<parentShort8>-<lane>). To wait idle, register a watch
  (watch ... register, or the watch-wake mod) and END THE TURN; pi-orch wait
  blocks the caller's turn. status --owner and cleanup --owner are the lineage
  surface; goals need --goal-budget-tokens when the child may run long.
`;

// J2 P3: every flag a verb reads, name by name. An unknown flag used to be
// stored by parseArgs and silently dropped (Phase A receipt:
// --goal-budget-tokens exited 0 while the goal armed with the 5M default) —
// now a usage error before the client factory runs.
const COMMON_FLAGS = new Set(['socket', 'token-path', 'api-base', 'parent-session', 'json', 'snapshot']);
const VERB_FLAGS: Record<string, Set<string>> = {
  capabilities: new Set([]),
  capacity: new Set([]),
  models: new Set(['runtime', 'match']),
  spawn: new Set(['runtime', 'cwd', 'owner', 'ttl', 'label', 'model-selector', 'model-match', 'thinking', 'goal-objective', 'goal-max-turns', 'goal-verify', 'goal-budget-tokens', 'wait-for-slot', 'agent-os-capture', 'no-completion-template', 'id-only', 'preflight-path', 'preflight-tool', 'route-limit']),
  prompt: new Set(['message', 'mode', 'no-detach', 'idempotency-key', 'verbosity', 'require-active-turn', 'owner', 'no-completion-template', 'id-only', 'preflight-path', 'preflight-tool', 'route-limit']),
  wait: new Set(['deadline', 'objective', 'conditions', 'run-id', 'all', 'any', 'label', 'slice']),
  result: new Set(['transcript']),
  verify: new Set(['run-id', 'since', 'rerun', 'rerun-timeout', 'cwd', 'repo']),
  cleanup: new Set(['lease', 'owner', 'watch']),
  status: new Set(['parent', 'owner']),
  goal: new Set(['goal-objective', 'goal-max-turns', 'goal-verify', 'goal-budget-tokens', 'no-completion-template']),
  watch: new Set(['conditions', 'objective', 'label', 'pin', 'fire-if-settled', 'id-only', 'generation', 'force-unconditional']),
};

/** The full allowed flag set for a verb (connection flags included), or undefined for an unknown verb. */
export function allowedFlagsFor(verb: string): Set<string> | undefined {
  const verbFlags = VERB_FLAGS[verb];
  if (!verbFlags) return undefined;
  return new Set([...COMMON_FLAGS, ...verbFlags]);
}

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
  const KNOWN_VERBS = new Set(['capabilities', 'capacity', 'models', 'spawn', 'prompt', 'wait', 'result', 'verify', 'cleanup', 'status', 'goal', 'watch']);
  if (!KNOWN_VERBS.has(args.verb)) {
    throw new UsageError(`unknown verb '${args.verb}'`);
  }
  // J2 P3: unknown flags are a usage error BEFORE anything runs — never a
  // silent drop (the Phase A footgun). Names the offending flags.
  const allowedFlags = allowedFlagsFor(args.verb) as Set<string>;
  const unknownFlags = [...args.flags.keys(), ...args.repeatable.keys()].filter((name) => !allowedFlags.has(name));
  if (unknownFlags.length > 0) {
    throw new UsageError(`unknown flag(s) for '${args.verb}': ${unknownFlags.map((name) => `--${name}`).join(', ')}`);
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
      const goalBudget = flagNumber(args, 'goal-budget-tokens');
      const preflight = preflightFrom(args);
      // 02-correction 1: the shared goal-field validation as a usage error
      // BEFORE the client factory — the Luna probe (1e12 budget) never
      // reaches a request now.
      // 04-correction B: ANY goal flag (an objective present even if empty,
      // a budget, max-turns, verify) opts this spawn into goal validation —
      // goal flags without an objective used to be silently dropped and a
      // PLAIN child created.
      const goalFlagsGiven = args.flags.has('goal-objective') || args.flags.has('goal-budget-tokens') || args.flags.has('goal-max-turns') || args.flags.has('goal-verify');
      if (goalFlagsGiven) {
        validatedGoalFields({ objective: goalObjective ?? '', maxTurns: flagNumber(args, 'goal-max-turns'), verifyCommand: flagString(args, 'goal-verify'), budgetTokens: goalBudget });
      }
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
          ? {
              objective: goalObjective,
              maxTurns: flagNumber(args, 'goal-max-turns'),
              verifyCommand: flagString(args, 'goal-verify'),
              ...(goalBudget !== undefined ? { budgetTokens: goalBudget } : {}),
            }
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
      // (Checked BEFORE the budget note — the note must never mask a failure.)
      const templateError = ((body as { raw?: { __templateFollowUpError?: unknown } }).raw)?.__templateFollowUpError;
      if (templateError !== undefined) {
        return {
          ...rendered,
          exitCode: 22,
          stderr: `pi-orch: TEMPLATE_NOT_DELIVERED — the completion template could not be delivered to ${(body as { sessionId?: string }).sessionId ?? 'the child'}: ${String(templateError)}. The child holds only the pointer objective, not the full report instructions; re-send the template with 'prompt <sessionId> --message <instructions>' or re-dispatch.`,
        };
      }
      // J2 P1/P2: an omitted budget must be visible, not silent — the Phase A
      // receipt armed a 5M goal believing it was 60M. A note, never an error.
      if (goalObjective && goalBudget === undefined) {
        return { ...rendered, stderr: DEFAULT_BUDGET_NOTE };
      }
      return rendered;
    }
    case 'goal': {
      // J2 P2: the H-b parent pattern's create-then-goal order.
      const sessionId = args.positional[0];
      const action = args.positional[1];
      if (!sessionId) throw new UsageError('goal needs <sessionId>');
      if (action !== 'start') throw new UsageError("goal supports only 'start' — pause/resume/clear stay interactive (goal <sessionId> start --goal-objective OBJ)");
      const objective = flagString(args, 'goal-objective');
      if (!objective) throw new UsageError('goal start needs --goal-objective OBJ');
      const budget = flagNumber(args, 'goal-budget-tokens');
      const maxTurns = flagNumber(args, 'goal-max-turns');
      const verifyCommand = flagString(args, 'goal-verify');
      // 02-correction 1: same validation, same usage-class failure, before
      // anything runs.
      validatedGoalFields({ objective, maxTurns, verifyCommand, budgetTokens: budget });
      const completionTemplate = args.flags.has('no-completion-template') ? false : undefined;
      const body = await getClient().goalStart(sessionId, {
        objective,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(verifyCommand !== undefined ? { verifyCommand } : {}),
        ...(budget !== undefined ? { budgetTokens: budget } : {}),
        ...(completionTemplate !== undefined ? { completionTemplate } : {}),
      });
      const rendered = output(json, body, (value) => {
        const goal = value as { status?: string; objective?: string };
        return `goal ${goal.status ?? 'unknown'}${goal.objective ? ` — ${goal.objective.slice(0, 80)}` : ''}`;
      });
      // 02-correction 3: a goal child armed through the verb is the same
      // receipt-less class — a template that could not be delivered is a real
      // failure (exit 22), exactly like on spawn.
      const templateError = ((body as { raw?: { __templateFollowUpError?: unknown } }).raw)?.__templateFollowUpError;
      if (templateError !== undefined) {
        return {
          ...rendered,
          exitCode: 22,
          stderr: `pi-orch: TEMPLATE_NOT_DELIVERED — the completion template could not be delivered to ${(body as { sessionId?: string }).sessionId ?? sessionId}: ${String(templateError)}. The child holds only the pointer objective, not the full report instructions; re-send the template with 'prompt <sessionId> --message <instructions>' or re-dispatch.`,
        };
      }
      return budget === undefined ? { ...rendered, stderr: DEFAULT_BUDGET_NOTE } : rendered;
    }
    case 'watch': {
      // J2 P4: register/list/delete WITHOUT waiting — the idle-parent pattern:
      // register, print the watchId, exit; the wake arrives via the watch-wake
      // mod (Claude Code) or the server's onFire (Pi sessions).
      const sessionId = args.positional[0];
      const sub = args.positional[1];
      if (!sessionId || !sub) throw new UsageError('watch needs <sessionId> register|list|delete');
      if (sub === 'register') {
        const conditionsFlag = flagString(args, 'conditions');
        if (!conditionsFlag) throw new UsageError('watch register needs --conditions (agent_end|goal_end|paused|question:TEXT|deadline:S)');
        const conditions = parseConditionList(conditionsFlag, flagString(args, 'objective'));
        const fireIfSettled = args.flags.has('fire-if-settled') ? true : undefined;
        const pin = args.flags.has('pin') ? true : undefined;
        const body = await getClient().registerWatch(sessionId, {
          conditions,
          ...(flagString(args, 'label') !== undefined ? { label: flagString(args, 'label') } : {}),
          ...(fireIfSettled !== undefined ? { fireIfSettled } : {}),
          ...(pin !== undefined ? { pin } : {}),
        });
        return output(json, body, (value) => {
          const watch = value as { watchId: string; status?: string };
          if (args.flags.has('id-only')) return watch.watchId;
          return `watch ${watch.watchId} (${watch.status ?? 'active'})`;
        });
      }
      if (sub === 'list') {
        const watch = await getClient().getWatch(sessionId);
        return output(json, { watch }, (value) => {
          const entry = (value as { watch: Record<string, unknown> | null }).watch;
          if (!entry) return 'no watch registered';
          if (args.flags.has('id-only')) return String(entry.watchId);
          return `watch ${String(entry.watchId)} status=${String(entry.status ?? 'unknown')} firings=${String(entry.firingCount ?? 0)}${entry.allFired ? ' (all fired)' : ''}${entry.label ? ` label=${String(entry.label)}` : ''}`;
        });
      }
      if (sub === 'delete') {
        // 04-correction A1: fail closed. A delete carries the server's CAS
        // precondition (expectedGeneration) from --generation or from a fresh
        // read; when NO generation is available (nothing registered, or a
        // read without one) the unconditional delete is REFUSED — exit 19 —
        // unless the caller passes --force-unconditional, the documented
        // legacy escape. 04-correction A2: the acknowledgement is validated
        // (success:true, watchId present, generation equal to the one sent)
        // before anything is reported as deleted.
        const force = args.flags.has('force-unconditional');
        let expectedGeneration = flagString(args, 'generation');
        if (expectedGeneration === undefined && !force) {
          const watch = await getClient().getWatch(sessionId);
          if (!watch) {
            return {
              exitCode: 19,
              stderr: `pi-orch: no watch registered for ${sessionId} — refusing an unconditional delete (pass --generation <g> to target a known watch, or --force-unconditional for the legacy blind delete)`,
            };
          }
          if (watch.generation === undefined) {
            return {
              exitCode: 19,
              stderr: `pi-orch: the watch on ${sessionId} reported no generation — refusing an unconditional delete (pass --generation <g>, or --force-unconditional for the legacy blind delete)`,
            };
          }
          expectedGeneration = watch.generation;
        }
        try {
          const body = await getClient().deleteWatch(sessionId, expectedGeneration !== undefined ? { expectedGeneration } : undefined);
          return output(json, body, (value) => {
            const deleted = value as { generation?: string };
            return `watch deleted${deleted.generation ? ` (generation ${deleted.generation})` : ''}`;
          });
        } catch (error) {
          const mismatch = error as { code?: string; expectedGeneration?: string; currentGeneration?: string; message?: string };
          if (mismatch.code === 'WATCH_GENERATION_MISMATCH') {
            return {
              exitCode: 19,
              stderr: `pi-orch: WATCH_GENERATION_MISMATCH — deleted nothing; the watch was replaced since it was read (expected ${mismatch.expectedGeneration ?? 'unknown'}, current ${mismatch.currentGeneration ?? 'unknown'})`,
            };
          }
          if (mismatch.code === 'WATCH_DELETE_ACK_FAILED') {
            return {
              exitCode: 19,
              stderr: mismatch.message ?? 'pi-orch: WATCH_DELETE_ACK_FAILED — nothing is reported as deleted',
            };
          }
          throw error;
        }
      }
      throw new UsageError(`unknown watch subcommand '${sub}' (register|list|delete — the verb never waits)`);
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
      // 02-correction 5: --slice never did anything; accepted as a deprecated
      // no-op so existing callers do not break silently.
      const sliceNote = args.flags.has('slice')
        ? 'pi-orch: note — --slice is a deprecated no-op (it never had any effect); it will be removed in a future release'
        : undefined;
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
        return { exitCode: body.exitCode, stdout, ...(sliceNote ? { stderr: sliceNote } : {}) };
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
      const waitStderr = exitCode === 0
        ? sliceNote
        : [stdout, sliceNote].filter(Boolean).join('\n');
      return { exitCode, stdout, ...(waitStderr !== undefined ? { stderr: waitStderr } : {}) };
    }
    case 'result': {
      const runId = args.positional[0];
      if (!runId) throw new UsageError('result needs <runId>');
      const body = await getClient().result(runId, { includeTranscript: args.flags.has('transcript') });
      return output(json, body, (value) => {
        const result = value as { status: string; finalText?: string; outputClass?: 'command' | 'final_text' | 'no_text'; outputClassBasis?: string; evidence: { transcript: string } };
        // I1 (H2 item 1): a handler-return receipt is a COMMAND — it has no
        // final text by design, so it must not read as an empty final answer.
        const outputLine = result.outputClass === 'command'
          ? `output command (slash-command handler return${result.outputClassBasis ? `: ${result.outputClassBasis}` : ''} — no final text is expected on this receipt)`
          : (result.finalText ?? '(no final text on the receipt — read the transcript)');
        return [
          `status ${result.status}`,
          outputLine,
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
      const owner = flagString(args, 'owner');
      // J2 P5: the external-parent lineage — Claude Code parents' children
      // carry only the retention ownerId, never a parentSessionId.
      if (owner) {
        if (sessionId || parent) throw new UsageError('--owner cannot combine with a sessionId or --parent');
        const body = await getClient().status({ owner });
        return output(json, body, (value) => {
          const status = value as { owner?: string; pruned?: number; children: Array<Record<string, unknown>> };
          const lines = status.children.map((child) => `${String(child.sessionId)} busy=${String(child.busy)} goal=${String(child.goalStatus)} last=${String((child.lastRun as { status?: string } | undefined)?.status)}${interruptionSuffix(child)}`);
          lines.push(`owner ${String(status.owner)}: ${status.children.length} child(ren), ${String(status.pruned ?? 0)} stale ledger entr(y/ies) pruned`);
          return lines.join('\n');
        });
      }
      if (!sessionId && !parent) throw new UsageError('status needs <sessionId>, --parent <id> or --owner <id>');
      const body = await getClient().status({ sessionId, parent });
      return output(json, body, (value) => {
        const status = value as { children: Array<Record<string, unknown>> };
        return status.children
          .map((child) => `${String(child.sessionId)} busy=${String(child.busy)} goal=${String(child.goalStatus)} last=${String((child.lastRun as { status?: string } | undefined)?.status)}${interruptionSuffix(child)}`)
          .join('\n');
      });
    }
    default:
      throw new UsageError(`unknown verb '${args.verb}'`);
  }
}

/**
 * Wave K: the interruption suffix on a status child line, present only when
 * the server holds interruption facts for the child's goal.
 */
function interruptionSuffix(child: Record<string, unknown>): string {
  const facts = child.goalInterruption as { cause?: string; continueCount?: number; autoContinued?: boolean } | undefined;
  if (!facts) return '';
  return ` interrupted cause=${facts.cause ?? 'unknown'} continueCount=${facts.continueCount ?? 0} autoContinued=${facts.autoContinued === true}`;
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

/** J2 P1/P2: printed on stderr (never an error) when a goal is armed without an explicit budget. */
const DEFAULT_BUDGET_NOTE = 'pi-orch: note — no --goal-budget-tokens given; the server default budget is 5,000,000 tokens, which pauses long goals mid-run';

/** 02-correction 1: validate the CLI-assembled goal fields as a USAGE error (exit 2) before any request. */
function validatedGoalFields(goal: { objective: string; maxTurns?: number; verifyCommand?: string; budgetTokens?: number }): void {
  try {
    validateGoalFields(goal);
  } catch (error) {
    if (error instanceof GoalFieldValidationError) throw new UsageError(error.message.replace(/^pi-orch: /, ''));
    throw error;
  }
}

// ─── process entry ───────────────────────────────────────────────────────────

export function makeClientFactory(argv: string[]): (config: { parentSessionId?: string }) => ClientLike {
  const args = parseArgs(argv);
  const socket = flagString(args, 'socket') ?? process.env.PI_WEB_UI_SOCKET ?? defaultSocketPath(process.env);
  const tokenPath = flagString(args, 'token-path') ?? process.env.PI_WEB_UI_TOKEN_PATH ?? defaultTokenPath(process.env);
  const apiBase = flagString(args, 'api-base') ?? process.env.PI_WEB_UI_API_BASE;
  // Correction 03 item 4: the route-limit flags are parsed LAZILY, inside the
  // closure — runCli calls the factory within its own try, so a junk value
  // surfaces as a UsageError → exit 2 with the usage text, never an uncaught
  // stack from main() before runCli can map it.
  let routeLimits: Record<string, number> | undefined;
  return ({ parentSessionId }) => {
    routeLimits ??= mergeRouteLimits(process.env, routeLimitOverrides(args.repeatable.get('route-limit') ?? []));
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
  // J2 P1/P2: stderr prints whenever present — success notes (the 5M default
  // budget note) must reach the caller, not just errors.
  if (result.stderr !== undefined) deps.stderr(result.stderr);
  processObject.exitCode = result.exitCode;
}

const invokedDirectly = process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('pi-orch');
if (invokedDirectly) void main(process);
