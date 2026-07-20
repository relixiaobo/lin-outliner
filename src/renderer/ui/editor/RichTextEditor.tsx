import { useEffect, useMemo, useRef, useState } from 'react';
import { toggleMark } from 'prosemirror-commands';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { replaceAllRichTextPatch, type CreateNodeTree, type PasteRowMeta, type ReferenceTarget, type RichText, type RichTextPatch } from '../../api/types';
import type { FocusRequest, FocusTarget, PendingInputChar } from '../../state/document';
import type { EditorTrigger, NavigateRootOptions } from '../shared';
import { wantsNewPaneFromClick } from '../shared';
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
  TRANSIENT_TEXT_SENTINEL,
} from './richTextCodec';
import { richTextPatchFromTransaction } from './editorTextPatch';
import { applyRichTextPatchToContent } from './richTextPatchApply';
import { createInlineMarkShortcutTransaction } from './inlineMarkShortcuts';
import { moveInlineCodeCaretAcrossBoundary, setDomSelectionAtDocSide } from './inlineCodeBoundaryNavigation';
import { pmSchema } from './pmSchema';
import { targetFromInlineReferenceElement } from './inlineReferenceAttrs';
import { openUrlPreviewFromClick } from '../preview/urlPreviewRouting';
import {
  applyCursorPlacement,
  selectionForPlacement,
  selectionTextOffsets as selectionOffsets,
} from './nodeLineView';
import { resolveNodeLineTrigger } from './nodeLineTrigger';
import { focusTargetMatches } from '../focus/focusModel';
import { compositionAnchorTransaction } from './imeCompositionAnchor';
import {
  beginComposition,
  endComposition,
  extractComposedInsertion,
  IME_TRACE_ENABLED,
  imeTrace,
  isCompositionLive,
} from './compositionRelay';

export interface EditorSplitPayload {
  before: RichText;
  after: RichText;
  atStart: boolean;
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
  /** Extra class appended to the editor element (e.g. a field-value or block class). */
  className?: string;
  readOnly?: boolean;
  /** Keeps a read-only editor focusable/selectable while rejecting content mutations. */
  readOnlyCaret?: boolean;
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
  onSelectAllRows?: () => void;
  onDescriptionToggle?: (payload: EditorDescriptionTogglePayload) => void;
  onModEnter: (content: RichText) => void;
  onEscape: () => void;
  /**
   * Fired on a Space keypress with no modifiers. Returning `true` consumes the
   * key (the space is not inserted). A date value row uses this to summon its
   * picker when the value is empty, while still allowing a literal space when
   * the row already has text.
   */
  onSpace?: () => boolean;
  onTriggerChange: (trigger: EditorTrigger | null) => void;
  onFieldTriggerFire?: () => void;
  /** Fired when a bare ``` / ~~~ owns the row, to convert it into a code block. */
  onCodeFenceFire?: () => void;
  /** Resolves true only when the parsed first-row content should enter this editor. */
  onPasteOutliner?: (payload: {
    content: RichText;
    children: CreateNodeTree[];
    siblingsAfter: CreateNodeTree[];
    /** Metadata (`#tag` / `field::` / task checkbox) for the first merged block. */
    firstMeta?: PasteRowMeta;
  }) => Promise<boolean>;
  onPasteImage?: (images: PastedImage[]) => void;
  onPasteFiles?: (files: File[]) => void;
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
  onInlineReferenceClick?: (target: ReferenceTarget, options?: NavigateRootOptions) => void;
  resolveInlineReferenceColor?: (targetNodeId: string) => string | undefined;
  focusTarget?: FocusTarget;
  focusRequest?: FocusRequest | null;
  pendingInput?: PendingInputChar | null;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  onPendingInputConsumed?: (input: PendingInputChar) => void;
  /**
   * Fired at compositionend when a focusRequest targeting ANOTHER editor
   * arrived mid-composition and was parked by the composition gate (issue
   * #176). `text` is what the composition inserted — already reverted locally
   * and never flushed to core. The host re-issues the parked request via
   * `relayCompositionHandoffState`, landing the text at the focus target
   * through the pendingInput rail.
   */
  onCompositionHandoff?: (text: string) => void;
  /**
   * A non-editable element rendered as an inline widget at the very end of the
   * last paragraph's text, so trailing chrome (the row's tag chips) flows right
   * after the last word and wraps WITH the text instead of dropping to its own
   * line. The owner portals its content into this node and toggles it to `null`
   * when empty. Placed inside the paragraph's inline content (not as a sibling),
   * which is the only way a separate element can join the editor's last line.
   */
  inlineSlotEl?: HTMLElement | null;
}

/**
 * Document position just inside the end of the last textblock's inline content —
 * where a `side: 1` widget renders after the final character, on the last line.
 * Outliner rows are single-paragraph, but this stays correct for any textblock.
 */
function lastTextblockInlineEnd(doc: PMNode): number | null {
  let pos: number | null = null;
  doc.forEach((node, offset) => {
    if (node.isTextblock) pos = offset + 1 + node.content.size;
  });
  return pos;
}

function focusEditorDom(view: EditorView) {
  view.dom.focus({ preventScroll: true });
}

function isEditableSurface(props: RichTextEditorProps) {
  return !props.readOnly || Boolean(props.readOnlyCaret);
}

function selectedInlineReferencePosition(view: EditorView): number | null {
  const selection = view.state.selection;
  if (!(selection instanceof NodeSelection)) return null;
  return selection.node.type.name === 'inlineReference' ? selection.from : null;
}

function ensureImeCompositionAnchor(view: EditorView) {
  const tr = compositionAnchorTransaction(view.state);
  if (tr) view.dispatch(tr);
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
  return isEmptyRichText(docToRichText(doc));
}

function isEmptyRichText(content: RichText) {
  return content.text.replaceAll(TRANSIENT_TEXT_SENTINEL, '').trim().length === 0 && content.inlineRefs.length === 0;
}

function isEmptyAfterPatch(
  previousContent: RichText,
  nextContent: RichText,
  patch: RichTextPatch,
  wasEmpty: boolean,
) {
  if (wasEmpty) return isEmptyRichText(nextContent);
  for (const op of patch.ops) {
    if (op.type === 'replace_all') return isEmptyRichText(nextContent);
    if (
      op.type === 'replace'
      && (
        op.to > op.from
        || (op.deletedInlineRefs?.length ?? 0) > 0
        || op.content.text.trim().length === 0
      )
    ) {
      return isEmptyRichText(nextContent);
    }
  }
  return previousContent.text.length > 0 || previousContent.inlineRefs.length > 0
    ? false
    : isEmptyRichText(nextContent);
}

function isModifierOnlyKey(event: KeyboardEvent) {
  return event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift';
}

function isReadOnlyMutationKey(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete';
}

function domSelectionCoversEditorText(element: HTMLElement) {
  const selection = window.getSelection();
  if (
    !selection
    || selection.isCollapsed
    || selection.rangeCount === 0
    || !selection.anchorNode
    || !selection.focusNode
    || !element.contains(selection.anchorNode)
    || !element.contains(selection.focusNode)
  ) {
    return false;
  }
  const text = element.textContent ?? '';
  return selection.toString().length >= text.length;
}

export function RichTextEditor(props: RichTextEditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  const lastExternalContentRef = useRef(props.content);
  const lastContentRevisionRef = useRef(props.contentRevision ?? 0);
  const fieldTriggerFiredRef = useRef(false);
  const codeFenceFiredRef = useRef(false);
  const selectAllRowsReadyRef = useRef(false);
  const composingRef = useRef(false);
  const compositionDocChangedRef = useRef(false);
  const structuredPastePendingRef = useRef(false);
  // Cross-editor composition gate state (issue #176): this editor's gate token,
  // the focusRequest snapshot at composition start (a request that PREDATES the
  // composition is someone else's business — only one that arrived mid-
  // composition gets relayed), and the buffering flag that bridges the sync
  // compositionend handler and its flush microtask so a late final composition
  // transaction can't flush to this node first.
  const compositionToken = useMemo(() => Symbol('ime-composition'), []);
  const compositionStartFocusRequestRef = useRef<FocusRequest | null>(null);
  const pendingHandoffRef = useRef(false);
  const initialEmpty = isEmptyRichText(props.content);
  const [isEmpty, setIsEmptyState] = useState(initialEmpty);
  const isEmptyRef = useRef(initialEmpty);
  const [structuredPastePending, setStructuredPastePending] = useState(false);
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

  const setEditorIsEmpty = (value: boolean) => {
    isEmptyRef.current = value;
    setIsEmptyState(value);
  };

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

  const updateTrigger = (view: EditorView, content = lastExternalContentRef.current) => {
    propsRef.current.onTriggerChange(resolveNodeLineTrigger(view, content));
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
    setEditorIsEmpty(isEmptyDoc(view.state.doc));
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

  // Transition into composing: snapshot the focusRequest (so only requests
  // arriving DURING the composition are relayed) and raise the global gate.
  const markComposing = () => {
    if (!composingRef.current) {
      compositionStartFocusRequestRef.current = propsRef.current.focusRequest ?? null;
      beginComposition(compositionToken);
      imeTrace('composing:begin', propsRef.current.nodeId, 'requestAtStart:', Boolean(propsRef.current.focusRequest));
    }
    composingRef.current = true;
  };

  const applyFocusRequest = (view: EditorView, request: FocusRequest) => {
    focusEditorDom(view);
    applyCursorPlacement(view, request.placement);
    updateToolbar(view);
    if (!composingRef.current && !view.composing) updateTrigger(view);
    propsRef.current.onFocusRequestConsumed?.(request);
  };

  // Mirror of the external-content sync effect's apply branch, callable from
  // the composition handoff (which preempts that parked sync).
  const applyExternalContent = (view: EditorView) => {
    const content = propsRef.current.content;
    const nextDoc = richTextToDoc(content, pmSchema, propsRef.current.resolveInlineReferenceColor);
    const nextState = EditorState.create({ doc: nextDoc, schema: pmSchema });
    view.updateState(nextState);
    setEditorIsEmpty(isEmptyRichText(content));
    lastExternalContentRef.current = content;
    fieldTriggerFiredRef.current = false;
    codeFenceFiredRef.current = false;
  };

  // A focusRequest targeting another editor landed mid-composition and was
  // parked by the gate. The composed text was never flushed (composition
  // transactions buffer), so resetting to the echoed external content IS
  // core's truth for this node — no compensating patch. The text re-enters
  // through the focus target's pendingInput insertion.
  const handoffCompositionToFocusTarget = (view: EditorView) => {
    const composed = extractComposedInsertion(
      lastExternalContentRef.current.text,
      docToRichText(view.state.doc).text,
    ).replaceAll(INLINE_REF_TEXT_SENTINEL, '').replaceAll(TRANSIENT_TEXT_SENTINEL, '');
    imeTrace('handoff', propsRef.current.nodeId, 'text:', JSON.stringify(composed), '->', propsRef.current.focusRequest?.target.nodeId);
    applyExternalContent(view);
    compositionDocChangedRef.current = false;
    propsRef.current.onCompositionHandoff?.(composed);
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
      editable: () => !structuredPastePendingRef.current && isEditableSurface(propsRef.current),
      // Inline trailing slot (the row's tag chips). A view-level prop, not a state
      // plugin, so it survives the bare `updateState(EditorState.create(...))` calls
      // on the paste path. Recomputed every update, so its position tracks edits.
      decorations: (state) => {
        const el = propsRef.current.inlineSlotEl;
        if (!el) return null;
        const pos = lastTextblockInlineEnd(state.doc);
        if (pos == null) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(pos, el, {
            side: 1,
            key: 'inline-tag-slot',
            stopEvent: () => true,
            ignoreSelection: true,
          }),
        ]);
      },
      dispatchTransaction(transaction) {
        if (structuredPastePendingRef.current && transaction.docChanged) return;
        // Dev-only forensic trail for the #176 family — its argument
        // construction (DOM serialization per composing transaction) is not
        // free, so the whole block is gated, not just the sink.
        const traceComposing = IME_TRACE_ENABLED && (composingRef.current || view.composing);
        const blockBefore = traceComposing ? view.dom.firstElementChild : null;
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (traceComposing) {
          const viewInternals = view as unknown as {
            input?: { compositionNode?: Node | null };
          };
          const compositionNode = viewInternals.input?.compositionNode ?? null;
          imeTrace('compo-tr', propsRef.current.nodeId,
            'doc:', JSON.stringify(nextState.doc.textContent.slice(0, 30)),
            'dom:', JSON.stringify(view.dom.innerHTML.slice(0, 120)),
            'compNode:', compositionNode ? JSON.stringify((compositionNode.nodeValue ?? '').slice(0, 30)) : 'null',
            'blockSwapped:', blockBefore !== null && view.dom.firstElementChild !== blockBefore);
        }
        const composing = composingRef.current || view.composing || pendingHandoffRef.current;
        if (transaction.selectionSet || transaction.docChanged) {
          updateToolbar(view);
        }
        if (transaction.docChanged) {
          if (composing) {
            compositionDocChangedRef.current = true;
            return;
          }
          const patch = richTextPatchFromTransaction(transaction);
          if (patch.ops.length === 0) {
            compositionDocChangedRef.current = false;
            updateTrigger(view);
            return;
          }
          const previousContent = lastExternalContentRef.current;
          const nextContent = applyRichTextPatchToContent(previousContent, patch);
          setEditorIsEmpty(isEmptyAfterPatch(previousContent, nextContent, patch, isEmptyRef.current));
          compositionDocChangedRef.current = false;
          lastExternalContentRef.current = nextContent;
          updateTrigger(view, nextContent);
          if (patch.ops.some((op) => op.type === 'replace_all')) propsRef.current.onChange(nextContent);
          if (patch.ops.length > 0) propsRef.current.onPatch(patch);
          handleContentUpdateAction(nextContent);
        } else if (transaction.selectionSet && !composing) {
          updateTrigger(view);
        }
      },
      handleTextInput(viewInstance, from, to, text) {
        if (propsRef.current.readOnly || structuredPastePendingRef.current) return true;
        if (composingRef.current || viewInstance.composing) return false;
        const tr = createInlineMarkShortcutTransaction(viewInstance.state, from, to, text);
        if (!tr) return false;

        const selectionPosition = tr.selection.from;
        viewInstance.dispatch(tr);
        queueMicrotask(() => {
          if (!viewInstance.isDestroyed) setDomSelectionAtDocSide(viewInstance, selectionPosition, 'after');
        });
        return true;
      },
      handleDOMEvents: {
        mousedown() {
          selectAllRowsReadyRef.current = false;
          return false;
        },
        keydown(_viewInstance, event) {
          if (structuredPastePendingRef.current) {
            event.preventDefault();
            return true;
          }
          if (isImeComposingEvent(event as KeyboardEvent)) {
            markComposing();
            clearMatchingPendingInput();
          }
          return false;
        },
        beforeinput(viewInstance, event) {
          if (structuredPastePendingRef.current) {
            event.preventDefault();
            return true;
          }
          clearMatchingPendingInput();
          if (propsRef.current.readOnly) {
            event.preventDefault();
            return true;
          }
          const inputEvent = event as InputEvent;
          if (inputEvent.inputType === 'insertCompositionText') {
            ensureImeCompositionAnchor(viewInstance);
          }
          return false;
        },
        click(viewInstance, event) {
          if (event.shiftKey) return false;
          const targetElement = event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>('[data-inline-ref-kind]')
            : null;
          const target = targetElement ? targetFromInlineReferenceElement(targetElement) : null;
          if (target && target.kind !== 'local-file' && propsRef.current.onInlineReferenceClick) {
            event.preventDefault();
            event.stopPropagation();
            propsRef.current.onInlineReferenceClick(target, {
              newPane: wantsNewPaneFromClick(event),
            });
            return true;
          }
          const link = event.target instanceof HTMLElement
            ? event.target.closest<HTMLAnchorElement>('a[href]')
            : null;
          if (!link || !viewInstance.dom.contains(link)) return false;
          if (!openUrlPreviewFromClick(event, link.href, link.textContent ?? undefined)) return false;
          event.preventDefault();
          event.stopPropagation();
          return true;
        },
        paste(viewInstance, event) {
          const clipboardEvent = event as ClipboardEvent;
          if (structuredPastePendingRef.current) {
            clipboardEvent.preventDefault();
            return true;
          }

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

          const onPasteFiles = propsRef.current.onPasteFiles;
          if (mediaPaste?.kind === 'files' && onPasteFiles) {
            clipboardEvent.preventDefault();
            onPasteFiles(mediaPaste.files);
            return true;
          }

          if (propsRef.current.readOnly) {
            event.preventDefault();
            return true;
          }

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

          const applyStructuredPaste = (
            payload: Parameters<typeof onPasteOutliner>[0],
            nextEditorContent?: RichText,
          ) => {
            const restoreEditability = () => {
              structuredPastePendingRef.current = false;
              if (!viewInstance.isDestroyed) {
                setStructuredPastePending(false);
                viewInstance.setProps({
                  editable: () => isEditableSurface(propsRef.current),
                });
              }
            };
            structuredPastePendingRef.current = true;
            setStructuredPastePending(true);
            viewInstance.setProps({ editable: () => false });
            let pendingPaste: Promise<boolean>;
            try {
              pendingPaste = onPasteOutliner(payload);
            } catch (error) {
              restoreEditability();
              throw error;
            }
            void pendingPaste
              .then((applyEditorContent) => {
                if (applyEditorContent && nextEditorContent && !viewInstance.isDestroyed) {
                  setContent(nextEditorContent);
                }
              })
              .finally(restoreEditability);
          };

          // A typed first block (e.g. a code block) can't live inside this
          // ProseMirror row, so keep the row and insert everything after it.
          if (first.type !== undefined) {
            applyStructuredPaste({
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
          // Derive the row metadata from the first block itself (it extends
          // PasteRowMeta) so a future PasteRowMeta field can't be silently lost.
          const { content: _content, children: _children, type: _type, codeLanguage: _codeLanguage, ...firstMeta } =
            first;
          // Merging into an existing non-empty row must not silently flip it into
          // a checked task — only a genuinely empty row adopts the checkbox state.
          if (current.text.trim().length > 0) {
            delete firstMeta.checkbox;
            delete firstMeta.done;
          }
          applyStructuredPaste({
            content: nextContent,
            children: first.children,
            siblingsAfter: parsed.slice(1),
            firstMeta,
          }, nextContent);
          return true;
        },
        focus() {
          propsRef.current.onFocus();
          updateToolbar(view);
          if (!composingRef.current && !view.composing) updateTrigger(view);
          return false;
        },
        blur() {
          selectAllRowsReadyRef.current = false;
          if (composingRef.current || compositionDocChangedRef.current) {
            imeTrace('blur-during-composition', propsRef.current.nodeId,
              'buffered:', compositionDocChangedRef.current,
              'request:', propsRef.current.focusRequest?.target.nodeId ?? null);
          }
          composingRef.current = false;
          endComposition(compositionToken);
          flushCompositionChanges(view);
          propsRef.current.onCommit(docToRichText(view.state.doc));
          propsRef.current.onTriggerChange(null);
          window.setTimeout(() => updateToolbar(view), 0);
          return false;
        },
        compositionstart(viewInstance) {
          markComposing();
          compositionDocChangedRef.current = false;
          clearMatchingPendingInput();
          ensureImeCompositionAnchor(viewInstance);
          return false;
        },
        compositionend(viewInstance, event) {
          // A focusRequest that arrived DURING this composition was parked by
          // the gate (issue #176); decide its fate in the flush microtask,
          // after ProseMirror has settled the final composition transaction.
          const parkedRequest = propsRef.current.focusRequest ?? null;
          const requestArrivedMidComposition = parkedRequest !== null
            && parkedRequest !== compositionStartFocusRequestRef.current;
          imeTrace('compositionend', propsRef.current.nodeId,
            'data:', JSON.stringify((event as CompositionEvent).data ?? ''),
            'parked:', requestArrivedMidComposition ? parkedRequest?.target.nodeId : null);
          if (requestArrivedMidComposition) pendingHandoffRef.current = true;
          composingRef.current = false;
          queueMicrotask(() => {
            pendingHandoffRef.current = false;
            endComposition(compositionToken);
            if (viewInstance.isDestroyed) return;
            const target = propsRef.current.focusTarget;
            if (requestArrivedMidComposition
              && propsRef.current.focusRequest === parkedRequest
              && parkedRequest) {
              if (target && focusTargetMatches(parkedRequest.target, target)) {
                // Parked request aimed at this editor: flush the composition
                // normally, then apply the held placement.
                flushCompositionChanges(viewInstance);
                updateTrigger(viewInstance);
                handleContentUpdateAction(lastExternalContentRef.current);
                applyFocusRequest(viewInstance, parkedRequest);
                return;
              }
              handoffCompositionToFocusTarget(viewInstance);
              return;
            }
            flushCompositionChanges(viewInstance);
            updateTrigger(viewInstance);
            handleContentUpdateAction(lastExternalContentRef.current);
          });
          return false;
        },
      },
      handleKeyDown(viewInstance, event) {
        if (isImeComposingEvent(event) || composingRef.current) return false;
        const mod = event.metaKey || event.ctrlKey;
        const selectAllRowsShortcut = Boolean(
          propsRef.current.onSelectAllRows
          && matchesShortcutEvent(event, 'selection.select_all'),
        );
        if (!selectAllRowsShortcut && !isModifierOnlyKey(event)) selectAllRowsReadyRef.current = false;
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

        if (
          event.key === ' '
          && !mod
          && !event.altKey
          && !event.shiftKey
          && !propsRef.current.readOnly
          && propsRef.current.onSpace?.()
        ) {
          event.preventDefault();
          return true;
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
          propsRef.current.onSelectAllRows
          && selectAllRowsShortcut
        ) {
          const selection = viewInstance.state.selection;
          const contentStart = 1;
          const contentEnd = Math.max(contentStart, viewInstance.state.doc.content.size - 1);
          const from = Math.min(selection.from, selection.to);
          const to = Math.max(selection.from, selection.to);
          const fullTextSelected = (from <= contentStart && to >= contentEnd)
            || (selectAllRowsReadyRef.current && domSelectionCoversEditorText(viewInstance.dom));
          const emptyText = contentStart === contentEnd && isEmptyDoc(viewInstance.state.doc);
          if (fullTextSelected && (selectAllRowsReadyRef.current || emptyText)) {
            event.preventDefault();
            selectAllRowsReadyRef.current = false;
            viewInstance.dom.blur();
            propsRef.current.onSelectAllRows();
            return true;
          }
          selectAllRowsReadyRef.current = true;
          return false;
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
          if (propsRef.current.readOnly) return true;
          return toggleMark(pmSchema.marks.bold)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.key.toLowerCase() === 'i') {
          event.preventDefault();
          if (propsRef.current.readOnly) return true;
          return toggleMark(pmSchema.marks.italic)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.key.toLowerCase() === 'e') {
          event.preventDefault();
          if (propsRef.current.readOnly) return true;
          return toggleMark(pmSchema.marks.code)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (propsRef.current.readOnly) return true;
          return toggleMark(pmSchema.marks.strike)(viewInstance.state, viewInstance.dispatch);
        }
        if (mod && event.shiftKey && event.key.toLowerCase() === 'h') {
          event.preventDefault();
          if (propsRef.current.readOnly) return true;
          return toggleMark(pmSchema.marks.highlight)(viewInstance.state, viewInstance.dispatch);
        }
        if (!mod && !event.shiftKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          if (moveInlineCodeCaretAcrossBoundary(viewInstance, event.key === 'ArrowRight' ? 'right' : 'left')) {
            event.preventDefault();
            return true;
          }
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
          textLength: lastExternalContentRef.current.text.length,
          hasShiftArrow: Boolean(propsRef.current.onShiftArrow),
        });
        if (!structural) {
          if (propsRef.current.readOnly && isReadOnlyMutationKey(event)) {
            event.preventDefault();
            return true;
          }
          return false;
        }
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
                atStart: false,
                atEnd: true,
              });
              break;
            }
            const { from, to } = selectionOffsets(viewInstance);
            propsRef.current.onEnter({
              before: sliceRichText(current, 0, from),
              after: sliceRichText(current, from, current.text.length),
              atStart: from === to && from === 0,
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
    imeTrace('editor:mount', propsRef.current.nodeId);

    return () => {
      imeTrace('editor:unmount', propsRef.current.nodeId,
        'composing:', composingRef.current || pendingHandoffRef.current,
        'buffered:', compositionDocChangedRef.current);
      propsRef.current.onTriggerChange(null);
      // A view dying mid-composition must release the gate, and re-issue a
      // request parked behind it (the composed text dies with the view).
      const wasComposing = composingRef.current || pendingHandoffRef.current;
      composingRef.current = false;
      pendingHandoffRef.current = false;
      endComposition(compositionToken);
      if (wasComposing) {
        const request = propsRef.current.focusRequest;
        if (request && request !== compositionStartFocusRequestRef.current) {
          propsRef.current.onCompositionHandoff?.('');
        }
      }
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
    if (composingRef.current || view.composing) {
      // The dangerous fallthrough: composing but not DOM-focused — the replace
      // below force-commits a live IME session.
      imeTrace('external-replace-while-composing-unfocused', propsRef.current.nodeId);
    }
    const currentContent = lastExternalContentRef.current;
    if (view.hasFocus() && richTextEquals(props.content, currentContent)) {
      lastExternalContentRef.current = props.content;
      return;
    }
    if (view.hasFocus() && !contentRevisionChanged) return;
    const nextDoc = richTextToDoc(props.content, pmSchema, props.resolveInlineReferenceColor);
    if (nextDoc.eq(view.state.doc)) return;
    const nextState = EditorState.create({ doc: nextDoc, schema: pmSchema });
    view.updateState(nextState);
    setEditorIsEmpty(isEmptyRichText(props.content));
    lastExternalContentRef.current = props.content;
    // A programmatic content replace (e.g. clearing the trailing draft after an
    // atomic `>`/``` resolution) bypasses handleContentUpdateAction, so it would
    // otherwise leave the one-shot `>`/``` fire guards latched on this reused
    // editor — suppressing the next typed trigger. Reset them on every external
    // sync so a freshly typed trigger fires again.
    fieldTriggerFiredRef.current = false;
    codeFenceFiredRef.current = false;
    if (!composingRef.current && !view.composing) updateTrigger(view);
  }, [props.content, props.contentRevision, props.resolveInlineReferenceColor]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({
      editable: () => !structuredPastePendingRef.current && isEditableSurface(propsRef.current),
    });
  }, [props.readOnly, props.readOnlyCaret]);

  // The inline tag slot appears/disappears (node <-> null) when tags are added or
  // removed — events that don't dispatch a transaction to THIS editor. Force a
  // redraw so the `decorations` prop is recomputed and the widget added/removed.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({});
  }, [props.inlineSlotEl]);

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
    // A live IME composition — in ANY editor, hence the module-level gate —
    // parks the request unconsumed: applying focus/selection now would force-
    // commit the composition mid-word (issue #176). The composing editor
    // relays the request, with any text composed during the hold, at
    // compositionend.
    if (isCompositionLive()) {
      imeTrace('focusRequest:park', props.nodeId);
      return;
    }
    imeTrace('focusRequest:apply', props.nodeId);
    applyFocusRequest(view, request);
  }, [props.focusRequest]);

  useEffect(() => {
    const view = viewRef.current;
    const input = props.pendingInput;
    const target = propsRef.current.focusTarget;
    if (!view || view.isDestroyed || !input || !target) return;
    if (!focusTargetMatches(input.target, target)) return;
    if (
      propsRef.current.readOnly
      || structuredPastePendingRef.current
      || composingRef.current
      || view.composing
    ) return;

    imeTrace('pendingInput:apply', props.nodeId, 'text:', JSON.stringify(input.char));
    focusEditorDom(view);
    const insertFrom = view.state.selection.from;
    let tr = view.state.tr.insertText(input.char);
    const maxPos = tr.doc.content.size - 1;
    const nextPos = Math.max(1, Math.min(insertFrom + input.char.length, maxPos));
    tr = tr.setSelection(TextSelection.create(tr.doc, nextPos));
    view.dispatch(tr);
    updateToolbar(view);
    updateTrigger(view);
    handleContentUpdateAction(lastExternalContentRef.current);
    propsRef.current.onPendingInputConsumed?.(input);
  }, [props.pendingInput, structuredPastePending]);

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
