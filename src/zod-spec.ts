/**
 * Minimal validator for the snapshot's zod-derived field descriptions
 * (`pi-orch-contract-snapshot/v1`). Used by the tests to prove the request
 * builders conform to the server's actual schemas; importable so tooling can
 * run the same conformance check ad hoc.
 *
 * Limitation (documented): zod `.superRefine` bodies are not introspectable, so
 * cross-field refinements (e.g. "pin xor retention" on create) are marked
 * `refined` in the snapshot but are not re-validated here — the server enforces
 * them and the builders simply never emit the conflicting combination.
 */

export interface ZodField {
  type: string;
  optional?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  int?: boolean;
  uuid?: boolean;
  values?: Array<string | number | boolean>;
  fields?: Record<string, ZodField>;
  strict?: boolean;
  items?: ZodField;
  refined?: boolean;
  defaulted?: boolean;
  opaque?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ZodSpec {
  readonly root: ZodField;

  constructor(root: ZodField) {
    this.root = root;
  }

  check(value: unknown, field: ZodField = this.root, path = ''): string[] {
    const problems: string[] = [];
    const at = path || '<root>';
    if (value === undefined) {
      if (!field.optional) problems.push(`${at}: required but missing`);
      return problems;
    }
    if (value === null) {
      if (!field.nullable) problems.push(`${at}: null is not allowed`);
      return problems;
    }
    switch (field.type) {
      case 'string': {
        if (typeof value !== 'string') {
          problems.push(`${at}: expected string, got ${typeof value}`);
          break;
        }
        if (field.min !== undefined && value.length < field.min) problems.push(`${at}: shorter than ${field.min}`);
        if (field.max !== undefined && value.length > field.max) problems.push(`${at}: longer than ${field.max}`);
        if (field.uuid && !UUID_RE.test(value)) problems.push(`${at}: not a uuid`);
        break;
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          problems.push(`${at}: expected finite number, got ${typeof value}`);
          break;
        }
        if (field.int && !Number.isInteger(value)) problems.push(`${at}: expected integer`);
        if (field.min !== undefined && value < field.min) problems.push(`${at}: below ${field.min}`);
        if (field.max !== undefined && value > field.max) problems.push(`${at}: above ${field.max}`);
        break;
      }
      case 'boolean':
        if (typeof value !== 'boolean') problems.push(`${at}: expected boolean, got ${typeof value}`);
        break;
      case 'enum':
        if (!field.values?.includes(value as string | number | boolean)) {
          problems.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(field.values)}`);
        }
        break;
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          problems.push(`${at}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
          break;
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(field.fields ?? {});
        for (const key of Object.keys(record)) {
          if (!keys.includes(key)) problems.push(`${at}.${key}: unknown key (schema is strict)`);
        }
        for (const key of keys) {
          const child = (field.fields ?? {})[key];
          if (child) problems.push(...this.check(record[key], child, `${at}.${key}`));
        }
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          problems.push(`${at}: expected array, got ${typeof value}`);
          break;
        }
        if (field.min !== undefined && value.length < field.min) problems.push(`${at}: fewer than ${field.min} items`);
        if (field.max !== undefined && value.length > field.max) problems.push(`${at}: more than ${field.max} items`);
        if (field.items) {
          value.forEach((item, index) => problems.push(...this.check(item, field.items as ZodField, `${at}[${index}]`)));
        }
        break;
      }
      case 'unknown':
        break;
      default:
        // Introspection gap (opaque zod wrapper): do not block — the server validates.
        break;
    }
    return problems;
  }
}
