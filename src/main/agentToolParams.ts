export function recordParams(rawParams: unknown): Record<string, unknown> {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    throw new Error('Tool input must be an object.');
  }
  return rawParams as Record<string, unknown>;
}

export function requiredString(
  params: Record<string, unknown>,
  field: string,
  maxLength: number,
  normalize: (value: string) => string,
): string {
  const value = optionalString(params[field], maxLength, normalize);
  if (!value) throw new Error(`Pass ${field}.`);
  return value;
}

export function optionalString(
  value: unknown,
  maxLength: number,
  normalize: (value: string) => string,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalize(value);
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new Error(`Value is too long; max ${maxLength} characters.`);
  return normalized;
}

export function trimStringValue(value: string): string {
  return value.trim();
}

export function collapseWhitespaceString(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncatedStringValue(
  value: unknown,
  maxLength: number,
  normalize: (value: string) => string = collapseWhitespaceString,
): string {
  return typeof value === 'string' ? normalize(value).slice(0, maxLength) : '';
}

export function optionalTruncatedStringValue(
  value: unknown,
  maxLength: number,
  normalize: (value: string) => string = collapseWhitespaceString,
): string | undefined {
  const normalized = truncatedStringValue(value, maxLength, normalize);
  return normalized || undefined;
}

export function requiredNormalizedString<TErr extends Error>(
  value: unknown,
  name: string,
  createMissingError: (name: string) => TErr,
  normalize: (value: string) => string = trimStringValue,
): string {
  const normalized = typeof value === 'string' ? normalize(value) : '';
  if (!normalized) throw createMissingError(name);
  return normalized;
}

export function optionalNormalizedString(
  value: unknown,
  normalize: (value: string) => string = trimStringValue,
): string | undefined {
  const normalized = typeof value === 'string' ? normalize(value) : '';
  return normalized || undefined;
}

export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
