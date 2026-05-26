import type { EditorView } from 'prosemirror-view';
import { resolveEditorTriggerText } from '../interactions/rowInteractions';
import type { EditorTrigger } from '../shared';
import { docPosToTextOffset, docToRichText } from './richTextCodec';
import { caretAnchor } from './nodeLineView';

/**
 * Cursor-aware trigger detection for a node line. Returns the active `#`/`@`/`/`
 * trigger at the caret, or `null`. This is the single source of truth the
 * node-line editor core uses (see `docs/plans/node-line-editor-core-design.md`
 * §5): the inline editor uses it today; the trailing input adopts it in 2b,
 * replacing its whole-text `lastIndexOf` detection.
 *
 * Detection only — *application* of a trigger (drive a popover, create a node)
 * is the caller's job and differs between the two editors.
 */
export function resolveNodeLineTrigger(view: EditorView): EditorTrigger | null {
  if (!view.state.selection.empty) return null;
  const content = docToRichText(view.state.doc);
  const cursorOffset = docPosToTextOffset(view.state.doc, view.state.selection.from);
  const trigger = resolveEditorTriggerText({
    text: content.text,
    cursorOffset,
  });
  if (trigger) return { ...trigger, anchor: caretAnchor(view) };
  // A line that is exactly a bare trigger char (no inline refs) opens an empty
  // trigger — e.g. typing "/" on its own.
  if (content.inlineRefs.length === 0 && ['#', '@', '/'].includes(content.text)) {
    return {
      kind: content.text as EditorTrigger['kind'],
      query: '',
      from: 0,
      to: 1,
      anchor: caretAnchor(view),
    };
  }
  return null;
}
