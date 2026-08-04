import { rules as recommendedSecretlintRules } from '@secretlint/secretlint-rule-preset-recommend';
import type {
  SecretLintRuleContext,
  SecretLintRuleCreator,
  SecretLintSourceCode,
  SecretLintSourceNodeLocation,
  SecretLintSourceNodePosition,
  SecretLintSourceNodeRange,
} from '@secretlint/types';

const REDACTED_SECRET = '[redacted]';
const REDACTED_SECRET_LIKE_CONTENT = '[redacted secret-like content]';

const SECRET_SCAN_RULES = (recommendedSecretlintRules as readonly SecretLintRuleCreator<unknown>[])
  .filter((rule) => rule.meta.type === 'scanner');

const PARTIAL_PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const DURABLE_HIGH_CONFIDENCE_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9_./+=-]{12,}/gi,
];
const MEMORY_TEXT_SECRET_ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/gi,
];

const SECRET_FIELD_TERMINALS = new Set([
  'bearer',
  'credential',
  'credentials',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
]);
const SECRET_KEY_QUALIFIERS = new Set([
  'api',
  'auth',
  'client',
  'encryption',
  'private',
  'secret',
  'signing',
]);
const UNSEPARATED_SECRET_FIELD_PATTERN = /^(?:api|auth|client|encryption|private|secret|signing)(?:key|keys)$|^(?:access|auth|id|refresh|session|validation)token$/;
const NON_CREDENTIAL_SCALAR_PATTERNS: readonly RegExp[] = [
  /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i,
  /^[-+]?0x[\da-f]+$/i,
  /^[-+]?0b[01]+$/i,
  /^[-+]?0o[0-7]+$/i,
  /^(?:nan|[-+]?infinity|true|false|null|undefined)$/i,
];
const CREDENTIAL_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*}|[A-Za-z_][A-Za-z0-9_]*)$/,
  /^%[A-Za-z_][A-Za-z0-9_]*%$/,
  /^\{\{[^}]+}}$/,
  /^<[^>]+>$/,
];

// A long unbroken token run (base64 / blob / data URI) - elided to a length note
// so an inline image/blob cannot bloat a debug payload or the cache.
const LARGE_BLOB_PATTERN = /[A-Za-z0-9+/=_-]{256,}/g;

interface TextRange {
  readonly start: number;
  readonly end: number;
}

export function containsSecretLikeContent(content: string): boolean {
  PARTIAL_PRIVATE_KEY_HEADER.lastIndex = 0;
  if (PARTIAL_PRIVATE_KEY_HEADER.test(content)) return true;
  if (secretlintRanges(content).length > 0) return true;
  return patternRanges(content, DURABLE_HIGH_CONFIDENCE_PATTERNS).length > 0;
}

export function redactSecretLikeContent(content: string): string {
  let redacted = redactKnownCredentialText(content);
  for (const pattern of MEMORY_TEXT_SECRET_ASSIGNMENT_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, REDACTED_SECRET_LIKE_CONTENT);
  }
  return redacted;
}

/** Redact string values under explicit credential field names, preserving all other shapes. */
export function redactSecretKeyedValues(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecretKeyedValues);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = typeof item === 'string' && isSecretStringField(key) && isCredentialCandidateString(item)
      ? REDACTED_SECRET
      : redactSecretKeyedValues(item);
  }
  return output;
}

export interface SecretRedactionResult<T> {
  readonly value: T;
  /** RFC 6901 JSON pointers whose persisted values differ from the source. */
  readonly redactedPaths: readonly string[];
}

/**
 * Redact known credential formats and string values under credential field names.
 * Ambiguous values and scanner failures pass through unchanged.
 */
export function redactSecretLikeJson<T>(value: T): SecretRedactionResult<T> {
  const redactedPaths: string[] = [];
  const visit = (input: unknown, path: string): unknown => {
    if (typeof input === 'string') {
      const redacted = redactKnownCredentialText(input);
      if (redacted !== input) redactedPaths.push(path || '');
      return redacted;
    }
    if (Array.isArray(input)) {
      return input.map((entry, index) => visit(entry, `${path}/${index}`));
    }
    if (input === null || typeof input !== 'object') return input;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      const childPath = `${path}/${escapeJsonPointerToken(key)}`;
      if (typeof entry === 'string' && isSecretStringField(key) && isCredentialCandidateString(entry)) {
        if (entry !== REDACTED_SECRET) redactedPaths.push(childPath);
        output[key] = REDACTED_SECRET;
      } else {
        output[key] = visit(entry, childPath);
      }
    }
    return output;
  };
  try {
    return { value: visit(value, '') as T, redactedPaths };
  } catch {
    return { value, redactedPaths: [] };
  }
}

/** Redact one serialized provider-arguments object without reinterpreting nested strings as JSON. */
export function redactJsonEncodedSecretValues(content: string): string {
  const start = skipJsonWhitespace(content, 0);
  if (content[start] !== '{' && content[start] !== '[') return content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== 'object') return content;
    const replacements: JsonReplacement[] = [];
    const end = scanJsonValue(content, start, false, replacements);
    if (skipJsonWhitespace(content, end) !== content.length || replacements.length === 0) return content;
    let redacted = content;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      redacted = redacted.slice(0, replacement.start) + replacement.value + redacted.slice(replacement.end);
    }
    return redacted;
  } catch {
    return content;
  }
}

interface JsonReplacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function scanJsonValue(
  source: string,
  offset: number,
  secretStringField: boolean,
  replacements: JsonReplacement[],
): number {
  const start = skipJsonWhitespace(source, offset);
  const token = source[start];
  if (token === '"') {
    const end = scanJsonString(source, start);
    const value = JSON.parse(source.slice(start, end)) as string;
    const redacted = secretStringField && isCredentialCandidateString(value)
      ? REDACTED_SECRET
      : redactKnownCredentialText(value);
    if (redacted !== value) replacements.push({ start, end, value: JSON.stringify(redacted) });
    return end;
  }
  if (token === '{') return scanJsonObject(source, start, replacements);
  if (token === '[') return scanJsonArray(source, start, replacements);
  let end = start;
  while (end < source.length && !/[\s,}\]]/.test(source[end]!)) end += 1;
  if (end === start) throw new Error('Invalid JSON value');
  return end;
}

function scanJsonObject(
  source: string,
  start: number,
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
    offset = scanJsonValue(source, offset + 1, isSecretStringField(key), replacements);
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
  replacements: JsonReplacement[],
): number {
  let offset = skipJsonWhitespace(source, start + 1);
  if (source[offset] === ']') return offset + 1;
  while (offset < source.length) {
    offset = scanJsonValue(source, offset, false, replacements);
    offset = skipJsonWhitespace(source, offset);
    if (source[offset] === ']') return offset + 1;
    if (source[offset] !== ',') throw new Error('Invalid JSON array separator');
    offset = skipJsonWhitespace(source, offset + 1);
  }
  throw new Error('Unterminated JSON array');
}

function redactKnownCredentialText(content: string): string {
  const ranges = [...secretlintRanges(content), ...patternRanges(content, DURABLE_HIGH_CONFIDENCE_PATTERNS)];
  if (ranges.length === 0) return content;
  let redacted = content;
  for (const range of mergeRanges(ranges).sort((left, right) => right.start - left.start)) {
    redacted = redacted.slice(0, range.start) + REDACTED_SECRET_LIKE_CONTENT + redacted.slice(range.end);
  }
  return redacted;
}

function patternRanges(content: string, patterns: readonly RegExp[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined || match[0].length === 0) continue;
      ranges.push({ start, end: start + match[0].length });
    }
  }
  return ranges;
}

function secretlintRanges(content: string): TextRange[] {
  try {
    const source = secretlintSource(content);
    const ranges: TextRange[] = [];
    for (const rule of SECRET_SCAN_RULES) {
      const reported: TextRange[] = [];
      let acceptingReports = true;
      const context = {
        sharedOptions: {},
        createTranslator: () => (messageId: string) => ({
          message: 'Known credential format detected',
          messageId,
          data: undefined,
        }),
        report: (descriptor: { readonly range: readonly [number, number] }) => {
          if (!acceptingReports) return;
          const [start, end] = descriptor.range;
          if (
            Number.isInteger(start)
            && Number.isInteger(end)
            && start >= 0
            && end > start
            && end <= content.length
          ) {
            reported.push({ start, end });
          }
        },
        ignore: () => {},
      } as SecretLintRuleContext;
      try {
        const pending = rule.create(context, {}).file?.(source);
        acceptingReports = false;
        if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
          void Promise.resolve(pending).catch(() => {});
          continue;
        }
        ranges.push(...reported);
      } catch {
        acceptingReports = false;
      }
    }
    return mergeRanges(ranges);
  } catch {
    return [];
  }
}

function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push(range);
    } else if (range.end > previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: range.end };
    }
  }
  return merged;
}

function isSecretStringField(key: string): boolean {
  const segments = secretKeySegments(key);
  const last = segments.at(-1);
  if (!last) return false;
  if (last === 'authorization') {
    return segments.length === 1 || segments.at(-2) === 'proxy' || segments.at(-2) === 'x';
  }
  if (SECRET_FIELD_TERMINALS.has(last)) return true;
  if (last === 'header' && segments.slice(0, -1).some((segment) => segment === 'authorization')) return true;
  if (last === 'hash' && segments.at(-2) === 'password') return true;
  if (last === 'pem' && segments.includes('private') && segments.includes('key')) return true;
  if (
    (last === 'key' || last === 'keys')
    && segments.slice(0, -1).some((segment) => SECRET_KEY_QUALIFIERS.has(segment))
  ) return true;
  return segments.length === 1 && UNSEPARATED_SECRET_FIELD_PATTERN.test(last);
}

function isCredentialCandidateString(value: string): boolean {
  const normalized = value.trim();
  if (normalized === '' || normalized === REDACTED_SECRET) return false;
  const scalar = normalized.replaceAll('_', '');
  if (NON_CREDENTIAL_SCALAR_PATTERNS.some((pattern) => pattern.test(scalar))) return false;
  if (CREDENTIAL_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return true;
}

function secretKeySegments(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function secretlintSource(content: string): SecretLintSourceCode {
  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lineStarts.push(index + 1);
  }
  const positionToIndex = (position: SecretLintSourceNodePosition): number => {
    const lineStart = lineStarts[Math.max(0, Math.min(lineStarts.length - 1, position.line - 1))] ?? 0;
    return Math.max(0, Math.min(content.length, lineStart + position.column));
  };
  const indexToPosition = (requestedIndex: number): SecretLintSourceNodePosition => {
    const index = Math.max(0, Math.min(content.length, requestedIndex));
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const midpoint = Math.ceil((low + high) / 2);
      if (lineStarts[midpoint]! <= index) low = midpoint;
      else high = midpoint - 1;
    }
    return { line: low + 1, column: index - lineStarts[low]! };
  };
  return {
    hasBOM: content.charCodeAt(0) === 0xfeff,
    content,
    filePath: 'tool-arguments.txt',
    physicalFilePath: undefined,
    contentType: 'text',
    ext: '.txt',
    getFilePath: () => 'tool-arguments.txt',
    getPhysicalFilePath: () => undefined,
    locationToRange: (location: SecretLintSourceNodeLocation): SecretLintSourceNodeRange => [
      positionToIndex(location.start),
      positionToIndex(location.end),
    ],
    rangeToLocation: (range: SecretLintSourceNodeRange): SecretLintSourceNodeLocation => ({
      start: indexToPosition(range[0]),
      end: indexToPosition(range[1]),
    }),
    positionToIndex,
    indexToPosition,
  };
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

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Elide long base64/blob runs to a length note (inline images, encoded blobs). */
export function elideLargeBlobs(content: string): string {
  LARGE_BLOB_PATTERN.lastIndex = 0;
  return content.replace(LARGE_BLOB_PATTERN, (match) => `[base64 elided: ${match.length} chars]`);
}
