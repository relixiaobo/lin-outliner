import type { EditorView } from 'prosemirror-view';
import { resolveEditorTriggerText } from '../interactions/rowInteractions';
import type { EditorTrigger } from '../shared';
import type { RichText } from '../../api/types';
import { TAG_TRIGGER_QUERY_PATTERN, isCssHexColorToken } from '../../../core/textSyntax';
import { docPosToTextOffset, docToRichText } from './richTextCodec';
import { caretAnchor } from './nodeLineView';

const TRIGGER_CONTEXT_LIMIT = 256;

/**
 * Cursor-aware trigger detection for a node line. Returns the active `#`/`@`/`/`
 * trigger at the caret, or `null`. This is the single source of truth the
 * node-line editor core uses (see `docs/plans/archive/node-line-editor-core-design.md`
 * §5): the inline editor uses it today; the trailing input adopts it in 2b,
 * replacing its whole-text `lastIndexOf` detection.
 *
 * Detection only — *application* of a trigger (drive a popover, create a node)
 * is the caller's job and differs between the two editors.
 */
export function resolveNodeLineTrigger(view: EditorView, currentContent?: RichText): EditorTrigger | null {
  if (!view.state.selection.empty) return null;
  const content = currentContent ?? docToRichText(view.state.doc);
  const cursorOffset = docPosToTextOffset(view.state.doc, view.state.selection.from);
  const trigger = currentContent
    ? resolveBoundedEditorTriggerText(content.text, cursorOffset)
    : resolveEditorTriggerText({
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

function resolveBoundedEditorTriggerText(text: string, cursorOffset: number) {
  if (text.length <= TRIGGER_CONTEXT_LIMIT) {
    return resolveEditorTriggerText({ text, cursorOffset });
  }

  const beforeStart = Math.max(0, cursorOffset - TRIGGER_CONTEXT_LIMIT);
  const beforeCursor = text.slice(beforeStart, cursorOffset);
  const hashMatch = beforeCursor.match(TAG_TRIGGER_QUERY_PATTERN);
  if (hashMatch?.index !== undefined && isWindowMatchBoundary(text, beforeStart, hashMatch.index)) {
    if (!isCssHexColorToken(hashMatch[1] ?? '')) {
      return {
        kind: '#' as const,
        query: hashMatch[1] ?? '',
        from: beforeStart + hashMatch.index,
        to: cursorOffset,
      };
    }
  }

  const referenceMatch = beforeCursor.match(/@([^\s]*)$/u);
  if (referenceMatch?.index !== undefined && isWindowMatchBoundary(text, beforeStart, referenceMatch.index)) {
    return {
      kind: '@' as const,
      query: referenceMatch[1] ?? '',
      from: beforeStart + referenceMatch.index,
      to: cursorOffset,
    };
  }

  return null;
}

function isWindowMatchBoundary(text: string, windowStart: number, matchIndex: number) {
  return windowStart === 0 || matchIndex > 0 || /\s/u.test(text[windowStart - 1] ?? '');
}
