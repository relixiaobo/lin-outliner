import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { api } from '../../api/client';
import type { CommandOutcome, CreateNodeTree, DocumentProjection, NodeId, NodeProjection } from '../../api/types';
import { EMPTY_RICH_TEXT } from '../../api/types';
import type { CursorPlacement, DocumentIndex, FocusRequest, FocusSurface } from '../../state/document';
import { pmSchema } from '../editor/pmSchema';
import { richTextToDoc } from '../editor/richTextCodec';
import { focusTarget, focusTargetMatches } from '../focus/focusModel';
import {
  resolveTrailingRowArrowDownIntent,
  resolveTrailingRowArrowUpIntent,
  resolveTrailingRowBackspaceIntent,
  resolveTrailingRowEnterIntent,
  resolveTrailingRowEscapeIntent,
  resolveTrailingRowUpdateAction,
} from '../interactions/rowInteractions';
import { getTreeReferenceBlockReason } from '../interactions/referenceRules';
import { isOptionsFieldType } from '../fields/fieldTypeRegistry';
import { filterFieldOptions, resolveFieldOptions } from '../interactions/fieldOptions';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { readPastedImages, type PastedImage } from '../interactions/imagePaste';
import { classifyMediaPaste } from '../interactions/clipboardPaste';
import { matchesShortcutEvent } from '../interactions/shortcutRegistry';
import { parseClipboardPaste } from '../interactions/pasteParser';
import type { SlashCommandId } from '../interactions/slashCommands';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import {
  PopoverBulletIcon,
  PopoverEmpty,
  PopoverListbox,
  PopoverListItem,
} from './PopoverList';
import { TrailingInputLeading } from './TrailingInputLeading';
import { TriggerPopover } from './TriggerPopover';
import type { CommandRunner, EditorTrigger } from '../shared';
import { triggerOwnsWholeText, type TrailingInlineTrigger, type TrailingSlashTrigger } from './trailingTriggers';

interface TrailingInputProps {
  panelId?: string | null;
  parentId: NodeId;
  index: DocumentIndex;
  expanded: Set<NodeId>;
  focusRequest?: FocusRequest | null;
  focusedId?: NodeId | null;
  focusSurface?: FocusSurface | null;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  run: CommandRunner;
  onCreate: (parentId: NodeId, text: string) => Promise<NodeId | null> | NodeId | null | void;
  onCreateTree?: (parentId: NodeId, nodes: CreateNodeTree[]) => Promise<unknown> | unknown;
  onPasteImages?: (parentId: NodeId, images: PastedImage[]) => Promise<unknown> | unknown;
  onPasteMediaUrl?: (parentId: NodeId, url: string) => Promise<unknown> | unknown;
  onIndentNode?: (nodeId: NodeId) => Promise<unknown> | unknown;
  onUpdateCreated?: (nodeId: NodeId, text: string) => Promise<void> | void;
  onToggleCreated?: (nodeId: NodeId) => Promise<void> | void;
  onApplyTagTrigger?: (params: {
    parentId: NodeId;
    text: string;
    trigger: TrailingInlineTrigger;
    tagId: NodeId;
  }) => Promise<CommandOutcome | DocumentProjection | null | void> | CommandOutcome | DocumentProjection | null | void;
  onCreateTagTrigger?: (params: {
    parentId: NodeId;
    text: string;
    trigger: TrailingInlineTrigger;
    name: string;
  }) => Promise<CommandOutcome | DocumentProjection | null | void> | CommandOutcome | DocumentProjection | null | void;
  onApplyReferenceTrigger?: (params: {
    parentId: NodeId;
    text: string;
    trigger: TrailingInlineTrigger;
    target: NodeProjection;
    forceInline?: boolean;
  }) => Promise<CommandOutcome | DocumentProjection | null | void> | CommandOutcome | DocumentProjection | null | void;
  onReferenceConversionCreated?: (params: {
    nodeId: NodeId;
    parentId: NodeId;
    targetId: NodeId;
  }) => void;
  onExecuteSlashTrigger?: (params: {
    parentId: NodeId;
    text: string;
    trigger: TrailingSlashTrigger;
    commandId: Exclude<SlashCommandId, 'reference' | 'command_palette' | 'image'>;
  }) => Promise<CommandOutcome | DocumentProjection | null | void> | CommandOutcome | DocumentProjection | null | void;
  onCreateField?: (parentId: NodeId) => Promise<void> | void;
  onOpenCommandPalette?: () => void;
  onExpand?: (nodeId: NodeId) => void;
  onFocusNode?: (nodeId: NodeId) => void;
  onFocusDescription?: (nodeId: NodeId, parentId: NodeId) => void;
  onCollapseNode?: (nodeId: NodeId) => void;
  onNavigateOut?: (direction: 'up' | 'down') => void;
  onUndo?: () => void;
  onRedo?: () => void;
  optionField?: NodeProjection;
  onSelectOption?: (optionId: NodeId) => Promise<unknown> | unknown;
  onCreateOption?: (name: string) => Promise<unknown> | unknown;
  continueOnEnter?: boolean;
  placeholder?: string;
}

type CommitFocusTarget = 'none' | 'trailing' | 'created';

function isInlineTrigger(trigger: EditorTrigger): trigger is TrailingInlineTrigger {
  return trigger.kind === '#' || trigger.kind === '@';
}

function isSlashTrigger(trigger: EditorTrigger): trigger is TrailingSlashTrigger {
  return trigger.kind === '/';
}

function emptyDoc() {
  return richTextToDoc(EMPTY_RICH_TEXT, pmSchema);
}

function plainTreeNode(text: string): CreateNodeTree {
  return {
    content: {
      ...EMPTY_RICH_TEXT,
      text,
    },
    children: [],
  };
}

function resetEditorContent(view: EditorView) {
  const doc = emptyDoc();
  let tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
  tr = tr.setMeta('addToHistory', false);
  tr = tr.setSelection(TextSelection.create(tr.doc, 1));
  view.dispatch(tr);
}

function replaceEditorTextRange(
  view: EditorView,
  fromOffset: number,
  toOffset: number,
  replacement: string,
) {
  const from = Math.max(1, Math.min(1 + fromOffset, view.state.doc.content.size - 1));
  const to = Math.max(from, Math.min(1 + toOffset, view.state.doc.content.size - 1));
  let tr = view.state.tr.insertText(replacement, from, to);
  const cursor = Math.max(1, Math.min(from + replacement.length, tr.doc.content.size - 1));
  tr = tr.setSelection(TextSelection.create(tr.doc, cursor));
  view.dispatch(tr);
}

function clearCommittedEditor(view: EditorView, updateHasContent: (nextHasContent: boolean) => void) {
  if (!view.isDestroyed) {
    resetEditorContent(view);
  }
  updateHasContent(false);
}

function replaceEditorText(view: EditorView, text: string) {
  const docTo = Math.max(1, view.state.doc.content.size - 1);
  let tr = view.state.tr.insertText(text, 1, docTo);
  const maxPos = tr.doc.content.size - 1;
  tr = tr.setMeta('addToHistory', false);
  tr = tr.setSelection(TextSelection.create(tr.doc, Math.max(1, Math.min(1 + text.length, maxPos))));
  view.dispatch(tr);
}

function getEditorText(view: EditorView): string {
  return view.state.doc.textContent;
}

function commandFocusNodeId(result: CommandOutcome | DocumentProjection | null | void): NodeId | null {
  if (!result || !('focus' in result)) return null;
  return result.focus?.nodeId ?? null;
}

function commandFocusParentId(result: CommandOutcome | DocumentProjection | null | void): NodeId | null {
  if (!result || !('focus' in result)) return null;
  return result.focus?.parentId ?? null;
}

function commandProjection(result: unknown): DocumentProjection | null {
  if (!result || typeof result !== 'object') return null;
  if ('projection' in result) return (result as CommandOutcome).projection;
  if ('nodes' in result) return result as DocumentProjection;
  return null;
}

function caretAnchor(view: EditorView) {
  try {
    const rect = view.coordsAtPos(view.state.selection.from);
    return {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
    };
  } catch {
    return undefined;
  }
}

function setTrailingSelection(view: EditorView, placement: CursorPlacement) {
  if (placement.kind === 'preserve') return;
  const textLength = getEditorText(view).length;
  const boundedOffset = placement.kind === 'start'
    ? 0
    : placement.kind === 'text-offset'
      ? Math.max(0, Math.min(textLength, placement.offset))
      : textLength;
  const from = placement.kind === 'all' ? 1 : Math.max(1, Math.min(1 + boundedOffset, view.state.doc.content.size - 1));
  const to = placement.kind === 'all' ? Math.max(1, view.state.doc.content.size - 1) : from;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

function isPlainPrintableKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
  );
}

function lastVisibleDescendant(
  parentId: NodeId,
  index: DocumentIndex,
  expanded: Set<NodeId>,
): NodeId | null {
  const parent = index.byId.get(parentId);
  const lastChildId = parent?.children.filter((childId) => index.byId.has(childId)).at(-1);
  if (!lastChildId) return null;
  if (!expanded.has(lastChildId)) return lastChildId;
  return lastVisibleDescendant(lastChildId, index, expanded) ?? lastChildId;
}

export function TrailingInput(props: TrailingInputProps) {
  const [effectiveParentId, setEffectiveParentId] = useState(props.parentId);
  const [depthShift, setDepthShift] = useState(0);
  const [hasContent, setHasContent] = useState(false);
  const [pendingCommittedVisual, setPendingCommittedVisual] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsQuery, setOptionsQuery] = useState('');
  const [optionsIndex, setOptionsIndex] = useState(0);
  const [trailingTrigger, setTrailingTrigger] = useState<EditorTrigger | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  const effectiveParentRef = useRef(props.parentId);
  const depthShiftRef = useRef(0);
  const committingRef = useRef(false);
  const clearAfterProjectionRef = useRef(false);
  const refocusAfterProjectionRef = useRef(false);
  const composingRef = useRef(false);
  const committedVisualTextRef = useRef('');
  const eagerBufferRef = useRef('');
  const postCommitIndentRef = useRef(false);
  const commitEagerBufferAfterSettleRef = useRef(false);
  const focusEagerBufferAfterSettleRef = useRef(false);
  const skipCreatedFocusAfterCommitRef = useRef(false);
  const trailingTriggerRef = useRef<EditorTrigger | null>(null);
  const optionsStateRef = useRef({
    isOptionsField: false,
    optionsOpen: false,
    optionCount: 0,
    filteredOptions: [] as ReturnType<typeof filterFieldOptions>,
    optionsIndex: 0,
    canCreateOption: false,
    optionsQuery: '',
  });
  const isOptionsField = isOptionsFieldType(props.optionField?.fieldType);
  const allOptions = resolveFieldOptions(props.optionField, props.index.byId);
  const filteredOptions = filterFieldOptions(allOptions, optionsQuery);
  const canCreateOption = isOptionsField
    && props.optionField?.fieldType === 'options'
    && Boolean(optionsQuery.trim())
    && props.optionField?.autocollectOptions !== false
    && !allOptions.some((option) => option.label.toLowerCase() === optionsQuery.trim().toLowerCase());
  const optionCount = filteredOptions.length + (canCreateOption ? 1 : 0);
  const trailingText = viewRef.current ? getEditorText(viewRef.current) : '';
  const treeReferenceParentId = trailingTrigger
    && isInlineTrigger(trailingTrigger)
    && trailingTrigger.kind === '@'
    && triggerOwnsWholeText(trailingText, trailingTrigger)
    ? effectiveParentId
    : null;
  const optionsMenuStyle = useAnchoredOverlay(optionsMenuRef, {
    anchorRef: mountRef,
    disabled: !optionsOpen || !isOptionsField,
    layoutKey: `${optionsQuery}:${optionCount}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 280,
  });
  optionsStateRef.current = {
    isOptionsField,
    optionsOpen,
    optionCount,
    filteredOptions,
    optionsIndex,
    canCreateOption,
    optionsQuery,
  };

  propsRef.current = props;
  effectiveParentRef.current = effectiveParentId;
  depthShiftRef.current = depthShift;
  trailingTriggerRef.current = trailingTrigger;

  useEffect(() => {
    effectiveParentRef.current = props.parentId;
    depthShiftRef.current = 0;
    setEffectiveParentId(props.parentId);
    setDepthShift(0);
    setTrailingTrigger(null);
    setOptionsOpen(false);
    setOptionsQuery('');
    setOptionsIndex(0);
    setPendingCommittedVisual(false);
    committedVisualTextRef.current = '';
    eagerBufferRef.current = '';
    const view = viewRef.current;
    if (view && !view.isDestroyed) {
      resetEditorContent(view);
      updateHasContent(false);
    }
  }, [props.parentId]);

  useEffect(() => {
    setOptionsIndex(0);
  }, [optionsQuery, optionCount]);

  useLayoutEffect(() => {
    if (!clearAfterProjectionRef.current) return;
    if (committingRef.current) return;
    const view = viewRef.current;
    if (!view || view.isDestroyed) return;
    finishProjectionClearIfPending(view);
  }, [props.index.projection]);

  const resetEffectiveParent = () => {
    effectiveParentRef.current = propsRef.current.parentId;
    depthShiftRef.current = 0;
    setEffectiveParentId(propsRef.current.parentId);
    setDepthShift(0);
  };

  const setTrailingParent = (parentId: NodeId, depthShiftValue: number) => {
    effectiveParentRef.current = parentId;
    depthShiftRef.current = depthShiftValue;
    setEffectiveParentId(parentId);
    setDepthShift(depthShiftValue);
  };

  const refocusTrailingEditorSoon = () => {
    const focus = () => {
      const view = viewRef.current;
      if (!view || view.isDestroyed) return;
      view.focus();
    };
    queueMicrotask(focus);
    requestAnimationFrame(focus);
    window.setTimeout(focus, 0);
  };

  const updateHasContent = (nextHasContent: boolean) => {
    setHasContent((current) => current === nextHasContent ? current : nextHasContent);
  };

  const beginProjectionClear = (
    focusAfterCommit: CommitFocusTarget = 'none',
    committedVisualText = '',
  ) => {
    clearAfterProjectionRef.current = true;
    refocusAfterProjectionRef.current = focusAfterCommit === 'trailing';
    committedVisualTextRef.current = committedVisualText;
    setPendingCommittedVisual(true);
  };

  const cancelProjectionClear = () => {
    clearAfterProjectionRef.current = false;
    refocusAfterProjectionRef.current = false;
    committedVisualTextRef.current = '';
    setPendingCommittedVisual(false);
  };

  const pendingBufferedText = (view: EditorView) => {
    if (eagerBufferRef.current.length > 0) return eagerBufferRef.current;
    const text = getEditorText(view);
    const committedText = committedVisualTextRef.current;
    return committedText && text.startsWith(committedText)
      ? text.slice(committedText.length)
      : text;
  };

  const finishProjectionClear = (view: EditorView, shouldRefocus: boolean) => {
    const bufferedText = pendingBufferedText(view);
    clearCommittedEditor(view, updateHasContent);
    eagerBufferRef.current = '';
    committedVisualTextRef.current = '';
    if (bufferedText.length > 0) {
      replaceEditorText(view, bufferedText);
      updateHasContent(true);
      shouldRefocus = true;
    }
    setPendingCommittedVisual(false);
    if (shouldRefocus) view.focus();
  };

  const finishProjectionClearIfPending = (view: EditorView | null = viewRef.current) => {
    if (!clearAfterProjectionRef.current || !view || view.isDestroyed) return;
    const shouldRefocus = refocusAfterProjectionRef.current;
    clearAfterProjectionRef.current = false;
    refocusAfterProjectionRef.current = false;
    finishProjectionClear(view, shouldRefocus);
  };

  const consumePendingTextForExternalHandoff = (view: EditorView) => {
    const bufferedText = pendingBufferedText(view);
    eagerBufferRef.current = '';
    committedVisualTextRef.current = '';
    resetEditorContent(view);
    updateHasContent(false);
    return bufferedText;
  };

  const appendCommittingBufferKey = (view: EditorView, key: string) => {
    eagerBufferRef.current += key;
    replaceEditorText(view, eagerBufferRef.current);
    updateHasContent(eagerBufferRef.current.length > 0);
  };

  const removeCommittingBufferKey = (view: EditorView) => {
    if (eagerBufferRef.current.length > 0) {
      eagerBufferRef.current = eagerBufferRef.current.slice(0, -1);
    }
    replaceEditorText(view, eagerBufferRef.current);
    updateHasContent(eagerBufferRef.current.length > 0);
  };

  const createNode = async (parentId: NodeId, text: string) => (
    Promise.resolve(propsRef.current.onCreate(parentId, text))
  );

  const createContentAndContinuation = async (parentId: NodeId, text: string) => {
    if (propsRef.current.onCreateTree) {
      const result = await Promise.resolve(propsRef.current.onCreateTree(parentId, [
        plainTreeNode(text),
        plainTreeNode(''),
      ]));
      const continuationId = commandFocusNodeId(result as CommandOutcome | DocumentProjection | null | void);
      const projection = commandProjection(result);
      const parent = projection?.nodes.find((candidate) => candidate.id === parentId);
      const continuationIndex = continuationId ? parent?.children.indexOf(continuationId) ?? -1 : -1;
      return {
        committed: result != null,
        contentId: continuationIndex > 0 ? parent?.children[continuationIndex - 1] ?? null : null,
        continuationId,
      };
    }
    const contentId = await createNode(parentId, text) ?? null;
    const continuationId = await createNode(parentId, '') ?? null;
    return {
      committed: contentId != null && continuationId != null,
      contentId,
      continuationId,
    };
  };

  const commitContent = async (
    view: EditorView,
    rawText: string,
    continueWithEmpty: boolean,
    focusAfterCommit: CommitFocusTarget = 'none',
    parentOverride?: NodeId,
  ) => {
    if (committingRef.current) return;
    if (!continueWithEmpty && rawText.trim().length === 0) return;
    const targetParentId = parentOverride ?? effectiveParentRef.current;
    committingRef.current = true;
    beginProjectionClear(focusAfterCommit, rawText);
    let committed = false;
    let createdFocusId: NodeId | null = null;
    let createdContentId: NodeId | null = null;
    let continuationId: NodeId | null = null;
    try {
      if (targetParentId !== propsRef.current.parentId) {
        propsRef.current.onExpand?.(targetParentId);
      }
      const hasText = rawText.trim().length > 0;
      if (hasText && continueWithEmpty) {
        const result = await createContentAndContinuation(targetParentId, rawText);
        committed = result.committed;
        createdContentId = result.contentId;
        continuationId = result.continuationId;
        if (focusAfterCommit === 'created') createdFocusId = continuationId;
      } else if (hasText) {
        const nodeId = await createNode(targetParentId, rawText);
        committed = nodeId != null;
        createdContentId = nodeId ?? null;
        if (nodeId != null && focusAfterCommit === 'created') createdFocusId = nodeId;
      } else if (continueWithEmpty) {
        const nodeId = await createNode(targetParentId, '');
        committed = nodeId != null;
        if (nodeId != null && focusAfterCommit === 'created') createdFocusId = nodeId;
      }
      const shouldCommitBuffered = commitEagerBufferAfterSettleRef.current
        && eagerBufferRef.current.trim().length > 0;
      if (committed && postCommitIndentRef.current && createdContentId) {
        propsRef.current.onExpand?.(createdContentId);
        if (continuationId) {
          await propsRef.current.onIndentNode?.(continuationId);
          if (shouldCommitBuffered) {
            const bufferedText = eagerBufferRef.current;
            eagerBufferRef.current = '';
            await propsRef.current.onUpdateCreated?.(continuationId, bufferedText);
            committedVisualTextRef.current = getEditorText(view);
            if (focusEagerBufferAfterSettleRef.current) {
              createdFocusId = continuationId;
            }
          } else {
            createdFocusId = continuationId;
          }
        }
        if (!shouldCommitBuffered) {
          setTrailingParent(createdContentId, depthShiftRef.current + 1);
        }
      }
      if (
        committed
        && shouldCommitBuffered
        && !continuationId
      ) {
        const bufferedText = eagerBufferRef.current;
        const bufferedParentId = postCommitIndentRef.current && createdContentId
          ? createdContentId
          : effectiveParentRef.current;
        eagerBufferRef.current = '';
        const bufferedNodeId = await createNode(bufferedParentId, bufferedText);
        committedVisualTextRef.current = getEditorText(view);
        if (focusEagerBufferAfterSettleRef.current && bufferedNodeId) {
          createdFocusId = bufferedNodeId;
        }
      }
      if (createdFocusId && !skipCreatedFocusAfterCommitRef.current) propsRef.current.onFocusNode?.(createdFocusId);
    } finally {
      if (!committed) {
        cancelProjectionClear();
      }
      postCommitIndentRef.current = false;
      commitEagerBufferAfterSettleRef.current = false;
      focusEagerBufferAfterSettleRef.current = false;
      skipCreatedFocusAfterCommitRef.current = false;
      committingRef.current = false;
      if (committed) {
        finishProjectionClearIfPending(view);
      }
    }
  };

  const createDoneNode = async (view: EditorView, rawText: string) => {
    if (committingRef.current) return;
    const targetParentId = effectiveParentRef.current;
    committingRef.current = true;
    beginProjectionClear('none', rawText);
    let committed = false;
    try {
      const nodeId = await createNode(targetParentId, rawText);
      if (nodeId) {
        await propsRef.current.onToggleCreated?.(nodeId);
        propsRef.current.onFocusNode?.(nodeId);
        committed = true;
      }
    } finally {
      if (!committed) cancelProjectionClear();
      committingRef.current = false;
      if (committed) finishProjectionClearIfPending(view);
    }
  };

  const createNodeAndFocusDescription = async (view: EditorView, rawText: string) => {
    if (committingRef.current || rawText.trim().length === 0 || !propsRef.current.onFocusDescription) return;
    const targetParentId = effectiveParentRef.current;
    committingRef.current = true;
    beginProjectionClear('none', rawText);
    let committed = false;
    try {
      const nodeId = await createNode(targetParentId, rawText);
      if (nodeId) {
        propsRef.current.onFocusDescription(nodeId, targetParentId);
        committed = true;
      }
    } finally {
      if (!committed) cancelProjectionClear();
      committingRef.current = false;
      if (committed) finishProjectionClearIfPending(view);
      resetEffectiveParent();
    }
  };

  const createField = (view: EditorView) => {
    if (committingRef.current || !propsRef.current.onCreateField) return;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    void Promise.resolve(propsRef.current.onCreateField(effectiveParentRef.current))
      .finally(() => {
        committingRef.current = false;
      });
  };

  const openTrailingTrigger = (
    view: EditorView,
    triggerKind: EditorTrigger['kind'],
    textOffset: number,
  ) => {
    const text = getEditorText(view);
    const from = Math.max(0, text.lastIndexOf(triggerKind));
    const to = Math.max(from + 1, Math.min(textOffset, text.length));
    setTrailingTrigger({
      anchor: caretAnchor(view),
      from,
      kind: triggerKind,
      query: text.slice(from + 1, to),
      to,
    });
  };

  const closeTrailingTrigger = () => {
    if (trailingTriggerRef.current) setTrailingTrigger(null);
  };

  const beginInlineTriggerCommit = (committedVisualText: string) => {
    committingRef.current = true;
    beginProjectionClear('none', committedVisualText);
  };

  const finishInlineTriggerCommit = (committed: boolean, view: EditorView) => {
    if (!committed) {
      cancelProjectionClear();
      if (!view.isDestroyed) view.focus();
    }
    committingRef.current = false;
    setTrailingTrigger(null);
    resetEffectiveParent();
    if (committed) finishProjectionClearIfPending(view);
  };

  const applyTrailingTag = async (
    tag: NodeProjection,
    triggerOverride?: TrailingInlineTrigger | null,
  ) => {
    const view = viewRef.current;
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isInlineTrigger(currentTrigger) ? currentTrigger : null);
    if (!view || !trigger || !propsRef.current.onApplyTagTrigger) return null;
    const text = getEditorText(view);
    beginInlineTriggerCommit(text);
    let committed = false;
    try {
      const result = await propsRef.current.onApplyTagTrigger({
        parentId: effectiveParentRef.current,
        tagId: tag.id,
        text,
        trigger,
      });
      committed = Boolean(result);
      return result;
    } finally {
      finishInlineTriggerCommit(committed, view);
    }
  };

  const createTrailingTag = async (
    name: string,
    triggerOverride?: TrailingInlineTrigger | null,
  ) => {
    const view = viewRef.current;
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isInlineTrigger(currentTrigger) ? currentTrigger : null);
    if (!view || !trigger || !propsRef.current.onCreateTagTrigger) return null;
    const text = getEditorText(view);
    beginInlineTriggerCommit(text);
    let committed = false;
    try {
      const result = await propsRef.current.onCreateTagTrigger({
        name,
        parentId: effectiveParentRef.current,
        text,
        trigger,
      });
      committed = Boolean(result);
      return result;
    } finally {
      finishInlineTriggerCommit(committed, view);
    }
  };

  const applyTrailingReference = async (
    target: NodeProjection,
    triggerOverride?: TrailingInlineTrigger | null,
  ) => {
    const view = viewRef.current;
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isInlineTrigger(currentTrigger) ? currentTrigger : null);
    if (!view || !trigger || !propsRef.current.onApplyReferenceTrigger) {
      return null;
    }
    const text = getEditorText(view);
    const blockReason = getTreeReferenceBlockReason({
      parentId: effectiveParentRef.current,
      targetId: target.id,
      byId: propsRef.current.index.byId,
    });
    const forceInline = blockReason === 'already_in_parent';
    const createsInlineConversion = !forceInline && triggerOwnsWholeText(text, trigger);
    beginInlineTriggerCommit(text);
    let committed = false;
    try {
      let result = await propsRef.current.onApplyReferenceTrigger({
        parentId: effectiveParentRef.current,
        target,
        text,
        trigger,
        forceInline,
      });
      committed = Boolean(result);
      const nodeId = commandFocusNodeId(result);
      if (createsInlineConversion && nodeId) {
        const parentId = commandFocusParentId(result) ?? effectiveParentRef.current;
        const pendingText = consumePendingTextForExternalHandoff(view);
        if (pendingText.length > 0) {
          const projection = commandProjection(result);
          const createdNode = projection?.nodes.find((node) => node.id === nodeId);
          if (createdNode) {
            const patched = await propsRef.current.run(
              () => api.replaceNodeText(nodeId, {
                ...createdNode.content,
                text: pendingText,
              }),
              { applyFocus: false },
            );
            const patchedProjection = commandProjection(patched);
            if (patchedProjection) {
              result = {
                projection: patchedProjection,
                focus: {
                  nodeId,
                  parentId,
                  selectAll: false,
                  placement: {
                    kind: 'text-offset',
                    offset: pendingText.length,
                    inlineRefBias: 'after',
                  },
                },
              };
            }
          }
        }
        propsRef.current.onReferenceConversionCreated?.({
          nodeId,
          parentId,
          targetId: target.id,
        });
      }
      return result;
    } finally {
      finishInlineTriggerCommit(committed, view);
    }
  };

  const executeTrailingSlashCommand = async (
    commandId: SlashCommandId,
    triggerOverride?: TrailingSlashTrigger | null,
  ) => {
    const view = viewRef.current;
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isSlashTrigger(currentTrigger)
      ? currentTrigger
      : null);
    if (!view || !trigger) return null;

    if (commandId === 'reference') {
      replaceEditorTextRange(view, trigger.from, trigger.to, '@');
      setTrailingTrigger({
        anchor: caretAnchor(view) ?? trigger.anchor,
        from: trigger.from,
        kind: '@',
        query: '',
        to: trigger.from + 1,
      });
      return propsRef.current.index.projection;
    }

    if (commandId === 'command_palette') {
      replaceEditorTextRange(view, trigger.from, trigger.to, '');
      setTrailingTrigger(null);
      propsRef.current.onOpenCommandPalette?.();
      return propsRef.current.index.projection;
    }

    // Image insertion is an in-row slash command only; the trailing "new row"
    // affordance does not offer it.
    if (commandId === 'image') return null;

    if (!propsRef.current.onExecuteSlashTrigger) return null;
    const text = getEditorText(view);
    beginInlineTriggerCommit(text);
    let committed = false;
    try {
      const result = await propsRef.current.onExecuteSlashTrigger({
        commandId,
        parentId: effectiveParentRef.current,
        text,
        trigger,
      });
      committed = Boolean(result);
      return result;
    } finally {
      finishInlineTriggerCommit(committed, view);
    }
  };

  const closeOptions = () => {
    setOptionsOpen(false);
    setOptionsQuery('');
    setOptionsIndex(0);
  };

  const selectOption = (view: EditorView, optionId: NodeId) => {
    if (committingRef.current || !propsRef.current.onSelectOption) return;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    closeOptions();
    void Promise.resolve(propsRef.current.onSelectOption(optionId))
      .finally(() => {
        committingRef.current = false;
      });
  };

  const createOption = (view: EditorView) => {
    const name = optionsStateRef.current.optionsQuery.trim();
    if (committingRef.current || !name || !propsRef.current.onCreateOption) return;
    committingRef.current = true;
    resetEditorContent(view);
    updateHasContent(false);
    closeOptions();
    void Promise.resolve(propsRef.current.onCreateOption(name))
      .finally(() => {
        committingRef.current = false;
      });
  };

  const indentEffectiveParent = () => {
    const currentParentId = effectiveParentRef.current;
    const children = propsRef.current.index.byId.get(currentParentId)?.children ?? [];
    const lastChildId = children.filter((childId) => propsRef.current.index.byId.has(childId)).at(-1);
    if (!lastChildId) return;
    setTrailingParent(lastChildId, depthShiftRef.current + 1);
    refocusTrailingEditorSoon();
  };

  const indentedParentForCurrentScope = () => {
    const currentParentId = effectiveParentRef.current;
    const children = propsRef.current.index.byId.get(currentParentId)?.children ?? [];
    return children.filter((childId) => propsRef.current.index.byId.has(childId)).at(-1) ?? null;
  };

  const commitTextAsIndentedChild = async (view: EditorView) => {
    const text = getEditorText(view);
    if (text.trim().length === 0) return false;
    const targetParentId = indentedParentForCurrentScope();
    if (!targetParentId) return false;
    propsRef.current.onExpand?.(targetParentId);
    await commitContent(view, text, false, 'created', targetParentId);
    return true;
  };

  const outdentEffectiveParent = () => {
    if (effectiveParentRef.current === propsRef.current.parentId || depthShiftRef.current <= 0) return;
    const parentId = propsRef.current.index.byId.get(effectiveParentRef.current)?.parentId;
    if (!parentId) return;
    setTrailingParent(parentId, Math.max(0, depthShiftRef.current - 1));
    refocusTrailingEditorSoon();
  };

  const focusLastVisible = () => {
    const target = lastVisibleDescendant(effectiveParentRef.current, propsRef.current.index, propsRef.current.expanded);
    if (target) {
      propsRef.current.onFocusNode?.(target);
      return true;
    }
    return false;
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const rememberPendingFocusTarget = (event: PointerEvent) => {
      if (!committingRef.current) return;
      if (event.target instanceof Node && !mount.contains(event.target)) {
        skipCreatedFocusAfterCommitRef.current = true;
      }
      const target = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('.ProseMirror')
        : null;
      if (target) {
        skipCreatedFocusAfterCommitRef.current = true;
      }
    };
    document.addEventListener('pointerdown', rememberPendingFocusTarget, true);

    const view = new EditorView(mount, {
      state: EditorState.create({
        schema: pmSchema,
        doc: emptyDoc(),
      }),
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (!transaction.docChanged) return;

        const text = getEditorText(view);
        updateHasContent(text.length > 0);
        if (committingRef.current) return;

        const optionState = optionsStateRef.current;
        const action = resolveTrailingRowUpdateAction({
          text,
          isOptionsField: optionState.isOptionsField,
        });
        if (action.type === 'create_field') {
          createField(view);
          return;
        }
        if (action.type === 'open_trigger') {
          closeOptions();
          openTrailingTrigger(view, action.trigger, action.textOffset);
          return;
        }
        if (action.type === 'open_options') {
          closeTrailingTrigger();
          setOptionsOpen(true);
          setOptionsQuery(action.query);
          return;
        }
        if (action.type === 'close_options') {
          closeOptions();
        }
        closeTrailingTrigger();
      },
      handleDOMEvents: {
        paste(viewInstance, event) {
          const clipboardEvent = event as ClipboardEvent;

          // Image / media-URL front-matter is classified by the same helper the
          // inline editor uses, so the two stay in lock-step. The trailing input
          // has no selection, and (unlike the inline editor) lets a lone link
          // URL flow into the editor as text, so it ignores the `linkUrl` intent
          // and falls through to the structured path below.
          const mediaPaste = classifyMediaPaste(clipboardEvent.clipboardData, { hasSelection: false });

          const onPasteImages = propsRef.current.onPasteImages;
          if (mediaPaste?.kind === 'images' && onPasteImages) {
            clipboardEvent.preventDefault();
            const parentId = effectiveParentRef.current;
            resetEditorContent(viewInstance);
            updateHasContent(false);
            void readPastedImages(mediaPaste.files).then((images) => onPasteImages(parentId, images));
            return true;
          }

          const onPasteMediaUrl = propsRef.current.onPasteMediaUrl;
          if (mediaPaste?.kind === 'mediaUrl' && onPasteMediaUrl) {
            clipboardEvent.preventDefault();
            const parentId = effectiveParentRef.current;
            resetEditorContent(viewInstance);
            updateHasContent(false);
            void Promise.resolve(onPasteMediaUrl(parentId, mediaPaste.url));
            return true;
          }

          const pastedText = clipboardEvent.clipboardData?.getData('text/plain') ?? '';
          const pastedHtml = clipboardEvent.clipboardData?.getData('text/html') ?? '';

          const parsed = parseClipboardPaste(pastedText, pastedHtml);
          if (parsed.length === 0) return false;
          // Only take over for genuinely structured paste; a single plain line
          // should keep flowing into the trailing editor for further editing.
          const structured =
            pastedText.includes('\n') ||
            parsed.length > 1 ||
            parsed[0].children.length > 0 ||
            parsed[0].type !== undefined;
          if (!structured) return false;

          clipboardEvent.preventDefault();
          if (committingRef.current) return true;
          committingRef.current = true;
          resetEditorContent(viewInstance);
          updateHasContent(false);
          void Promise.resolve(
            propsRef.current.onCreateTree
              ? propsRef.current.onCreateTree(effectiveParentRef.current, parsed)
              : Promise.all(parsed.map((node) => createNode(effectiveParentRef.current, node.content.text))),
          )
            .finally(() => {
              committingRef.current = false;
            });
          return true;
        },
        focus() {
          if (optionsStateRef.current.isOptionsField) {
            setOptionsOpen(true);
            setOptionsQuery('');
            setOptionsIndex(0);
          }
          return false;
        },
        blur(viewInstance, event) {
          composingRef.current = false;
          if (committingRef.current) {
            const relatedTarget = (event as FocusEvent).relatedTarget;
            const explicitFocusTarget = relatedTarget instanceof HTMLElement
              ? relatedTarget.closest<HTMLElement>('.ProseMirror')
                ?? relatedTarget.closest<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')
              : null;
            if (explicitFocusTarget) {
              skipCreatedFocusAfterCommitRef.current = true;
            }
            const bufferedText = pendingBufferedText(viewInstance);
            if (bufferedText.trim().length > 0) {
              eagerBufferRef.current = bufferedText;
              commitEagerBufferAfterSettleRef.current = true;
              refocusAfterProjectionRef.current = false;
            }
            return false;
          }
          if (clearAfterProjectionRef.current) return false;
          const text = getEditorText(viewInstance);
          if (text.trim().length > 0) {
            void commitContent(viewInstance, text, false, 'none').then(resetEffectiveParent);
            return false;
          }
          updateHasContent(false);
          closeTrailingTrigger();
          closeOptions();
          resetEffectiveParent();
          return false;
        },
        compositionstart() {
          composingRef.current = true;
          return false;
        },
        compositionend(viewInstance) {
          composingRef.current = false;
          queueMicrotask(() => {
            if (committingRef.current || viewInstance.isDestroyed) return;
            const text = getEditorText(viewInstance);
            updateHasContent(text.length > 0);
            const optionState = optionsStateRef.current;
            const action = resolveTrailingRowUpdateAction({
              text,
              isOptionsField: optionState.isOptionsField,
            });
            if (action.type === 'open_options') {
              closeTrailingTrigger();
              setOptionsOpen(true);
              setOptionsQuery(action.query);
            } else if (action.type === 'close_options') {
              closeOptions();
              closeTrailingTrigger();
            } else if (action.type === 'open_trigger') {
              closeOptions();
              openTrailingTrigger(viewInstance, action.trigger, action.textOffset);
            } else {
              closeTrailingTrigger();
            }
          });
          return false;
        },
      },
      handleKeyDown(viewInstance, event) {
        if (isImeComposingEvent(event) || composingRef.current) return false;
        if (committingRef.current) {
          if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            if (!event.shiftKey) {
              postCommitIndentRef.current = true;
              const bufferedText = pendingBufferedText(viewInstance);
              if (bufferedText.trim().length > 0) {
                eagerBufferRef.current = bufferedText;
                commitEagerBufferAfterSettleRef.current = true;
                focusEagerBufferAfterSettleRef.current = true;
                refocusAfterProjectionRef.current = false;
              }
              resetEditorContent(viewInstance);
              updateHasContent(false);
              setPendingCommittedVisual(false);
            }
            return true;
          }
          if (isPlainPrintableKey(event)) {
            event.preventDefault();
            appendCommittingBufferKey(viewInstance, event.key);
            if (postCommitIndentRef.current) {
              commitEagerBufferAfterSettleRef.current = true;
              focusEagerBufferAfterSettleRef.current = true;
              refocusAfterProjectionRef.current = false;
            }
          } else if (event.key === 'Backspace') {
            event.preventDefault();
            removeCommittingBufferKey(viewInstance);
            if (postCommitIndentRef.current) {
              commitEagerBufferAfterSettleRef.current = eagerBufferRef.current.trim().length > 0;
              focusEagerBufferAfterSettleRef.current = eagerBufferRef.current.trim().length > 0;
              refocusAfterProjectionRef.current = false;
            }
          }
          return true;
        }

        if (matchesShortcutEvent(event, 'trailing.redo')) {
          event.preventDefault();
          propsRef.current.onRedo?.();
          return true;
        }

        if (matchesShortcutEvent(event, 'trailing.undo')) {
          event.preventDefault();
          propsRef.current.onUndo?.();
          return true;
        }

        if (matchesShortcutEvent(event, 'trailing.checkbox')) {
          event.preventDefault();
          void createDoneNode(viewInstance, getEditorText(viewInstance));
          return true;
        }

        if (
          matchesShortcutEvent(event, 'trailing.description')
          && getEditorText(viewInstance).trim().length > 0
        ) {
          event.preventDefault();
          void createNodeAndFocusDescription(viewInstance, getEditorText(viewInstance));
          return true;
        }

        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const text = getEditorText(viewInstance);
          const intent = resolveTrailingRowEnterIntent({
            continueOnText: propsRef.current.continueOnEnter === true,
            hasText: text.trim().length > 0,
            optionsOpen: optionsStateRef.current.optionsOpen,
            optionCount: optionsStateRef.current.optionCount,
          });
          if (intent === 'options_confirm') {
            const optionState = optionsStateRef.current;
            const option = optionState.filteredOptions[optionState.optionsIndex];
            if (option) selectOption(viewInstance, option.id);
            else if (optionState.canCreateOption) createOption(viewInstance);
            return true;
          }
          void commitContent(
            viewInstance,
            text,
            intent === 'create_content_and_continue' || intent === 'create_empty',
            intent === 'create_content_and_continue' || intent === 'create_empty' ? 'created' : 'trailing',
          );
          return true;
        }

        if (event.key === 'Tab') {
          event.preventDefault();
          if (event.shiftKey) outdentEffectiveParent();
          else {
            const text = getEditorText(viewInstance);
            if (text.trim().length > 0) {
              void commitTextAsIndentedChild(viewInstance);
            } else {
              indentEffectiveParent();
            }
          }
          return true;
        }

        if (event.key === 'Backspace') {
          const text = getEditorText(viewInstance);
          const currentParentId = effectiveParentRef.current;
          const parentChildCount = propsRef.current.index.byId.get(currentParentId)?.children.length ?? 0;
          const target = lastVisibleDescendant(currentParentId, propsRef.current.index, propsRef.current.expanded);
          const intent = resolveTrailingRowBackspaceIntent({
            isEditorEmpty: text.length === 0,
            depthShifted: currentParentId !== propsRef.current.parentId,
            parentChildCount,
            hasLastVisibleTarget: Boolean(target),
          });

          if (intent === 'allow_default') return false;
          event.preventDefault();
          if (intent === 'reset_depth_shift') {
            resetEffectiveParent();
            return true;
          }
          if (intent === 'collapse_parent') {
            propsRef.current.onCollapseNode?.(currentParentId);
            propsRef.current.onFocusNode?.(currentParentId);
            return true;
          }
          if (intent === 'focus_last_visible' && target) {
            propsRef.current.onFocusNode?.(target);
          }
          return true;
        }

        if (event.key === 'ArrowUp') {
          const intent = resolveTrailingRowArrowUpIntent({
            hasLastVisibleTarget: Boolean(lastVisibleDescendant(effectiveParentRef.current, propsRef.current.index, propsRef.current.expanded)),
            hasNavigateOut: Boolean(propsRef.current.onNavigateOut),
            optionsOpen: optionsStateRef.current.optionsOpen,
            optionCount: optionsStateRef.current.optionCount,
          });
          if (intent === 'options_up') {
            event.preventDefault();
            setOptionsIndex((current) => Math.max(0, current - 1));
            return true;
          }
          if (intent === 'focus_last_visible') {
            event.preventDefault();
            focusLastVisible();
            return true;
          }
          if (intent === 'navigate_out_up') {
            event.preventDefault();
            propsRef.current.onNavigateOut?.('up');
            return true;
          }
        }

        if (event.key === 'ArrowDown') {
          const intent = resolveTrailingRowArrowDownIntent({
            hasNavigateOut: Boolean(propsRef.current.onNavigateOut),
            optionsOpen: optionsStateRef.current.optionsOpen,
            optionCount: optionsStateRef.current.optionCount,
          });
          if (intent === 'options_down') {
            event.preventDefault();
            setOptionsIndex((current) => Math.min(optionsStateRef.current.optionCount - 1, current + 1));
            return true;
          }
          if (intent === 'navigate_out_down') {
            event.preventDefault();
            propsRef.current.onNavigateOut?.('down');
            return true;
          }
        }

        if (event.key === 'Escape') {
          const intent = resolveTrailingRowEscapeIntent(optionsStateRef.current.optionsOpen);
          if (intent === 'close_options') {
            event.preventDefault();
            closeOptions();
            return true;
          }
          if (intent === 'blur_editor') {
            event.preventDefault();
            viewInstance.dom.blur();
            return true;
          }
        }

        return false;
      },
    });

    viewRef.current = view;
    return () => {
      document.removeEventListener('pointerdown', rememberPendingFocusTarget, true);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    const request = props.focusRequest;
    if (!view || view.isDestroyed || !request) return;
    const target = focusTarget(
      effectiveParentId,
      effectiveParentId,
      props.panelId ?? null,
      'trailing',
    );
    if (!focusTargetMatches(request.target, target)) return;
    view.focus();
    setTrailingSelection(view, request.placement);
    props.onFocusRequestConsumed?.(request);
  }, [effectiveParentId, props.focusRequest, props.onFocusRequestConsumed, props.panelId]);

  const rowInlineIndent = `calc(var(--row-depth) * ${depthShift})`;
  const rowStyle: CSSProperties | undefined = depthShift > 0
    ? ({
      marginLeft: rowInlineIndent,
      '--row-inline-indent': rowInlineIndent,
    } as CSSProperties)
    : undefined;

  return (
    <div
      className="row control trailing-row"
      data-trailing-parent-id={effectiveParentId}
      style={rowStyle}
    >
      <TrailingInputLeading hasContent={hasContent && !pendingCommittedVisual} />
      <div
        ref={mountRef}
        className={`row-editor trailing-editor ${hasContent ? '' : 'is-empty'}`}
        data-placeholder={props.placeholder ?? ''}
      />
      {optionsOpen && isOptionsField && createPortal(
        <PopoverListbox
          ref={optionsMenuRef}
          className="node-picker-popover trailing-options-popover"
          label="Field options"
          style={optionsMenuStyle}
        >
          {optionCount === 0 && <PopoverEmpty>No options</PopoverEmpty>}
          {filteredOptions.map((option, index) => (
            <PopoverListItem
              key={option.id}
              active={index === optionsIndex}
              icon={<PopoverBulletIcon />}
              label={option.label}
              onMouseEnter={() => setOptionsIndex(index)}
              onClick={() => {
                const view = viewRef.current;
                if (view) selectOption(view, option.id);
              }}
            />
          ))}
          {canCreateOption && (
            <PopoverListItem
              active={optionsIndex === filteredOptions.length}
              icon={<PopoverBulletIcon />}
              label={`Create "${optionsQuery.trim()}"`}
              onMouseEnter={() => setOptionsIndex(filteredOptions.length)}
              onClick={() => {
                const view = viewRef.current;
                if (view) createOption(view);
              }}
            />
          )}
        </PopoverListbox>,
        document.body,
      )}
      {trailingTrigger && (
        <TriggerPopover
          trigger={{ nodeId: effectiveParentId, ...trailingTrigger }}
          index={props.index}
          nodeId={effectiveParentId}
          run={props.run}
          close={closeTrailingTrigger}
          clearTriggerText={async () => {}}
          applyTag={isInlineTrigger(trailingTrigger) && trailingTrigger.kind === '#'
            ? (tag) => applyTrailingTag(tag, trailingTrigger)
            : undefined}
          createTagAndApply={isInlineTrigger(trailingTrigger) && trailingTrigger.kind === '#'
            ? (name) => createTrailingTag(name, trailingTrigger)
            : undefined}
          applyReference={isInlineTrigger(trailingTrigger) && trailingTrigger.kind === '@'
            ? (target) => applyTrailingReference(target, trailingTrigger)
            : undefined}
          executeSlashCommand={isSlashTrigger(trailingTrigger)
            ? (commandId) => executeTrailingSlashCommand(commandId, trailingTrigger)
            : undefined}
          enabledSlashCommandIds={['field', 'reference', 'heading', 'checkbox', 'code', 'command_palette']}
          treeReferenceParentId={treeReferenceParentId}
          existingTagIds={[]}
        />
      )}
      <span />
    </div>
  );
}
