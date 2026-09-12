import { readOutlineStartupFailure, type OutlineStartupFailure } from './startupFailure';

/** Private read-only child-process response; it contains no document content. */
export interface OutlineDataInspection {
  readonly version: 1;
  readonly exists: boolean;
  readonly hasTransactionLog: boolean;
  readonly identity: { readonly workspaceId: string; readonly documentId: string } | null;
  readonly error: OutlineStartupFailure | null;
}

export function decodeOutlineDataInspection(value: unknown): OutlineDataInspection {
  if (!record(value) || value.version !== 1 || typeof value.exists !== 'boolean' || typeof value.hasTransactionLog !== 'boolean'
    || (value.identity !== null && (!record(value.identity) || typeof value.identity.workspaceId !== 'string' || typeof value.identity.documentId !== 'string'))
    || (value.error !== null && !readOutlineStartupFailure(value.error))) throw new Error('Invalid Outline storage inspection response');
  return value as unknown as OutlineDataInspection;
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
