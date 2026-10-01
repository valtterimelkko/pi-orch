/**
 * C3b item 1 — the child completion dispatch template, ONE source of truth.
 *
 * This is the exact instruction paragraph C3a recorded verbatim (C3a.md,
 * correction 01 §1) and live-proved on the server side (16/16 GLM 5.3 Flash
 * children produced a parseable `pi-completion/v1` block with it). The client
 * appends it by default to every `prompt` message and to a goal objective at
 * `spawn`; `completionTemplate: false` (CLI `--no-completion-template`) opts
 * out. test/completion-template.test.ts pins this constant byte-for-byte
 * against C3a.md, so the template cannot drift from its live proof.
 *
 * Do NOT edit this string without re-running the C3a-class live proof: it is
 * the wording real models demonstrably comply with.
 */

export const COMPLETION_REPORT_INSTRUCTION: string = [
  'END-OF-TASK REPORT (required): the LAST thing in your final answer must be exactly this kind of fenced block (info string `completion`, JSON body):',
  '',
  '```completion',
  '{"schema":"pi-completion/v1","status":"done","summary":"<one line>","commands":[{"command":"<a command you ran>","exitCode":0}],"filesChanged":["<path>"]}',
  '```',
  '',
  'Fill in the real values; add "tests", "commits", "openIssues" or "blockedReason" fields only if they apply. Do not end your turn with only a tool call: after your final tool call, always write a short final answer that ends with the report block. Nothing after the closing fence.',
].join('\n');

/**
 * I5 — the goal-marker instruction, for goal children ONLY (plain prompts keep
 * COMPLETION_REPORT_INSTRUCTION byte-identical, pinned in
 * test/completion-template.test.ts). Root cause (plan §R4 interim I5, from the
 * production smoke): the goal engine's prompt says to state the status marker
 * at the END of the turn, while this template says the report block must be the
 * LAST thing — the model obeyed the template and dropped the marker, so the
 * goal looped to its turn budget. The goal engine's verifier accepts the LAST
 * `Status: …` line ANYWHERE in the message (it must start its own line), so the
 * conflict disappears if the marker is written immediately BEFORE the block:
 * the block stays last and the marker stays visible.
 *
 * The instruction names the exact line forms, requires the marker to start its
 * own line as PLAIN TEXT, and forbids decoration: the verifier's pattern is
 * `^\s*(?:\*\*)?Status:\s*(GOAL_ACHIEVED|CONTINUING|NEEDS_USER_INPUT)` — a
 * backtick-quoted or bullet-prefixed line never matches (bold is tolerated).
 */
export const GOAL_MARKER_INSTRUCTION: string = [
  'GOAL STATUS LINE (required while the goal is active): when the goal is met, write the exact line Status: GOAL_ACHIEVED on a line of its own IMMEDIATELY BEFORE the report block, so the report block remains the last thing in your answer. Until the goal is met, write the exact line Status: CONTINUING in that same place instead (on its own line, immediately before the block).',
  'Write the status line as plain text starting the line — no backticks, no quotes, no bullet, nothing before the word Status; brief progress may follow it after an em-dash. Never write the status line after the report block.',
].join('\n');

/**
 * I5 — the exact shape of EVERY optional field, read from the contract
 * snapshot (contract/internal-api-client-snapshot.json, types.CompletionBlock,
 * contractVersion 1.58.1 — test/completion-template.test.ts validates the
 * shapes against that snapshot and against the client's own resolver).
 * Root cause: the template said "add \"tests\" … only if they apply" without a
 * shape, so GLM 5.3 Flash wrote `"tests": "4 pass / 0 fail"` (a string) and the
 * server rejected the block SCHEMA_VIOLATION fieldPath tests — 7/7 blocks in
 * the IV integrated proof. Each line that starts with `{` is one complete JSON
 * object showing one field's exact shape.
 */
export const COMPLETION_FIELD_SHAPES: string = [
  'FIELD SHAPES — every optional field of pi-completion/v1 (the server rejects a block whose fields do not match these shapes exactly; omit a field that does not apply, and never invent other fields):',
  '{"summary":"<one line>"}',
  '{"commands":[{"command":"<a command you ran>","exitCode":0,"note":"<optional>"}]}',
  '{"tests":[{"name":"<test or suite name>","result":"pass","note":"<optional>"}]}',
  '{"commits":[{"sha":"<full sha>","repo":"<repo path>","subject":"<optional>"}]}',
  '{"filesChanged":["<path>"]}',
  '{"openIssues":["<issue>"]}',
  '{"blockedReason":"<why the task is blocked>"}',
  'Fence format: open the block with a line that is exactly ```completion on its own line (nothing else on that line), put the JSON on the next line, and close with ``` on its own line. The server only captures the block when the JSON is on its own line; JSON on the same line as the opening fence is not a block.',
  '"tests" is an ARRAY of objects and each "result" is "pass", "fail" or "skip" — never write "tests" as a string such as "4 pass / 0 fail". Omit any field that does not apply.',
].join('\n');

/**
 * I5 — the full instruction text a GOAL child receives as the template
 * follow-up: the C3a-proven verbatim paragraph, plus the marker instruction
 * and the field shapes. Composed here so the client, the tests and the live
 * proof all quote the same bytes.
 */
export const GOAL_REPORT_INSTRUCTION: string = [
  COMPLETION_REPORT_INSTRUCTION,
  '',
  GOAL_MARKER_INSTRUCTION,
  '',
  COMPLETION_FIELD_SHAPES,
].join('\n');

/**
 * Append the template to a task message or goal objective as its own trailing
 * paragraph. Idempotent: a task that already carries the template is returned
 * unchanged (re-dispatching a templated prompt never double-appends).
 */
export function applyCompletionTemplate(task: string): string {
  if (!task || task.length === 0) throw new Error('pi-orch: completion template needs a non-empty task');
  if (task.includes(COMPLETION_REPORT_INSTRUCTION)) return task;
  return `${task}\n\n${COMPLETION_REPORT_INSTRUCTION}`;
}

/**
 * Goal objectives are SINGLE-LINE on the server (createSessionBody refine),
 * so the verbatim multi-line paragraph cannot ride in the objective itself.
 * The goal injection instead appends this flattened, single-line POINTER
 * (derived from the constant — same schema name, same follow-up promise) and
 * the client delivers the verbatim paragraph as a follow_up prompt right
 * after the create (the C3a live-proven shape, 16/16 parse rate).
 */
/**
 * I5 correction 01 — the POINTER's one-sentence marker reminder. The full
 * explanation (GOAL_MARKER_INSTRUCTION) rides in the template follow-up; the
 * pointer keeps only this reminder plus the schema name and the follow-up
 * promise, so the suffix stays within the 700-character budget (was 1,280,
 * which had shrunk the largest accepted raw objective from 3,335 to 2,720).
 * Same rules as the full instruction: exact line forms, own line, immediately
 * before the block, plain text.
 */
export const GOAL_MARKER_REMINDER: string =
  'When the goal is met, write the exact line Status: GOAL_ACHIEVED on its own line immediately before the report block (until then, Status: CONTINUING in the same place).';

/**
 * Goal objectives are SINGLE-LINE on the server (createSessionBody refine),
 * so the verbatim multi-line paragraph cannot ride in the objective itself.
 * The goal injection appends this single-line POINTER — a concise marker
 * reminder plus the schema name and the follow-up promise (I5 correction 01:
 * suffix ≤ 700 chars; the flattened template no longer rides here) — and the
 * client delivers the verbatim paragraph plus the full marker instruction and
 * field shapes as a follow_up prompt right after the create (the C3a
 * live-proven shape, 16/16 parse rate).
 */
export function applyGoalObjectiveTemplate(objective: string): string {
  if (!objective || objective.length === 0) throw new Error('pi-orch: completion template needs a non-empty task');
  if (objective.includes('pi-completion/v1')) return objective;
  // I5 correction 01: the pointer is a POINTER. The flattened template used to
  // ride here too (suffix 1,280 chars), which cost 615 characters of objective
  // budget for text the follow-up repeats verbatim — so it moved out.
  return `${objective} [${GOAL_MARKER_REMINDER} When you finish: end with the fenced pi-completion/v1 completion report block (the full report instructions arrive as a follow-up message.)]`;
}
