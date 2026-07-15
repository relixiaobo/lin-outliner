import { mergeEquivalentTextMarks } from '../textMarks';
import type { RichText, TextMark, TextMarkKind } from '../types';

export interface CanonicalMarkdownParseResult {
  content: RichText;
  escapedOffsets: Set<number>;
}

interface SourceRange {
  start: number;
  end: number;
}

type MarkdownStyleMarkKind = Extract<TextMarkKind, 'bold' | 'italic' | 'strike' | 'highlight'>;
type NestedMarkdownParser = (input: string) => CanonicalMarkdownParseResult;

interface MarkdownStyleFrame {
  type: MarkdownStyleMarkKind;
  start: number;
}

interface MarkdownMarkHistory {
  mark: TextMark;
  previous: MarkdownMarkHistory | null;
}

interface CanonicalMarkdownState {
  stack: MarkdownStyleFrame[];
  history: MarkdownMarkHistory | null;
  reopenCost: number;
}

interface MarkdownLinkMatch {
  end: number;
  href: string;
  label: string;
}

interface MarkdownCodeSpan {
  contentEnd: number;
  contentStart: number;
  end: number;
}

interface MarkdownLexemes {
  codeSpans: Map<number, MarkdownCodeSpan>;
  links: Map<number, MarkdownLinkMatch>;
  protectedRanges: SourceRange[];
}

interface MarkdownLinkIndex {
  angleInvalidPrefix: Uint32Array;
  lineBreakPrefix: Uint32Array;
  nextNonWhitespace: Int32Array;
  nextUnescapedGreaterThan: Int32Array;
  nextUnescapedWhitespace: Int32Array;
  previousNonWhitespace: Int32Array;
  quotePairs: ReadonlyMap<number, number>;
}

const MAX_CANONICAL_MARKDOWN_STATES = 64;

const STAR_OPEN_SEQUENCES: readonly (readonly MarkdownStyleMarkKind[])[] = [
  [],
  ['italic'],
  ['bold'],
  ['bold', 'italic'],
  ['italic', 'bold'],
];

export function parseCanonicalMarkdown(
  input: string,
  escapable: ReadonlySet<string>,
  parseNested: NestedMarkdownParser,
): CanonicalMarkdownParseResult | null {
  const lexemes = scanMarkdownLexemes(input);
  let states: CanonicalMarkdownState[] = [{ stack: [], history: null, reopenCost: 0 }];
  const escapedOffsets = new Set<number>();
  let text = '';
  for (let index = 0; index < input.length;) {
    const char = input[index] ?? '';
    const next = input[index + 1] ?? '';
    if (char === '\\' && escapable.has(next)) {
      escapedOffsets.add(text.length);
      text += next;
      index += 2;
      continue;
    }

    if (char === '[') {
      const link = lexemes.links.get(index);
      if (link) {
        const nested = parseNested(link.label);
        const markStart = text.length;
        text += nested.content.text;
        for (const offset of nested.escapedOffsets) escapedOffsets.add(markStart + offset);
        states = states.map((state) => ({
          ...state,
          history: appendMarkdownMarkHistory(state.history, [
            ...nested.content.marks.map((mark) => ({
              ...mark,
              start: markStart + mark.start,
              end: markStart + mark.end,
            })),
            ...(text.length > markStart ? [{
              start: markStart,
              end: text.length,
              type: 'link' as const,
              attrs: { href: link.href },
            }] : []),
          ]),
        }));
        index = link.end;
        continue;
      }
    }

    if (char === '`') {
      const codeSpan = lexemes.codeSpans.get(index);
      if (codeSpan) {
        const markStart = text.length;
        text += parseMarkdownCodeSpanContent(input.slice(codeSpan.contentStart, codeSpan.contentEnd));
        if (text.length > markStart) {
          states = states.map((state) => ({
            ...state,
            history: appendMarkdownMarkHistory(state.history, [
              { start: markStart, end: text.length, type: 'code' },
            ]),
          }));
        }
        index = codeSpan.end;
        continue;
      }
    }

    if (input.startsWith('~~', index) || input.startsWith('==', index)) {
      const type: MarkdownStyleMarkKind = input.startsWith('~~', index) ? 'strike' : 'highlight';
      states = transitionDelimitedStyle(states, type, text.length);
      if (states.length === 0) return null;
      index += 2;
      continue;
    }

    if (char === '*') {
      let end = index + 1;
      while (input[end] === '*') end += 1;
      states = transitionStarRun(states, end - index, text.length);
      if (states.length === 0) return null;
      index = end;
      continue;
    }

    text += char;
    index += 1;
  }

  const completed = states
    .filter((state) => state.stack.length === 0)
    .map((state) => ({
      ...state,
      marks: mergeEquivalentTextMarks(markdownMarkHistory(state.history)).sort(compareMarkdownMarks),
    }))
    .sort((left, right) => left.reopenCost - right.reopenCost);
  const selected = completed[0];
  if (!selected) return null;
  return { content: { text, marks: selected.marks, inlineRefs: [] }, escapedOffsets };
}

export function canonicalMarkdownProtectedRanges(text: string): SourceRange[] {
  return scanMarkdownLexemes(text).protectedRanges;
}

function transitionStarRun(
  states: readonly CanonicalMarkdownState[],
  runLength: number,
  offset: number,
): CanonicalMarkdownState[] {
  // One run may close a stack suffix and reopen styles at the same text boundary.
  const nextStates: CanonicalMarkdownState[] = [];
  for (const state of states) {
    let closableCount = 0;
    for (let index = state.stack.length - 1; index >= 0; index -= 1) {
      if (!isStarStyle(state.stack[index]!.type)) break;
      closableCount += 1;
    }
    for (let closeCount = 0; closeCount <= closableCount; closeCount += 1) {
      const closing = state.stack.slice(state.stack.length - closeCount).reverse();
      const closingLength = closing.reduce((total, frame) => total + starDelimiterLength(frame.type), 0);
      const openingLength = runLength - closingLength;
      if (openingLength < 0) continue;
      const baseStack = state.stack.slice(0, state.stack.length - closeCount);
      const activeTypes = new Set(baseStack.map((frame) => frame.type));
      for (const opening of STAR_OPEN_SEQUENCES) {
        if (opening.reduce((total, type) => total + starDelimiterLength(type), 0) !== openingLength) continue;
        if (opening.some((type) => activeTypes.has(type))) continue;
        const nextStack = [
          ...baseStack,
          ...opening.map((type) => ({ type, start: offset })),
        ];
        if (sameMarkdownStack(state.stack, nextStack)) continue;
        if (closing.some((frame) => frame.start === offset)) continue;
        const reopened = opening.filter((type) => closing.some((frame) => frame.type === type)).length;
        nextStates.push({
          stack: nextStack,
          history: appendMarkdownMarkHistory(state.history, [
            ...closing.map((frame) => ({ start: frame.start, end: offset, type: frame.type })),
          ]),
          reopenCost: state.reopenCost + reopened,
        });
      }
    }
  }
  return dedupeMarkdownStates(nextStates);
}

function transitionDelimitedStyle(
  states: readonly CanonicalMarkdownState[],
  type: Extract<MarkdownStyleMarkKind, 'strike' | 'highlight'>,
  offset: number,
): CanonicalMarkdownState[] {
  const nextStates = states.flatMap((state): CanonicalMarkdownState[] => {
    const top = state.stack[state.stack.length - 1];
    if (top?.type === type) {
      if (top.start === offset) return [];
      return [{
        stack: state.stack.slice(0, -1),
        history: appendMarkdownMarkHistory(state.history, [{ start: top.start, end: offset, type }]),
        reopenCost: state.reopenCost,
      }];
    }
    if (state.stack.some((frame) => frame.type === type)) return [];
    return [{
      stack: [...state.stack, { type, start: offset }],
      history: state.history,
      reopenCost: state.reopenCost,
    }];
  });
  return dedupeMarkdownStates(nextStates);
}

function dedupeMarkdownStates(states: readonly CanonicalMarkdownState[]): CanonicalMarkdownState[] {
  // Future transitions depend only on the active stack; equivalent histories
  // normalize to the same adjacent mark ranges, so retain the cheapest path.
  const deduped = new Map<string, CanonicalMarkdownState>();
  for (const state of states) {
    const key = markdownStackKey(state.stack);
    const existing = deduped.get(key);
    if (!existing || state.reopenCost < existing.reopenCost) deduped.set(key, state);
  }
  return [...deduped.values()]
    .sort((left, right) => left.reopenCost - right.reopenCost)
    .slice(0, MAX_CANONICAL_MARKDOWN_STATES);
}

function markdownStackKey(stack: readonly MarkdownStyleFrame[]): string {
  return JSON.stringify(stack.map((frame) => [frame.type, frame.start]));
}

function appendMarkdownMarkHistory(
  history: MarkdownMarkHistory | null,
  marks: readonly TextMark[],
): MarkdownMarkHistory | null {
  let next = history;
  for (const mark of marks) next = { mark, previous: next };
  return next;
}

function markdownMarkHistory(history: MarkdownMarkHistory | null): TextMark[] {
  const marks: TextMark[] = [];
  for (let current = history; current; current = current.previous) marks.push(current.mark);
  return marks.reverse();
}

function sameMarkdownStack(left: readonly MarkdownStyleFrame[], right: readonly MarkdownStyleFrame[]): boolean {
  return left.length === right.length
    && left.every((frame, index) => frame.type === right[index]?.type && frame.start === right[index]?.start);
}

function isStarStyle(type: MarkdownStyleMarkKind): type is Extract<MarkdownStyleMarkKind, 'bold' | 'italic'> {
  return type === 'bold' || type === 'italic';
}

function starDelimiterLength(type: MarkdownStyleMarkKind): number {
  return type === 'bold' ? 2 : type === 'italic' ? 1 : 0;
}

function scanMarkdownLexemes(input: string): MarkdownLexemes {
  const escaped = escapedCharacterMask(input);
  const codeSpans = scanMarkdownCodeSpans(input, escaped);
  const links = scanMarkdownLinks(input, escaped, codeSpans);
  const protectedRanges = [
    ...[...codeSpans.entries()].map(([start, span]) => ({ start, end: span.end })),
    ...[...links.entries()].map(([start, link]) => ({ start, end: link.end })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  return { codeSpans, links, protectedRanges };
}

function escapedCharacterMask(input: string): Uint8Array {
  const escaped = new Uint8Array(input.length);
  let backslashRun = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === '\\') {
      backslashRun += 1;
      continue;
    }
    if (backslashRun % 2 === 1) escaped[index] = 1;
    backslashRun = 0;
  }
  return escaped;
}

function scanMarkdownCodeSpans(
  input: string,
  escaped: Uint8Array,
): Map<number, MarkdownCodeSpan> {
  const spans = new Map<number, MarkdownCodeSpan>();
  const pendingByLength = new Map<number, Array<{ contentStart: number; start: number }>>();
  for (let index = 0; index < input.length;) {
    if (input[index] === '\n') {
      pendingByLength.clear();
      index += 1;
      continue;
    }
    if (input[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (input[end] === '`') end += 1;
    const physicalLength = end - index;
    // Inside code, escapes are literal so the whole physical run may close;
    // outside code, only the suffix after an escaped first tick may open.
    for (const opening of pendingByLength.get(physicalLength) ?? []) {
      if (opening.contentStart >= index) continue;
      spans.set(opening.start, {
        contentStart: opening.contentStart,
        contentEnd: index,
        end,
      });
    }
    pendingByLength.delete(physicalLength);

    const openingStart = index + (escaped[index] !== 0 ? 1 : 0);
    const openingLength = end - openingStart;
    if (openingLength > 0) {
      const pending = pendingByLength.get(openingLength);
      if (pending) pending.push({ start: openingStart, contentStart: end });
      else pendingByLength.set(openingLength, [{ start: openingStart, contentStart: end }]);
    }
    index = end;
  }
  return spans;
}

function parseMarkdownCodeSpanContent(raw: string): string {
  if (
    raw.length >= 2
    && raw.startsWith(' ')
    && raw.endsWith(' ')
    && /[^ ]/u.test(raw)
  ) return raw.slice(1, -1);
  return raw;
}

function scanMarkdownLinks(
  input: string,
  escaped: Uint8Array,
  codeSpans: ReadonlyMap<number, MarkdownCodeSpan>,
): Map<number, MarkdownLinkMatch> {
  if (!input.includes('](')) return new Map();
  const linkIndex = buildMarkdownLinkIndex(input, escaped, codeSpans);
  const parenthesisPairs = scanParenthesisPairs(input, escaped, codeSpans, linkIndex);
  const links = new Map<number, MarkdownLinkMatch>();
  const labelStack: Array<{ containsLink: boolean; start: number }> = [];
  for (let index = 0; index < input.length;) {
    const codeSpan = codeSpans.get(index);
    if (codeSpan) {
      index = codeSpan.end;
      continue;
    }
    const char = input[index] ?? '';
    if (escaped[index] !== 0) {
      index += 1;
      continue;
    }
    if (char === '[') {
      labelStack.push({ start: index, containsLink: false });
      index += 1;
      continue;
    }
    if (char !== ']') {
      index += 1;
      continue;
    }
    const label = labelStack.pop();
    const parentLabel = labelStack[labelStack.length - 1];
    if (label?.containsLink && parentLabel) parentLabel.containsLink = true;
    const destinationStart = index + 1;
    const destinationEnd = parenthesisPairs.get(destinationStart);
    if (!label || destinationEnd === undefined) {
      index += 1;
      continue;
    }
    const href = parseMarkdownLinkDestination(
      input,
      destinationStart + 1,
      destinationEnd,
      linkIndex,
      parenthesisPairs,
    );
    if (href !== null && !label.containsLink) {
      links.set(label.start, {
        end: destinationEnd + 1,
        href,
        label: input.slice(label.start + 1, index),
      });
      if (parentLabel) parentLabel.containsLink = true;
      index = destinationEnd + 1;
      continue;
    }
    index += 1;
  }
  return links;
}

function scanParenthesisPairs(
  input: string,
  escaped: Uint8Array,
  codeSpans: ReadonlyMap<number, MarkdownCodeSpan>,
  linkIndex: MarkdownLinkIndex,
): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: Array<{ linkDestination: boolean; start: number }> = [];
  for (let index = 0; index < input.length;) {
    const codeSpan = codeSpans.get(index);
    if (codeSpan) {
      index = codeSpan.end;
      continue;
    }
    if (escaped[index] !== 0) {
      index += 1;
      continue;
    }
    const char = input[index] ?? '';
    const top = stack[stack.length - 1];
    if (
      top?.linkDestination
      && (char === '"' || char === "'")
      && /\s/u.test(input[index - 1] ?? '')
    ) {
      const quoteEnd = linkIndex.quotePairs.get(index);
      if (
        quoteEnd !== undefined
        && input[linkIndex.nextNonWhitespace[quoteEnd + 1]] === ')'
      ) {
        index = quoteEnd + 1;
        continue;
      }
    }
    if (char === '(') {
      stack.push({
        start: index,
        linkDestination: input[index - 1] === ']' && escaped[index - 1] === 0,
      });
    } else if (char === ')') {
      const opening = stack.pop();
      if (opening) pairs.set(opening.start, index);
    }
    index += 1;
  }
  return pairs;
}

function buildMarkdownLinkIndex(
  input: string,
  escaped: Uint8Array,
  codeSpans: ReadonlyMap<number, MarkdownCodeSpan>,
): MarkdownLinkIndex {
  const length = input.length;
  const angleInvalidPrefix = new Uint32Array(length + 1);
  const lineBreakPrefix = new Uint32Array(length + 1);
  const nextNonWhitespace = new Int32Array(length + 1);
  const nextUnescapedGreaterThan = new Int32Array(length + 1);
  const nextUnescapedWhitespace = new Int32Array(length + 1);
  const previousNonWhitespace = new Int32Array(length + 1);
  nextNonWhitespace.fill(length);
  nextUnescapedGreaterThan.fill(length);
  nextUnescapedWhitespace.fill(length);
  previousNonWhitespace.fill(-1);

  let previous = -1;
  for (let index = 0; index < length; index += 1) {
    const char = input[index] ?? '';
    const whitespace = /\s/u.test(char);
    angleInvalidPrefix[index + 1] = (angleInvalidPrefix[index] ?? 0)
      + (whitespace || char === '<' || char === '>' ? 1 : 0);
    lineBreakPrefix[index + 1] = (lineBreakPrefix[index] ?? 0)
      + (char === '\n' || char === '\r' ? 1 : 0);
    if (!whitespace) previous = index;
    previousNonWhitespace[index] = previous;
  }
  previousNonWhitespace[length] = previous;

  let nextNonWhitespaceOffset = length;
  let nextUnescapedGreaterThanOffset = length;
  let nextUnescapedWhitespaceOffset = length;
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = input[index] ?? '';
    const whitespace = /\s/u.test(char);
    if (!whitespace) nextNonWhitespaceOffset = index;
    if (escaped[index] === 0 && char === '>') nextUnescapedGreaterThanOffset = index;
    if (escaped[index] === 0 && whitespace) nextUnescapedWhitespaceOffset = index;
    nextNonWhitespace[index] = nextNonWhitespaceOffset;
    nextUnescapedGreaterThan[index] = nextUnescapedGreaterThanOffset;
    nextUnescapedWhitespace[index] = nextUnescapedWhitespaceOffset;
  }

  return {
    angleInvalidPrefix,
    lineBreakPrefix,
    nextNonWhitespace,
    nextUnescapedGreaterThan,
    nextUnescapedWhitespace,
    previousNonWhitespace,
    quotePairs: scanQuotePairs(input, escaped, codeSpans),
  };
}

function scanQuotePairs(
  input: string,
  escaped: Uint8Array,
  codeSpans: ReadonlyMap<number, MarkdownCodeSpan>,
): Map<number, number> {
  const pairs = new Map<number, number>();
  const previousByQuote = new Map<'"' | "'", number>();
  for (let index = 0; index < input.length;) {
    const codeSpan = codeSpans.get(index);
    if (codeSpan) {
      index = codeSpan.end;
      continue;
    }
    const char = input[index] ?? '';
    if (char === '\n') {
      previousByQuote.clear();
      index += 1;
      continue;
    }
    if ((char !== '"' && char !== "'") || escaped[index] !== 0) {
      index += 1;
      continue;
    }
    const previous = previousByQuote.get(char);
    if (previous !== undefined) pairs.set(previous, index);
    previousByQuote.set(char, index);
    index += 1;
  }
  return pairs;
}

function parseMarkdownLinkDestination(
  input: string,
  start: number,
  end: number,
  linkIndex: MarkdownLinkIndex,
  parenthesisPairs: ReadonlyMap<number, number>,
): string | null {
  if (
    start >= end
    || (linkIndex.lineBreakPrefix[end] ?? 0) !== (linkIndex.lineBreakPrefix[start] ?? 0)
  ) return null;
  const valueStart = linkIndex.nextNonWhitespace[start] ?? input.length;
  const lastValueOffset = linkIndex.previousNonWhitespace[end - 1] ?? -1;
  if (valueStart >= end || lastValueOffset < valueStart) return null;
  const valueEnd = lastValueOffset + 1;

  let destinationStart = valueStart;
  let destinationEnd: number;
  let remainderStart: number;
  if (input[valueStart] === '<') {
    destinationStart += 1;
    destinationEnd = linkIndex.nextUnescapedGreaterThan[destinationStart] ?? input.length;
    if (
      destinationEnd >= valueEnd
      || destinationEnd === destinationStart
      || (linkIndex.angleInvalidPrefix[destinationEnd] ?? 0)
        !== (linkIndex.angleInvalidPrefix[destinationStart] ?? 0)
    ) return null;
    const nextValue = linkIndex.nextNonWhitespace[destinationEnd + 1] ?? input.length;
    remainderStart = nextValue < valueEnd ? nextValue : valueEnd;
  } else {
    const whitespace = linkIndex.nextUnescapedWhitespace[valueStart] ?? input.length;
    destinationEnd = Math.min(whitespace, valueEnd);
    if (destinationEnd === destinationStart) return null;
    const nextValue = linkIndex.nextNonWhitespace[whitespace] ?? input.length;
    remainderStart = whitespace < valueEnd && nextValue < valueEnd ? nextValue : valueEnd;
  }

  if (remainderStart < valueEnd) {
    const quote = input[remainderStart] ?? '';
    const validTitle = quote === '('
      ? parenthesisPairs.get(remainderStart) === valueEnd - 1
      : (quote === '"' || quote === "'")
        && linkIndex.quotePairs.get(remainderStart) === valueEnd - 1;
    if (!validTitle) return null;
  }
  return decodeMarkdownLinkDestination(input.slice(destinationStart, destinationEnd));
}

function decodeMarkdownLinkDestination(value: string): string {
  return value.replace(/\\([\\()])/gu, '$1');
}

function compareMarkdownMarks(left: TextMark, right: TextMark): number {
  return left.start - right.start
    || right.end - left.end
    || markdownMarkNestingRank(left.type) - markdownMarkNestingRank(right.type);
}

function markdownMarkNestingRank(type: TextMarkKind): number {
  if (type === 'bold') return 0;
  if (type === 'italic') return 1;
  if (type === 'strike') return 2;
  if (type === 'highlight') return 3;
  if (type === 'link') return 4;
  if (type === 'code') return 5;
  return 6;
}
