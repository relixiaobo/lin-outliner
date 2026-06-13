const CSS_HEX_COLOR_BODY = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const BARE_TAG_BODY_CHARS = String.raw`\p{L}\p{N}_-`;
const BARE_TAG_NAME = String.raw`[${BARE_TAG_BODY_CHARS}]+`;
const BRACKET_TAG_NAME = String.raw`(?:\\[^\n]|[^\]\\\n])+`;
const BARE_FORMAT_TAG_NAME = new RegExp(String.raw`^${BARE_TAG_NAME}$`, 'u');

export const TAG_TOKEN_SOURCE = String.raw`\[\[#(${BRACKET_TAG_NAME})\]\]|#\[\[(${BRACKET_TAG_NAME})\]\]|#(${BARE_TAG_NAME})`;
export const TAG_TRIGGER_QUERY_PATTERN = new RegExp(String.raw`#([${BARE_TAG_BODY_CHARS}]*)$`, 'u');
export const TAG_TOKEN = new RegExp(TAG_TOKEN_SOURCE, 'u');

export function matchTagTokens(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(new RegExp(TAG_TOKEN_SOURCE, 'gu'));
}

export function isCssHexColorToken(value: string): boolean {
  const token = value.startsWith('#') ? value.slice(1) : value;
  return CSS_HEX_COLOR_BODY.test(token);
}

export function canWriteBareTagName(name: string): boolean {
  return BARE_FORMAT_TAG_NAME.test(name) && !isCssHexColorToken(name);
}

export interface ParsedTagToken {
  name: string;
  bare: boolean;
}

export interface ExtractedTags {
  tags: string[];
  rest: string;
}

export interface ParsedCheckboxMarker {
  checked: boolean;
  rest: string;
}

function escapeBracketTagName(name: string): string {
  return name.replace(/[\\\]\n\r\t]/gu, (char) => {
    if (char === '\n') return String.raw`\n`;
    if (char === '\r') return String.raw`\r`;
    if (char === '\t') return String.raw`\t`;
    return `\\${char}`;
  });
}

function unescapeBracketTagName(name: string): string {
  return name.replace(/\\([\\\]nrt])/gu, (_match, char: string) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    return char;
  });
}

function parseTagTokenParts(bracketName: string | undefined, hashBracketName: string | undefined, bareName: string | undefined): ParsedTagToken | null {
  const rawName = bracketName ?? hashBracketName ?? bareName ?? '';
  const name = (bareName === undefined ? unescapeBracketTagName(rawName) : rawName).trim();
  if (!name) return null;
  if (bareName !== undefined && isCssHexColorToken(bareName)) return null;
  return { name, bare: bareName !== undefined };
}

export function parseTagTokenMatch(match: RegExpMatchArray): ParsedTagToken | null {
  return parseTagTokenParts(match[1], match[2], match[3]);
}

export function removeTagTokens(text: string): string {
  return text
    .replace(new RegExp(TAG_TOKEN_SOURCE, 'gu'), (match, bracketName: string | undefined, hashBracketName: string | undefined, bareName: string | undefined) => {
      const parsed = parseTagTokenParts(bracketName, hashBracketName, bareName);
      return parsed ? '' : match;
    })
    .replace(/\s+/gu, ' ')
    .trim();
}

export function extractTags(text: string): ExtractedTags {
  const tags: string[] = [];
  for (const match of matchTagTokens(text)) {
    const parsed = parseTagTokenMatch(match);
    if (parsed) tags.push(parsed.name);
  }
  return { tags: [...new Set(tags)], rest: removeTagTokens(text) };
}

export function formatTag(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Cannot format an empty tag name.');
  }
  if (canWriteBareTagName(trimmed)) {
    return `#${trimmed}`;
  }
  return `#[[${escapeBracketTagName(trimmed)}]]`;
}

export function parseCheckboxMarker(line: string): ParsedCheckboxMarker | null {
  const match = /^\[([ xX])\](?:\s+(.*))?$/u.exec(line);
  if (!match) return null;
  return {
    checked: (match[1] ?? '').toLowerCase() === 'x',
    rest: match[2] ?? '',
  };
}
