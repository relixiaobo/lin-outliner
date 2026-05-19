import { useEffect, useMemo, useRef, useState } from 'react';
import { toggleMark } from 'prosemirror-commands';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { CreateNodeTree, RichText, RichTextPatch } from '../../api/types';
import type { FocusRequest, FocusTarget, PendingInputChar, CursorPlacement } from '../../state/document';
import type { EditorTrigger, TriggerAnchor } from '../shared';
import {
  resolveContentRowUpdateAction,
  resolveEditorTriggerText,
} from '../interactions/rowInteractions';
import { resolveSelectedReferenceShortcut } from '../interactions/selectedReferenceShortcuts';
import { parseOutlinerPaste } from '../interactions/pasteParser';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { FloatingEditorToolbar, type ToolbarMark } from './FloatingEditorToolbar';
import type { OverlayAnchorRect } from '../primitives/useAnchoredOverlay';
import {
  concatRichText,
  docPosToTextOffset,
  docToRichText,
  richTextToDoc,
  richTextEquals,
  sliceRichText,
  textOffsetToDocPos,
} from './richTextCodec';
import { richTextPatchFromTransaction } from './editorTextPatch';
import { pmSchema } from './pmSchema';
import { focusTargetMatches } from '../focus/focusModel';

export interface EditorSplitPayload {
  before: RichText;
  after: RichText;
  atEnd: boolean;
}

type EditorFocusPlacement = 'start' | 'end' | 'all' | { offset: number; inlineRefBias?: 'before' | 'after' };

interface RichTextEditorProps {
  nodeId: string;
  content: RichText;
  contentRevision?: number;
  placeholder?: string;
  readOnly?: boolean;
  completed?: boolean;
  onFocus: () => void;
  onChange: (content: RichText) => void;
  onPatch: (patch: RichTextPatch) => void;
  onCommit: (content: RichText) => void;
  onEnter: (payload: EditorSplitPayload) => void;
  onBackspaceAtStart: (isEmpty: boolean) => void;
  onTab: (shiftKey: boolean, cursorOffset: number) => void;
  onArrowUpAtStart: () => void;
  onArrowDownAtEnd: () => void;
  onShiftArrow?: (direction: 'up' | 'down') => void;
  onMove?: (direction: 'up' | 'down') => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onModEnter: (content: RichText) => void;
  onEscape: () => void;
  onTriggerChange: (trigger: EditorTrigger | null) => void;
  onFieldTriggerFire?: () => void;
  onPasteOutliner?: (payload: {
    content: RichText;
    children: CreateNodeTree[];
    siblingsAfter: CreateNodeTree[];
  }) => void;
  resolveInlineReferenceColor?: (targetNodeId: string) => string | undefined;
  focusTarget?: FocusTarget;
  focusRequest?: FocusRequest | null;
  pendingInput?: PendingInputChar | null;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  onPendingInputConsumed?: (input: PendingInputChar) => void;
}

function setEditorSelection(view: EditorView, placement: EditorFocusPlacement) {
  const content = docToRichText(view.state.doc);
  const start = 1;
  const end = Math.max(1, view.state.doc.content.size - 1);
  const pos = typeof placement === 'object'
    ? textOffsetToDocPos(view.state.doc, placement.offset, { inlineRefBias: placement.inlineRefBias })
    : placement === 'start'
      ? start
      : textOffsetToDocPos(view.state.doc, content.text.length, { inlineRefBias: 'after' });
  const selection = placement === 'all'
    ? TextSelection.create(view.state.doc, start, end)
    : TextSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(selection));
}

function setEditorCursorPlacement(view: EditorView, placement: CursorPlacement) {
  if (placement.kind === 'preserve') return;
  if (placement.kind === 'text-offset') {
    setEditorSelection(view, { offset: placement.offset, inlineRefBias: placement.inlineRefBias });
    return;
  }
  setEditorSelection(view, placement.kind);
}

function selectionOffsets(view: EditorView) {
  const from = docPosToTextOffset(view.state.doc, view.state.selection.from);
  const to = docPosToTextOffset(view.state.doc, view.state.selection.to);
  return from < to ? { from, to } : { from: to, to: from };
}

function selectedInlineReferencePosition(view: EditorView): number | null {
  const selection = view.state.selection;
  if (!(selection instanceof NodeSelection)) return null;
  return selection.node.type.name === 'inlineReference' ? selection.from : null;
}

function activeMarksForSelection(view: EditorView): Set<ToolbarMark> {
  const result = new Set<ToolbarMark>();
  const { from, to, empty } = view.state.selection;
  const markNames: ToolbarMark[] = ['bold', 'italic', 'strike', 'code', 'highlight'];

  for (const markName of markNames) {
    const markType = pmSchema.marks[markName];
    if (!markType) continue;
    const active = empty
      ? Boolean((view.state.storedMarks ?? view.state.selection.$from.marks()).some((mark) => mark.type === markType))
      : view.state.doc.rangeHasMark(from, to, markType);
    if (active) result.add(markName);
  }

  return result;
}

function toolbarAnchor(view: EditorView): OverlayAnchorRect | null {
  if (view.state.selection.empty) return null;
  try {
    const from = view.coordsAtPos(view.state.selection.from);
    const to = view.coordsAtPos(view.state.selection.to);
    const left = Math.min(from.left, to.left);
    const right = Math.max(from.right, to.right);
    const top = Math.min(from.top, to.top);
    return {
      bottom: top,
      left,
      right,
      top,
      width: Math.max(1, right - left),
    };
  } catch {
    return null;
  }
}

function caretAnchor(view: EditorView): TriggerAnchor | undefined {
  try {
    const rect = view.coordsAtPos(view.state.selection.from);
    return { left: rect.left, top: rect.top, bottom: rect.bottom };
  } catch {
    return undefined;
  }
}

function resolveEditorTrigger(view: EditorView): EditorTrigger | null {
  if (!view.state.selection.empty) return null;
  const content = docToRichText(view.state.doc);
  const cursorOffset = docPosToTextOffset(view.state.doc, view.state.selection.from);
  const trigger = resolveEditorTriggerText({
    text: content.text,
    cursorOffset,
  });
  if (trigger) return { ...trigger, anchor: caretAnchor(view) };
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

function isEmptyDoc(doc: EditorState['doc']) {
  const content = docToRichText(doc);
  return content.text.replace(/\u200B/g, '').trim().length === 0 && content.inlineRefs.length === 0;
}

export function RichTextEditor(props: RichTextEditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  const lastExternalContentRef = useRef(props.content);
  const lastContentRevisionRef = useRef(props.contentRevision ?? 0);
  const fieldTriggerFiredRef = useRef(false);
  const composingRef = useRef(false);
  const [isEmpty, setIsEmpty] = useState(() => props.content.text.trim().length === 0 && props.content.inlineRefs.length === 0);
  const [toolbar, setToolbar] = useState({
    visible: false,
    anchorRect: null as OverlayAnchorRect | null,
    activeMarks: new Set<ToolbarMark>(),
  });
  const focusPending = Boolean(props.focusTarget && (
    (props.focusRequest && focusTargetMatches(props.focusRequest.target, props.focusTarget))
    || (props.pendingInput && focusTargetMatches(props.pendingInput.target, props.focusTarget))
  ));
  const editorClassName = [
    'row-editor',
    props.completed ? 'done' : '',
    isEmpty ? 'is-empty' : '',
    focusPending ? 'is-focus-pending' : '',
  ].filter(Boolean).join(' ');

  propsRef.current = props;

  const initialState = useMemo(() => EditorState.create({
    doc: richTextToDoc(props.content, pmSchema, props.resolveInlineReferenceColor),
    schema: pmSchema,
  }), []);

  const updateToolbar = (view: EditorView) => {
    const anchorRect = toolbarAnchor(view);
    if (!anchorRect || !view.hasFocus()) {
      setToolbar((prev) => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }
    setToolbar({
      visible: true,
      anchorRect,
      activeMarks: activeMarksForSelection(view),
    });
  };

  const updateTrigger = (view: EditorView) => {
    propsRef.current.onTriggerChange(resolveEditorTrigger(view));
  };

  const handleContentUpdateAction = (nextContent: RichText) => {
    const updateAction = resolveContentRowUpdateAction({
      text: nextContent.text,
      inlineRefCount: nextContent.inlineRefs.length,
      enableFieldTrigger: Boolean(propsRef.current.onFieldTriggerFire),
    });
    if (updateAction.type === 'create_field' && !fieldTriggerFiredRef.current) {
      fieldTriggerFiredRef.current = true;
      propsRef.current.onFieldTriggerFire?.();
    } else if (updateAction.type !== 'create_field') {
      fieldTriggerFiredRef.current = false;
    }
  };

  const clearMatchingPendingInput = () => {
    const input = propsRef.current.pendingInput;
    const target = propsRef.current.focusTarget;
    if (!input || !target || !focusTargetMatches(input.target, target)) return;
    propsRef.current.onPendingInputConsumed?.(input);
  };

  const toggleToolbarMark = (mark: ToolbarMark) => {
    const view = viewRef.current;
    if (!view || propsRef.current.readOnly) return;
    const markType = pmSchema.marks[mark];
    if (!markType) return;
    toggleMark(markType)(view.state, view.dispatch);
    view.focus();
    updateToolbar(view);
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const view = new EditorView(mount, {
      state: initialState,
      editable: () => !propsRef.current.readOnly,
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        const composing = composingRef.current || view.composing;
        if (transaction.selectionSet || transaction.docChanged) {
          updateToolbar(view);
          if (!composing) updateTrigger(view);
        }
        if (transaction.docChanged) {
          const nextContent = docToRichText(nextState.doc);
          setIsEmpty(nextContent.text.replace(/\u200B/g, '').trim().length === 0 && nextContent.inlineRefs.length === 0);
          lastExternalContentRef.current = nextContent;
          propsRef.current.onChange(nextContent);
          const patch = richTextPatchFromTransaction(transaction);
          if (patch.ops.length > 0) propsRef.current.onPatch(patch);
          if (!composing) handleContentUpdateAction(nextContent);
        }
      },
      handleDOMEvents: {
        keydown(_viewInstance, event) {
          if (isImeComposingEvent(event as KeyboardEvent)) {
            composingRef.current = true;
            clearMatchingPendingInput();
          }
          return false;
        },
        beforeinput() {
          clearMatchingPendingInput();
          return false;
        },
        paste(viewInstance, event) {
          const onPasteOutliner = propsRef.current.onPasteOutliner;
          if (!onPasteOutliner || propsRef.current.readOnly) return false;

          const clipboardEvent = event as ClipboardEvent;
          const plainText = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
          if (!plainText.includes('\n')) return false;

          const parsed = parseOutlinerPaste(plainText);
          if (parsed.length === 0) return false;

          clipboardEvent.preventDefault();
          const first = parsed[0];
          const current = docToRichText(viewInstance.state.doc);
          const { from, to } = selectionOffsets(viewInstance);
          const before = sliceRichText(current, 0, from);
          const after = sliceRichText(current, to, current.text.length);
          const nextContent = concatRichText(before, first.content, after);
          const nextDoc = richTextToDoc(
            nextContent,
            pmSchema,
            propsRef.current.resolveInlineReferenceColor,
          );
          const nextState = EditorState.create({
            doc: nextDoc,
            schema: pmSchema,
          });
          viewInstance.updateState(nextState);
          lastExternalContentRef.current = nextContent;
          propsRef.current.onChange(nextContent);
          propsRef.current.onTriggerChange(null);
          onPasteOutliner({
            content: nextContent,
            children: first.children,
            siblingsAfter: parsed.slice(1),
          });
          return true;
        },
        focus() {
          propsRef.current.onFocus();
          updateToolbar(view);
          if (!composingRef.current && !view.composing) updateTrigger(view);
          return false;
        },
        blur() {
          composingRef.current = false;
          propsRef.current.onCommit(docToRichText(view.state.doc));
          propsRef.current.onTriggerChange(null);
          window.setTimeout(() => updateToolbar(view), 0);
          return false;
        },
        compositionstart() {
          composingRef.current = true;
          clearMatchingPendingInput();
          return false;
        },
        compositionend(viewInstance) {
          composingRef.current = false;
          queueMicrotask(() => {
            if (viewInstance.isDestroyed) return;
            updateTrigger(viewInstance);
            handleContentUpdateAction(docToRichText(viewInstance.state.doc));
          });
          return false;
        },
      },
      handleKeyDown(viewInstance, event) {
        if (isImeComposingEvent(event) || composingRef.current) return false;
        const mod = event.metaKey || event.ctrlKey;
        const selectedRefPos = selectedInlineReferencePosition(viewInstance);
        if (selectedRefPos !== null) {
          const action = resolveSelectedReferenceShortcut(event);
          if (action === 'delete') {
            event.preventDefault();
            viewInstance.dispatch(viewInstance.state.tr.deleteSelection());
            return true;
          }
          if (action === 'convert_arrow_right') {
            event.preventDefault();
            viewInstance.dispatch(
              viewInstance.state.tr.setSelection(TextSelection.create(viewInstance.state.doc, selectedRefPos + 1)),
            );
            return true;
          }
          if (action === 'convert_printable') {
            event.preventDefault();
            viewInstance.dispatch(viewInstance.state.tr.insertText(event.key));
            return true;
          }
          if (action === 'escape') {
            event.preventDefault();
            propsRef.current.onEscape();
            return true;
          }
        }

        if (mod && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) propsRef.current.onRedo?.();
          else propsRef.current.onUndo?.();
          return true;
        }

        if (mod && event.key.toLowerCase() === 'y') {
          event.preventDefault();
          propsRef.current.onRedo?.();
          return true;
        }

        if (mod && event.key.toLowerCase() === 'b') {
          event.preventDefault();
          return toggleMark(pmSchema.marks.bold)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.key.toLowerCase() === 'i') {
          event.preventDefault();
          return toggleMark(pmSchema.marks.italic)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.key.toLowerCase() === 'e') {
          event.preventDefault();
          return toggleMark(pmSchema.marks.code)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          return toggleMark(pmSchema.marks.strike)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.shiftKey && event.key.toLowerCase() === 'h') {
          event.preventDefault();
          return toggleMark(pmSchema.marks.highlight)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.key === 'Enter') {
          event.preventDefault();
          propsRef.current.onModEnter(docToRichText(viewInstance.state.doc));
          return true;
        }
        if (mod && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          if (!propsRef.current.onMove) return false;
          event.preventDefault();
          propsRef.current.onMove(event.key === 'ArrowUp' ? 'up' : 'down');
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const current = docToRichText(viewInstance.state.doc);
          if (propsRef.current.readOnly) {
            propsRef.current.onEnter({
              before: current,
              after: { text: '', marks: [], inlineRefs: [] },
              atEnd: true,
            });
            return true;
          }
          const { from, to } = selectionOffsets(viewInstance);
          propsRef.current.onEnter({
            before: sliceRichText(current, 0, from),
            after: sliceRichText(current, from, current.text.length),
            atEnd: from === to && to >= current.text.length,
          });
          return true;
        }
        if (event.key === 'Backspace') {
          const current = docToRichText(viewInstance.state.doc);
          const { from, to } = selectionOffsets(viewInstance);
          if (from === 0 && to === 0) {
            event.preventDefault();
            propsRef.current.onBackspaceAtStart(
              current.text.replace(/\u200B/g, '').trim().length === 0 && current.inlineRefs.length === 0,
            );
            return true;
          }
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          const { from } = selectionOffsets(viewInstance);
          propsRef.current.onTab(event.shiftKey, from);
          return true;
        }
        if (event.shiftKey && !mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          if (!propsRef.current.onShiftArrow) return false;
          event.preventDefault();
          propsRef.current.onShiftArrow(event.key === 'ArrowUp' ? 'up' : 'down');
          return true;
        }
        if (event.key === 'ArrowUp') {
          const { from } = selectionOffsets(viewInstance);
          if (from === 0) {
            event.preventDefault();
            propsRef.current.onArrowUpAtStart();
            return true;
          }
        }
        if (event.key === 'ArrowDown') {
          const current = docToRichText(viewInstance.state.doc);
          const { to } = selectionOffsets(viewInstance);
          if (to >= current.text.length) {
            event.preventDefault();
            propsRef.current.onArrowDownAtEnd();
            return true;
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          propsRef.current.onEscape();
          return true;
        }
        return false;
      },
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [initialState]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || props.content === lastExternalContentRef.current) return;
    const contentRevision = props.contentRevision ?? 0;
    const contentRevisionChanged = contentRevision !== lastContentRevisionRef.current;
    lastContentRevisionRef.current = contentRevision;
    if (
      view.hasFocus()
      && !contentRevisionChanged
      && !richTextEquals(props.content, docToRichText(view.state.doc))
    ) return;
    const nextDoc = richTextToDoc(props.content, pmSchema, props.resolveInlineReferenceColor);
    if (nextDoc.eq(view.state.doc)) return;
    const nextState = EditorState.create({ doc: nextDoc, schema: pmSchema });
    view.updateState(nextState);
    setIsEmpty(isEmptyDoc(nextState.doc));
    lastExternalContentRef.current = props.content;
    if (!composingRef.current && !view.composing) updateTrigger(view);
  }, [props.content, props.contentRevision, props.resolveInlineReferenceColor]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({ editable: () => !props.readOnly });
  }, [props.readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    const request = props.focusRequest;
    const target = props.focusTarget;
    if (!view || view.isDestroyed || !request || !target) return;
    if (!focusTargetMatches(request.target, target)) return;

    view.focus();
    setEditorCursorPlacement(view, request.placement);
    updateToolbar(view);
    if (!composingRef.current && !view.composing) updateTrigger(view);
    props.onFocusRequestConsumed?.(request);
  }, [props.focusRequest, props.focusTarget, props.onFocusRequestConsumed]);

  useEffect(() => {
    const view = viewRef.current;
    const input = props.pendingInput;
    const target = props.focusTarget;
    if (!view || view.isDestroyed || !input || !target) return;
    if (!focusTargetMatches(input.target, target)) return;
    if (props.readOnly || composingRef.current || view.composing) return;

    view.focus();
    const insertFrom = view.state.selection.from;
    let tr = view.state.tr.insertText(input.char);
    const maxPos = tr.doc.content.size - 1;
    const nextPos = Math.max(1, Math.min(insertFrom + input.char.length, maxPos));
    tr = tr.setSelection(TextSelection.create(tr.doc, nextPos));
    view.dispatch(tr);
    updateToolbar(view);
    updateTrigger(view);
    handleContentUpdateAction(docToRichText(view.state.doc));
    props.onPendingInputConsumed?.(input);
  }, [props.pendingInput, props.focusTarget, props.readOnly, props.onPendingInputConsumed]);

  return (
    <>
      <div
        ref={mountRef}
        className={editorClassName}
        data-placeholder={props.placeholder ?? ''}
      />
      <FloatingEditorToolbar
        visible={toolbar.visible}
        anchorRect={toolbar.anchorRect}
        activeMarks={toolbar.activeMarks}
        onToggle={toggleToolbarMark}
      />
    </>
  );
}
