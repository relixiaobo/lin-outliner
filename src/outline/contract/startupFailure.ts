/** Private parent/child startup observation; it grants no Runtime ownership. */
export interface OutlineStartupFailure {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly found?: number;
  readonly expected?: number;
}

export function describeOutlineStartupFailure(error: unknown): OutlineStartupFailure {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : 'Outline Runtime startup failed.';
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: message.length <= 4_000 ? message : 'Outline Runtime startup details exceed the display limit.',
    ...(typeof record.code === 'string' && record.code.length < 80 ? { code: record.code } : {}),
    ...(typeof record.found === 'number' && typeof record.expected === 'number'
      ? { found: record.found, expected: record.expected } : {}),
  };
}

export function readOutlineStartupFailure(value: unknown): Error | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length > 80
    || typeof record.message !== 'string' || record.message.length > 4_000) return null;
  const error = record.name === 'SyntaxError' ? new SyntaxError(record.message) : new Error(record.message);
  return Object.assign(error, {
    ...(typeof record.code === 'string' && record.code.length < 80 ? { code: record.code } : {}),
    ...(typeof record.found === 'number' && typeof record.expected === 'number'
      ? { found: record.found, expected: record.expected } : {}),
  });
}
