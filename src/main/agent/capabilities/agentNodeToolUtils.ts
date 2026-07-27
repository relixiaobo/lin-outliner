export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function elapsed(started: number): number {
  return Date.now() - started;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function compactOutline(outlines: string[]): string | undefined {
  const text = outlines.map((outline) => outline.trim()).filter(Boolean).join('\n\n');
  return text || undefined;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function firstDuplicate<T>(values: T[]): T | undefined {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
