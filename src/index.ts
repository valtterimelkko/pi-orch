/**
 * pi-orch — thin parent client for the Pi Web UI Internal API.
 * Public surface: the client class, the builders, the parsers and the loaded
 * contract snapshot. Zero runtime dependencies beyond Node's standard library.
 */

export { PiOrchClient, defaultConditions, type ClientConfig } from './client.ts';
export {
  buildCreateBody,
  buildPromptBody,
  buildWatchBody,
  buildPreflightSpec,
  agentEnd,
  goalEnd,
  goalPaused,
  questionSentinel,
  deadlineCondition,
  type CreateInput,
  type PromptInput,
  type Runtime,
  type ThinkingLevel,
} from './builders.ts';
export {
  parseReceipt,
  classifyReceipt,
  parseWatchesWait,
  isTerminalReceipt,
  ApiError,
  type Receipt,
  type ReceiptClassification,
  type WatchConditionSpec,
  type WatchFiring,
} from './parsers.ts';
export { waitOnChild, type WaitOutcome, type WaitDeps } from './wait.ts';
export { loadSnapshot, liveContractVersion, SNAPSHOT_SEARCH_PATHS, type ClientContractSnapshot, type LoadedSnapshot } from './snapshot.ts';
export { ZodSpec, type ZodField } from './zod-spec.ts';
export { EXIT_CODES, OUTCOME_EXIT_CODES, ERROR_CODE_EXIT_CODES, exitCodeFor, nameFor } from './exit-codes.ts';
export { Transport, TransportError, readToken, parseRetryAfter } from './transport.ts';
export { runCli, main, type CliDeps, type CliResult, type ClientLike } from './cli.ts';
