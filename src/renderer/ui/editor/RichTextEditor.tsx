import { useEffect, useMemo, useRef, useState } from 'react';
import { toggleMark } from 'prosemirror-commands';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { replaceAllRichTextPatch, type CreateNodeTree, type RichText, type RichTextPatch } from '../../api/types';
import type { FocusRequest, FocusTarget, PendingInputChar } from '../../state/document';
import type { EditorTrigger, NavigateRootOptions } from '../shared';
import { wantsNewTabFromClick } from '../shared';
import { resolveContentRowUpdateAction } from '../interactions/rowInteractions';
import { resolveNodeLineKeyAction } from '../interactions/nodeLineKeymap';
import { resolveSelectedReferenceShortcut } from '../interactions/selectedReferenceShortcuts';
import {
  isPlainSingleParagraph,
  parseClipboardPaste,
} from '../interactions/pasteParser';
import { readPastedImages, type PastedImage } from '../interactions/imagePaste';
import { classifyMediaPaste } from '../interactions/clipboardPaste';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { matchesShortcutEvent } from '../interactions/shortcutRegistry';
import { FloatingEditorToolbar, type ToolbarMark } from './FloatingEditorToolbar';
import type { OverlayAnchorRect } from '../primitives/useAnchoredOverlay';
import {
  concatRichText,
  docToRichText,
  INLINE_REF_TEXT_SENTINEL,
  richTextToDoc,
  richTextEquals,
  sliceRichText,
} from './richTextCodec';
import { richTextPatchFromTransaction } from './editorTextPatch';
import { pmSchema } from './pmSchema';
import {
  applyCursorPlacement,
  selectionForPlacement,
  selectionTextOffsets as selectionOffsets,
} from './nodeLineView';
import { resolveNodeLineTrigger } from './nodeLineTrigger';
import { focusTargetMatches } from '../focus/focusModel';

export interface EditorSplitPayload {
  before: RichText;
  after: RichText;
  atEnd: boolean;
}

export interface EditorDescriptionTogglePayload {
  cursorOffset: number;
}

interface RichTextEditorProps {
  nodeId: string;
  content: RichText;
  contentRevision?: number;
  placeholder?: string;
  /** Extra class appended to the editor element (e.g. `trailing-editor`). */
  className?: string;
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
  onDescriptionToggle?: (payload: EditorDescriptionTogglePayload) => void;
  onModEnter: (content: RichText) => void;
  onEscape: () => void;
  onTriggerChange: (trigger: EditorTrigger | null) => void;
  onFieldTriggerFire?: () => void;
  /** Fired when a bare ``` / ~~~ owns the row, to convert it into a code block. */
  onCodeFenceFire?: () => void;
  onPasteOutliner?: (payload: {
    content: RichText;
    children: CreateNodeTree[];
    siblingsAfter: CreateNodeTree[];
  }) => void;
  onPasteImage?: (images: PastedImage[]) => void;
  /** A lone remote image URL pasted with no active selection. */
  onPasteMediaUrl?: (url: string) => void;
  /**
   * First-chance paste handler. When it returns `true` the editor's own paste
   * logic is skipped entirely. Lets a consumer (the trailing slot) keep its own
   * create-on-paste semantics while sharing this one editor.
   */
  onPasteCapture?: (event: ClipboardEvent, ctx: { selectionEmpty: boolean }) => boolean;
  /**
   * Whether a lone single-line URL is linkified in place. Defaults to `true`
   * (inline rows). The trailing slot sets this `false` so a pasted URL flows in
   * as plain text instead.
   */
  linkifyPastedUrl?: boolean;
  onInlineReferenceClick?: (targetNodeId: string, options?: NavigateRootOptions) => void;
  resolveInlineReferenceColor?: (targetNodeId: string) => string | undefined;
  focusTarget?: FocusTarget;
  focusRequest?: FocusRequest | null;
  pendingInput?: PendingInputChar | null;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  onPendingInputConsumed?: (input: PendingInputChar) => void;
}

function focusEditorDom(view: EditorView) {
  view.dom.focus({ preventScroll: true });
}

function selectedInlineReferencePosition(view: EditorView): number | null {
  const selection = view.state.selection;
  if (!(selection instanceof NodeSelection)) return null;
  return selection.node.type.name === 'inlineReference' ? selection.from : null;
}

function hasInlineReferenceType(node: PMNode | null | undefined): boolean {
  return node?.type.name === 'inlineReference';
}

function hasTextCompositionAnchor(node: PMNode | null | undefined): boolean {
  return Boolean(node?.isText);
}

function ensureImeCompositionAnchor(view: EditorView) {
  const { selection } = view.state;
  if (selection instanceof NodeSelection && selection.node.type.name === 'inlineReference') {
    const position = selection.from + selection.node.nodeSize;
    let tr = view.state.tr.insertText(INLINE_REF_TEXT_SENTINEL, position, position);
    tr = tr.setSelection(TextSelection.create(tr.doc, position + INLINE_REF_TEXT_SENTINEL.length));
    view.dispatch(tr);
    return true;
  }

  if (!selection.empty) return false;

  const position = selection.from;
  const resolved = view.state.doc.resolve(position);
  if (hasInlineReferenceType(resolved.nodeBefore) && !hasTextCompositionAnchor(resolved.nodeAfter)) {
    let tr = view.state.tr.insertText(INLINE_REF_TEXT_SENTINEL, position, position);
    tr = tr.setSelection(TextSelection.create(tr.doc, position + INLINE_REF_TEXT_SENTINEL.length));
    view.dispatch(tr);
    return true;
  }
  if (hasInlineReferenceType(resolved.nodeAfter) && !hasTextCompositionAnchor(resolved.nodeBefore)) {
    let tr = view.state.tr.insertText(INLINE_REF_TEXT_SENTINEL, position, position);
    tr = tr.setSelection(TextSelection.create(tr.doc, position + INLINE_REF_TEXT_SENTINEL.length));
    view.dispatch(tr);
    return true;
  }
  return false;
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
  const codeFenceFiredRef = useRef(false);
  const composingRef = useRef(false);
  const compositionDocChangedRef = useRef(false);
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
    props.className ?? '',
    props.completed ? 'done' : '',
    isEmpty ? 'is-empty' : '',
    focusPending ? 'is-focus-pending' : '',
  ].filter(Boolean).join(' ');

  propsRef.current = props;

  const initialState = useMemo(() => {
    const doc = richTextToDoc(props.content, pmSchema, props.resolveInlineReferenceColor);
    const initialSelection = props.focusTarget
      && props.focusRequest
      && focusTargetMatches(props.focusRequest.target, props.focusTarget)
      ? selectionForPlacement(doc, props.focusRequest.placement)
      : null;
    return EditorState.create({
      doc,
      schema: pmSchema,
      ...(initialSelection ? { selection: initialSelection } : {}),
    });
  }, []);

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
    propsRef.current.onTriggerChange(resolveNodeLineTrigger(view));
  };

  const handleContentUpdateAction = (nextContent: RichText) => {
    const updateAction = resolveContentRowUpdateAction({
      text: nextContent.text,
      inlineRefCount: nextContent.inlineRefs.length,
      enableFieldTrigger: Boolean(propsRef.current.onFieldTriggerFire),
      enableCodeFence: Boolean(propsRef.current.onCodeFenceFire),
    });
    if (updateAction.type === 'create_field' && !fieldTriggerFiredRef.current) {
      fieldTriggerFiredRef.current = true;
      propsRef.current.onFieldTriggerFire?.();
    } else if (updateAction.type !== 'create_field') {
      fieldTriggerFiredRef.current = false;
    }
    if (updateAction.type === 'create_code_block' && !codeFenceFiredRef.current) {
      codeFenceFiredRef.current = true;
      propsRef.current.onCodeFenceFire?.();
    } else if (updateAction.type !== 'create_code_block') {
      codeFenceFiredRef.current = false;
    }
  };

  const flushCompositionChanges = (view: EditorView) => {
    if (!compositionDocChangedRef.current) return;
    compositionDocChangedRef.current = false;

    const nextContent = docToRichText(view.state.doc);
    setIsEmpty(isEmptyDoc(view.state.doc));
    if (richTextEquals(nextContent, lastExternalContentRef.current)) return;

    lastExternalContentRef.current = nextContent;
    propsRef.current.onChange(nextContent);
    propsRef.current.onPatch(replaceAllRichTextPatch(nextContent));
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
          if (composing) {
            compositionDocChangedRef.current = true;
            return;
          }
          compositionDocChangedRef.current = false;
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
        beforeinput(viewInstance, event) {
          clearMatchingPendingInput();
          const inputEvent = event as InputEvent;
          if (inputEvent.inputType === 'insertCompositionText') {
            ensureImeCompositionAnchor(viewInstance);
          }
          return false;
        },
        click(_viewInstance, event) {
          const target = event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>('[data-inline-ref]')
            : null;
          const targetNodeId = target?.dataset.inlineRef;
          if (!targetNodeId || !propsRef.current.onInlineReferenceClick) return false;
          event.preventDefault();
          event.stopPropagation();
          propsRef.current.onInlineReferenceClick(targetNodeId, {
            newTab: wantsNewTabFromClick(event),
          });
          return true;
        },
        paste(viewInstance, event) {
          if (propsRef.current.readOnly) return false;

          const clipboardEvent = event as ClipboardEvent;

          // First-chance hook: the trailing slot owns create-on-paste semantics
          // and short-circuits the in-place editing logic below.
          const { from, to } = selectionOffsets(viewInstance);
          if (propsRef.current.onPasteCapture?.(clipboardEvent, { selectionEmpty: from === to })) {
            return true;
          }

          // Image / media-URL / single-line-URL front-matter is classified by
          // the same helper the trailing input uses, so the two stay in
          // lock-step. Only the application below differs (edit in place here;
          // create a node in the trailing input).
          const mediaPaste = classifyMediaPaste(clipboardEvent.clipboardData, { hasSelection: from !== to });

          const onPasteImage = propsRef.current.onPasteImage;
          if (mediaPaste?.kind === 'images' && onPasteImage) {
            clipboardEvent.preventDefault();
            void readPastedImages(mediaPaste.files).then((images) => onPasteImage(images));
            return true;
          }

          const onPasteMediaUrl = propsRef.current.onPasteMediaUrl;
          if (mediaPaste?.kind === 'mediaUrl' && onPasteMediaUrl) {
            clipboardEvent.preventDefault();
            onPasteMediaUrl(mediaPaste.url);
            return true;
          }

          const plainText = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
          const htmlText = clipboardEvent.clipboardData?.getData('text/html') ?? '';

          const setContent = (nextContent: RichText) => {
            const nextDoc = richTextToDoc(
              nextContent,
              pmSchema,
              propsRef.current.resolveInlineReferenceColor,
            );
            viewInstance.updateState(EditorState.create({ doc: nextDoc, schema: pmSchema }));
            lastExternalContentRef.current = nextContent;
            propsRef.current.onChange(nextContent);
            propsRef.current.onTriggerChange(null);
          };

          // A single-line URL becomes a link: wrap the selection if there is
          // one, otherwise insert the URL as link-marked text. Consumers that
          // prefer a pasted URL to flow in as plain text opt out via
          // `linkifyPastedUrl={false}`.
          if (mediaPaste?.kind === 'linkUrl' && propsRef.current.linkifyPastedUrl !== false) {
            const url = mediaPaste.url;
            clipboardEvent.preventDefault();
            const current = docToRichText(viewInstance.state.doc);
            let nextContent: RichText;
            if (from !== to) {
              nextContent = {
                ...current,
                marks: [...current.marks, { start: from, end: to, type: 'link', attrs: { href: url } }],
              };
            } else {
              const display = plainText.trim();
              const linkText: RichText = {
                text: display,
                marks: [{ start: 0, end: display.length, type: 'link', attrs: { href: url } }],
                inlineRefs: [],
              };
              const before = sliceRichText(current, 0, from);
              const after = sliceRichText(current, from, current.text.length);
              nextContent = concatRichText(concatRichText(before, linkText), after);
            }
            setContent(nextContent);
            propsRef.current.onPatch(replaceAllRichTextPatch(nextContent));
            return true;
          }

          const onPasteOutliner = propsRef.current.onPasteOutliner;
          if (!onPasteOutliner) return false;

          const parsed = parseClipboardPaste(plainText, htmlText);
          if (parsed.length === 0) return false;
          // Plain single-line text gains nothing over the browser's paste.
          if (!plainText.includes('\n') && isPlainSingleParagraph(parsed)) return false;

          clipboardEvent.preventDefault();
          const first = parsed[0];

          // A typed first block (e.g. a code block) can't live inside this
          // ProseMirror row, so keep the row and insert everything after it.
          if (first.type !== undefined) {
            onPasteOutliner({
              content: docToRichText(viewInstance.state.doc),
              children: [],
              siblingsAfter: parsed,
            });
            return true;
          }

          const current = docToRichText(viewInstance.state.doc);
          const before = sliceRichText(current, 0, from);
          const after = sliceRichText(current, to, current.text.length);
          const nextContent = concatRichText(before, first.content, after);
          setContent(nextContent);
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
          flushCompositionChanges(view);
          propsRef.current.onCommit(docToRichText(view.state.doc));
          propsRef.current.onTriggerChange(null);
          window.setTimeout(() => updateToolbar(view), 0);
          return false;
        },
        compositionstart(viewInstance) {
          composingRef.current = true;
          compositionDocChangedRef.current = false;
          clearMatchingPendingInput();
          ensureImeCompositionAnchor(viewInstance);
          return false;
        },
        compositionend(viewInstance) {
          composingRef.current = false;
          queueMicrotask(() => {
            if (viewInstance.isDestroyed) return;
            flushCompositionChanges(viewInstance);
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
            const selectedNode = viewInstance.state.selection instanceof NodeSelection
              ? viewInstance.state.selection.node
              : null;
            const position = selectedNode
              ? selectedRefPos + selectedNode.nodeSize
              : selectedRefPos;
            let tr = viewInstance.state.tr.setSelection(TextSelection.create(viewInstance.state.doc, position));
            tr = tr.insertText(event.key);
            viewInstance.dispatch(tr);
            return true;
          }
          if (action === 'escape') {
            event.preventDefault();
            propsRef.current.onEscape();
            return true;
          }
        }

        if (matchesShortcutEvent(event, 'editor.redo')) {
          event.preventDefault();
          propsRef.current.onRedo?.();
          return true;
        }

        if (matchesShortcutEvent(event, 'editor.undo')) {
          event.preventDefault();
          propsRef.current.onUndo?.();
          return true;
        }

        if (
          matchesShortcutEvent(event, 'editor.description')
          && propsRef.current.onDescriptionToggle
        ) {
          event.preventDefault();
          const { from } = selectionOffsets(viewInstance);
          propsRef.current.onDescriptionToggle({
            cursorOffset: from,
          });
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
        if (matchesShortcutEvent(event, 'editor.checkbox')) {
          event.preventDefault();
          propsRef.current.onModEnter(docToRichText(viewInstance.state.doc));
          return true;
        }
        if (
          matchesShortcutEvent(event, 'editor.move_up')
          || matchesShortcutEvent(event, 'editor.move_down')
        ) {
          if (!propsRef.current.onMove) return false;
          event.preventDefault();
          propsRef.current.onMove(matchesShortcutEvent(event, 'editor.move_up') ? 'up' : 'down');
          return true;
        }
        const selection = selectionOffsets(viewInstance);
        const structural = resolveNodeLineKeyAction(event, {
          from: selection.from,
          to: selection.to,
          textLength: docToRichText(viewInstance.state.doc).text.length,
          hasShiftArrow: Boolean(propsRef.current.onShiftArrow),
        });
        if (!structural) return false;
        if (structural.type === 'backspaceAtStart') {
          // A "backspace at start" is decided by *text* offset, but inline-ref
          // atoms carry no text offset — so a caret sitting just after a leading
          // reference also reads as offset 0. Delete the reference only when it
          // is the node immediately before the caret; a caret truly at the start
          // (nothing, or just the zero-width IME sentinel, before it) still merges
          // the row up.
          const { $from, empty } = viewInstance.state.selection;
          if (!empty) return false;
          if ($from.nodeBefore?.type.name === 'inlineReference') {
            event.preventDefault();
            viewInstance.dispatch(
              viewInstance.state.tr
                .delete($from.pos - $from.nodeBefore.nodeSize, $from.pos)
                .scrollIntoView(),
            );
            return true;
          }
        }
        event.preventDefault();
        switch (structural.type) {
          case 'split': {
            const current = docToRichText(viewInstance.state.doc);
            if (propsRef.current.readOnly) {
              propsRef.current.onEnter({
                before: current,
                after: { text: '', marks: [], inlineRefs: [] },
                atEnd: true,
              });
              break;
            }
            const { from, to } = selectionOffsets(viewInstance);
            propsRef.current.onEnter({
              before: sliceRichText(current, 0, from),
              after: sliceRichText(current, from, current.text.length),
              atEnd: from === to && to >= current.text.length,
            });
            break;
          }
          case 'backspaceAtStart': {
            const current = docToRichText(viewInstance.state.doc);
            propsRef.current.onBackspaceAtStart(
              current.text.replace(/\u200B/g, '').trim().length === 0 && current.inlineRefs.length === 0,
            );
            break;
          }
          case 'indent':
            propsRef.current.onTab(structural.shiftKey, selection.from);
            break;
          case 'shiftArrow':
            propsRef.current.onShiftArrow?.(structural.direction);
            break;
          case 'navigateUpAtStart':
            propsRef.current.onArrowUpAtStart();
            break;
          case 'navigateDownAtEnd':
            propsRef.current.onArrowDownAtEnd();
            break;
          case 'escape':
            propsRef.current.onEscape();
            break;
        }
        return true;
      },
    });

    viewRef.current = view;

    return () => {
      propsRef.current.onTriggerChange(null);
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
    if (view.hasFocus() && (composingRef.current || view.composing)) return;
    const currentContent = docToRichText(view.state.doc);
    if (view.hasFocus() && richTextEquals(props.content, currentContent)) {
      lastExternalContentRef.current = props.content;
      return;
    }
    if (view.hasFocus() && !contentRevisionChanged) return;
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

  // Depend only on the focus request itself. The matching target and the
  // consume callback are read from `propsRef` (the latest-props ref this
  // component already maintains) instead of the dependency array: both change
  // identity on every parent render, and listing them here made the effect
  // re-run every render. Under a large document with an active editor trigger
  // that re-entrancy looped (applyCursorPlacement -> updateTrigger ->
  // onTriggerChange -> setTrigger -> render -> effect again) until React's
  // update-depth limit tripped.
  useEffect(() => {
    const view = viewRef.current;
    const request = props.focusRequest;
    const target = propsRef.current.focusTarget;
    if (!view || view.isDestroyed || !request || !target) return;
    if (!focusTargetMatches(request.target, target)) return;

    focusEditorDom(view);
    applyCursorPlacement(view, request.placement);
    updateToolbar(view);
    if (!composingRef.current && !view.composing) updateTrigger(view);
    propsRef.current.onFocusRequestConsumed?.(request);
  }, [props.focusRequest]);

  useEffect(() => {
    const view = viewRef.current;
    const input = props.pendingInput;
    const target = propsRef.current.focusTarget;
    if (!view || view.isDestroyed || !input || !target) return;
    if (!focusTargetMatches(input.target, target)) return;
    if (propsRef.current.readOnly || composingRef.current || view.composing) return;

    focusEditorDom(view);
    const insertFrom = view.state.selection.from;
    let tr = view.state.tr.insertText(input.char);
    const maxPos = tr.doc.content.size - 1;
    const nextPos = Math.max(1, Math.min(insertFrom + input.char.length, maxPos));
    tr = tr.setSelection(TextSelection.create(tr.doc, nextPos));
    view.dispatch(tr);
    updateToolbar(view);
    updateTrigger(view);
    handleContentUpdateAction(docToRichText(view.state.doc));
    propsRef.current.onPendingInputConsumed?.(input);
  }, [props.pendingInput]);

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
