import {
  formatChatSourceReferenceMarker,
  formatFileReferenceMarker,
  formatNodeReferenceMarker,
} from './referenceMarkup';
import type { ReferenceTarget, RichText, TextMark } from './types';
import { mergeEquivalentTextMarks, textMarkIdentity } from './textMarks';
import {
  escapeSemanticTextChar,
  parseMarkdownReferenceRichText,
  type SemanticEscapeOptions,
} from './semanticIngest/inlineScanner';

export function markdownReferenceMarkupToRichText(rawText: string): RichText {
  return parseMarkdownReferenceRichText(rawText);
}

export function richTextToMarkdownReferenceMarkup(
  content: RichText,
  context: Pick<SemanticEscapeOptions, 'prefix' | 'suffix'> = {},
): string {
  const insertions = new Map<number, Array<{ text: string; order: number }>>();
  const add = (offset: number, text: string, order: number) => {
    const safeOffset = Math.min(Math.max(0, Math.trunc(offset)), content.text.length);
    insertions.set(safeOffset, [...(insertions.get(safeOffset) ?? []), { text, order }]);
  };

  const refs = [...content.inlineRefs].sort((left, right) => left.offset - right.offset);
  const skippedRanges = refs.flatMap((ref) => {
    const displayName = ref.displayName?.trim() ?? '';
    if (!displayName) return [];
    const start = Math.min(Math.max(0, Math.trunc(ref.offset)), content.text.length);
    if (content.text.slice(start, start + displayName.length) !== displayName) return [];
    return [{ start, end: start + displayName.length }];
  });
  for (const ref of refs) {
    add(ref.offset, inlineRefMarker(ref), 10);
  }
  const serializableMarks = mergeEquivalentTextMarks(marksOutsideSkippedRanges(
    markdownSerializableMarks(content.marks),
    skippedRanges,
    content.text.length,
  )).flatMap((mark) => {
    const delimiters = markDelimiters(mark);
    return delimiters ? [{ mark, delimiters }] : [];
  });
  addMarkdownMarkTransitions(serializableMarks, add);
  const codeRanges = content.marks
    .filter((mark) => mark.type === 'code')
    .map((mark) => ({ start: mark.start, end: mark.end }));
  const linkRanges = content.marks
    .filter((mark) => mark.type === 'link')
    .map((mark) => ({ start: mark.start, end: mark.end }));

  let out = '';
  for (let index = 0; index <= content.text.length; index += 1) {
    const items = insertions.get(index);
    if (items) {
      for (const item of [...items].sort((left, right) => left.order - right.order)) {
        out += item.text;
      }
    }
    const skipped = skippedRanges.find((range) => range.start === index);
    if (skipped) {
      index = skipped.end - 1;
      continue;
    }
    if (index < content.text.length) {
      const insideCode = codeRanges.some((range) => index >= range.start && index < range.end);
      const insideLink = linkRanges.some((range) => index >= range.start && index < range.end);
      out += insideCode
        ? content.text[index]
        : escapeSemanticTextChar(content.text, index, {
          ...context,
          escapeBareUrls: !insideLink,
        });
    }
  }
  return out;
}

function referenceDisplayFallback(target: ReferenceTarget): string {
  if (target.kind === 'node') return target.nodeId;
  if (target.kind === 'local-file') return target.path.split('/').filter(Boolean).at(-1) ?? target.path;
  return 'Referenced source';
}

function inlineRefMarker(ref: RichText['inlineRefs'][number]): string {
  const displayName = ref.displayName?.trim();
  if (ref.target.kind === 'node') {
    return formatNodeReferenceMarker(displayName || ref.target.nodeId, ref.target.nodeId);
  }
  if (ref.target.kind === 'chat-source') {
    return formatChatSourceReferenceMarker(displayName || 'Referenced source', ref.target);
  }
  const path = ref.target.path;
  return formatFileReferenceMarker(displayName || referenceDisplayFallback(ref.target), path, ref.target.entryKind);
}

function markdownSerializableMarks(marks: readonly TextMark[]): TextMark[] {
  const heading = marks.find((mark) => mark.type === 'headingMark' && mark.start === 0);
  const withoutHeading = marks.filter((mark) => mark !== heading);
  if (!heading) return withoutHeading;
  return withoutHeading;
}

function marksOutsideSkippedRanges(
  marks: readonly TextMark[],
  skippedRanges: ReadonlyArray<{ start: number; end: number }>,
  textLength: number,
): TextMark[] {
  const normalizedRanges = skippedRanges
    .map((range) => ({
      start: Math.min(Math.max(0, range.start), textLength),
      end: Math.min(Math.max(0, range.end), textLength),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const result: TextMark[] = [];
  for (const mark of marks) {
    const markStart = Math.min(Math.max(0, Math.trunc(mark.start)), textLength);
    const markEnd = Math.min(Math.max(0, Math.trunc(mark.end)), textLength);
    let segments: Array<{ start: number; end: number }> = markEnd > markStart
      ? [{ start: markStart, end: markEnd }]
      : [];
    for (const skipped of normalizedRanges) {
      segments = segments.flatMap((segment) => subtractRange(segment, skipped));
      if (segments.length === 0) break;
    }
    for (const segment of segments) {
      result.push({ ...mark, start: segment.start, end: segment.end });
    }
  }
  return result;
}

interface SerializableMarkdownMark {
  mark: TextMark;
  delimiters: { open: string; close: string };
}

function addMarkdownMarkTransitions(
  entries: readonly SerializableMarkdownMark[],
  add: (offset: number, text: string, order: number) => void,
): void {
  const starting = new Map<number, SerializableMarkdownMark[]>();
  const ending = new Map<number, SerializableMarkdownMark[]>();
  for (const entry of entries) {
    starting.set(entry.mark.start, [...(starting.get(entry.mark.start) ?? []), entry]);
    ending.set(entry.mark.end, [...(ending.get(entry.mark.end) ?? []), entry]);
  }
  const boundaries = [...new Set([...starting.keys(), ...ending.keys()])].sort((left, right) => left - right);
  const active = new Set<SerializableMarkdownMark>();
  let current: SerializableMarkdownMark[] = [];
  for (const offset of boundaries) {
    for (const entry of ending.get(offset) ?? []) active.delete(entry);
    for (const entry of starting.get(offset) ?? []) active.add(entry);
    const target = [...active].sort(compareActiveMarkdownMarks);
    let shared = 0;
    while (shared < current.length && current[shared] === target[shared]) shared += 1;

    const closing = current
      .slice(shared)
      .reverse()
      .map((entry) => entry.delimiters.close)
      .join('');
    if (closing) add(offset, closing, -1_000);

    const opening = target
      .slice(shared)
      .map((entry) => entry.delimiters.open)
      .join('');
    if (opening) add(offset, opening, 1_000);
    current = target;
  }
}

function compareActiveMarkdownMarks(
  left: SerializableMarkdownMark,
  right: SerializableMarkdownMark,
): number {
  if (isStarDelimitedMark(left.mark) && isStarDelimitedMark(right.mark)) {
    const intervalOrder = right.mark.end - left.mark.end || left.mark.start - right.mark.start;
    if (intervalOrder !== 0) return intervalOrder;
  }
  return markdownMarkNestingRank(left.mark.type) - markdownMarkNestingRank(right.mark.type)
    || left.mark.start - right.mark.start
    || right.mark.end - left.mark.end
    || textMarkIdentity(left.mark).localeCompare(textMarkIdentity(right.mark));
}

function isStarDelimitedMark(mark: TextMark): boolean {
  return mark.type === 'bold' || mark.type === 'italic';
}

function subtractRange(
  segment: { start: number; end: number },
  range: { start: number; end: number },
): Array<{ start: number; end: number }> {
  if (range.end <= segment.start || range.start >= segment.end) return [segment];
  const next: Array<{ start: number; end: number }> = [];
  if (range.start > segment.start) next.push({ start: segment.start, end: range.start });
  if (range.end < segment.end) next.push({ start: range.end, end: segment.end });
  return next;
}

function markDelimiters(mark: TextMark): { open: string; close: string } | null {
  if (mark.type === 'bold') return { open: '**', close: '**' };
  if (mark.type === 'italic') return { open: '*', close: '*' };
  if (mark.type === 'strike') return { open: '~~', close: '~~' };
  if (mark.type === 'highlight') return { open: '==', close: '==' };
  if (mark.type === 'code') return { open: '`', close: '`' };
  if (mark.type === 'link') {
    const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
    return href ? { open: '[', close: `](${escapeMarkdownLinkDestination(href)})` } : null;
  }
  return null;
}

function markdownMarkNestingRank(type: TextMark['type']): number {
  if (type === 'bold') return 0;
  if (type === 'italic') return 1;
  if (type === 'strike') return 2;
  if (type === 'highlight') return 3;
  if (type === 'link') return 4;
  if (type === 'code') return 5;
  return 6;
}

function escapeMarkdownLinkDestination(href: string): string {
  return href.replace(/[\\()]/gu, '\\$&');
}
