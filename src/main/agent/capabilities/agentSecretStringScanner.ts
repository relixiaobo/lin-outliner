import { rules as recommendedSecretlintRules } from '@secretlint/secretlint-rule-preset-recommend';
import type {
  SecretLintRuleContext,
  SecretLintRuleCreator,
  SecretLintSourceCode,
  SecretLintSourceNodeLocation,
  SecretLintSourceNodePosition,
  SecretLintSourceNodeRange,
} from '@secretlint/types';

export const REDACTED_SECRET = '[redacted]';
const REDACTED_SECRET_LIKE_CONTENT = '[redacted secret-like content]';
const MAX_JSON_SECRET_SCAN_DEPTH = 256;

const SECRET_SCAN_RULES = (recommendedSecretlintRules as readonly SecretLintRuleCreator<unknown>[])
  .filter((rule) => rule.meta.type === 'scanner');

const PARTIAL_PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const SUPPLEMENTAL_HIGH_CONFIDENCE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9_./+=-]{12,}/gi,
];
const ENV_SECRET_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]{2,63})\s*[:=]\s*(['"]?)([A-Za-z0-9_./+=-]{12,})\2/g;

const STRONG_SECRET_FIELD_TERMINALS = new Set([
  'bearer',
  'credential',
  'credentials',
  'password',
  'passwd',
  'pwd',
  'secret',
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
const SECRET_TOKEN_QUALIFIERS = new Set([
  'access',
  'api',
  'auth',
  'bot',
  'gh',
  'id',
  'jwt',
  'npm',
  'oauth',
  'refresh',
  'session',
  'validation',
]);
const UNSEPARATED_SECRET_FIELD_PATTERN = /^(?:api|auth|client|encryption|private|secret|signing)(?:key|keys)$|^(?:access|api|auth|bot|gh|id|jwt|npm|oauth|refresh|session|validation)token$/;
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
const JSON_ENCODED_ARGUMENT_FIELD_TERMINALS = new Set(['args', 'arguments', 'body', 'payload']);

type SecretFieldConfidence = 'strong' | 'ambiguous';

interface TextRange {
  readonly start: number;
  readonly end: number;
}

interface JsonStringToken {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly confidence: SecretFieldConfidence | null;
}

interface JsonReplacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export interface SecretStringScanJob {
  readonly content: string;
  readonly inspectEncodedJson: boolean;
}

export function containsSecretLikeContent(content: string): boolean {
  PARTIAL_PRIVATE_KEY_HEADER.lastIndex = 0;
  if (PARTIAL_PRIVATE_KEY_HEADER.test(content)) return true;
  if (secretlintRanges(content).length > 0) return true;
  if (patternRanges(content, SUPPLEMENTAL_HIGH_CONFIDENCE_PATTERNS).length > 0) return true;
  return environmentAssignmentRanges(content).length > 0;
}

export function redactSecretLikeContent(content: string): string {
  return redactKnownCredentialText(content);
}

export function scanSecretStrings(jobs: readonly SecretStringScanJob[]): string[] {
  return jobs.map((job) => job.inspectEncodedJson
    ? redactJsonEncodedSecretValues(job.content)
    : redactKnownCredentialText(job.content));
}

export function secretStringFieldConfidence(key: string): SecretFieldConfidence | null {
  const segments = secretKeySegments(key);
  const last = segments.at(-1);
  if (!last) return null;
  if (segments.length === 1 && (last === 'pgpassword' || last === 'mysqlpwd')) return 'strong';
  if (last === 'credentials' && segments.length === 1) return 'ambiguous';
  if (last === 'authorization') {
    return segments.length === 1 || segments.at(-2) === 'proxy' || segments.at(-2) === 'x'
      ? 'strong'
      : null;
  }
  if (STRONG_SECRET_FIELD_TERMINALS.has(last)) return 'strong';
  if (last === 'token') {
    if (segments.length === 1) return 'ambiguous';
    return segments.slice(0, -1).some((segment) => SECRET_TOKEN_QUALIFIERS.has(segment))
      ? 'strong'
      : null;
  }
  if (last === 'header' && segments.slice(0, -1).some((segment) => segment === 'authorization')) return 'strong';
  if (last === 'hash' && segments.at(-2) === 'password') return 'strong';
  if (last === 'pem' && segments.includes('private') && segments.includes('key')) return 'strong';
  if (
    (last === 'key' || last === 'keys')
    && segments.slice(0, -1).some((segment) => SECRET_KEY_QUALIFIERS.has(segment))
  ) return 'strong';
  return segments.length === 1 && UNSEPARATED_SECRET_FIELD_PATTERN.test(last) ? 'strong' : null;
}

export function isCredentialCandidateString(value: string, confidence: SecretFieldConfidence): boolean {
  const normalized = value.trim();
  if (normalized === '' || normalized === REDACTED_SECRET) return false;
  const scalar = normalized.replaceAll('_', '');
  if (NON_CREDENTIAL_SCALAR_PATTERNS.some((pattern) => pattern.test(scalar))) return false;
  if (CREDENTIAL_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  if (confidence === 'strong') return true;
  return normalized.length >= 20
    && /^[A-Za-z0-9_./+=-]+$/.test(normalized)
    && /[A-Za-z]/.test(normalized)
    && /\d/.test(normalized);
}

export function isJsonEncodedArgumentField(key: string): boolean {
  const terminal = secretKeySegments(key).at(-1);
  return terminal !== undefined && JSON_ENCODED_ARGUMENT_FIELD_TERMINALS.has(terminal);
}

function redactJsonEncodedSecretValues(content: string): string {
  const tokens = jsonStringTokens(content);
  if (!tokens) return redactKnownCredentialText(content);
  const replacements: JsonReplacement[] = [];
  for (const token of tokens) {
    const redacted = token.confidence && isCredentialCandidateString(token.value, token.confidence)
      ? REDACTED_SECRET
      : redactKnownCredentialText(token.value);
    if (redacted !== token.value) {
      replacements.push({ start: token.start, end: token.end, value: JSON.stringify(redacted) });
    }
  }
  return applyJsonReplacements(content, replacements);
}

function redactKnownCredentialText(content: string): string {
  const ranges = credentialTextRanges(content);
  if (ranges.length === 0) return content;
  let redacted = content;
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    redacted = redacted.slice(0, range.start) + REDACTED_SECRET_LIKE_CONTENT + redacted.slice(range.end);
  }
  return redacted;
}

function credentialTextRanges(content: string): TextRange[] {
  return mergeRanges([
    ...secretlintRanges(content),
    ...patternRanges(content, SUPPLEMENTAL_HIGH_CONFIDENCE_PATTERNS),
    ...environmentAssignmentRanges(content),
  ]);
}

function scanJsonValue(
  source: string,
  offset: number,
  confidence: SecretFieldConfidence | null,
  tokens: JsonStringToken[],
): number {
  const start = skipJsonWhitespace(source, offset);
  const token = source[start];
  if (token === '"') {
    const end = scanJsonString(source, start);
    const value = JSON.parse(source.slice(start, end)) as string;
    tokens.push({ start, end, value, confidence });
    return end;
  }
  if (token === '{') return scanJsonObject(source, start, tokens);
  if (token === '[') return scanJsonArray(source, start, tokens);
  let end = start;
  while (end < source.length && !/[\s,}\]]/.test(source[end]!)) end += 1;
  if (end === start) throw new Error('Invalid JSON value');
  return end;
}

function scanJsonObject(source: string, start: number, tokens: JsonStringToken[]): number {
  let offset = skipJsonWhitespace(source, start + 1);
  if (source[offset] === '}') return offset + 1;
  while (offset < source.length) {
    if (source[offset] !== '"') throw new Error('Invalid JSON object key');
    const keyEnd = scanJsonString(source, offset);
    const key = JSON.parse(source.slice(offset, keyEnd)) as string;
    offset = skipJsonWhitespace(source, keyEnd);
    if (source[offset] !== ':') throw new Error('Invalid JSON object delimiter');
    offset = scanJsonValue(source, offset + 1, secretStringFieldConfidence(key), tokens);
    offset = skipJsonWhitespace(source, offset);
    if (source[offset] === '}') return offset + 1;
    if (source[offset] !== ',') throw new Error('Invalid JSON object separator');
    offset = skipJsonWhitespace(source, offset + 1);
  }
  throw new Error('Unterminated JSON object');
}

function scanJsonArray(source: string, start: number, tokens: JsonStringToken[]): number {
  let offset = skipJsonWhitespace(source, start + 1);
  if (source[offset] === ']') return offset + 1;
  while (offset < source.length) {
    offset = scanJsonValue(source, offset, null, tokens);
    offset = skipJsonWhitespace(source, offset);
    if (source[offset] === ']') return offset + 1;
    if (source[offset] !== ',') throw new Error('Invalid JSON array separator');
    offset = skipJsonWhitespace(source, offset + 1);
  }
  throw new Error('Unterminated JSON array');
}

function jsonStringTokens(content: string): JsonStringToken[] | null {
  const start = skipJsonWhitespace(content, 0);
  if (content[start] !== '{' && content[start] !== '[') return null;
  if (exceedsJsonSecretScanDepth(content)) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const tokens: JsonStringToken[] = [];
    const end = scanJsonValue(content, start, null, tokens);
    return skipJsonWhitespace(content, end) === content.length ? tokens : null;
  } catch {
    return null;
  }
}

function exceedsJsonSecretScanDepth(content: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const token of content) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (token === '\\') {
        escaped = true;
      } else if (token === '"') {
        inString = false;
      }
      continue;
    }
    if (token === '"') {
      inString = true;
    } else if (token === '{' || token === '[') {
      depth += 1;
      if (depth > MAX_JSON_SECRET_SCAN_DEPTH) return true;
    } else if (token === '}' || token === ']') {
      depth -= 1;
    }
  }
  return false;
}

function applyJsonReplacements(content: string, replacements: readonly JsonReplacement[]): string {
  let redacted = content;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    redacted = redacted.slice(0, replacement.start) + replacement.value + redacted.slice(replacement.end);
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

function environmentAssignmentRanges(content: string): TextRange[] {
  ENV_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  const ranges: TextRange[] = [];
  for (const match of content.matchAll(ENV_SECRET_ASSIGNMENT_PATTERN)) {
    const start = match.index;
    const key = match[1];
    const value = match[3];
    if (start === undefined || !key || !value) continue;
    const confidence = secretStringFieldConfidence(key);
    if (!confidence || !isCredentialCandidateString(value, confidence)) continue;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function secretlintRanges(content: string): TextRange[] {
  try {
    const source = secretlintSource(content);
    const ranges: TextRange[] = [];
    for (const rule of SECRET_SCAN_RULES) {
      ranges.push(...secretlintRuleRanges(rule, source, content.length));
    }
    return mergeRanges(ranges);
  } catch {
    return [];
  }
}

function secretlintRuleRanges(
  rule: SecretLintRuleCreator<unknown>,
  source: SecretLintSourceCode,
  contentLength: number,
): TextRange[] {
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
        && end <= contentLength
      ) reported.push({ start, end });
    },
    ignore: () => {},
  } as SecretLintRuleContext;
  try {
    const pending = rule.create(context, {}).file?.(source);
    acceptingReports = false;
    if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
      void Promise.resolve(pending).catch(() => {});
      return [];
    }
    return reported;
  } catch {
    acceptingReports = false;
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
