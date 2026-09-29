/** Structural types mirroring the snapshot's extracted-type entries. */

export interface TypeField {
  type: string;
  optional?: boolean;
}

export interface ExtractedType {
  kind: 'interface' | 'type' | 'enum';
  fields?: Record<string, TypeField>;
  type?: string;
  values?: string[];
}

export interface SnapshotRoute {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  handler: string;
  sourceFile: string;
  query?: Record<string, string>;
  request?: { zod?: string; type?: string };
  response?: string;
}
