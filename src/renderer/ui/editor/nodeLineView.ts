import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type { CursorPlacement } from '../../state/document';
import type { TriggerAnchor } from '../shared';
import { docPosToTextOffset, docToRichText, textOffsetToDocPos } from './richTextCodec';

/**
 * View helpers shared by the two node-line editors — the inline editor
 * (`RichTextEditor`) and the trailing input (`TrailingInput`). Both render a
 * single-paragraph `pmSchema` document with the same position model: text
 * offset `N` maps to doc position `1 + N` (and the inline-ref-aware codec
 * functions reduce to exactly that when the line carries no inline references,
 * which is always the case for the trailing input). Keeping these here means
 * caret anchoring and cursor placement behave identically across both.
 */

/** Caret coordinates for anchoring a trigger popover, or undefined if unknown. */
export function caretAnchor(view: EditorView): TriggerAnchor | undefined {
  try {
    const rect = view.coordsAtPos(view.state.selection.from);
    return { left: rect.left, top: rect.top, bottom: rect.bottom };
  } catch {
    return undefined;
  }
}

/** Normalized `[from, to]` text offsets of the current selection. */
export function selectionTextOffsets(view: EditorView): { from: number; to: number } {
  const from = docPosToTextOffset(view.state.doc, view.state.selection.from);
  const to = docPosToTextOffset(view.state.doc, view.state.selection.to);
  return from < to ? { from, to } : { from: to, to: from };
}

/**
 * Resolve a `CursorPlacement` to a selection on a single-paragraph node-line
 * doc. Returns `null` for `preserve` (the caller should leave the selection
 * untouched).
 */
export function selectionForPlacement(doc: PMNode, placement: CursorPlacement): TextSelection | null {
  if (placement.kind === 'preserve') return null;
  const start = 1;
  const end = Math.max(1, doc.content.size - 1);
  if (placement.kind === 'all') return TextSelection.create(doc, start, end);
  if (placement.kind === 'start') return TextSelection.create(doc, start);
  if (placement.kind === 'text-offset') {
    const pos = textOffsetToDocPos(doc, placement.offset, { inlineRefBias: placement.inlineRefBias });
    return TextSelection.create(doc, pos);
  }
  // 'end'
  const text = docToRichText(doc).text;
  const pos = textOffsetToDocPos(doc, text.length, { inlineRefBias: 'after' });
  return TextSelection.create(doc, pos);
}

/** Apply a `CursorPlacement` to the view (a no-op for `preserve`). */
export function applyCursorPlacement(view: EditorView, placement: CursorPlacement): void {
  const selection = selectionForPlacement(view.state.doc, placement);
  if (selection) view.dispatch(view.state.tr.setSelection(selection));
}
