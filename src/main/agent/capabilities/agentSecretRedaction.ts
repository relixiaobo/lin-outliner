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

// Durable JSON strings use only formats that identify a credential with high
// confidence. Generic `token=...` prose is ambiguous in commands and source
// files; structured JSON keys are handled separately below.
const DURABLE_STRING_REDACTION_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9_./+=-]{12,}/gi,
];

const BENIGN_SECRET_LIKE_KEYS = new Set([
  'authorizationendpoint',
  'authorizationurl',
  'authorizationuri',
  'availabletokens',
  'candidatestokencount',
  'childtokencap',
  'completiontokens',
  'estimatedinputtokens',
  'estimatedtokens',
  'fixedtokens',
  'fulltokens',
  'inputtokenlimit',
  'inputtokens',
  'maxoutputtokens',
  'maxtokens',
  'maxtotaltokens',
  'modelcalltokens',
  'outputtokens',
  'passwordpolicy',
  'pdfpasswordprotected',
  'prompttokencount',
  'prompttokens',
  'reasoningtokens',
  'remainingfulltokens',
  'remainingtokenbudget',
  'reportedreasoningtokens',
  'requiredtokens',
  'reservedoutputtokens',
  'retainedtokens',
  'secretpolicy',
  'subagenttokenbudget',
  'tokenbudget',
  'tokencount',
  'tokenlimit',
  'tokentype',
  'tokenusage',
  'totaltokencount',
  'totaltokens',
  'tokensused',
  'waitingforauthorization',
]);
const SECRET_KEY_NOUNS = new Set([
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
]);
const SECRET_KEY_PREFIXES = new Set([
  'api',
  'auth',
  'client',
  'encryption',
  'private',
  'secret',
  'signing',
]);
const SECRET_KEY_SUBSTRING_PATTERN = /credential|password|passwd|authorization|bearer|secret|token|(?:api|auth|client|encryption|private|signing)(?:key|keys)/;
const UNSCANNABLE_JSON_REDACTION = '[redacted unscannable JSON]';

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
 * `authorization`), preserving structure.
 */
export function redactSecretKeyedValues(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecretKeyedValues);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? '[redacted]' : redactSecretKeyedValues(item);
  }
  return output;
}

export interface SecretRedactionResult<T> {
  readonly value: T;
  /** RFC 6901 JSON pointers whose persisted values differ from the source. */
  readonly redactedPaths: readonly string[];
}

/**
 * Redact secret-bearing JSON without changing its container or primitive types.
 * Type preservation gives replay validation the best chance to succeed while
 * the pointer list makes the substitution explicit to the model.
 */
export function redactSecretLikeJson<T>(value: T): SecretRedactionResult<T> {
  const redactedPaths: string[] = [];
  const visit = (input: unknown, path: string, secretKey: boolean): unknown => {
    if (secretKey) {
      const redacted = redactValuePreservingShape(input);
      if (!jsonValuesEqual(redacted, input)) redactedPaths.push(path || '');
      return redacted;
    }
    if (typeof input === 'string') {
      const redacted = redactDurableJsonString(input);
      if (redacted !== input) redactedPaths.push(path || '');
      return redacted;
    }
    if (Array.isArray(input)) {
      return input.map((entry, index) => visit(entry, `${path}/${index}`, false));
    }
    if (input === null || typeof input !== 'object') return input;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      const childPath = `${path}/${escapeJsonPointerToken(key)}`;
      output[key] = visit(entry, childPath, isSecretKey(key));
    }
    return output;
  };
  return { value: visit(value, '', false) as T, redactedPaths };
}

function redactValuePreservingShape(value: unknown): unknown {
  if (typeof value === 'string') return '[redacted]';
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.map(redactValuePreservingShape);
  if (value === null || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [key, redactValuePreservingShape(entry)]));
}

function isSecretKey(key: string): boolean {
  const segments = secretKeySegments(key);
  const normalized = segments.join('');
  if (BENIGN_SECRET_LIKE_KEYS.has(normalized)) return false;
  if (segments.some((segment) => SECRET_KEY_NOUNS.has(segment))) return true;
  if (segments.some((segment, index) => (
    (segment === 'key' || segment === 'keys')
    && index > 0
    && SECRET_KEY_PREFIXES.has(segments[index - 1]!)
  ))) return true;
  return SECRET_KEY_SUBSTRING_PATTERN.test(normalized);
}

function secretKeySegments(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function redactDurableJsonString(content: string): string {
  let redacted = redactJsonEncodedSecretValues(content);
  for (const pattern of DURABLE_STRING_REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, '[redacted secret-like content]');
  }
  return redacted;
}

interface JsonReplacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

/** Redact secret-keyed values in valid JSON while preserving all unrelated bytes. */
export function redactJsonEncodedSecretValues(content: string): string {
  const start = skipJsonWhitespace(content, 0);
  if (content[start] !== '{' && content[start] !== '[') return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return content;
  }
  if (parsed === null || typeof parsed !== 'object') return content;
  try {
    const replacements: JsonReplacement[] = [];
    const end = scanJsonValue(content, start, false, replacements);
    if (skipJsonWhitespace(content, end) !== content.length || replacements.length === 0) return content;
    let redacted = content;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      redacted = redacted.slice(0, replacement.start) + replacement.value + redacted.slice(replacement.end);
    }
    return redacted;
  } catch {
    // Valid JSON must never bypass durable redaction because a pathological
    // nesting shape exceeded the formatting-preserving scanner's call stack.
    return UNSCANNABLE_JSON_REDACTION;
  }
}

function scanJsonValue(
  source: string,
  offset: number,
  forceRedaction: boolean,
  replacements: JsonReplacement[],
): number {
  const start = skipJsonWhitespace(source, offset);
  const token = source[start];
  if (token === '"') {
    const end = scanJsonString(source, start);
    const value = JSON.parse(source.slice(start, end)) as string;
    if (forceRedaction && value !== '[redacted]') {
      replacements.push({ start, end, value: JSON.stringify('[redacted]') });
    } else if (!forceRedaction) {
      const nested = redactJsonEncodedSecretValues(value);
      if (nested !== value) replacements.push({ start, end, value: JSON.stringify(nested) });
    }
    return end;
  }
  if (token === '{') return scanJsonObject(source, start, forceRedaction, replacements);
  if (token === '[') return scanJsonArray(source, start, forceRedaction, replacements);
  let end = start;
  while (end < source.length && !/[\s,}\]]/.test(source[end]!)) end += 1;
  if (end === start) throw new Error('Invalid JSON value');
  if (forceRedaction) {
    const value = JSON.parse(source.slice(start, end)) as unknown;
    const replacement = typeof value === 'number'
      ? value === 0 ? null : '0'
      : value === true ? 'false' : null;
    if (replacement !== null) replacements.push({ start, end, value: replacement });
  }
  return end;
}

function scanJsonObject(
  source: string,
  start: number,
  forceRedaction: boolean,
  replacements: JsonReplacement[],
): number {
  let offset = skipJsonWhitespace(source, start + 1);
  if (source[offset] === '}') return offset + 1;
  while (offset < source.length) {
    if (source[offset] !== '"') throw new Error('Invalid JSON object key');
    const keyEnd = scanJsonString(source, offset);
    const key = JSON.parse(source.slice(offset, keyEnd)) as string;
    offset = skipJsonWhitespace(source, keyEnd);
    if (source[offset] !== ':') throw new Error('Invalid JSON object delimiter');
    offset = scanJsonValue(source, offset + 1, forceRedaction || isSecretKey(key), replacements);
    offset = skipJsonWhitespace(source, offset);
    if (source[offset] === '}') return offset + 1;
    if (source[offset] !== ',') throw new Error('Invalid JSON object separator');
    offset = skipJsonWhitespace(source, offset + 1);
  }
  throw new Error('Unterminated JSON object');
}

function scanJsonArray(
  source: string,
  start: number,
  forceRedaction: boolean,
  replacements: JsonReplacement[],
): number {
  let offset = skipJsonWhitespace(source, start + 1);
  if (source[offset] === ']') return offset + 1;
  while (offset < source.length) {
    offset = scanJsonValue(source, offset, forceRedaction, replacements);
    offset = skipJsonWhitespace(source, offset);
    if (source[offset] === ']') return offset + 1;
    if (source[offset] !== ',') throw new Error('Invalid JSON array separator');
    offset = skipJsonWhitespace(source, offset + 1);
  }
  throw new Error('Unterminated JSON array');
}

function scanJsonString(source: string, start: number): number {
  let offset = start + 1;
  while (offset < source.length) {
    if (source[offset] === '"') return offset + 1;
    if (source[offset] === '\\') offset += 1;
    offset += 1;
  }
  throw new Error('Unterminated JSON string');
}

function skipJsonWhitespace(source: string, start: number): number {
  let offset = start;
  while (offset < source.length && /\s/.test(source[offset]!)) offset += 1;
  return offset;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  if (
    left === null
    || right === null
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) return false;
  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightRecord = right as Record<string, unknown>;
  if (leftEntries.length !== Object.keys(rightRecord).length) return false;
  return leftEntries.every(([key, entry]) => (
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && jsonValuesEqual(entry, rightRecord[key])
  ));
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Elide long base64/blob runs to a length note (inline images, encoded blobs). */
export function elideLargeBlobs(content: string): string {
  LARGE_BLOB_PATTERN.lastIndex = 0;
  return content.replace(LARGE_BLOB_PATTERN, (match) => `[base64 elided: ${match.length} chars]`);
}
