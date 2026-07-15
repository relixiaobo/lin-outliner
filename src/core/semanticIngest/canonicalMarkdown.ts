import { Lexer } from 'marked';
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
      const link = parseMarkdownLinkAt(input, index);
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
      const end = findClosingBacktick(input, index + 1);
      if (end >= 0) {
        const markStart = text.length;
        text += input.slice(index + 1, end);
        if (text.length > markStart) {
          states = states.map((state) => ({
            ...state,
            history: appendMarkdownMarkHistory(state.history, [
              { start: markStart, end: text.length, type: 'code' },
            ]),
          }));
        }
        index = end + 1;
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
  const ranges: SourceRange[] = [];
  for (let index = 0; index < text.length;) {
    if (isEscapedAt(text, index)) {
      index += 1;
      continue;
    }
    if (text[index] === '[') {
      const link = parseMarkdownLinkAt(text, index);
      if (link) {
        ranges.push({ start: index, end: link.end });
        index = link.end;
        continue;
      }
    }
    if (text[index] === '`') {
      const end = findClosingBacktick(text, index + 1);
      if (end >= 0) {
        ranges.push({ start: index, end: end + 1 });
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return ranges;
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
  const deduped = new Map<string, Map<MarkdownMarkHistory | null, CanonicalMarkdownState>>();
  for (const state of states) {
    const key = markdownStackKey(state.stack);
    const histories = deduped.get(key) ?? new Map<MarkdownMarkHistory | null, CanonicalMarkdownState>();
    const existing = histories.get(state.history);
    if (!existing || state.reopenCost < existing.reopenCost) histories.set(state.history, state);
    deduped.set(key, histories);
  }
  return [...deduped.values()].flatMap((histories) => [...histories.values()]);
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

function findClosingBacktick(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === '\n') return -1;
    if (input[index] === '`' && !isEscapedAt(input, index)) return index;
  }
  return -1;
}

function parseMarkdownLinkAt(input: string, start: number): MarkdownLinkMatch | null {
  let labelDepth = 0;
  let labelEnd = -1;
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index] ?? '';
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') {
      labelDepth += 1;
      continue;
    }
    if (char !== ']') continue;
    if (labelDepth > 0) {
      labelDepth -= 1;
      continue;
    }
    if (input[index + 1] === '(') labelEnd = index;
    break;
  }
  if (labelEnd < 0) return null;
  const token = Lexer.lexInline(input.slice(start))[0];
  if (token?.type !== 'link' || !token.href || !token.raw.startsWith('[')) return null;
  return {
    end: start + token.raw.length,
    href: token.href,
    label: input.slice(start + 1, labelEnd),
  };
}

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
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
