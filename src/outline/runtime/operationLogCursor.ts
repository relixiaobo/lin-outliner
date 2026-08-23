import { OutlineContractError, outlineError } from '../contract/errors';

export type OperationLogCursor =
  | { readonly kind: 'history'; readonly filterHash: string; readonly afterOperationId: string }
  | { readonly kind: 'affected'; readonly filterHash: string; readonly operationId: string; readonly offset: number };

export function encodeOperationLogCursor(cursor: OperationLogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeOperationLogCursor(cursor: string): OperationLogCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(value)) throw new Error('not an object');
    if (value.kind === 'history'
      && typeof value.filterHash === 'string'
      && typeof value.afterOperationId === 'string') {
      return value as unknown as OperationLogCursor;
    }
    if (value.kind === 'affected'
      && typeof value.filterHash === 'string'
      && typeof value.operationId === 'string'
      && Number.isSafeInteger(value.offset)
      && (value.offset as number) >= 0) {
      return value as unknown as OperationLogCursor;
    }
    throw new Error('invalid fields');
  } catch {
    throw new OutlineContractError(outlineError(
      'stale_revision',
      'conflict',
      'Operation log cursor is invalid or no longer matches the requested page.',
    ));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
