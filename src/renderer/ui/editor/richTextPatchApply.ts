import type { RichText, RichTextPatch, RichTextPatchOp, TextMark } from '../../api/types';
import { referenceTargetsEqual } from '../../api/types';

export function applyRichTextPatchToContent(content: RichText, patch: RichTextPatch): RichText {
  let next = content;
  for (const op of patch.ops) next = applyRichTextPatchOpToContent(next, op);
  return next;
}

function applyRichTextPatchOpToContent(content: RichText, op: RichTextPatchOp): RichText {
  if (op.type === 'replace_all') return cloneRichText(op.content);
  if (op.type === 'replace') {
    return replaceRichTextContentRange(
      removeDeletedInlineRefsFromContent(content, op.deletedInlineRefs ?? []),
      op,
    );
  }
  if (op.type === 'add_mark') return addTextMarkToContent(content, op);
  return removeTextMarkFromContent(content, op);
}

function cloneRichText(content: RichText): RichText {
  return {
    text: content.text,
    marks: content.marks.map((mark) => ({ ...mark, ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}) })),
    inlineRefs: content.inlineRefs.map((ref) => ({ ...ref, target: { ...ref.target } })),
  };
}

function replaceRichTextContentRange(content: RichText, op: Extract<RichTextPatchOp, { type: 'replace' }>): RichText {
  const from = clampTextOffset(op.from, content.text.length);
  const to = Math.max(from, clampTextOffset(op.to, content.text.length));
  const insertedLength = op.content.text.length;
  if (
    from === to
    && from === content.text.length
    && op.content.marks.length === 0
    && op.content.inlineRefs.length === 0
  ) {
    return insertedLength === 0
      ? content
      : { text: `${content.text}${op.content.text}`, marks: content.marks, inlineRefs: content.inlineRefs };
  }

  const delta = insertedLength - (to - from);
  const mapPosition = (position: number, isStart: boolean) => {
    if (position < from) return position;
    if (position > to) return position + delta;
    return isStart ? from + insertedLength : from;
  };
  const remappedMarks = content.marks
    .map((mark) => ({
      ...mark,
      start: mapPosition(mark.start, true),
      end: mapPosition(mark.end, false),
    }))
    .filter((mark) => mark.end > mark.start);
  const insertedMarks = op.content.marks.map((mark) => ({
    ...mark,
    start: from + mark.start,
    end: from + mark.end,
  }));
  const beforeRefs: RichText['inlineRefs'] = [];
  const afterRefs: RichText['inlineRefs'] = [];
  for (const ref of content.inlineRefs) {
    if (ref.offset <= from) beforeRefs.push(ref);
    else if (ref.offset >= to) afterRefs.push({ ...ref, offset: ref.offset + delta });
  }

  return {
    text: `${content.text.slice(0, from)}${op.content.text}${content.text.slice(to)}`,
    marks: mergeAdjacentTextMarks([...remappedMarks, ...insertedMarks]),
    inlineRefs: [
      ...beforeRefs,
      ...op.content.inlineRefs.map((ref) => ({ ...ref, offset: from + ref.offset })),
      ...afterRefs,
    ],
  };
}

function addTextMarkToContent(content: RichText, op: Extract<RichTextPatchOp, { type: 'add_mark' }>): RichText {
  const start = clampTextOffset(op.from, content.text.length);
  const end = Math.max(start, clampTextOffset(op.to, content.text.length));
  if (end <= start) return content;
  const added: TextMark = {
    start,
    end,
    type: op.markType,
    ...(op.attrs && Object.keys(op.attrs).length > 0 ? { attrs: { ...op.attrs } } : {}),
  };
  if (content.marks.length === 0) return { ...content, marks: [added] };
  const preserved: TextMark[] = [];
  for (const mark of content.marks) {
    if (mark.type !== op.markType || mark.end <= start || mark.start >= end) {
      preserved.push(mark);
      continue;
    }
    if (mark.start < start) preserved.push({ ...mark, end: start });
    if (mark.end > end) preserved.push({ ...mark, start: end });
  }
  return { ...content, marks: mergeAdjacentTextMarks([...preserved, added]) };
}

function removeTextMarkFromContent(content: RichText, op: Extract<RichTextPatchOp, { type: 'remove_mark' }>): RichText {
  if (content.marks.length === 0) return content;
  const start = clampTextOffset(op.from, content.text.length);
  const end = Math.max(start, clampTextOffset(op.to, content.text.length));
  if (end <= start) return content;
  let changed = false;
  const marks: TextMark[] = [];
  for (const mark of content.marks) {
    if (mark.type !== op.markType || mark.end <= start || mark.start >= end) {
      marks.push(mark);
      continue;
    }
    changed = true;
    if (mark.start < start) marks.push({ ...mark, end: start });
    if (mark.end > end) marks.push({ ...mark, start: end });
  }
  return changed ? { ...content, marks: mergeAdjacentTextMarks(marks) } : content;
}

function removeDeletedInlineRefsFromContent(
  content: RichText,
  refs: readonly RichText['inlineRefs'][number][],
): RichText {
  if (refs.length === 0 || content.inlineRefs.length === 0) return content;
  const usedDeletedIndexes = new Set<number>();
  const inlineRefs = content.inlineRefs.filter((ref) => {
    const deletedIndex = refs.findIndex((candidate, index) =>
      !usedDeletedIndexes.has(index)
      && candidate.offset === ref.offset
      && referenceTargetsEqual(candidate.target, ref.target)
      && (candidate.displayName === undefined || candidate.displayName === ref.displayName));
    if (deletedIndex < 0) return true;
    usedDeletedIndexes.add(deletedIndex);
    return false;
  });
  return inlineRefs.length === content.inlineRefs.length ? content : { ...content, inlineRefs };
}

function mergeAdjacentTextMarks(marks: TextMark[]) {
  const result: TextMark[] = [];
  for (const mark of marks.sort((left, right) =>
    left.start - right.start
    || left.end - right.end
    || left.type.localeCompare(right.type)
    || JSON.stringify(left.attrs ?? {}).localeCompare(JSON.stringify(right.attrs ?? {})))) {
    const last = result[result.length - 1];
    if (
      last
      && last.type === mark.type
      && last.end === mark.start
      && JSON.stringify(last.attrs ?? {}) === JSON.stringify(mark.attrs ?? {})
    ) {
      last.end = mark.end;
    } else {
      result.push({ ...mark, ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}) });
    }
  }
  return result;
}

function clampTextOffset(offset: number, length: number) {
  return Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, length));
}
