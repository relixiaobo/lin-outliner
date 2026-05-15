import type { Mark, Node as PMNode, Slice } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from 'prosemirror-transform';
import type { InlineRef, RichText, RichTextPatch, RichTextPatchOp, TextMarkKind } from '../../api/types';
import { docPosToTextOffset, docToRichText } from './richTextCodec';

const MARK_KINDS = new Set<TextMarkKind>(['bold', 'italic', 'strike', 'code', 'highlight', 'headingMark', 'link']);

export function richTextPatchFromTransaction(transaction: Transaction): RichTextPatch {
  const ops: RichTextPatchOp[] = [];

  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index];
    const doc = transaction.docs[index];
    if (!doc) continue;

    if (step instanceof ReplaceStep) {
      const from = docPosToTextOffset(doc, step.from);
      const to = docPosToTextOffset(doc, step.to);
      const deleted = richTextFromSlice(doc.slice(step.from, step.to));
      const content = richTextFromSlice(step.slice);
      ops.push({
        type: 'replace',
        from,
        to,
        content,
        ...(deleted.inlineRefs.length > 0
          ? { deletedInlineRefs: deleted.inlineRefs.map((ref) => ({ ...ref, offset: from + ref.offset })) }
          : {}),
      });
      continue;
    }

    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      const markType = markKind(step.mark);
      if (!markType) continue;
      const from = docPosToTextOffset(doc, step.from);
      const to = docPosToTextOffset(doc, step.to);
      ops.push(step instanceof AddMarkStep
        ? {
          type: 'add_mark',
          from,
          to,
          markType,
          ...(markAttrs(step.mark) ? { attrs: markAttrs(step.mark) } : {}),
        }
        : {
          type: 'remove_mark',
          from,
          to,
          markType,
        });
    }
  }

  if (ops.length > 0) return { ops };
  if (!transaction.docChanged) return { ops: [] };

  const before = docToRichText(transaction.before);
  return {
    ops: [{
      type: 'replace',
      from: 0,
      to: before.text.length,
      content: docToRichText(transaction.doc),
      ...(before.inlineRefs.length > 0 ? { deletedInlineRefs: before.inlineRefs } : {}),
    }],
  };
}

function richTextFromSlice(slice: Slice): RichText {
  const content: RichText = { text: '', marks: [], inlineRefs: [] };
  slice.content.forEach((node) => collectNode(node, content));
  return content;
}

function collectNode(node: PMNode, content: RichText) {
  if (node.isText) {
    const text = node.text ?? '';
    const start = content.text.length;
    content.text += text;
    for (const mark of node.marks) {
      const type = markKind(mark);
      if (!type) continue;
      content.marks.push({
        start,
        end: start + text.length,
        type,
        ...(markAttrs(mark) ? { attrs: markAttrs(mark) } : {}),
      });
    }
    return;
  }

  if (node.type.name === 'inlineReference') {
    content.inlineRefs.push({
      offset: content.text.length,
      targetNodeId: String(node.attrs.targetNodeId ?? ''),
      displayName: String(node.attrs.displayName ?? '') || undefined,
    });
    return;
  }

  node.forEach((child) => collectNode(child, content));
}

function markKind(mark: Mark): TextMarkKind | undefined {
  return MARK_KINDS.has(mark.type.name as TextMarkKind) ? mark.type.name as TextMarkKind : undefined;
}

function markAttrs(mark: Mark): Record<string, string> | undefined {
  const entries = Object.entries(mark.attrs ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}
