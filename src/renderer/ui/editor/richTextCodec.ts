import type { Mark, Node as PMNode, Schema } from 'prosemirror-model';
import type { InlineRef, RichText, TextMark, TextMarkKind } from '../../api/types';
import { EMPTY_RICH_TEXT } from '../../api/types';
import { pmSchema } from './pmSchema';

export const TRANSIENT_TEXT_SENTINEL = '\u200B';
export const INLINE_REF_TEXT_SENTINEL = TRANSIENT_TEXT_SENTINEL;

const MARK_NAMES: Record<TextMarkKind, string> = {
  bold: 'bold',
  italic: 'italic',
  strike: 'strike',
  code: 'code',
  highlight: 'highlight',
  headingMark: 'headingMark',
  link: 'link',
};

const TEXT_MARK_KINDS = new Map(Object.entries(MARK_NAMES).map(([kind, name]) => [name, kind as TextMarkKind]));

function markToPm(schema: Schema, mark: TextMark): Mark | null {
  const markType = schema.marks[MARK_NAMES[mark.type]];
  if (!markType) return null;
  return markType.create(mark.attrs ?? undefined);
}

function marksForRange(schema: Schema, marks: TextMark[], start: number, end: number): Mark[] {
  return marks
    .filter((mark) => mark.start < end && mark.end > start)
    .map((mark) => markToPm(schema, mark))
    .filter((mark): mark is Mark => Boolean(mark));
}

function visibleText(text: string): string {
  return text.replaceAll(TRANSIENT_TEXT_SENTINEL, '');
}

function visibleTextLength(text: string): number {
  return visibleText(text).length;
}

function rawOffsetForVisibleOffset(text: string, targetOffset: number): number {
  const target = Math.max(0, targetOffset);
  let visibleOffset = 0;
  for (let rawOffset = 0; rawOffset < text.length; rawOffset += 1) {
    if (text[rawOffset] === TRANSIENT_TEXT_SENTINEL) continue;
    if (visibleOffset === target) return rawOffset;
    visibleOffset += 1;
  }
  return text.length;
}

function sortedBoundaries(text: string, marks: TextMark[], inlineRefs: InlineRef[]): number[] {
  const boundaries = new Set<number>([0, text.length]);
  for (const mark of marks) {
    boundaries.add(Math.max(0, Math.min(text.length, mark.start)));
    boundaries.add(Math.max(0, Math.min(text.length, mark.end)));
  }
  for (const ref of inlineRefs) {
    boundaries.add(Math.max(0, Math.min(text.length, ref.offset)));
  }
  return [...boundaries].sort((a, b) => a - b);
}

export function richTextToDoc(
  content: RichText,
  schema = pmSchema,
  resolveInlineReferenceColor?: (targetNodeId: string) => string | undefined,
): PMNode {
  const paragraphChildren: PMNode[] = [];
  const text = content.text ?? '';
  const marks = content.marks ?? [];
  const inlineRefs = [...(content.inlineRefs ?? [])].sort((a, b) => a.offset - b.offset);
  const refsByOffset = new Map<number, InlineRef[]>();

  for (const ref of inlineRefs) {
    const offset = Math.max(0, Math.min(text.length, ref.offset));
    const refs = refsByOffset.get(offset) ?? [];
    refs.push(ref);
    refsByOffset.set(offset, refs);
  }

  const pushRefs = (offset: number) => {
    const refs = refsByOffset.get(offset);
    if (!refs) return;
    if (offset === 0) {
      paragraphChildren.push(schema.text(INLINE_REF_TEXT_SENTINEL));
    }
    for (const ref of refs) {
      paragraphChildren.push(schema.nodes.inlineReference.create({
        targetNodeId: ref.targetNodeId,
        displayName: ref.displayName ?? '',
        color: resolveInlineReferenceColor?.(ref.targetNodeId) ?? '',
      }));
    }
    if (offset === text.length) {
      paragraphChildren.push(schema.text(INLINE_REF_TEXT_SENTINEL));
    }
  };

  const boundaries = sortedBoundaries(text, marks, inlineRefs);
  pushRefs(0);
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end > start) {
      paragraphChildren.push(schema.text(text.slice(start, end), marksForRange(schema, marks, start, end)));
    }
    pushRefs(end);
  }

  return schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, paragraphChildren));
}

export function docToRichText(doc: PMNode): RichText {
  const textParts: string[] = [];
  const marks: TextMark[] = [];
  const inlineRefs: InlineRef[] = [];
  const paragraph = doc.firstChild;
  if (!paragraph) return EMPTY_RICH_TEXT;

  let offset = 0;
  paragraph.forEach((child) => {
    if (child.isText) {
      const rawText = child.text ?? '';
      const text = visibleText(rawText);
      if (text.length === 0) return;
      textParts.push(text);
      for (const mark of child.marks) {
        const type = TEXT_MARK_KINDS.get(mark.type.name);
        if (!type) continue;
        marks.push({
          start: offset,
          end: offset + text.length,
          type,
          attrs: mark.attrs && Object.keys(mark.attrs).length > 0
            ? Object.fromEntries(Object.entries(mark.attrs).map(([key, value]) => [key, String(value)]))
            : undefined,
        });
      }
      offset += text.length;
      return;
    }
    if (child.type.name === 'inlineReference') {
      inlineRefs.push({
        offset,
        targetNodeId: String(child.attrs.targetNodeId ?? ''),
        displayName: String(child.attrs.displayName ?? '') || undefined,
      });
    }
  });

  return {
    text: textParts.join(''),
    marks: mergeAdjacentMarks(marks),
    inlineRefs,
  };
}

function mergeAdjacentMarks(marks: TextMark[]): TextMark[] {
  const result: TextMark[] = [];
  for (const mark of marks.sort((a, b) => a.start - b.start || a.end - b.end || a.type.localeCompare(b.type))) {
    const last = result[result.length - 1];
    if (
      last &&
      last.type === mark.type &&
      last.end === mark.start &&
      JSON.stringify(last.attrs ?? {}) === JSON.stringify(mark.attrs ?? {})
    ) {
      last.end = mark.end;
    } else {
      result.push({ ...mark });
    }
  }
  return result;
}

export function richTextEquals(a: RichText, b: RichText): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function concatRichText(...parts: RichText[]): RichText {
  let text = '';
  const marks: TextMark[] = [];
  const inlineRefs: InlineRef[] = [];

  for (const part of parts) {
    const offset = text.length;
    text += part.text;
    marks.push(...part.marks.map((mark) => ({
      ...mark,
      start: mark.start + offset,
      end: mark.end + offset,
    })));
    inlineRefs.push(...part.inlineRefs.map((ref) => ({
      ...ref,
      offset: ref.offset + offset,
    })));
  }

  return {
    text,
    marks: mergeAdjacentMarks(marks),
    inlineRefs,
  };
}

export function sliceRichText(content: RichText, start: number, end: number): RichText {
  const from = Math.max(0, Math.min(content.text.length, start));
  const to = Math.max(from, Math.min(content.text.length, end));
  return {
    text: content.text.slice(from, to),
    marks: content.marks
      .filter((mark) => mark.start < to && mark.end > from)
      .map((mark) => ({
        ...mark,
        start: Math.max(0, mark.start - from),
        end: Math.min(to, mark.end) - from,
      }))
      .filter((mark) => mark.end > mark.start),
    inlineRefs: content.inlineRefs
      .filter((ref) => ref.offset >= from && ref.offset <= to)
      .map((ref) => ({ ...ref, offset: ref.offset - from })),
  };
}

function mapDeletedPosition(position: number, from: number, to: number): number {
  if (position <= from) return position;
  if (position >= to) return position - (to - from);
  return from;
}

export function deleteRichTextRange(content: RichText, start: number, end: number): RichText {
  const from = Math.max(0, Math.min(content.text.length, start));
  const to = Math.max(from, Math.min(content.text.length, end));
  if (from === to) return content;

  return {
    text: `${content.text.slice(0, from)}${content.text.slice(to)}`,
    marks: content.marks
      .map((mark) => ({
        ...mark,
        start: mapDeletedPosition(mark.start, from, to),
        end: mapDeletedPosition(mark.end, from, to),
      }))
      .filter((mark) => mark.end > mark.start),
    inlineRefs: content.inlineRefs
      .filter((ref) => ref.offset <= from || ref.offset >= to)
      .map((ref) => ({
        ...ref,
        offset: ref.offset >= to ? ref.offset - (to - from) : ref.offset,
      })),
  };
}

export function replaceRichTextRangeWithInlineRef(
  content: RichText,
  start: number,
  end: number,
  ref: Omit<InlineRef, 'offset'>,
  options: { trailingSpace?: boolean } = {},
): RichText {
  const next = deleteRichTextRange(content, start, end);
  const offset = Math.max(0, Math.min(next.text.length, start));
  const addTrailingSpace = options.trailingSpace !== false && shouldAddInlineRefTrailingSpace(next.text, offset);
  const text = addTrailingSpace
    ? `${next.text.slice(0, offset)} ${next.text.slice(offset)}`
    : next.text;
  const shiftAfterRef = addTrailingSpace ? 1 : 0;
  return {
    ...next,
    text,
    marks: next.marks
      .map((mark) => ({
        ...mark,
        start: mark.start >= offset ? mark.start + shiftAfterRef : mark.start,
        end: mark.end > offset ? mark.end + shiftAfterRef : mark.end,
      }))
      .filter((mark) => mark.end > mark.start),
    inlineRefs: [
      ...next.inlineRefs
        .filter((inlineRef) => inlineRef.offset !== offset || inlineRef.targetNodeId !== ref.targetNodeId)
        .map((inlineRef) => ({
          ...inlineRef,
          offset: inlineRef.offset >= offset ? inlineRef.offset + shiftAfterRef : inlineRef.offset,
        })),
      { ...ref, offset },
    ].sort((a, b) => a.offset - b.offset),
  };
}

function shouldAddInlineRefTrailingSpace(text: string, offset: number): boolean {
  const next = text[offset];
  return next === undefined || !/\s/u.test(next);
}

export function replaceRichTextRangeWithText(
  content: RichText,
  start: number,
  end: number,
  replacement: string,
  options: { inlineRefBias?: 'before' | 'after' } = {},
): RichText {
  const next = deleteRichTextRange(content, start, end);
  const offset = Math.max(0, Math.min(next.text.length, start));
  const keepBoundaryRefsBeforeText = start === end && options.inlineRefBias === 'after';
  return {
    text: `${next.text.slice(0, offset)}${replacement}${next.text.slice(offset)}`,
    marks: next.marks
      .map((mark) => ({
        ...mark,
        start: mark.start >= offset ? mark.start + replacement.length : mark.start,
        end: mark.end > offset ? mark.end + replacement.length : mark.end,
      }))
      .filter((mark) => mark.end > mark.start),
    inlineRefs: next.inlineRefs
      .map((ref) => ({
        ...ref,
        offset: ref.offset > offset || (ref.offset === offset && !keepBoundaryRefsBeforeText)
          ? ref.offset + replacement.length
          : ref.offset,
      })),
  };
}

export function markWholeTextAsHeading(content: RichText): RichText {
  const textLength = content.text.length;
  return {
    ...content,
    marks: [
      ...content.marks.filter((mark) => mark.type !== 'headingMark'),
      ...(textLength > 0
        ? [{ start: 0, end: textLength, type: 'headingMark' as const }]
        : []),
    ],
  };
}

export function textOffsetToDocPos(
  doc: PMNode,
  textOffset: number,
  options: { inlineRefBias?: 'before' | 'after' } = {},
): number {
  const paragraph = doc.firstChild;
  if (!paragraph) return 1;

  const clampedOffset = Math.max(0, textOffset);
  const inlineRefBias = options.inlineRefBias ?? 'after';
  let textSeen = 0;
  let found: number | null = null;
  paragraph.forEach((child, childOffset) => {
    if (found !== null) return;
    const childStart = 1 + childOffset;
    if (!child.isText) {
      if (textSeen === clampedOffset && inlineRefBias === 'before') {
        found = childStart;
        return;
      }
      if (textSeen > clampedOffset) {
        found = childStart;
      }
      return;
    }
    const textLength = child.text?.length ?? 0;
    const visibleLength = visibleTextLength(child.text ?? '');
    if (
      clampedOffset < textSeen + visibleLength
      || (clampedOffset === textSeen + visibleLength && inlineRefBias === 'before')
    ) {
      found = childStart + rawOffsetForVisibleOffset(child.text ?? '', clampedOffset - textSeen);
      return;
    }
    textSeen += visibleLength;
  });

  if (found !== null) return found;

  if (inlineRefBias === 'after') {
    let afterRefsAtOffset: number | null = null;
    let textBeforeChild = 0;
    paragraph.forEach((child, childOffset) => {
      const childStart = 1 + childOffset;
      if (child.isText) {
        textBeforeChild += visibleTextLength(child.text ?? '');
        return;
      }
      if (textBeforeChild === clampedOffset && afterRefsAtOffset === null) {
        afterRefsAtOffset = childStart + child.nodeSize;
      } else if (afterRefsAtOffset !== null && textBeforeChild === clampedOffset) {
        afterRefsAtOffset = childStart + child.nodeSize;
      }
    });
    if (afterRefsAtOffset !== null) return afterRefsAtOffset;
  }

  return Math.max(1, doc.content.size - 1);
}

export function docPosToTextOffset(doc: PMNode, docPos: number): number {
  const paragraph = doc.firstChild;
  if (!paragraph) return 0;

  let textSeen = 0;
  let found: number | null = null;
  paragraph.forEach((child, childOffset) => {
    if (found !== null) return;
    const childStart = 1 + childOffset;
    const childEnd = childStart + child.nodeSize;
    if (docPos <= childStart) {
      found = textSeen;
      return;
    }
    if (child.isText) {
      const text = child.text ?? '';
      const visibleLength = visibleTextLength(text);
      if (docPos <= childEnd) {
        const rawOffset = Math.max(0, Math.min(text.length, docPos - childStart));
        found = textSeen + visibleTextLength(text.slice(0, rawOffset));
        return;
      }
      textSeen += visibleLength;
    }
  });

  return found ?? textSeen;
}
