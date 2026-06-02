import type { Mark, Node as PMNode, Slice } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from 'prosemirror-transform';
import type { InlineRef, ReferenceTarget, RichText, RichTextPatch, RichTextPatchOp, TextMarkKind } from '../../api/types';
import { docPosToTextOffset, docToRichText, TRANSIENT_TEXT_SENTINEL, richTextEquals } from './richTextCodec';

const MARK_KINDS = new Set<TextMarkKind>(['bold', 'italic', 'strike', 'code', 'highlight', 'headingMark', 'link']);

function isEmptyRichText(content: RichText): boolean {
  return content.text.length === 0
    && content.inlineRefs.length === 0
    && content.marks.length === 0;
}

export function richTextPatchFromTransaction(transaction: Transaction): RichTextPatch {
  if (richTextEquals(docToRichText(transaction.before), docToRichText(transaction.doc))) {
    return { ops: [] };
  }

  if (needsWholeDocumentReplacement(transaction)) {
    return {
      ops: [{
        type: 'replace_all',
        content: docToRichText(transaction.doc),
      }],
    };
  }

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
      const isNoop = from === to && isEmptyRichText(content) && isEmptyRichText(deleted);
      if (isNoop) continue;
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

function needsWholeDocumentReplacement(transaction: Transaction) {
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index];
    const doc = transaction.docs[index];
    if (!doc || !(step instanceof ReplaceStep)) continue;

    const from = docPosToTextOffset(doc, step.from);
    const to = docPosToTextOffset(doc, step.to);
    const deleted = richTextFromSlice(doc.slice(step.from, step.to));
    const inserted = richTextFromSlice(step.slice);
    if (isEmptyRichText(deleted) && isEmptyRichText(inserted)) continue;
    if (deleted.inlineRefs.length > 0 || inserted.inlineRefs.length > 0) return true;
    if (from === to && docToRichText(doc).inlineRefs.some((ref) => ref.offset === from)) return true;
  }
  return false;
}

function richTextFromSlice(slice: Slice): RichText {
  const content: RichText = { text: '', marks: [], inlineRefs: [] };
  slice.content.forEach((node) => collectNode(node, content));
  return content;
}

function collectNode(node: PMNode, content: RichText) {
  if (node.isText) {
    const text = (node.text ?? '').replaceAll(TRANSIENT_TEXT_SENTINEL, '');
    if (text.length === 0) return;
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
    const target = targetFromInlineReferenceAttrs(node.attrs);
    if (!target) return;
    content.inlineRefs.push({
      offset: content.text.length,
      target,
      displayName: String(node.attrs.displayName ?? '') || undefined,
      mimeType: String(node.attrs.mimeType ?? '') || undefined,
      sizeBytes: typeof node.attrs.sizeBytes === 'number' && Number.isFinite(node.attrs.sizeBytes)
        ? node.attrs.sizeBytes
        : undefined,
    });
    return;
  }

  node.forEach((child) => collectNode(child, content));
}

function markKind(mark: Mark): TextMarkKind | undefined {
  return MARK_KINDS.has(mark.type.name as TextMarkKind) ? mark.type.name as TextMarkKind : undefined;
}

function targetFromInlineReferenceAttrs(attrs: Record<string, unknown>): ReferenceTarget | null {
  const targetKind = String(attrs.targetKind ?? 'node');
  if (targetKind === 'node') {
    const nodeId = String(attrs.targetNodeId ?? '');
    return nodeId ? { kind: 'node', nodeId } : null;
  }
  if (targetKind === 'local-file') {
    const path = String(attrs.targetPath ?? '');
    const entryKind = attrs.entryKind === 'directory' ? 'directory' : 'file';
    return path ? { kind: 'local-file', path, entryKind } : null;
  }
  return null;
}

function markAttrs(mark: Mark): Record<string, string> | undefined {
  const entries = Object.entries(mark.attrs ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}
