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
 * Append the template to a task message or goal objective as its own trailing
 * paragraph. Idempotent: a task that already carries the template is returned
 * unchanged (re-dispatching a templated prompt never double-appends).
 */
export function applyCompletionTemplate(task: string): string {
  if (!task || task.length === 0) throw new Error('pi-orch: completion template needs a non-empty task');
  if (task.includes(COMPLETION_REPORT_INSTRUCTION)) return task;
  return `${task}\n\n${COMPLETION_REPORT_INSTRUCTION}`;
}
