import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type {
  CommandOutcome,
  CreateNodeTree,
  DocumentProjection,
  NodeId,
  NodeProjection,
  RichText,
} from '../../api/types';
import { EMPTY_RICH_TEXT } from '../../api/types';
import type {
  CursorPlacement,
  DocumentIndex,
  FocusRequest,
  FocusSurface,
} from '../../state/document';
import { focusTarget } from '../focus/focusModel';
import { RichTextEditor, type EditorSplitPayload } from '../editor/RichTextEditor';
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
import { projectFieldConfig } from '../../../core/configProjection';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { readPastedImages, type PastedImage } from '../interactions/imagePaste';
import { classifyMediaPaste } from '../interactions/clipboardPaste';
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

const PRESERVE_PLACEMENT: CursorPlacement = { kind: 'preserve' };

function isInlineTrigger(trigger: EditorTrigger): trigger is TrailingInlineTrigger {
  return trigger.kind === '#' || trigger.kind === '@';
}

function isSlashTrigger(trigger: EditorTrigger): trigger is TrailingSlashTrigger {
  return trigger.kind === '/';
}

function plainBuffer(text: string): RichText {
  return { ...EMPTY_RICH_TEXT, text };
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
  // The trailing line is a virtual buffer: a local RichText, not a real node,
  // rendered by the single shared editor. `contentRevision` is bumped whenever
  // the buffer is reset/replaced imperatively so the controlled editor re-syncs.
  const [buffer, setBuffer] = useState<RichText>(EMPTY_RICH_TEXT);
  const [contentRevision, setContentRevision] = useState(0);
  const [localFocus, setLocalFocus] = useState<FocusRequest | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  const effectiveParentRef = useRef(props.parentId);
  const depthShiftRef = useRef(0);
  const committingRef = useRef(false);
  const clearAfterProjectionRef = useRef(false);
  const refocusAfterProjectionRef = useRef(false);
  const committedVisualTextRef = useRef('');
  const eagerBufferRef = useRef('');
  const postCommitIndentRef = useRef(false);
  const commitEagerBufferAfterSettleRef = useRef(false);
  const focusEagerBufferAfterSettleRef = useRef(false);
  const skipCreatedFocusAfterCommitRef = useRef(false);
  const trailingTriggerRef = useRef<EditorTrigger | null>(null);
  const bufferRef = useRef<RichText>(EMPTY_RICH_TEXT);
  const localFocusRef = useRef<FocusRequest | null>(null);
  const optionsStateRef = useRef({
    isOptionsField: false,
    optionsOpen: false,
    optionCount: 0,
    filteredOptions: [] as ReturnType<typeof filterFieldOptions>,
    optionsIndex: 0,
    canCreateOption: false,
    optionsQuery: '',
  });
  const optionFieldConfig = props.optionField
    ? projectFieldConfig(props.index.byId, props.optionField)
    : undefined;
  const optionFieldType = optionFieldConfig?.fieldType;
  const isOptionsField = isOptionsFieldType(optionFieldType);
  const allOptions = resolveFieldOptions(props.optionField, props.index.byId);
  const filteredOptions = filterFieldOptions(allOptions, optionsQuery);
  // Options fields always accept free-typed values; auto-collect only governs
  // whether the value joins the reusable option pool (decided in onCreateOption).
  const canCreateOption = isOptionsField
    && optionFieldType === 'options'
    && Boolean(optionsQuery.trim())
    && !allOptions.some((option) => option.label.toLowerCase() === optionsQuery.trim().toLowerCase());
  const optionCount = filteredOptions.length + (canCreateOption ? 1 : 0);
  const trailingText = buffer.text;
  const treeReferenceParentId = trailingTrigger
    && isInlineTrigger(trailingTrigger)
    && trailingTrigger.kind === '@'
    && triggerOwnsWholeText(trailingText, trailingTrigger)
    ? effectiveParentId
    : null;
  const optionsMenuStyle = useAnchoredOverlay(optionsMenuRef, {
    anchorRef: rowRef,
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
  bufferRef.current = buffer;
  localFocusRef.current = localFocus;

  const trailingFocusTarget = focusTarget(
    effectiveParentId,
    effectiveParentId,
    props.panelId ?? null,
    'trailing',
  );

  // --- buffer primitives (replace the old imperative EditorView ops) ---

  const bumpRevision = () => setContentRevision((revision) => revision + 1);

  const getEditorText = () => bufferRef.current.text;

  const setEditorText = (text: string) => {
    const next = plainBuffer(text);
    bufferRef.current = next;
    setBuffer(next);
    bumpRevision();
  };

  const resetEditorContent = () => {
    setEditorText('');
  };

  const replaceEditorTextRange = (fromOffset: number, toOffset: number, replacement: string) => {
    const text = bufferRef.current.text;
    const from = Math.max(0, Math.min(fromOffset, text.length));
    const to = Math.max(from, Math.min(toOffset, text.length));
    setEditorText(text.slice(0, from) + replacement + text.slice(to));
    // Place the caret after the replacement (the editor's content-sync effect
    // runs before its focus effect, so this placement wins).
    focusEditorSoon({ kind: 'text-offset', offset: from + replacement.length, inlineRefBias: 'after' });
  };

  const focusEditorSoon = (placement: CursorPlacement = PRESERVE_PLACEMENT) => {
    // Build the target from the synchronously-updated effective parent so an
    // imperative refocus right after an indent/outdent targets the new parent.
    setLocalFocus({
      target: focusTarget(
        effectiveParentRef.current,
        effectiveParentRef.current,
        propsRef.current.panelId ?? null,
        'trailing',
      ),
      placement,
    });
  };

  // --- effects ---

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
    resetEditorContent();
    updateHasContent(false);
  }, [props.parentId]);

  useEffect(() => {
    setOptionsIndex(0);
  }, [optionsQuery, optionCount]);

  useLayoutEffect(() => {
    if (!clearAfterProjectionRef.current) return;
    if (committingRef.current) return;
    finishProjectionClearIfPending();
  }, [props.index.projection]);

  // Options-field popover owns Arrow/Enter/Escape while open — mirrors the
  // window capture-phase pattern the trigger popover uses, so navigation does
  // not depend on the shared editor's keymap.
  useEffect(() => {
    if (!optionsOpen || !isOptionsField) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeOptions();
        return;
      }
      const state = optionsStateRef.current;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setOptionsIndex((current) => Math.min(state.optionCount - 1, current + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setOptionsIndex((current) => Math.max(0, current - 1));
        return;
      }
      // Enter
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.optionCount === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const option = state.filteredOptions[state.optionsIndex];
      if (option) selectOption(option.id);
      else if (state.canCreateOption) createOption();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [optionsOpen, isOptionsField]);

  // During an in-flight commit, keystrokes are buffered (eagerBuffer) and shown
  // in place of the just-committed text, then restored once the projection
  // settles. The editor itself is bypassed via a window capture-phase listener
  // (it owns the keymap, so this is how the slot reclaims keys mid-commit).
  useEffect(() => {
    const onKeyDownCapture = (event: globalThis.KeyboardEvent) => {
      if (!committingRef.current) return;
      if (isImeComposingEvent(event)) return;
      if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.shiftKey) {
          postCommitIndentRef.current = true;
          const bufferedText = pendingBufferedText();
          if (bufferedText.trim().length > 0) {
            eagerBufferRef.current = bufferedText;
            commitEagerBufferAfterSettleRef.current = true;
            focusEagerBufferAfterSettleRef.current = true;
            refocusAfterProjectionRef.current = false;
          }
          resetEditorContent();
          updateHasContent(false);
          setPendingCommittedVisual(false);
        }
        return;
      }
      if (isPlainPrintableKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        appendCommittingBufferKey(event.key);
        if (postCommitIndentRef.current) {
          commitEagerBufferAfterSettleRef.current = true;
          focusEagerBufferAfterSettleRef.current = true;
          refocusAfterProjectionRef.current = false;
        }
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        removeCommittingBufferKey();
        if (postCommitIndentRef.current) {
          commitEagerBufferAfterSettleRef.current = eagerBufferRef.current.trim().length > 0;
          focusEagerBufferAfterSettleRef.current = eagerBufferRef.current.trim().length > 0;
          refocusAfterProjectionRef.current = false;
        }
      }
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => window.removeEventListener('keydown', onKeyDownCapture, true);
  }, []);

  // When a commit is in flight and the user clicks away (to another editor or a
  // focusable control), suppress the post-commit refocus of the created node.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!committingRef.current) return;
      const row = rowRef.current;
      if (event.target instanceof Node && row && !row.contains(event.target)) {
        skipCreatedFocusAfterCommitRef.current = true;
      }
      const target = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('.ProseMirror')
        : null;
      if (target && row && !row.contains(target)) {
        skipCreatedFocusAfterCommitRef.current = true;
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  // --- depth shift / effective parent ---

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

  const updateHasContent = (nextHasContent: boolean) => {
    setHasContent((current) => current === nextHasContent ? current : nextHasContent);
  };

  // --- projection-settle commit dance ---

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

  const pendingBufferedText = () => {
    if (eagerBufferRef.current.length > 0) return eagerBufferRef.current;
    const text = getEditorText();
    const committedText = committedVisualTextRef.current;
    return committedText && text.startsWith(committedText)
      ? text.slice(committedText.length)
      : text;
  };

  const finishProjectionClear = (shouldRefocus: boolean) => {
    const bufferedText = pendingBufferedText();
    resetEditorContent();
    updateHasContent(false);
    eagerBufferRef.current = '';
    committedVisualTextRef.current = '';
    setPendingCommittedVisual(false);
    if (bufferedText.length > 0) {
      setEditorText(bufferedText);
      updateHasContent(true);
      // Restore the buffered text with the caret at its end.
      focusEditorSoon({ kind: 'end' });
      return;
    }
    if (shouldRefocus) focusEditorSoon();
  };

  const finishProjectionClearIfPending = () => {
    if (!clearAfterProjectionRef.current) return;
    const shouldRefocus = refocusAfterProjectionRef.current;
    clearAfterProjectionRef.current = false;
    refocusAfterProjectionRef.current = false;
    finishProjectionClear(shouldRefocus);
  };

  const consumePendingTextForExternalHandoff = () => {
    const bufferedText = pendingBufferedText();
    eagerBufferRef.current = '';
    committedVisualTextRef.current = '';
    resetEditorContent();
    updateHasContent(false);
    return bufferedText;
  };

  const appendCommittingBufferKey = (key: string) => {
    eagerBufferRef.current += key;
    setEditorText(eagerBufferRef.current);
    updateHasContent(eagerBufferRef.current.length > 0);
  };

  const removeCommittingBufferKey = () => {
    if (eagerBufferRef.current.length > 0) {
      eagerBufferRef.current = eagerBufferRef.current.slice(0, -1);
    }
    setEditorText(eagerBufferRef.current);
    updateHasContent(eagerBufferRef.current.length > 0);
  };

  // --- node creation ---

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
            committedVisualTextRef.current = getEditorText();
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
        committedVisualTextRef.current = getEditorText();
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
        finishProjectionClearIfPending();
      }
    }
  };

  const createDoneNode = async (rawText: string) => {
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
      if (committed) finishProjectionClearIfPending();
    }
  };

  const createNodeAndFocusDescription = async (rawText: string) => {
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
      if (committed) finishProjectionClearIfPending();
      resetEffectiveParent();
    }
  };

  const createField = () => {
    if (committingRef.current || !propsRef.current.onCreateField) return;
    committingRef.current = true;
    resetEditorContent();
    updateHasContent(false);
    void Promise.resolve(propsRef.current.onCreateField(effectiveParentRef.current))
      .finally(() => {
        committingRef.current = false;
      });
  };

  // --- trigger application (atomic create-and-apply; unchanged commands) ---

  const closeTrailingTrigger = () => {
    if (trailingTriggerRef.current) setTrailingTrigger(null);
  };

  const beginInlineTriggerCommit = (committedVisualText: string) => {
    committingRef.current = true;
    beginProjectionClear('none', committedVisualText);
  };

  const finishInlineTriggerCommit = (committed: boolean) => {
    if (!committed) {
      cancelProjectionClear();
      focusEditorSoon();
    }
    committingRef.current = false;
    setTrailingTrigger(null);
    resetEffectiveParent();
    if (committed) finishProjectionClearIfPending();
  };

  const applyTrailingTag = async (
    tag: NodeProjection,
    triggerOverride?: TrailingInlineTrigger | null,
  ) => {
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isInlineTrigger(currentTrigger) ? currentTrigger : null);
    if (!trigger || !propsRef.current.onApplyTagTrigger) return null;
    const text = getEditorText();
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
      finishInlineTriggerCommit(committed);
    }
  };

  const createTrailingTag = async (
    name: string,
    triggerOverride?: TrailingInlineTrigger | null,
  ) => {
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isInlineTrigger(currentTrigger) ? currentTrigger : null);
    if (!trigger || !propsRef.current.onCreateTagTrigger) return null;
    const text = getEditorText();
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
      finishInlineTriggerCommit(committed);
    }
  };

  const applyTrailingReference = async (
    target: NodeProjection,
    triggerOverride?: TrailingInlineTrigger | null,
  ) => {
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isInlineTrigger(currentTrigger) ? currentTrigger : null);
    if (!trigger || !propsRef.current.onApplyReferenceTrigger) {
      return null;
    }
    const text = getEditorText();
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
        const pendingText = consumePendingTextForExternalHandoff();
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
      finishInlineTriggerCommit(committed);
    }
  };

  const executeTrailingSlashCommand = async (
    commandId: SlashCommandId,
    triggerOverride?: TrailingSlashTrigger | null,
  ) => {
    const currentTrigger = trailingTriggerRef.current;
    const trigger = triggerOverride ?? (currentTrigger && isSlashTrigger(currentTrigger)
      ? currentTrigger
      : null);
    if (!trigger) return null;

    if (commandId === 'reference') {
      replaceEditorTextRange(trigger.from, trigger.to, '@');
      setTrailingTrigger({
        anchor: trigger.anchor,
        from: trigger.from,
        kind: '@',
        query: '',
        to: trigger.from + 1,
      });
      return propsRef.current.index.projection;
    }

    if (commandId === 'command_palette') {
      replaceEditorTextRange(trigger.from, trigger.to, '');
      setTrailingTrigger(null);
      propsRef.current.onOpenCommandPalette?.();
      return propsRef.current.index.projection;
    }

    // Image insertion is an in-row slash command only; the trailing "new row"
    // affordance does not offer it.
    if (commandId === 'image') return null;

    if (!propsRef.current.onExecuteSlashTrigger) return null;
    const text = getEditorText();
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
      finishInlineTriggerCommit(committed);
    }
  };

  // --- options field ---

  const closeOptions = () => {
    setOptionsOpen(false);
    setOptionsQuery('');
    setOptionsIndex(0);
  };

  const selectOption = (optionId: NodeId) => {
    if (committingRef.current || !propsRef.current.onSelectOption) return;
    committingRef.current = true;
    resetEditorContent();
    updateHasContent(false);
    closeOptions();
    void Promise.resolve(propsRef.current.onSelectOption(optionId))
      .finally(() => {
        committingRef.current = false;
      });
  };

  const createOption = () => {
    const name = optionsStateRef.current.optionsQuery.trim();
    if (committingRef.current || !name || !propsRef.current.onCreateOption) return;
    committingRef.current = true;
    resetEditorContent();
    updateHasContent(false);
    closeOptions();
    void Promise.resolve(propsRef.current.onCreateOption(name))
      .finally(() => {
        committingRef.current = false;
      });
  };

  // --- structural navigation (depth, last-visible, navigate-out) ---

  const indentEffectiveParent = () => {
    const currentParentId = effectiveParentRef.current;
    const children = propsRef.current.index.byId.get(currentParentId)?.children ?? [];
    const lastChildId = children.filter((childId) => propsRef.current.index.byId.has(childId)).at(-1);
    if (!lastChildId) return;
    setTrailingParent(lastChildId, depthShiftRef.current + 1);
    focusEditorSoon();
  };

  const indentedParentForCurrentScope = () => {
    const currentParentId = effectiveParentRef.current;
    const children = propsRef.current.index.byId.get(currentParentId)?.children ?? [];
    return children.filter((childId) => propsRef.current.index.byId.has(childId)).at(-1) ?? null;
  };

  const commitTextAsIndentedChild = async () => {
    const text = getEditorText();
    if (text.trim().length === 0) return false;
    const targetParentId = indentedParentForCurrentScope();
    if (!targetParentId) return false;
    propsRef.current.onExpand?.(targetParentId);
    await commitContent(text, false, 'created', targetParentId);
    return true;
  };

  const outdentEffectiveParent = () => {
    if (effectiveParentRef.current === propsRef.current.parentId || depthShiftRef.current <= 0) return;
    const parentId = propsRef.current.index.byId.get(effectiveParentRef.current)?.parentId;
    if (!parentId) return;
    setTrailingParent(parentId, Math.max(0, depthShiftRef.current - 1));
    focusEditorSoon();
  };

  const focusLastVisible = () => {
    const target = lastVisibleDescendant(effectiveParentRef.current, propsRef.current.index, propsRef.current.expanded);
    if (target) {
      propsRef.current.onFocusNode?.(target);
      return true;
    }
    return false;
  };

  // --- shared-editor callbacks (edit semantics -> create semantics) ---

  const handleChange = (content: RichText) => {
    bufferRef.current = content;
    setBuffer(content);
    if (committingRef.current) return;
    const text = content.text;
    updateHasContent(text.length > 0);
    if (!optionsStateRef.current.isOptionsField) return;
    const action = resolveTrailingRowUpdateAction({ text, isOptionsField: true });
    if (action.type === 'open_options') {
      closeTrailingTrigger();
      setOptionsOpen(true);
      setOptionsQuery(action.query);
    } else if (action.type === 'close_options') {
      closeOptions();
    }
  };

  const handleTriggerChange = (trigger: EditorTrigger | null) => {
    if (committingRef.current) return;
    // Options fields type free-text queries; `#`/`/` are not triggers there.
    if (optionsStateRef.current.isOptionsField) return;
    if (trigger) closeOptions();
    setTrailingTrigger(trigger);
  };

  const handleFieldTriggerFire = () => {
    if (optionsStateRef.current.isOptionsField) return;
    createField();
  };

  const handleFocus = () => {
    if (optionsStateRef.current.isOptionsField) {
      setOptionsOpen(true);
      setOptionsQuery('');
      setOptionsIndex(0);
    }
  };

  const handleCommit = () => {
    // Fires on blur. Mid-commit blurs buffer their remaining text for replay
    // after the projection settles; otherwise commit any pending text.
    if (committingRef.current) {
      const bufferedText = pendingBufferedText();
      if (bufferedText.trim().length > 0) {
        eagerBufferRef.current = bufferedText;
        commitEagerBufferAfterSettleRef.current = true;
        refocusAfterProjectionRef.current = false;
      }
      return;
    }
    if (clearAfterProjectionRef.current) return;
    // Read the synchronously-updated buffer, not the editor-provided doc: after
    // a commit resets the buffer, the view can still hold the just-committed
    // text for a frame, and reading it here would commit a duplicate.
    const text = getEditorText();
    if (text.trim().length > 0) {
      void commitContent(text, false, 'none').then(resetEffectiveParent);
      return;
    }
    updateHasContent(false);
    closeTrailingTrigger();
    closeOptions();
    resetEffectiveParent();
  };

  const handleEnter = (_payload: EditorSplitPayload) => {
    // The shared editor reports a split; the trailing slot commits the whole
    // line (options confirmation is handled by the options popover capture).
    const text = getEditorText();
    const intent = resolveTrailingRowEnterIntent({
      continueOnText: propsRef.current.continueOnEnter === true,
      hasText: text.trim().length > 0,
      optionsOpen: optionsStateRef.current.optionsOpen,
      optionCount: optionsStateRef.current.optionCount,
    });
    if (intent === 'options_confirm') {
      const state = optionsStateRef.current;
      const option = state.filteredOptions[state.optionsIndex];
      if (option) selectOption(option.id);
      else if (state.canCreateOption) createOption();
      return;
    }
    const continueWithEmpty = intent === 'create_content_and_continue' || intent === 'create_empty';
    void commitContent(text, continueWithEmpty, continueWithEmpty ? 'created' : 'trailing');
  };

  const handleTab = (shiftKey: boolean) => {
    if (committingRef.current) return;
    if (shiftKey) {
      outdentEffectiveParent();
      return;
    }
    const text = getEditorText();
    if (text.trim().length > 0) {
      void commitTextAsIndentedChild();
    } else {
      indentEffectiveParent();
    }
  };

  const handleBackspaceAtStart = () => {
    const currentParentId = effectiveParentRef.current;
    const parentChildCount = propsRef.current.index.byId.get(currentParentId)?.children.length ?? 0;
    const target = lastVisibleDescendant(currentParentId, propsRef.current.index, propsRef.current.expanded);
    const intent = resolveTrailingRowBackspaceIntent({
      isEditorEmpty: getEditorText().length === 0,
      depthShifted: currentParentId !== propsRef.current.parentId,
      parentChildCount,
      hasLastVisibleTarget: Boolean(target),
    });
    if (intent === 'reset_depth_shift') {
      resetEffectiveParent();
      return;
    }
    if (intent === 'collapse_parent') {
      propsRef.current.onCollapseNode?.(currentParentId);
      propsRef.current.onFocusNode?.(currentParentId);
      return;
    }
    if (intent === 'focus_last_visible' && target) {
      propsRef.current.onFocusNode?.(target);
    }
  };

  const handleArrowUpAtStart = () => {
    const intent = resolveTrailingRowArrowUpIntent({
      hasLastVisibleTarget: Boolean(lastVisibleDescendant(effectiveParentRef.current, propsRef.current.index, propsRef.current.expanded)),
      hasNavigateOut: Boolean(propsRef.current.onNavigateOut),
      optionsOpen: optionsStateRef.current.optionsOpen,
      optionCount: optionsStateRef.current.optionCount,
    });
    if (intent === 'focus_last_visible') {
      focusLastVisible();
      return;
    }
    if (intent === 'navigate_out_up') {
      propsRef.current.onNavigateOut?.('up');
    }
  };

  const handleArrowDownAtEnd = () => {
    const intent = resolveTrailingRowArrowDownIntent({
      hasNavigateOut: Boolean(propsRef.current.onNavigateOut),
      optionsOpen: optionsStateRef.current.optionsOpen,
      optionCount: optionsStateRef.current.optionCount,
    });
    if (intent === 'navigate_out_down') {
      propsRef.current.onNavigateOut?.('down');
    }
  };

  const handleEscape = () => {
    const intent = resolveTrailingRowEscapeIntent(optionsStateRef.current.optionsOpen);
    if (intent === 'close_options') {
      closeOptions();
      return;
    }
    // blur_editor
    const dom = rowRef.current?.querySelector<HTMLElement>('.ProseMirror');
    dom?.blur();
  };

  const handlePasteCapture = (event: ClipboardEvent): boolean => {
    // Image / media-URL front-matter classified by the same helper the inline
    // editor uses. The trailing input has no selection, and lets a lone link
    // URL flow into the buffer as text (linkifyPastedUrl={false}), so it ignores
    // the `linkUrl` intent and only takes over for genuinely structured paste.
    const mediaPaste = classifyMediaPaste(event.clipboardData, { hasSelection: false });

    const onPasteImages = propsRef.current.onPasteImages;
    if (mediaPaste?.kind === 'images' && onPasteImages) {
      event.preventDefault();
      const parentId = effectiveParentRef.current;
      resetEditorContent();
      updateHasContent(false);
      void readPastedImages(mediaPaste.files).then((images) => onPasteImages(parentId, images));
      return true;
    }

    const onPasteMediaUrl = propsRef.current.onPasteMediaUrl;
    if (mediaPaste?.kind === 'mediaUrl' && onPasteMediaUrl) {
      event.preventDefault();
      const parentId = effectiveParentRef.current;
      resetEditorContent();
      updateHasContent(false);
      void Promise.resolve(onPasteMediaUrl(parentId, mediaPaste.url));
      return true;
    }

    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    const pastedHtml = event.clipboardData?.getData('text/html') ?? '';
    const parsed = parseClipboardPaste(pastedText, pastedHtml);
    if (parsed.length === 0) return false;
    const structured =
      pastedText.includes('\n') ||
      parsed.length > 1 ||
      parsed[0].children.length > 0 ||
      parsed[0].type !== undefined;
    if (!structured) return false;

    event.preventDefault();
    if (committingRef.current) return true;
    committingRef.current = true;
    resetEditorContent();
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
  };

  const handleFocusRequestConsumed = (request: FocusRequest) => {
    if (request === localFocusRef.current) {
      setLocalFocus(null);
      return;
    }
    propsRef.current.onFocusRequestConsumed?.(request);
  };

  const rowInlineIndent = `calc(var(--row-depth) * ${depthShift})`;
  const rowStyle: CSSProperties | undefined = depthShift > 0
    ? ({
      marginLeft: rowInlineIndent,
      '--row-inline-indent': rowInlineIndent,
    } as CSSProperties)
    : undefined;

  return (
    <div
      ref={rowRef}
      className="row control trailing-row"
      data-trailing-parent-id={effectiveParentId}
      style={rowStyle}
    >
      <TrailingInputLeading hasContent={hasContent && !pendingCommittedVisual} />
      <RichTextEditor
        nodeId={`trailing:${effectiveParentId}`}
        className="trailing-editor"
        content={buffer}
        contentRevision={contentRevision}
        placeholder={props.placeholder}
        linkifyPastedUrl={false}
        focusTarget={trailingFocusTarget}
        focusRequest={localFocus ?? props.focusRequest ?? null}
        onFocusRequestConsumed={handleFocusRequestConsumed}
        onFocus={handleFocus}
        onChange={handleChange}
        onPatch={() => {}}
        onCommit={handleCommit}
        onEnter={handleEnter}
        onBackspaceAtStart={handleBackspaceAtStart}
        onTab={handleTab}
        onArrowUpAtStart={handleArrowUpAtStart}
        onArrowDownAtEnd={handleArrowDownAtEnd}
        onModEnter={() => void createDoneNode(getEditorText())}
        onDescriptionToggle={() => void createNodeAndFocusDescription(getEditorText())}
        onEscape={handleEscape}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        onTriggerChange={handleTriggerChange}
        onFieldTriggerFire={handleFieldTriggerFire}
        onPasteCapture={handlePasteCapture}
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
              onClick={() => selectOption(option.id)}
            />
          ))}
          {canCreateOption && (
            <PopoverListItem
              active={optionsIndex === filteredOptions.length}
              icon={<PopoverBulletIcon />}
              label={`Create "${optionsQuery.trim()}"`}
              onMouseEnter={() => setOptionsIndex(filteredOptions.length)}
              onClick={() => createOption()}
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
