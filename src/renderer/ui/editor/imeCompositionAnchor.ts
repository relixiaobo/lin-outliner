/**
 * Zero-width text anchors that keep an IME composition session alive.
 *
 * A macOS IME binds its marked range to a concrete DOM #text node. When the
 * caret has no stable text node to host that range, ProseMirror's first
 * non-trivial composition redraw replaces the surrounding DOM and the OS IME
 * session dies mid-word — the composition force-commits and recomposes torn
 * (pinyin "skill" → "sk ill"). Seeding the position with the zero-width
 * sentinel gives the composition a #text node that ProseMirror patches in
 * place (characterData only), so the session survives. The sentinel never
 * reaches `RichText` or patches — the codec strips it (`richTextCodec`).
 */

import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';
import { INLINE_REF_TEXT_SENTINEL } from './richTextCodec';

function isInlineReference(node: PMNode | null | undefined): boolean {
  return node?.type.name === 'inlineReference';
}

function isTextCompositionAnchor(node: PMNode | null | undefined): boolean {
  return Boolean(node?.isText);
}

function anchorTransactionAt(state: EditorState, position: number): Transaction {
  let tr = state.tr.insertText(INLINE_REF_TEXT_SENTINEL, position, position);
  tr = tr.setSelection(TextSelection.create(tr.doc, position + INLINE_REF_TEXT_SENTINEL.length));
  return tr;
}

/**
 * The transaction that seeds a composition anchor for the current selection,
 * or `null` when the caret already sits in stable text. Anchored cases:
 *
 * - A selected inline reference: compose after the node (the IME would
 *   otherwise target the reference's own DOM).
 * - An EMPTY textblock: it has no text node at all, so ProseMirror redraws the
 *   whole paragraph element on the first non-append composition rewrite
 *   (macOS Pinyin re-segmenting "s k" → "sk i" at the third letter) and the
 *   session dies with the removed node (issue #176's empty-row variant;
 *   verified by MutationObserver trace: `childList removed: P` at composition
 *   update 3).
 * - A caret directly against an inline reference with no text node on the
 *   other side: the composition would bind to the reference's DOM.
 */
export function compositionAnchorTransaction(state: EditorState): Transaction | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && isInlineReference(selection.node)) {
    return anchorTransactionAt(state, selection.from + selection.node.nodeSize);
  }

  if (!selection.empty) return null;

  const position = selection.from;
  const resolved = state.doc.resolve(position);
  if (resolved.parent.isTextblock && resolved.parent.content.size === 0) {
    return anchorTransactionAt(state, position);
  }
  if (isInlineReference(resolved.nodeBefore) && !isTextCompositionAnchor(resolved.nodeAfter)) {
    return anchorTransactionAt(state, position);
  }
  if (isInlineReference(resolved.nodeAfter) && !isTextCompositionAnchor(resolved.nodeBefore)) {
    return anchorTransactionAt(state, position);
  }
  return null;
}
