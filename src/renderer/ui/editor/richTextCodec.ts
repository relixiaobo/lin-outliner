import type { Mark, Node as PMNode, Schema } from 'prosemirror-model';
import type { InlineRef, RichText, TextMark, TextMarkKind } from '../../api/types';
import { EMPTY_RICH_TEXT } from '../../api/types';
import { pmSchema } from './pmSchema';

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
    for (const ref of refs) {
      paragraphChildren.push(schema.nodes.inlineReference.create({
        targetNodeId: ref.targetNodeId,
        displayName: ref.displayName ?? '',
        color: resolveInlineReferenceColor?.(ref.targetNodeId) ?? '',
      }));
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
      const text = child.text ?? '';
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
): RichText {
  const next = deleteRichTextRange(content, start, end);
  const offset = Math.max(0, Math.min(next.text.length, start));
  return {
    ...next,
    inlineRefs: [
      ...next.inlineRefs.filter((inlineRef) => inlineRef.offset !== offset || inlineRef.targetNodeId !== ref.targetNodeId),
      { ...ref, offset },
    ].sort((a, b) => a.offset - b.offset),
  };
}

export function replaceRichTextRangeWithText(
  content: RichText,
  start: number,
  end: number,
  replacement: string,
): RichText {
  const next = deleteRichTextRange(content, start, end);
  const offset = Math.max(0, Math.min(next.text.length, start));
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
        offset: ref.offset >= offset ? ref.offset + replacement.length : ref.offset,
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

export function textOffsetToDocPos(doc: PMNode, textOffset: number): number {
  const paragraph = doc.firstChild;
  if (!paragraph) return 1;

  const clampedOffset = Math.max(0, textOffset);
  let textSeen = 0;
  let found: number | null = null;
  paragraph.forEach((child, childOffset) => {
    if (found !== null) return;
    if (!child.isText) {
      if (textSeen >= clampedOffset) found = 1 + childOffset;
      return;
    }
    const textLength = child.text?.length ?? 0;
    if (clampedOffset <= textSeen + textLength) {
      found = 1 + childOffset + (clampedOffset - textSeen);
      return;
    }
    textSeen += textLength;
  });

  return found ?? Math.max(1, doc.content.size - 1);
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
      const textLength = child.text?.length ?? 0;
      if (docPos <= childEnd) {
        found = textSeen + Math.max(0, Math.min(textLength, docPos - childStart));
        return;
      }
      textSeen += textLength;
    }
  });

  return found ?? textSeen;
}
