export function encodeCursor(value: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null | undefined): Record<string, string | number> | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isRecord(decoded)) throw new Error('cursor payload must be an object');
    for (const entry of Object.values(decoded)) {
      if (typeof entry !== 'string' && typeof entry !== 'number') throw new Error('cursor values must be scalar');
    }
    return decoded as Record<string, string | number>;
  } catch {
    throw new Error('Invalid pagination cursor');
  }
}

export function pageLimit(value: number | null | undefined): number {
  if (value === null || value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('Page limit must be an integer between 1 and 100');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
