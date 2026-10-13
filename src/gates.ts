/**
 * W2-g — the brief's machine-readable GATES block.
 *
 *   GATES:
 *   - `env NODE_ENV=test npm test` → 0
 *   - npm run typecheck -> 0
 *
 * A line that is exactly `GATES:` opens the block; each following line is
 * `- <command> → <expected exit>` (the ASCII `->` is accepted too). The block
 * ends at the first blank line after the first gate, or at the first line that
 * is not a bullet. `verify --gates-file` re-runs every gate and compares exits.
 */

export interface Gate {
  command: string;
  expectedExit: number;
}

export interface ParsedGates {
  /** A `GATES:` header line was present. */
  found: boolean;
  gates: Gate[];
  /** Bullet lines inside the block that could not be parsed (kept verbatim). */
  malformed: string[];
}

const BULLET = /^\s*-\s+(.*?)\s*(?:→|->)\s*(\d+)\s*$/;

export function parseGatesBlock(text: string): ParsedGates {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^GATES:\s*$/i.test(line.trim()));
  if (start === -1) return { found: false, gates: [], malformed: [] };
  const gates: Gate[] = [];
  const malformed: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      if (gates.length + malformed.length > 0) break;
      continue;
    }
    if (!/^\s*-\s/.test(line)) break;
    const match = BULLET.exec(line);
    const raw = match?.[1]?.trim();
    if (!match || !raw) {
      malformed.push(line.trim());
      continue;
    }
    const command = raw.length > 1 && raw.startsWith('`') && raw.endsWith('`') ? raw.slice(1, -1).trim() : raw;
    gates.push({ command, expectedExit: Number(match[2]) });
  }
  return { found: true, gates, malformed };
}

const REFUSED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b/, reason: "contains 'git push' (verify never publishes)" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "contains 'git reset --hard' (verify never rewrites a working tree)" },
  { pattern: /\brm\s+-rf\s+\//, reason: "contains 'rm -rf /' (verify never deletes)" },
  { pattern: /\bnpm\s+(?:ci|install|i)\b/, reason: "contains 'npm ci'/'npm install' (verify never changes installed dependencies)" },
];

/** Why a gate command may not be run by the read-only verifier, or undefined when it may. */
export function gateRefusal(command: string): string | undefined {
  const normalised = command.replace(/\s+/g, ' ');
  for (const { pattern, reason } of REFUSED) {
    if (pattern.test(normalised)) return `refused: ${reason}`;
  }
  return undefined;
}

export interface GateResult {
  command: string;
  expectedExit: number;
  /** Absent when the gate was refused or could not run. */
  actualExit?: number;
  result: 'verified' | 'contradicted' | 'unverifiable';
  timedOut?: boolean;
  refused?: string;
  /** The last 20 lines of combined stdout+stderr. */
  outputTail: string[];
}

export const GATE_OUTPUT_TAIL_LINES = 20;
export const DEFAULT_GATE_TIMEOUT_MS = 1_800_000;

export function outputTail(stdout: string, stderr: string): string[] {
  const lines = `${stdout}${stdout && stderr && !stdout.endsWith('\n') ? '\n' : ''}${stderr}`.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-GATE_OUTPUT_TAIL_LINES);
}
