import { parseInlineMarkdown } from './markdownPaste';
import {
  formatChatSourceReferenceMarker,
  formatFileReferenceMarker,
  formatNodeReferenceMarker,
  parseReferenceMarkers,
} from './referenceMarkup';
import type { ReferenceTarget, RichText, TextMark } from './types';

export function markdownReferenceMarkupToRichText(rawText: string): RichText {
  const parsed = parseInlineMarkdown(rawText);
  const markers = parseReferenceMarkers(parsed.text);
  if (markers.length === 0) return parsed;

  const inlineRefs: RichText['inlineRefs'] = [];
  let text = '';
  let cursor = 0;
  const ranges: Array<{ oldStart: number; oldEnd: number; newStart: number }> = [];
  for (const marker of markers) {
    text += parsed.text.slice(cursor, marker.start);
    const displayName = marker.label || referenceDisplayFallback(marker.target);
    const newStart = text.length;
    inlineRefs.push({
      offset: newStart,
      target: marker.target,
      ...(displayName ? { displayName } : {}),
    });
    ranges.push({
      oldStart: marker.start,
      oldEnd: marker.end,
      newStart,
    });
    cursor = marker.end;
  }
  text += parsed.text.slice(cursor);

  return {
    text,
    marks: parsed.marks
      .map((mark) => ({
        ...mark,
        start: mapReferenceStrippedOffset(mark.start, ranges),
        end: mapReferenceStrippedOffset(mark.end, ranges),
      }))
      .filter((mark) => mark.end > mark.start),
    inlineRefs,
  };
}

export function richTextToMarkdownReferenceMarkup(content: RichText): string {
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
  for (const mark of markdownSerializableMarks(content.marks)) {
    const delimiters = markDelimiters(mark);
    if (!delimiters) continue;
    add(mark.start, delimiters.open, 20);
    add(mark.end, delimiters.close, -20);
  }

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
    if (index < content.text.length) out += content.text[index];
  }
  return out;
}

function mapReferenceStrippedOffset(
  offset: number,
  ranges: ReadonlyArray<{ oldStart: number; oldEnd: number; newStart: number }>,
): number {
  let delta = 0;
  for (const range of ranges) {
    if (offset < range.oldStart) break;
    if (offset <= range.oldEnd) {
      return range.newStart;
    }
    delta -= range.oldEnd - range.oldStart;
  }
  return offset + delta;
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

function markDelimiters(mark: TextMark): { open: string; close: string } | null {
  if (mark.type === 'bold') return { open: '**', close: '**' };
  if (mark.type === 'italic') return { open: '*', close: '*' };
  if (mark.type === 'strike') return { open: '~~', close: '~~' };
  if (mark.type === 'highlight') return { open: '==', close: '==' };
  if (mark.type === 'code') return { open: '`', close: '`' };
  if (mark.type === 'link') {
    const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
    return href ? { open: '[', close: `](${href})` } : null;
  }
  return null;
}
