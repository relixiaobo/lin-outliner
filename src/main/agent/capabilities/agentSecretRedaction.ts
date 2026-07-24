const SECRET_LIKE_DETECTION_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?:api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/gi,
  /\bBearer\s+[A-Za-z0-9_./+=-]{12,}/gi,
];

const SECRET_LIKE_REDACTION_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?:api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/gi,
  /\bBearer\s+[A-Za-z0-9_./+=-]{12,}/gi,
];

// Object keys whose values are credentials — redacted by NAME before anything
// reaches an on-screen surface (complements the value-pattern pass above).
const SECRET_KEY_PATTERN = /api[_-]?key|authorization|bearer|secret|password|passwd|pwd|token/i;

// A long unbroken token run (base64 / blob / data URI) — elided to a length note
// so an inline image/blob can't bloat a debug payload or the cache.
const LARGE_BLOB_PATTERN = /[A-Za-z0-9+/=_-]{256,}/g;

export function containsSecretLikeContent(content: string): boolean {
  return SECRET_LIKE_DETECTION_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}

export function redactSecretLikeContent(content: string): string {
  let redacted = content;
  for (const pattern of SECRET_LIKE_REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, '[redacted secret-like content]');
  }
  return redacted;
}

/**
 * Recursively redact object VALUES under secret-bearing KEYS (e.g. `api_key`,
 * `authorization`), preserving structure. Pairs with {@link redactSecretLikeContent}
 * (value-pattern) for defense in depth; both live here so they evolve together.
 */
export function redactSecretKeyedValues(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecretKeyedValues);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecretKeyedValues(item);
  }
  return output;
}

/** Elide long base64/blob runs to a length note (inline images, encoded blobs). */
export function elideLargeBlobs(content: string): string {
  LARGE_BLOB_PATTERN.lastIndex = 0;
  return content.replace(LARGE_BLOB_PATTERN, (match) => `[base64 elided: ${match.length} chars]`);
}
