import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { api } from '../../api/client';
import { freshNodeId } from '../../../core/nodeId';
import { formatAssetSourceUri } from '../../../core/source';
import type { OperationUndoGroup } from '../../../outline/contract';
import type {
  AssetMetadata,
  CommandResult,
  ContentBearingNodeProjection,
  CreateNodeTree,
  FocusHint,
  NodeId,
  NodeProjection,
  PasteRowMeta,
  RichText,
  RichTextPatch,
} from '../../api/types';
import {
  EMPTY_RICH_TEXT,
  inlineRefNodeId,
  isContentBearingNode,
  nodeReferenceTarget,
  plainText,
  replaceAllRichTextPatch,
} from '../../api/types';
import { projectFieldTypeById, nodeShowsCheckbox } from '../../../core/configProjection';
import type { CursorPlacement, FocusTarget } from '../../state/document';
import {
  flattenVisibleRows,
  isRowExpanded,
  resolveReferenceTargetId,
  type DocumentIndex,
  type PendingStructuralChange,
  type UiState,
} from '../../state/document';
import { referenceSummaryForIndex } from '../../state/referenceSummary';
import { deriveRowMemoState, rowMemoStateEqual } from '../../state/rowUiState';
import { RichTextEditor, type EditorSplitPayload } from '../editor/RichTextEditor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
  richTextEquals,
} from '../editor/richTextCodec';
import { applyRichTextPatchToContent } from '../editor/richTextPatchApply';
import { CoalescedTextPatchQueue } from '../editor/coalescedTextPatchQueue';
import { indentTargetParentId, previousVisibleRowId } from '../interactions/outlinerStructure';
import { resolveDropHoverPosition, type DropHoverPosition } from '../interactions/dropPosition';
import { selectVisibleRowsState } from '../interactions/selectionActions';
import { ingestPastedImages, shouldConvertRowToImage, type PastedImage } from '../interactions/imagePaste';
import {
  createAssetNode,
  dataTransferFiles,
  hasFileTransfer,
  ingestFiles,
} from '../interactions/attachmentIngest';
import { getTreeReferenceBlockReason } from '../interactions/referenceRules';
import { resolveFieldOptions, resolveSelectedOptionId, type FieldOption } from '../interactions/fieldOptions';
import { resolveSelectedReferenceShortcut } from '../interactions/selectedReferenceShortcuts';
import {
  resolveContentRowBackspaceAtStartIntent,
  resolveContentRowUpdateAction,
  resolveReferenceSelectionAction,
} from '../interactions/rowInteractions';
import type { SlashCommandId } from '../interactions/slashCommands';
import type {
  CommandRunner,
  CommandRunnerOperationResult,
  CommandRunnerOptions,
  NavigateRootOptions,
  TriggerAnchor,
  TriggerState,
} from '../shared';
import { commandRunnerAbort, commandRunnerNoop, outlinerChildren, parentIdsEmptiedByOutdent, textOf } from '../shared';
import {
  clearFocusRequestState,
  clearFocusState,
  clearPendingInputState,
  cursorAll,
  cursorEnd,
  cursorStart,
  cursorOffset as cursorAtOffset,
  focusTarget,
  focusTargetMatches,
  outlinerNavigationFocusTarget,
  relayCompositionHandoffState,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from '../focus/focusModel';
import { renderedTextRightEdge, resolveTextOffsetFromPoint } from '../interactions/domCaret';
import { TagBar } from '../tags/TagBar';
import { inlineReferenceTextColor, resolveTagColor, tagBulletColors } from '../tags/tagColors';
import { CheckboxFieldControl } from './CheckboxFieldControl';
import { CodeBlockRow } from './CodeBlockRow';
import { TriggerPopover } from './TriggerPopover';
import { DoneCheckbox } from './DoneCheckbox';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { OutlinerRowShell } from './OutlinerRowShell';
import { animateOutlinerRowMovementAfterNextCommit } from './rowMoveAnimation';
import {
  buildOutlinerRows,
  isActiveTableFieldEntry,
  readViewConfig,
  viewDisplayValuesFor,
  type ViewFieldValue,
} from './row-model';
import { draftCreateIndex, previousDraftSiblingId } from '../../state/trailingDraftPlacement';
import { selectableRowForId } from '../../state/selectableRows';
import { RowLeading } from './RowLeading';
import { makeDraftNode } from './draftRow';
import { TrailingOptionsPopover } from './TrailingOptionsPopover';
import { DateValuePicker } from './DateValuePicker';
import type { FieldValueContext } from '../fields/fieldValueEditors';
import {
  fieldValueOpenHref,
  validateFieldValue,
} from '../fields/fieldValueValidation';
import { CalendarIcon, ICON_SIZE, OpenIcon, WarningIcon } from '../icons';
import {
  createPlaceholderInlineField,
  createPlaceholderInlineFieldAfterNode,
  fieldDefinitionIdFromInlineFieldOutcome,
  referenceTriggerFromSlash,
  triggerOwnsWholeText,
} from './trailingTriggers';
import {
  announceDropTarget,
  DROP_TARGET_CHANGE_EVENT,
  useOutlinerRowInteraction,
} from './useOutlinerRowInteraction';
import { ButtonControl } from '../primitives/ButtonControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import {
  PopoverBulletIcon,
  PopoverListbox,
  PopoverListItem,
} from './PopoverList';
import { noteOutlinerItemRender } from './renderProbe';
import { useT } from '../../i18n/I18nProvider';
import { usePopoverSelection } from './usePopoverSelection';
import { OutlineSourcePreview, SourcePreviewAffordance } from '../preview/NodeSourcesSection';
import {
  addOptimisticRemovals,
  clearOptimisticRemovals,
  latestOptimisticStructuralDependency,
  optimisticMergedNode,
  optimisticReplacementAnchors,
  startOptimisticStructuralEdit,
  startOptimisticRelocation,
  startOptimisticRemoval,
  type BeginOptimisticStructuralEditInput,
} from './optimisticStructuralEdit';
import {
  nodeWithPendingPatch,
  optimisticTagPatch,
  pendingNodePatch,
  startOptimisticDoneTransition,
  startOptimisticNodePatch,
} from './optimisticNodePatch';

const TEXT_EDIT_UNDO_GROUP_FLUSH_MS = 700;

interface OutlinerItemProps {
  panelId: string;
  nodeId: NodeId;
  parentId: NodeId;
  rootId: NodeId;
  selectionRootId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  depth: number;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  ui: UiState;
  // Always-current ui (stable ref) for handlers; see useOutlinerRowInteraction.
  uiRef: MutableRefObject<UiState>;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  onTogglePin: (nodeId: NodeId) => void;
  referencePath: readonly NodeId[];
  optionField?: NodeProjection;
  onSelectOption?: (
    optionId: NodeId,
    id?: NodeId,
  ) => Promise<CommandRunnerOperationResult>;
  // Field-value editing context: present only when this row renders a field's
  // value (not body content). It makes the row create/select through the field
  // command set and, for optionPicker fields, mounts the options popover.
  fieldValue?: FieldValueContext;
  // Eager materialization: when true, this row's node is not in the projection
  // yet — it is the trailing draft. The first committed text materializes it
  // under `nodeId` (kept stable so the editor is never remounted), after which
  // the row is rendered like any other content row.
  draft?: boolean;
  // Optional visual anchor for a relocated trailing draft. When present, the
  // draft sits after this sibling and materializes at the same structural index.
  draftAfterId?: NodeId | null;
  optimisticChange?: PendingStructuralChange;
  // Empty-state placeholder shown on this trailing draft's editor (definition
  // template / options blocks), so an empty section reads "add here" instead of
  // a lone label over a near-invisible ghost bullet. Ignored once materialized.
  draftPlaceholder?: string;
  semanticRole?: 'treeitem' | 'presentation';
  hideDisplayFields?: boolean;
  suppressChildFieldEntries?: boolean;
  outlineSourcePreviewKey?: string;
  tableNextRowId?: NodeId | null;
  onDisclosureToggleAnchor?: (anchorElement: HTMLElement | null) => void;
}

function commandResultWithFocus(result: CommandResult, focus: Omit<FocusHint, 'selectAll'>): CommandResult {
  return { ...result, focus: { ...focus, selectAll: false } };
}

function OutlinerItemImpl(props: OutlinerItemProps) {
  noteOutlinerItemRender();
  const t = useT();
  const tf = t.outliner.field;
  const realNodeCandidate = props.index.byId.get(props.nodeId);
  const realNode = realNodeCandidate && isContentBearingNode(realNodeCandidate)
    ? realNodeCandidate
    : undefined;
  const parentNode = props.index.byId.get(props.parentId);
  // A draft row synthesizes an empty plain node so the normal render path runs;
  // `realNode` distinguishes "not materialized yet" from a real node.
  const optimisticContent = props.optimisticChange?.latestContent.current;
  const projectedOrDraftNode = props.optimisticChange?.nodeOverride?.current ?? realNode ?? (props.draft
    ? makeDraftNode(props.nodeId, props.parentId, optimisticContent ?? EMPTY_RICH_TEXT)
    : undefined);
  const structuralNode = projectedOrDraftNode && props.optimisticChange?.presentation === 'codeBlock'
    ? {
        ...projectedOrDraftNode,
        type: 'codeBlock' as const,
        content: optimisticContent ?? projectedOrDraftNode.content,
        codeLanguage: '',
      }
    : projectedOrDraftNode;
  const node = structuralNode
    ? nodeWithPendingPatch(structuralNode, props.ui.pendingNodePatches.get(structuralNode.id))
    : structuralNode;
  const [draftContent, setDraftContent] = useState<RichText>(node?.content ?? EMPTY_RICH_TEXT);
  const [draftContentRevision, setDraftContentRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // An optionPicker field-value draft uses the editor as the free-text filter for
  // the additive options popover. Open on focus; typed text drives the query.
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Date value rows summon their picker overlay additively (Space / calendar
  // affordance); it is never a separate editing mode.
  const [dateOverlayOpen, setDateOverlayOpen] = useState(false);
  const draftContentRef = useRef<RichText>(node?.content ?? EMPTY_RICH_TEXT);
  const localDraftSyncRef = useRef<{ nodeId: NodeId; content: RichText } | null>(null);
  const pendingTextPatchRef = useRef<Promise<unknown>>(Promise.resolve());
  const textPatchQueueRef = useRef<CoalescedTextPatchQueue | null>(null);
  if (!textPatchQueueRef.current) textPatchQueueRef.current = new CoalescedTextPatchQueue();
  const textPatchQueue = textPatchQueueRef.current;
  // Guards materialization so the create fires exactly once per draft. A second
  // caller shares the in-flight result, so it can stop its dependent command when
  // the create is rejected without starting another create.
  const materializeStartedRef = useRef(false);
  const materializePromiseRef = useRef<Promise<boolean> | null>(null);
  const materializedFieldParentIdRef = useRef<NodeId | null>(null);
  const materializedTextUndoGroupRef = useRef<OperationUndoGroup | null>(null);
  const materializedTextUndoGroupFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous mirror of the active trigger, set by onTriggerChange *before* the
  // patch callback runs in the same editor transaction (props.trigger is React
  // state and lags one render). applyTextPatch reads it to decide whether a body
  // draft eager-materializes (normal typing) or stays buffered (a #/@/`/`/`>` query
  // resolving atomically).
  const draftTriggerActiveRef = useRef(false);
  const semanticTriggerResolutionRef = useRef(false);
  const restoredReferenceConversionNodeRef = useRef<NodeId | null>(null);
  const descriptionReturnPlacementRef = useRef<CursorPlacement>(cursorEnd());
  const optionAnchorRef = useRef<HTMLDivElement | null>(null);
  const clearMaterializedTextUndoGroup = () => {
    if (materializedTextUndoGroupFlushRef.current) {
      clearTimeout(materializedTextUndoGroupFlushRef.current);
      materializedTextUndoGroupFlushRef.current = null;
    }
    materializedTextUndoGroupRef.current = null;
  };
  const scheduleMaterializedTextUndoGroupFlush = () => {
    if (!materializedTextUndoGroupRef.current) return;
    if (materializedTextUndoGroupFlushRef.current) clearTimeout(materializedTextUndoGroupFlushRef.current);
    materializedTextUndoGroupFlushRef.current = setTimeout(() => {
      materializedTextUndoGroupFlushRef.current = null;
      materializedTextUndoGroupRef.current = null;
    }, TEXT_EDIT_UNDO_GROUP_FLUSH_MS);
  };
  const materializedTextUndoGroupFor = (nodeId: NodeId): OperationUndoGroup | undefined => {
    const group = materializedTextUndoGroupRef.current;
    return group?.nodeId === nodeId ? group : undefined;
  };
  const referenceTargetId = node?.type === 'reference' && node.targetId
    ? resolveReferenceTargetId(node.targetId, props.index.byId)
    : null;
  const projectedDisplayedCandidate = referenceTargetId ? props.index.byId.get(referenceTargetId) ?? node : node;
  const projectedDisplayed = projectedDisplayedCandidate && isContentBearingNode(projectedDisplayedCandidate)
    ? projectedDisplayedCandidate
    : undefined;
  const displayed = projectedDisplayed
    ? nodeWithPendingPatch(projectedDisplayed, props.ui.pendingNodePatches.get(projectedDisplayed.id))
    : projectedDisplayed;
  const childParentId = referenceTargetId ?? props.nodeId;
  const childParentNode = childParentId === node?.id
    ? node
    : props.index.byId.get(childParentId);
  const referenceCycle = node?.type === 'reference'
    && Boolean(referenceTargetId)
    && props.referencePath.includes(childParentId);
  const rowScopeChildIds = referenceCycle ? [] : outlinerChildren(childParentNode, props.index.byId).filter((childId) => {
    const child = props.index.byId.get(childId);
    if (!child || !isContentBearingNode(child)) return false;
    return !props.suppressChildFieldEntries || !isActiveTableFieldEntry(child, props.index.byId);
  });
  const rowChildIds = rowScopeChildIds.filter((childId) => (
    props.index.byId.get(childId)?.type !== 'fieldEntry'
  ));
  const firstContentChildId = rowChildIds[0];
  const firstContentChildIndex = firstContentChildId
    ? childParentNode?.children.indexOf(firstContentChildId) ?? -1
    : -1;
  const parentView = readViewConfig(parentNode, props.index.byId);
  const referenceSummary = referenceSummaryForIndex(props.index);
  const displayValues = realNode && displayed && !props.draft && !props.fieldValue
    ? viewDisplayValuesFor(displayed, parentView, props.index.byId, { referenceSummary })
    : [];
  const trailingDraftOrigin = props.draft === true
    && !realNode
    && (!props.optimisticChange || props.optimisticChange.originatesFromDraft === true);
  const exposesTrailingDraftMarker = trailingDraftOrigin
    && (!props.optimisticChange || props.optimisticChange.retainsTrailingDraftMarker === true);
  const ordinaryTrailingDraft = trailingDraftOrigin && !props.optimisticChange;
  const row = useOutlinerRowInteraction({
    rowId: props.nodeId,
    parentId: props.parentId,
    childParentId,
    panelId: props.panelId,
    rootId: props.rootId,
    selectionRootId: props.selectionRootId,
    depth: props.depth,
    childIds: rowChildIds,
    index: props.index,
    ui: props.ui,
    uiRef: props.uiRef,
    setUi: props.setUi,
    run: props.run,
    locked: node?.locked ?? true,
    dragId: props.dragId,
    setDragId: props.setDragId,
    draft: ordinaryTrailingDraft,
    draftAfterId: props.draftAfterId,
  });
  // A not-yet-materialized draft is also "focused" when keyboard navigation
  // targets the parent's trailing surface (the existing trailing-focus signal);
  // once the editor takes focus, onFocus settles it to this row's own id.
  const trailingDraftFocused = ordinaryTrailingDraft
    && props.ui.focusedId === props.parentId
    && props.ui.focusSurface === 'trailing'
    && props.ui.focusedPanelId === props.panelId;
  const rowEditorFocused = (props.ui.focusedId === props.nodeId
    && props.ui.focusSurface === 'row'
    && props.ui.focusedPanelId === props.panelId)
    || trailingDraftFocused;

  useLayoutEffect(() => {
    const nextContent = displayed?.content ?? EMPTY_RICH_TEXT;
    if (textPatchQueue.isBusy()) return;
    const pendingLocalDraft = localDraftSyncRef.current;
    if (pendingLocalDraft) {
      if (pendingLocalDraft.nodeId !== displayed?.id) {
        localDraftSyncRef.current = null;
      } else if (richTextEquals(nextContent, pendingLocalDraft.content)) {
        localDraftSyncRef.current = null;
      } else {
        return;
      }
    }
    if (rowEditorFocused) return;
    draftContentRef.current = nextContent;
    setDraftContent(nextContent);
  }, [displayed?.id, displayed?.content, displayed?.type === 'reference' ? displayed.targetId : undefined, rowEditorFocused]);

  useLayoutEffect(() => {
    const change = props.optimisticChange;
    if (!change) return;
    const content = change.latestContent.current;
    const refMatches = richTextEquals(draftContentRef.current, content);
    const stateMatches = richTextEquals(draftContent, content);
    if (refMatches && stateMatches) return;
    const editId = referenceTargetId ?? node?.id ?? props.nodeId;
    localDraftSyncRef.current = { nodeId: editId, content };
    draftContentRef.current = content;
    if (!stateMatches) setDraftContent(content);
    setDraftContentRevision((revision) => revision + 1);
  }, [draftContent, props.optimisticChange]);

  useEffect(() => () => {
    if (materializedTextUndoGroupFlushRef.current) {
      clearTimeout(materializedTextUndoGroupFlushRef.current);
      materializedTextUndoGroupFlushRef.current = null;
    }
  }, []);

  if (!node || !displayed) return null;

  const replaceLocalDraftContent = (content: RichText) => {
    if (props.optimisticChange) {
      props.optimisticChange.latestContent.current = content;
      if (props.optimisticChange.nodeOverride) {
        props.optimisticChange.nodeOverride.current = {
          ...props.optimisticChange.nodeOverride.current,
          content,
        };
      }
    }
    localDraftSyncRef.current = { nodeId: targetEditId, content };
    draftContentRef.current = content;
    setDraftContent(content);
    setDraftContentRevision((revision) => revision + 1);
  };

  const targetEditId = referenceTargetId ?? node.id;
  const drillDownId = referenceTargetId ?? node.id;
  const startDoneTransition = (
    transition: 'toggle' | 'cycle',
    command: () => Promise<CommandRunnerOperationResult>,
  ) => startOptimisticDoneTransition({
    index: props.index,
    node: displayed,
    currentUi: props.uiRef.current,
    setUi: props.setUi,
    transition,
    command,
  });
  // Field-value editing flags. A field value's trailing draft is NOT a separate
  // editing mode: it materializes through the same materializeDraft path as a body
  // node, differing only in WHICH create command runs (injected via
  // props.fieldValue.materializeValue). The draft buffers text until commit
  // (Enter/blur) so the create sees the full text — this lets core dedup a typed
  // value against an existing pool option in one shot, instead of per keystroke.
  const fieldValueDraft = Boolean(props.fieldValue) && props.draft === true && !realNode;
  const virtualFieldValueDraft = fieldValueDraft && !props.fieldValue?.entryId;
  const runClaimedVirtualFieldMaterialization = async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    if (!virtualFieldValueDraft || materializeStartedRef.current) return null;
    materializeStartedRef.current = true;
    try {
      const result = await operation();
      if (result === null) materializeStartedRef.current = false;
      return result;
    } catch (error) {
      materializeStartedRef.current = false;
      throw error;
    }
  };
  const fieldDescriptor = props.fieldValue?.descriptor;
  const checkboxFieldValue = Boolean(props.fieldValue && fieldDescriptor?.isWholeFieldControl);
  // An options field's draft shows the additive options overlay and treats free
  // text as the filter query, so #/@// and the code fence are plain text there.
  const optionPickerDraft = fieldValueDraft && fieldDescriptor?.interaction === 'optionPicker';
  const suppressTextTriggers = optionPickerDraft;
  // A date field value (draft or committed) is an editable row that additively
  // offers a calendar overlay; Space on an empty value summons it.
  const dateFieldValue = Boolean(props.fieldValue) && fieldDescriptor?.interaction === 'datePicker';
  const editorFocusTarget = rowFocusTarget(props.nodeId, props.parentId, props.panelId);
  // A not-yet-materialized draft consumes the parent's trailing focus request
  // (keyboard nav into the trailing line targets `(parentId, 'trailing')`); once
  // the editor focuses, onFocus settles the signal to this row's own id.
  const editorRequestTarget = ordinaryTrailingDraft
    ? focusTarget(props.parentId, props.parentId, props.panelId, 'trailing')
    : editorFocusTarget;
  const descriptionFocusTarget = focusTarget(props.nodeId, props.parentId, props.panelId, 'description');
  const requestRowFocus = (
    nodeId: NodeId,
    placement: CursorPlacement = cursorEnd(),
    parentId: NodeId | null = props.index.byId.get(nodeId)?.parentId ?? null,
  ) => {
    props.setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(nodeId, parentId, props.panelId),
      placement,
    ));
  };
  const selectRow = (rowId: NodeId, selectionSource: UiState['selectionSource'] = 'ref-click') => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    flushSync(() => {
      props.setUi((prev) => ({
        ...clearFocusState(prev),
        selectedId: rowId,
        selectedIds: new Set([rowId]),
        selectionAnchorId: rowId,
        selectionRootId: props.selectionRootId,
        selectionSource,
      }));
    });
  };
  const selectAllVisibleRows = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    flushSync(() => {
      props.setUi((prev) => selectVisibleRowsState(prev, {
        byId: props.index.byId,
        selectionRootId: props.selectionRootId,
      }));
    });
  };
  const toggleRowDisclosure = (anchorElement?: HTMLElement | null) => {
    props.onDisclosureToggleAnchor?.(anchorElement ?? null);
    row.toggleExpandOrSelect();
  };
  const pendingReferenceConversion = props.ui.pendingReferenceConversion?.nodeId === props.nodeId;
  const leadingVariant = node.type === 'reference' || pendingReferenceConversion
    ? 'reference'
    : displayed.type === 'tagDef'
      ? 'tag'
      : displayed.type === 'fieldDef'
        ? 'fieldDef'
        : 'content';
  const appliedTags = displayed.tags
    .map((tagId) => props.index.byId.get(tagId))
    .filter((tag): tag is NodeProjection => Boolean(tag));
  const appliedTagColors = tagBulletColors(appliedTags, props.index.byId);
  const tagDefColor = leadingVariant === 'tag' ? resolveTagColor(displayed, props.index.byId).text : undefined;
  const showDoneCheckbox = nodeShowsCheckbox(props.index.byId, displayed);
  const descriptionEditing = props.ui.editingDescriptionId === targetEditId;
  const referenceLikeRow = node.type === 'reference' || pendingReferenceConversion;
  const isCodeBlock = displayed.type === 'codeBlock' && !referenceLikeRow;
  // Additive layers on a committed field value: a non-blocking validation hint
  // and (for a well-formed URI / email) an open-link affordance. The hint takes
  // precedence, so malformed input never exposes a broken link.
  const fieldValueText = realNode ? displayed.content.text : '';
  const fieldValueHint = props.fieldValue && fieldDescriptor?.validates && realNode
    ? validateFieldValue(props.fieldValue.fieldType, fieldValueText, props.fieldValue.constraints)
    : null;
  const fieldValueHref = props.fieldValue && fieldDescriptor?.isLink && realNode && !fieldValueHint
    ? fieldValueOpenHref(props.fieldValue.fieldType, fieldValueText)
    : null;
  const showDateTrigger = dateFieldValue && Boolean(realNode);
  const sourcePreviewPlacement = props.fieldValue?.sourcePreviewPlacement;
  const sourcePreviewAction = realNode
    && props.fieldValue
    && sourcePreviewPlacement
    && sourcePreviewPlacement !== 'none' ? (
    <SourcePreviewAffordance
      index={props.index}
      ownerId={props.fieldValue.ownerId}
      valueId={realNode.id}
    />
  ) : null;
  const hasFieldValueAffordances = Boolean(
    props.fieldValue && (showDateTrigger || fieldValueHint || fieldValueHref || sourcePreviewAction),
  );

  // Plain text rows host trailing content INSIDE the editor as one inline widget
  // at the end of the final text block. Tags and ordinary field affordances then
  // follow the last word and wrap with it instead of becoming a separate row.
  // Code and whole-field controls have no compatible inline text surface.
  const isPlainTextRow = !isCodeBlock;
  const hasTags = displayed.tags.length > 0;
  const useInlineContentSlot = isPlainTextRow && !checkboxFieldValue;
  const inlineContentSlotRef = useRef<HTMLSpanElement | null>(null);
  if (
    useInlineContentSlot
    && (hasTags || hasFieldValueAffordances)
    && inlineContentSlotRef.current === null
  ) {
    const el = document.createElement('span');
    el.className = 'row-inline-content-slot';
    el.contentEditable = 'false';
    inlineContentSlotRef.current = el;
  }
  const inlineContentSlot = useInlineContentSlot && (hasTags || hasFieldValueAffordances)
    ? inlineContentSlotRef.current
    : null;
  const [externalFileDropPosition, setExternalFileDropPosition] = useState<DropHoverPosition | null>(null);
  const externalFileDropTargetKey = `${props.panelId}:${props.parentId}:${props.nodeId}:${props.draft ? 'draft' : 'row'}:external-file`;
  const clearExternalFileDropState = () => {
    setExternalFileDropPosition(null);
    announceDropTarget(null);
  };
  useEffect(() => {
    const handleDropTargetChange = (event: Event) => {
      const key = (event as CustomEvent<{ key: string | null }>).detail?.key ?? null;
      if (key !== externalFileDropTargetKey) setExternalFileDropPosition(null);
    };
    window.addEventListener(DROP_TARGET_CHANGE_EVENT, handleDropTargetChange);
    return () => window.removeEventListener(DROP_TARGET_CHANGE_EVENT, handleDropTargetChange);
  }, [externalFileDropTargetKey]);
  // ProseMirror owns focused text between projection settlements. Read the live
  // ref when a pending structural change clears so the editor never falls back
  // to the React snapshot from before materialization and resets the caret.
  const renderedDraftContent = referenceTargetId
    ? displayed.content
    : props.optimisticChange?.latestContent.current ?? draftContentRef.current;
  const editorContentRevision = pendingReferenceConversion
    ? displayed.updatedAt
    : props.optimisticChange
      ? textRenderRevision(JSON.stringify(renderedDraftContent))
    : draftContentRevision;
  const activeTrigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
  const triggerOwnsWholeDraft = activeTrigger?.kind === '@'
    && draftContent.inlineRefs.length === 0
    && triggerOwnsWholeText(draftContent.text, activeTrigger);
  // A trigger resolving on the not-yet-materialized trailing draft creates its
  // node atomically (under props.parentId), instead of materializing a plain node
  // first and then mutating it. `materializeStartedRef` guards the window after a
  // blur/Enter materialize is already in flight but the real node has not landed.
  const onDraftTrigger = props.draft === true && !realNode && !materializeStartedRef.current;

  const restorePendingReferenceConversion = async (_content: RichText) => {
    const content = draftContentRef.current;
    const pendingConversion = props.ui.pendingReferenceConversion;
    if (pendingConversion?.nodeId !== props.nodeId) return { restored: false, nodeId: props.nodeId };
    if (restoredReferenceConversionNodeRef.current === props.nodeId) {
      return { restored: false, nodeId: props.nodeId };
    }
    if (!isOnlyInlineReference(content, pendingConversion.targetId)) {
      props.setUi((prev) => (
        prev.pendingReferenceConversion?.nodeId === props.nodeId
          ? { ...prev, pendingReferenceConversion: null }
          : prev
      ));
      return { restored: false, nodeId: props.nodeId };
    }

    const parentId = pendingConversion.parentId ?? props.parentId;
    const restoreBlocked = getTreeReferenceBlockReason({
      parentId,
      targetId: pendingConversion.targetId,
      byId: props.index.byId,
    });
    if (restoreBlocked) {
      props.setUi((prev) => (
        prev.pendingReferenceConversion?.nodeId === props.nodeId
          ? { ...prev, pendingReferenceConversion: null }
          : prev
      ));
      return { restored: false, nodeId: props.nodeId };
    }

    restoredReferenceConversionNodeRef.current = props.nodeId;
    const replacementId = freshNodeId();
    const pendingBeforeRestore = pendingTextPatchRef.current;
    const anchors = props.optimisticChange
      ? {
          beforeId: props.optimisticChange.beforeId,
          afterId: props.optimisticChange.afterId,
        }
      : optimisticReplacementAnchors(
          props.index.byId.get(parentId)?.children ?? [],
          props.nodeId,
        );
    const restoreSource = () => {
      restoredReferenceConversionNodeRef.current = null;
      props.setUi((previous) => {
        const restored = clearOptimisticRemovals(previous, [props.nodeId]);
        return {
          ...restored,
          pendingReferenceConversion: restored.pendingReferenceConversion?.nodeId === replacementId
            ? pendingConversion
            : restored.pendingReferenceConversion,
        };
      });
    };
    const { settlement } = startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: replacementId,
        parentId,
        ...anchors,
        content: EMPTY_RICH_TEXT,
        nodeOverride: {
          ...makeDraftNode(replacementId, parentId),
          type: 'reference',
          targetId: pendingConversion.targetId,
        },
        placement: cursorStart(),
        preserveFocus: true,
        updateUi: (previous) => ({
          ...addOptimisticRemovals(previous, [props.nodeId]),
          pendingReferenceConversion: null,
        }),
      },
      command: async () => {
        if (props.optimisticChange && !await props.optimisticChange.settlement.current) return null;
        await pendingBeforeRestore;
        return props.run(() => api.restoreInlineReferenceNodeToReference(
          props.nodeId,
          pendingConversion.targetId,
          replacementId,
        ), { applyFocus: false });
      },
      reconcile: async () => {
        props.setUi((previous) => clearOptimisticRemovals(previous, [props.nodeId]));
        return true;
      },
      onRejected: restoreSource,
      onFailed: restoreSource,
    });
    pendingTextPatchRef.current = settlement;
    return await settlement
      ? { restored: true, nodeId: replacementId }
      : { restored: false, nodeId: props.nodeId };
  };

  const commitDraft = async (content = draftContentRef.current) => {
    draftContentRef.current = content;
    setDraftContent(content);
    if (props.draft && !realNode) {
      if (semanticTriggerResolutionRef.current) return props.nodeId;
      if (props.optimisticChange?.phase === 'submitting') return props.nodeId;
      // Blur/commit on the trailing draft (body OR field value): materialize only
      // if something was typed (so a click-away on an empty line never persists an
      // empty node). materializeDraft routes to the right create command.
      const buffered = draftContentRef.current;
      if (buffered.text.trim().length > 0 || buffered.inlineRefs.length > 0) {
        materializeDraft();
        await pendingTextPatchRef.current;
      }
      return props.nodeId;
    }
    const result = await restorePendingReferenceConversion(content);
    if (props.fieldValue) {
      await pendingTextPatchRef.current;
      await props.run(() => props.fieldValue!.commitSlot(), { applyFocus: false });
    }
    return result.nodeId;
  };

  const currentDraftCreateIndex = () => draftCreateIndex(parentNode, props.draftAfterId ?? null);
  const rememberMaterializedFieldEntry = (result: CommandRunnerOperationResult) => {
    const fieldValue = props.fieldValue;
    if (!fieldValue) return null;
    const changedNodes = result && typeof result === 'object' && 'update' in result
      ? result.update.kind === 'full'
        ? result.update.projection.nodes
        : result.update.changedNodes
      : [];
    const entryId = fieldValue.entryId ?? changedNodes.find((candidate) => (
      candidate.type === 'fieldEntry'
      && candidate.parentId === fieldValue.ownerId
      && candidate.fieldDefId === fieldValue.fieldDefId
    ))?.id ?? null;
    if (entryId) {
      materializedFieldParentIdRef.current = entryId;
      const previousParentId = props.parentId;
      props.setUi((previous) => {
        let remappedPendingChange = false;
        for (const change of previous.pendingStructuralChanges) {
          if (
            change.id !== entryId
            && change.panelId === props.panelId
            && change.parentId === previousParentId
          ) {
            change.parentId = entryId;
            remappedPendingChange = true;
          }
        }
        const pendingStructuralChanges = remappedPendingChange
          ? [...previous.pendingStructuralChanges]
          : previous.pendingStructuralChanges;
        const remapTarget = (target: FocusTarget) => (
          target.panelId === props.panelId && target.parentId === previousParentId
            ? { ...target, parentId: entryId, ...(target.nodeId === previousParentId ? { nodeId: entryId } : {}) }
            : target
        );
        const focusTargetsPreviousParent = previous.focusedPanelId === props.panelId
          && previous.focusedParentId === previousParentId;
        return {
          ...previous,
          pendingStructuralChanges,
          ...(focusTargetsPreviousParent ? { focusedParentId: entryId } : {}),
          ...(previous.focusSurface === 'trailing'
            && previous.focusedPanelId === props.panelId
            && previous.focusedId === previousParentId
            ? { focusedId: entryId, focusedParentId: entryId }
            : {}),
          focusRequest: previous.focusRequest
            ? { ...previous.focusRequest, target: remapTarget(previous.focusRequest.target) }
            : null,
          trailingDraftPlacement: previous.trailingDraftPlacement?.panelId === props.panelId
            && previous.trailingDraftPlacement.parentId === previousParentId
            ? { ...previous.trailingDraftPlacement, parentId: entryId }
            : previous.trailingDraftPlacement,
        };
      });
    }
    return entryId;
  };
  // Materialization: turn the draft into a real node under its stable id on
  // commit. Runs once; the create and the text patches that follow share one undo
  // group. Keystrokes that land during the Runtime round-trip
  // stay in the buffer and are reconciled when the node arrives, then focus moves
  // from the parent's trailing surface to this row's own id (without re-focusing,
  // so the caret is undisturbed) — that frees the trailing signal for the freshly
  // minted next draft.
  //
  // A field value materializes through the injected fieldValue.materializeValue
  // (carrying this row's id, so the create routes to the field command set while
  // the row keeps its React identity); a body node uses api.materializeDraftNode.
  // Both honour the same id contract, so the surrounding reconcile/focus logic is
  // shared — the field value path is no longer a separate editing mode.
  const materializeDraft = (): Promise<boolean> => {
    if (realNode) return Promise.resolve(true);
    if (semanticTriggerResolutionRef.current) return Promise.resolve(false);
    if (props.optimisticChange?.phase === 'submitting') return props.optimisticChange.settlement.current;
    if (materializePromiseRef.current) return materializePromiseRef.current;
    if (materializeStartedRef.current) return Promise.resolve(false);
    const seed = draftContentRef.current;
    const fieldValue = props.fieldValue;
    // An empty virtual tag slot has no backing entry to create. Keep its draft
    // reusable instead of arming the one-shot materialization guard forever.
    if (fieldValue && seed.text.trim().length === 0 && seed.inlineRefs.length === 0) {
      return Promise.resolve(false);
    }
    const dependency = latestOptimisticStructuralDependency(
      props.uiRef.current,
      props.panelId,
      props.parentId,
      props.nodeId,
    );
    materializeStartedRef.current = true;
    const createIndex = currentDraftCreateIndex();
    const undoGroup: OperationUndoGroup | undefined = fieldValue
      ? undefined
      : { groupId: `undo-group:${crypto.randomUUID()}`, kind: 'text-edit', nodeId: props.nodeId };
    if (undoGroup) {
      clearMaterializedTextUndoGroup();
      materializedTextUndoGroupRef.current = undoGroup;
    }
    const runCreate = () => props.run(
      fieldValue
        ? () => fieldValue.materializeValue(props.nodeId, seed.text)
        : props.draftAfterId
          ? () => api.createNodeRelativeTo(
              props.draftAfterId!,
              props.parentId,
              'after',
              seed,
              props.nodeId,
              undoGroup ? { undoGroup } : undefined,
            )
          : () => api.materializeDraftNode(props.parentId, createIndex, seed.text, props.nodeId, undoGroup),
      {
        applyFocus: false,
        beforeApply: fieldValue ? rememberMaterializedFieldEntry : undefined,
      },
    );
    const pendingBeforeMaterialize = pendingTextPatchRef.current;
    const resetFailedMaterialization = () => {
      materializeStartedRef.current = false;
      materializePromiseRef.current = null;
      if (undoGroup && materializedTextUndoGroupRef.current?.groupId === undoGroup.groupId) {
        clearMaterializedTextUndoGroup();
      }
    };
    const { settlement: materializePromise } = startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: props.nodeId,
        parentId: props.parentId,
        originatesFromDraft: true,
        retainsTrailingDraftMarker: !fieldValue,
        afterId: props.draftAfterId,
        content: seed,
        placement: cursorEnd(),
      },
      retainOnRejected: true,
      command: async () => {
        if (dependency && !await dependency.settlement.current) return null;
        await pendingBeforeMaterialize;
        return runCreate();
      },
      reconcile: async (result, change) => {
        if (undoGroup && materializedTextUndoGroupRef.current?.groupId === undoGroup.groupId) {
          scheduleMaterializedTextUndoGroupFlush();
        }
        const latest = change.latestContent.current;
        if (richTextEquals(latest, seed)) return true;
        const reconciled = await props.run(
          () => api.applyNodeTextPatch(
            props.nodeId,
            replaceAllRichTextPatch(latest),
            undoGroup ? { undoGroup } : undefined,
          ),
          { applyFocus: false },
        );
        if (reconciled === null) return false;
        if (undoGroup && materializedTextUndoGroupRef.current?.groupId === undoGroup.groupId) {
          scheduleMaterializedTextUndoGroupFlush();
        }
        return true;
      },
      onRejected: resetFailedMaterialization,
      onFailed: resetFailedMaterialization,
    });
    materializePromiseRef.current = materializePromise;
    pendingTextPatchRef.current = materializePromise;
    void materializePromise;
    return materializePromise;
  };

  const applyTextPatch = (patch: RichTextPatch) => {
    const nextContent = applyRichTextPatchToContent(draftContentRef.current, patch);
    if (props.optimisticChange) {
      props.optimisticChange.latestContent.current = nextContent;
      if (props.optimisticChange.nodeOverride) {
        props.optimisticChange.nodeOverride.current = {
          ...props.optimisticChange.nodeOverride.current,
          content: nextContent,
        };
      }
    }
    localDraftSyncRef.current = { nodeId: targetEditId, content: nextContent };
    draftContentRef.current = nextContent;
    if (
      optionPickerDraft
      || pendingReferenceConversion
      || draftTriggerActiveRef.current
      || props.trigger?.nodeId === props.nodeId
      || patch.ops.some((op) => op.type === 'replace_all')
    ) {
      setDraftContent(nextContent);
    }
    if (optionPickerDraft && !optionsOpen) setOptionsOpen(true);

    const fireAction = resolveContentRowUpdateAction({
      text: nextContent.text,
      inlineRefCount: nextContent.inlineRefs.length,
      enableFieldTrigger: !suppressTextTriggers,
      enableCodeFence: !suppressTextTriggers
        && node.type === undefined
        && !pendingReferenceConversion
        && !displayed.locked,
    });
    // Bare structural triggers are renderer transactions. Persisting their
    // transient marker first would add an IPC round trip and briefly expose the
    // wrong row type before the atomic field/code command runs.
    if (fireAction.type !== 'none') return;

    if (props.draft && !realNode) {
      if (props.optimisticChange) return;
      // A body trailing draft eagerly materializes on the first typed character:
      // the draft becomes a real node carrying the text, and a fresh empty trailing
      // line takes its place below — the smooth "there is always a line to type
      // next" flow.
      //
      // Three cases stay buffered instead:
      //  • A field value — its create dedups the typed text against the option pool
      //    on commit (Enter/blur), so it needs the full text in one shot.
      //  • While a #/@/ popover trigger query is open — buffering lets the trigger
      //    resolve atomically into a tagged/reference/typed node (create_tagged_node,
      //    add_reference_conversion, …) rather than flashing a junk plain node first.
      //    draftTriggerActiveRef was just set, in this same transaction, by
      //    onTriggerChange (which runs before this callback).
      //  • A `>` field / ``` code-fence fire-trigger — these resolve in
      //    handleContentUpdateAction, which runs *after* this callback, so they are
      //    detected here directly from the buffered content and create their node
      //    atomically (createPlaceholderInlineField / convertRowToCodeBlock).
      if (!props.fieldValue && !draftTriggerActiveRef.current) {
        queueMicrotask(() => materializeDraft());
      }
      return;
    }
    pendingTextPatchRef.current = textPatchQueue.enqueue({
      key: targetEditId,
      patch,
      latestContent: nextContent,
      send: (nextPatch) => {
        const undoGroup = materializedTextUndoGroupFor(targetEditId);
        if (undoGroup) scheduleMaterializedTextUndoGroupFlush();
        return props.run(() => api.applyNodeTextPatch(
          targetEditId,
          nextPatch,
          undoGroup ? { undoGroup } : undefined,
        ), {
          applyFocus: false,
        });
      },
    });
  };

  const applyTextWithoutTrigger = async () => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    const pendingBeforeReplacement = pendingTextPatchRef.current;
    const nextContent = trigger
      ? deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to)
        : plainText(draftContentRef.current.text.replace(/(?:^|\s)([#@/>])([^\s#@/>]*)$/, '').trimEnd());
    replaceLocalDraftContent(nextContent);
    // A draft has no node to patch yet — the de-triggered text stays buffered until
    // it materializes on Enter/blur.
    if (onDraftTrigger) return;
    await pendingBeforeReplacement;
    await props.run(() => api.replaceNodeText(targetEditId, nextContent));
  };

  const handleEditorChange = (content: RichText) => {
    if (props.optimisticChange) props.optimisticChange.latestContent.current = content;
    localDraftSyncRef.current = { nodeId: targetEditId, content };
    draftContentRef.current = content;
    setDraftContent(content);
  };

  const runSemanticTriggerResolution = async <T,>(operation: () => Promise<T>): Promise<T> => {
    semanticTriggerResolutionRef.current = true;
    try {
      return await operation();
    } finally {
      semanticTriggerResolutionRef.current = false;
    }
  };

  const handlePasteOutliner = (payload: {
    content: RichText;
    children: CreateNodeTree[];
    siblingsAfter: CreateNodeTree[];
    firstMeta?: PasteRowMeta;
  }): Promise<boolean> => {
    const applySuccessfulPaste = () => {
      if (payload.children.length > 0) {
        props.setUi((prev) => {
          const expanded = new Set(prev.expanded);
          expanded.add(props.nodeId);
          return { ...prev, expanded };
        });
      }
    };
    const treesForPristineDraft = () => {
      const trees: CreateNodeTree[] = [];
      const firstHasBody = payload.content.text.trim().length > 0
        || payload.content.inlineRefs.length > 0
        || payload.children.length > 0
        || (payload.firstMeta?.tags?.length ?? 0) > 0
        || (payload.firstMeta?.fields?.length ?? 0) > 0
        || payload.firstMeta?.checkbox === true;
      if (firstHasBody) {
        trees.push({
          content: payload.content,
          children: payload.children,
          ...payload.firstMeta,
        });
      }
      trees.push(...payload.siblingsAfter);
      return trees;
    };

    if (virtualFieldValueDraft && props.fieldValue) {
      const trees = treesForPristineDraft();
      if (trees.length === 0) return Promise.resolve(false);
      return runClaimedVirtualFieldMaterialization(() => props.run(
          () => props.fieldValue!.materializeNodes(props.nodeId, trees),
          {
            applyFocus: false,
            beforeApply: (result) => {
              rememberMaterializedFieldEntry(result);
              replaceLocalDraftContent(EMPTY_RICH_TEXT);
              applySuccessfulPaste();
            },
          },
        )).then(() => false);
    }

    // The pristine trailing draft has no core node yet (it materializes on the
    // first committed character), so there is nothing to paste *into*: calling
    // paste_nodes_into_node with its client-proposed id throws "node not found".
    // Append the pasted trees at the trailing position instead and leave the
    // draft empty — it re-spawns below the new rows.
    if (props.draft && !realNode && !materializeStartedRef.current) {
      const trees = treesForPristineDraft();
      return trees.length > 0
        ? props.run(() => api.createNodesFromTree(props.parentId, trees)).then(() => false)
        : Promise.resolve(false);
    }
    const pasteIntoNode = () => api.pasteNodesIntoNode(
      props.nodeId,
      payload.content,
      payload.children,
      payload.siblingsAfter,
      payload.firstMeta ?? {},
    );
    if (props.draft && !realNode) {
      // A materialize for this draft is already in flight; paste once the row
      // lands in core so its id is no longer missing.
      const pendingPaste = pendingTextPatchRef.current.then(() => (
        props.run(pasteIntoNode, { beforeApply: applySuccessfulPaste })
      ));
      pendingTextPatchRef.current = pendingPaste;
      return pendingPaste.then((result) => result !== null);
    }
    return props.run(pasteIntoNode, { beforeApply: applySuccessfulPaste })
      .then((result) => result !== null);
  };

  const insertImagesFromAssets = async (assets: AssetMetadata[]) => {
    if (assets.length === 0) return;
    const parentId = materializedFieldParentIdRef.current ?? props.parentId;
    const siblings = props.index.byId.get(parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    let insertIndex = rowIndex >= 0 ? rowIndex + 1 : null;
    for (const asset of assets) {
      // Clipboard images are admitted as managed image Sources by construction
      // (filtered on the declared type upstream), so do not re-sniff the bytes.
      const result = await props.run(() => api.createSourceNode(parentId, insertIndex, {
        assetId: asset.id,
        name: asset.originalFilename,
      }));
      expandCreatedSourceOwner(result);
      if (insertIndex !== null) insertIndex += 1;
    }
  };

  const expandSourceOwner = (ownerId: NodeId) => {
    props.setUi((previous) => {
      if (previous.expanded.has(ownerId)) return previous;
      const expanded = new Set(previous.expanded);
      expanded.add(ownerId);
      return { ...previous, expanded };
    });
  };

  const expandCreatedSourceOwner = (result: CommandRunnerOperationResult) => {
    if (!result || !('focus' in result) || !result.focus?.nodeId) return;
    expandSourceOwner(result.focus.nodeId);
  };

  const insertAssetNodesAt = async (
    assets: AssetMetadata[],
    initialIndex: number | null,
    parentId = props.parentId,
    options?: CommandRunnerOptions,
  ) => {
    let insertIndex = initialIndex;
    for (const asset of assets) {
      const result = await createAssetNode(props.run, parentId, insertIndex, asset, options);
      expandCreatedSourceOwner(result);
      if (insertIndex !== null) insertIndex += 1;
    }
  };

  const materializeVirtualFieldAssets = async (
    assets: AssetMetadata[],
    options?: CommandRunnerOptions,
  ) => {
    if (
      !virtualFieldValueDraft
      || !props.fieldValue
      || assets.length === 0
      || materializeStartedRef.current
    ) return false;
    const [first, ...rest] = assets;
    let entryId: NodeId | null = null;
    const outcome = await runClaimedVirtualFieldMaterialization(() => props.run(
        () => props.fieldValue!.materializeAsset(props.nodeId, first!),
        {
          ...options,
          applyFocus: false,
          beforeApply: (result) => {
            entryId = rememberMaterializedFieldEntry(result);
            options?.beforeApply?.(result);
          },
        },
      ));
    if (!outcome) return true;
    replaceLocalDraftContent(EMPTY_RICH_TEXT);
    if (entryId) await insertAssetNodesAt(rest, null, entryId, options);
    return true;
  };

  const insertAssetNodesAfterCurrentRow = async (assets: AssetMetadata[], options?: CommandRunnerOptions) => {
    if (assets.length === 0) return;
    const parentId = materializedFieldParentIdRef.current ?? props.parentId;
    const siblings = props.index.byId.get(parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    await insertAssetNodesAt(assets, rowIndex >= 0 ? rowIndex + 1 : null, parentId, options);
  };

  // Land images "here": add the first Source to a plain, empty, childless row
  // rather than spawning an empty row beside it; remaining images become
  // ordinary Source-backed siblings. Used by clipboard paste and `/image`.
  const landImagesOnCurrentRow = async (assets: AssetMetadata[]) => {
    if (assets.length === 0) return;
    if (await materializeVirtualFieldAssets(assets)) return;
    if (props.draft && !realNode && !materializeStartedRef.current) {
      await insertAssetNodesAt(assets, currentDraftCreateIndex());
      return;
    }
    const draft = draftContentRef.current;
    const rowTextEmpty = draft.text.trim().length === 0 && draft.inlineRefs.length === 0;
    const canConvertInPlace = shouldConvertRowToImage({
      referenceLikeRow,
      nodeType: displayed.type,
      hasChildren: rowScopeChildIds.length > 0,
      rowTextEmpty,
    });
    if (canConvertInPlace) {
      const [first, ...rest] = assets;
      const result = await props.run(() => api.addSource(targetEditId, formatAssetSourceUri(first.id)));
      if (result) expandSourceOwner(targetEditId);
      await insertImagesFromAssets(rest);
    } else {
      await insertImagesFromAssets(assets);
    }
  };

  const handlePasteImage = async (images: PastedImage[]) => {
    await commitDraft();
    const assets = await ingestPastedImages(images);
    await landImagesOnCurrentRow(assets);
  };

  const handlePasteFiles = async (files: File[]) => {
    await commitDraft();
    const ingested = await ingestFiles(files);
    await landAssetsOnCurrentRow(ingested.assets, { applyFocus: false });
  };

  const landAssetsOnCurrentRow = async (assets: AssetMetadata[], options?: CommandRunnerOptions) => {
    if (assets.length === 0) return;
    if (await materializeVirtualFieldAssets(assets, options)) return;
    if (props.draft && !realNode && !materializeStartedRef.current) {
      await insertAssetNodesAt(assets, currentDraftCreateIndex(), props.parentId, options);
      return;
    }
    const [first, ...rest] = assets;
    const draft = draftContentRef.current;
    const rowTextEmpty = draft.text.trim().length === 0 && draft.inlineRefs.length === 0;
    const canConvertFirstImage = first.mimeType.startsWith('image/') && shouldConvertRowToImage({
      referenceLikeRow,
      nodeType: displayed.type,
      hasChildren: rowScopeChildIds.length > 0,
      rowTextEmpty,
    });
    if (!canConvertFirstImage) {
      await insertAssetNodesAfterCurrentRow(assets, options);
      return;
    }
    const result = await props.run(() => api.addSource(targetEditId, formatAssetSourceUri(first.id)), options);
    if (result) expandSourceOwner(targetEditId);
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    await insertAssetNodesAt(rest, rowIndex >= 0 ? rowIndex + 1 : null, props.parentId, options);
  };

  const rowElementForExternalDrag = (event: DragEvent<HTMLDivElement>) => (
    event.currentTarget.querySelector<HTMLElement>(':scope > .row')
      ?? event.currentTarget.closest<HTMLElement>('.row')
      ?? event.currentTarget
  );

  const externalAssetDropTarget = (position: DropHoverPosition | null): {
    parentId: NodeId;
    index: number | null;
    expandTargetId?: NodeId;
  } => {
    if (props.draft && !realNode && !materializeStartedRef.current) {
      return { parentId: props.parentId, index: currentDraftCreateIndex() };
    }

    const parentId = materializedFieldParentIdRef.current ?? props.parentId;
    const siblings = props.index.byId.get(parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    if (position === 'inside') {
      return { parentId: props.nodeId, index: 0, expandTargetId: props.nodeId };
    }
    if (position === 'after' && row.hasChildren && row.expanded) {
      return { parentId: props.nodeId, index: 0 };
    }
    return {
      parentId,
      index: rowIndex >= 0 ? rowIndex + (position === 'after' ? 1 : 0) : null,
    };
  };

  const handleExternalFileDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    const files = dataTransferFiles(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const dropPosition = externalFileDropPosition ?? 'after';
    setExternalFileDropPosition(null);
    announceDropTarget(null);
    void (async () => {
      await commitDraft();
      const ingested = await ingestFiles(files);
      if (await materializeVirtualFieldAssets(ingested.assets, { applyFocus: false })) return;
      const target = externalAssetDropTarget(dropPosition);
      if (target.expandTargetId) {
        props.setUi((prev) => {
          const expanded = new Set(prev.expanded);
          expanded.add(target.expandTargetId!);
          return { ...prev, expanded };
        });
      }
      await insertAssetNodesAt(ingested.assets, target.index, target.parentId, { applyFocus: false });
    })();
  };

  const handleExternalFileDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    const rowElement = rowElementForExternalDrag(event);
    const rect = rowElement.getBoundingClientRect();
    const nextPosition = props.draft && !realNode
      ? 'before'
      : resolveDropHoverPosition({
        offsetY: event.clientY - rect.top,
        rowHeight: rect.height,
      });
    announceDropTarget(externalFileDropTargetKey);
    setExternalFileDropPosition(nextPosition);
  };

  const handleExternalFileDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    event.stopPropagation();
    clearExternalFileDropState();
  };

  const handlePasteBareUrl = (url: string) => {
    const content: RichText = {
      text: url,
      marks: [{ start: 0, end: url.length, type: 'link', attrs: { href: url } }],
      inlineRefs: [],
    };
    if (props.draft && !realNode) {
      startOptimisticDraftMaterialization({
        content,
        updateUi: (previous) => {
          const expanded = new Set(previous.expanded);
          expanded.add(props.nodeId);
          return { ...previous, expanded };
        },
        rollbackUi: (previous) => {
          const expanded = new Set(previous.expanded);
          expanded.delete(props.nodeId);
          return { ...previous, expanded };
        },
        command: () => api.createSourceNode(
          props.parentId,
          currentDraftCreateIndex(),
          { sourceText: url, content, id: props.nodeId },
        ),
      });
      return;
    }
    const previousContent = draftContentRef.current;
    replaceLocalDraftContent(content);
    void startOptimisticNodePatch({
      currentUi: props.uiRef.current,
      setUi: props.setUi,
      patch: pendingNodePatch(targetEditId, { content }),
      command: async () => {
        const result = await props.run(
          () => api.setNodeContentAndAddSource(targetEditId, content, url),
          { applyFocus: false },
        );
        if (result) expandSourceOwner(targetEditId);
        return result;
      },
      onRejected: () => replaceLocalDraftContent(previousContent),
    });
  };

  const startOptimisticDraftMaterialization = (params: {
    content: RichText;
    nodeOverride?: ContentBearingNodeProjection;
    placement?: CursorPlacement;
    updateUi?: (previous: UiState) => UiState;
    rollbackUi?: (previous: UiState) => UiState;
    command: (change: PendingStructuralChange) => Promise<CommandRunnerOperationResult>;
    reconcile?: (
      result: NonNullable<CommandRunnerOperationResult>,
      change: PendingStructuralChange,
    ) => boolean | void | Promise<boolean | void>;
  }): CommandRunnerOperationResult => {
    const previousContent = draftContentRef.current;
    const pendingBeforeCommand = pendingTextPatchRef.current;
    const dependency = latestOptimisticStructuralDependency(
      props.uiRef.current,
      props.panelId,
      props.parentId,
      props.nodeId,
    );
    materializeStartedRef.current = true;
    const { settlement } = startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: props.nodeId,
        parentId: props.parentId,
        originatesFromDraft: true,
        afterId: props.draftAfterId,
        content: params.content,
        nodeOverride: params.nodeOverride ?? {
          ...makeDraftNode(props.nodeId, props.parentId, params.content),
          content: params.content,
        },
        placement: params.placement ?? cursorEnd(),
        updateSource: () => replaceLocalDraftContent(params.content),
        updateUi: params.updateUi,
      },
      command: async (change) => {
        if (dependency && !await dependency.settlement.current) return null;
        await pendingBeforeCommand;
        return props.run(() => params.command(change), {
          applyFocus: false,
          beforeApply: props.fieldValue ? rememberMaterializedFieldEntry : undefined,
        });
      },
      reconcile: async (result, change) => {
        if (await params.reconcile?.(result, change) === false) return false;
        return reconcilePendingStructuralChange(change);
      },
      onRejected: () => {
        materializeStartedRef.current = false;
        if (params.rollbackUi) props.setUi(params.rollbackUi);
        replaceLocalDraftContent(previousContent);
        restoreFocusAfterStructuralFailure(false);
      },
      onFailed: () => {
        materializeStartedRef.current = false;
        if (params.rollbackUi) props.setUi(params.rollbackUi);
      },
    });
    pendingTextPatchRef.current = settlement;
    return commandRunnerNoop();
  };

  // A `#tag` query resolves as one optimistic transaction. Drafts create the final
  // tagged row directly; materialized rows replace the trigger text and apply the
  // tag in one update, so neither path waits for Runtime before showing the chip.
  const applyDraftTag = async (tag: NodeProjection) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;
    const content = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
    return startOptimisticDraftMaterialization({
      content,
      nodeOverride: {
        ...makeDraftNode(props.nodeId, props.parentId, content),
        tags: [tag.id],
      },
      command: () => props.fieldValue
        ? props.fieldValue.materializeNodes(props.nodeId, [{ content, children: [] }], [tag.id])
        : api.createTaggedNode(
            props.parentId,
            content,
            tag.id,
            currentDraftCreateIndex(),
            props.nodeId,
          ),
    });
  };

  const createAndApplyDraftTag = async (name: string) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;
    const content = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
    return startOptimisticDraftMaterialization({
      content,
      command: () => props.fieldValue
        ? props.fieldValue.materializeNodes(props.nodeId, [{ content, children: [], tags: [name] }])
        : api.createTagAndTaggedNode(
            props.parentId,
            content,
            name,
            currentDraftCreateIndex(),
            props.nodeId,
          ),
    });
  };

  const applyMaterializedTag = async (tag: NodeProjection) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger || !displayed) return null;
    const previousContent = draftContentRef.current;
    const pendingBeforeReplacement = pendingTextPatchRef.current;
    const content = deleteRichTextRange(previousContent, trigger.from, trigger.to);
    replaceLocalDraftContent(content);
    void startOptimisticNodePatch({
      currentUi: props.uiRef.current,
      setUi: props.setUi,
      patch: optimisticTagPatch({
        node: displayed,
        ui: props.uiRef.current,
        tagId: tag.id,
        action: 'add',
        content,
      }),
      command: async () => {
        await pendingBeforeReplacement;
        return props.run(() => api.applyTagWithContent(targetEditId, tag.id, content), {
          applyFocus: false,
        });
      },
      onRejected: () => replaceLocalDraftContent(previousContent),
    });
    return commandRunnerNoop();
  };

  const createAndApplyMaterializedTag = async (name: string) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger || !displayed) return null;
    const previousContent = draftContentRef.current;
    const pendingBeforeReplacement = pendingTextPatchRef.current;
    const content = deleteRichTextRange(previousContent, trigger.from, trigger.to);
    const tagId = freshNodeId();
    replaceLocalDraftContent(content);
    void startOptimisticNodePatch({
      currentUi: props.uiRef.current,
      setUi: props.setUi,
      patch: optimisticTagPatch({
        node: displayed,
        ui: props.uiRef.current,
        tagId,
        action: 'add',
        content,
        pendingTagName: name,
      }),
      command: async () => {
        await pendingBeforeReplacement;
        return props.run(
          () => api.createTagAndApplyWithContent(targetEditId, name, content, tagId),
          { applyFocus: false },
        );
      },
      onRejected: () => replaceLocalDraftContent(previousContent),
    });
    return commandRunnerNoop();
  };

  const applyReference = async (target: NodeProjection) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) {
      return;
    }
    const pendingBeforeReplacement = pendingTextPatchRef.current;
    const currentDraft = draftContentRef.current;
    const byIdWithTarget = props.index.byId.has(target.id)
      ? props.index.byId
      : new Map(props.index.byId).set(target.id, target);
    const referenceParentId = virtualFieldValueDraft
      ? props.fieldValue!.ownerId
      : props.parentId;
    let treeBlockReason = getTreeReferenceBlockReason({
      parentId: referenceParentId,
      targetId: target.id,
      byId: byIdWithTarget,
    });
    if (virtualFieldValueDraft && treeBlockReason === 'already_in_parent') treeBlockReason = null;
    const action = resolveReferenceSelectionAction({
      text: currentDraft.text,
      inlineRefCount: currentDraft.inlineRefs.length,
      triggerFrom: trigger.from,
      triggerTo: trigger.to,
      treeBlockReason,
      sourceIsReference: node.type === 'reference',
    });
    if (action === 'blocked') return commandRunnerNoop();
    const nextContent = replaceRichTextRangeWithInlineRef(
      currentDraft,
      trigger.from,
      trigger.to,
      {
        target: nodeReferenceTarget(target.id),
        // Stored ref display-name snapshot (persisted data): store the raw text and let
        // the render path apply its own fallback (live title / id), matching every other
        // displayName write site (NodePanel, core). Baking a literal here — English or
        // the current UI language — would freeze it into the document.
        displayName: textOf(target),
      },
      // A whole-row conversion gets its editable caret anchor from the editor's
      // transient sentinel. Only an inline insertion stores a real separating gap.
      { trailingSpace: action !== 'tree_reference' },
    );
    if (action === 'tree_reference') {
      if (onDraftTrigger) {
        const fieldReference = Boolean(props.fieldValue);
        const optimisticNode: ContentBearingNodeProjection = fieldReference
          ? {
              ...makeDraftNode(props.nodeId, props.parentId),
              type: 'reference',
              targetId: target.id,
            }
          : {
              ...makeDraftNode(props.nodeId, props.parentId, nextContent),
              content: nextContent,
            };
        const result = startOptimisticDraftMaterialization({
          content: fieldReference ? EMPTY_RICH_TEXT : nextContent,
          nodeOverride: optimisticNode,
          placement: cursorAtOffset(
            cursorOffsetAfterInlineReference(nextContent, trigger.from),
            'after',
          ),
          updateUi: fieldReference
            ? undefined
            : (previous) => ({
                ...previous,
                pendingReferenceConversion: {
                  nodeId: props.nodeId,
                  parentId: props.parentId,
                  targetId: target.id,
                },
              }),
          rollbackUi: fieldReference
            ? undefined
            : (previous) => (
                previous.pendingReferenceConversion?.nodeId === props.nodeId
                  ? { ...previous, pendingReferenceConversion: null }
                  : previous
              ),
          command: () => props.fieldValue
            ? props.fieldValue.materializeReference(props.nodeId, target.id)
            : api.addReferenceConversion(
                props.parentId,
                target.id,
                currentDraftCreateIndex(),
                textOf(target),
                props.nodeId,
              ),
        });
        if (fieldReference) focusTrailingDraft();
        return result;
      }
      // Whole-text @ref. A draft has no node yet, so it creates a fresh
      // inline-conversion row (add_reference_conversion); a real (empty) row
      // converts itself in place (replace_node_with_reference_conversion).
      startOptimisticReferenceReplacement(target, nextContent, pendingBeforeReplacement);
      return commandRunnerNoop();
    }

    if (onDraftTrigger) {
      return startOptimisticDraftMaterialization({
        content: nextContent,
        placement: cursorAtOffset(
          cursorOffsetAfterInlineReference(nextContent, trigger.from),
          'after',
        ),
        command: () => props.fieldValue
          ? props.fieldValue.materializeNodes(props.nodeId, [{ content: nextContent, children: [] }])
          : api.createRichTextNode(
              props.parentId,
              currentDraftCreateIndex(),
              nextContent,
              props.nodeId,
            ),
      });
    }
    replaceLocalDraftContent(nextContent);
    requestRowFocus(
      props.nodeId,
      cursorAtOffset(cursorOffsetAfterInlineReference(nextContent, trigger.from), 'after'),
      props.parentId,
    );
    await pendingBeforeReplacement;
    return props.run(() => api.replaceNodeText(targetEditId, nextContent), {
      applyFocus: false,
    });
  };

  const executeSlashCommand = async (commandId: SlashCommandId) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;

    if (commandId === 'field') {
      startOptimisticFieldConversion();
      return commandRunnerNoop();
    }

    if (commandId === 'reference') {
      const pendingBeforeReplacement = pendingTextPatchRef.current;
      const nextContent = replaceRichTextRangeWithText(draftContentRef.current, trigger.from, trigger.to, '@');
      replaceLocalDraftContent(nextContent);
      if (onDraftTrigger) {
        // No node to patch yet — the '@' stays buffered. Re-focus the draft with the
        // caret right after the '@' (cursorEnd) so the editor itself re-detects an
        // empty @ trigger and continued typing extends its query. (A bare rAF
        // setTrigger would arm the popover but leave the caret before the '@', so
        // typing would land in front of it.)
        focusTrailingDraft();
        return commandRunnerNoop();
      }
      props.setTrigger({
        nodeId: props.nodeId,
        ...referenceTriggerFromSlash(trigger),
      });
      await pendingBeforeReplacement;
      return props.run(() => api.replaceNodeText(targetEditId, nextContent), {
        applyFocus: false,
      });
    }

    if (commandId === 'heading') {
      const pendingBeforeReplacement = pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      const nextContent = markWholeTextAsHeading(withoutTrigger);
      if (onDraftTrigger) {
        startOptimisticHeadingConversion(nextContent);
        return commandRunnerNoop();
      }
      replaceLocalDraftContent(nextContent);
      await pendingBeforeReplacement;
      return props.run(() => api.replaceNodeText(targetEditId, nextContent), {
        applyFocus: false,
      });
    }

    if (commandId === 'checkbox') {
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      startOptimisticCheckboxConversion(withoutTrigger);
      return commandRunnerNoop();
    }

    if (commandId === 'code') {
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      startOptimisticCodeBlockConversion(withoutTrigger);
      return commandRunnerNoop();
    }

    if (commandId === 'image' || commandId === 'attachment') {
      const pendingBeforeReplacement = pendingTextPatchRef.current;
      const previousContent = draftContentRef.current;
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      replaceLocalDraftContent(withoutTrigger);
      const assetsPromise = commandId === 'image'
        ? api.pickImageFiles()
        : api.pickAttachmentFiles();
      let contentSettlement: Promise<boolean> = Promise.resolve(true);
      if (virtualFieldValueDraft && (
        withoutTrigger.text.trim().length > 0
        || withoutTrigger.inlineRefs.length > 0
      )) {
        materializeDraft();
        contentSettlement = pendingTextPatchRef.current.then(() => true);
      } else if (!onDraftTrigger) {
        contentSettlement = startOptimisticNodePatch({
          currentUi: props.uiRef.current,
          setUi: props.setUi,
          patch: pendingNodePatch(targetEditId, { content: withoutTrigger }),
          command: async () => {
            await pendingBeforeReplacement;
            return props.run(() => api.replaceNodeText(targetEditId, withoutTrigger), {
              applyFocus: false,
            });
          },
          onRejected: () => replaceLocalDraftContent(previousContent),
        });
      }
      const assets = await assetsPromise;
      if (!await contentSettlement) return commandRunnerAbort();
      if (commandId === 'image') await landImagesOnCurrentRow(assets);
      else await landAssetsOnCurrentRow(assets);
      return commandRunnerNoop();
    }

    if (commandId === 'command_palette') {
      let clear: Promise<void>;
      if (onDraftTrigger) {
        replaceLocalDraftContent(deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to));
        clear = Promise.resolve();
      } else {
        clear = applyTextWithoutTrigger();
      }
      // The palette is renderer-local, so it opens in the selection frame rather
      // than waiting for the trigger-removal patch to cross the Runtime boundary.
      void window.lin?.showLauncher?.();
      await clear;
      return commandRunnerNoop();
    }

    return null;
  };

  // Markdown-style shortcut: a bare ``` / ~~~ owning a plain row converts it into
  // an empty code block (the fence text is dropped), mirroring the `/code` command
  // and how a pasted fence becomes a `codeBlock` node. Focus lands in the new
  // code editor via a focus request the CodeBlockRow consumes on mount.
  const convertRowToCodeBlock = () => {
    semanticTriggerResolutionRef.current = true;
    queueMicrotask(() => startOptimisticCodeBlockConversion());
  };

  // From the empty trailing draft, step focus up to the visually-previous row
  // without creating or deleting anything (the draft has no real node).
  const focusPreviousFromDraft = (placement: CursorPlacement = cursorEnd()) => {
    if (props.draftAfterId) {
      const liveUi = props.uiRef.current;
      const localVisibleRows = flattenVisibleRows(
        props.parentId,
        props.index.byId,
        liveUi.expanded,
        liveUi.expandedHiddenFields,
      );
      const siblingRows = buildOutlinerRows(
        props.index.byId.get(props.parentId),
        props.index.byId,
        { expandedHiddenFields: liveUi.expandedHiddenFields },
      );
      const afterIndex = siblingRows.findIndex((row) => row.id === props.draftAfterId);
      const nextSibling = afterIndex < 0
        ? undefined
        : siblingRows.slice(afterIndex + 1).find((row) => row.type === 'content' || row.type === 'field');
      const nextIndex = nextSibling ? localVisibleRows.indexOf(nextSibling.id) : -1;
      const previousId = nextIndex > 0
        ? localVisibleRows[nextIndex - 1]
        : localVisibleRows[localVisibleRows.length - 1];
      if (previousId) {
        requestRowFocus(previousId, placement, props.index.byId.get(previousId)?.parentId ?? null);
      }
      return;
    }
    if (props.parentId === props.rootId) {
      const visible = flattenVisibleRows(
        props.rootId,
        props.index.byId,
        props.uiRef.current.expanded,
        props.uiRef.current.expandedHiddenFields,
      );
      const previousId = visible[visible.length - 1];
      if (previousId) {
        requestRowFocus(previousId, placement, props.index.byId.get(previousId)?.parentId ?? null);
      }
      return;
    }
    requestRowFocus(props.parentId, placement, props.index.byId.get(props.parentId)?.parentId ?? null);
  };

  // Where focus goes after a discrete field-value commit (option pick / typed
  // value). The list vs single-value behaviour is documented inline below.
  // Focus the entry's trailing draft — the single entry point for the next value.
  // Used after a committed field value row's Enter and after the options overlay
  // picks/creates, so every "add another value" gesture funnels through the same
  // draft (everything is a node; values append via that draft).
  const focusTrailingDraft = (
    afterId: NodeId | null = null,
    parentId: NodeId = props.parentId,
  ) => {
    props.setUi((prev) => {
      const next = requestFocusState(
        prev,
        focusTarget(parentId, parentId, props.panelId, 'trailing'),
        cursorEnd(),
      );
      return afterId
        ? {
          ...next,
          trailingDraftPlacement: { parentId, afterId, panelId: props.panelId },
        }
        : next;
    });
  };

  // Append an existing pool option as a reference (the additive options overlay),
  // then return to the trailing draft for the next value. The typed query is
  // discarded — the user picked an option rather than creating from the text.
  const selectOptionAndAdvance = (optionId: NodeId) => {
    setOptionsOpen(false);
    const pendingParentId = props.fieldValue?.entryId ?? props.parentId;
    const option = props.index.byId.get(optionId);
    if (!props.fieldValue || !option) return;
    startOptimisticDraftMaterialization({
      content: EMPTY_RICH_TEXT,
      nodeOverride: {
        ...makeDraftNode(props.nodeId, props.parentId),
        type: 'reference',
        targetId: optionId,
      },
      command: (change) => props.fieldValue!.onSelectOption(optionId, change.id),
    });
    focusTrailingDraft(null, pendingParentId);
  };

  // Materialize the current draft (body or field value) then advance to the next
  // trailing draft. Shared by Enter and the options overlay's create affordance —
  // both create a value from the typed text via the same path.
  const materializeDraftAndAdvance = () => {
    const materialized = materializeDraft();
    focusTrailingDraft(
      !props.fieldValue ? props.nodeId : null,
      materializedFieldParentIdRef.current ?? props.fieldValue?.entryId ?? props.parentId,
    );
    return materialized;
  };

  // Commit a date the picker produced. A draft materializes with the picked text
  // (seed = date); a committed value replaces its text. The replace is queued on
  // the same patch chain as the materialize, so a quick second pick (e.g. adding
  // an end date before the create resolves) still lands on the real node.
  const commitDateValue = (nextValue: string) => {
    const text = plainText(nextValue);
    if (props.draft && !realNode && !materializeStartedRef.current) {
      if (!nextValue.trim()) {
        setDateOverlayOpen(false);
        return;
      }
      replaceLocalDraftContent(text);
      materializeDraft();
      return;
    }
    replaceLocalDraftContent(text);
    applyTextPatch(replaceAllRichTextPatch(text));
  };

  const clearPendingRemoval = (nodeId: NodeId) => {
    props.setUi((prev) => clearOptimisticRemovals(prev, [nodeId]));
  };

  const reconcilePendingStructuralChange = async (change: PendingStructuralChange): Promise<boolean> => {
    const latest = change.latestContent.current;
    if (richTextEquals(latest, change.initialContent)) return true;
    return await props.run(
      () => api.replaceNodeText(change.id, latest),
      { applyFocus: false },
    ) !== null;
  };

  const startPendingStructuralCommand = (
    input: BeginOptimisticStructuralEditInput,
    command: (change: PendingStructuralChange) => Promise<unknown | null>,
    onRejected: () => void,
    retainOnRejected = false,
  ) => startOptimisticStructuralEdit({
    panelId: props.panelId,
    setUi: props.setUi,
    input,
    command,
    reconcile: (_result, pendingChange) => reconcilePendingStructuralChange(pendingChange),
    onRejected,
    retainOnRejected,
  }).settlement;

  const startDependentContentEnter = (
    source: PendingStructuralChange,
    payload: EditorSplitPayload,
  ) => {
    const insertsBefore = payload.atStart && !payload.atEnd;
    const splitsContent = !payload.atStart && !payload.atEnd;
    if (!insertsBefore) {
      source.latestContent.current = payload.before;
      replaceLocalDraftContent(payload.before);
    }
    void startPendingStructuralCommand(
      {
        parentId: source.parentId,
        ...(insertsBefore ? { beforeId: source.id } : { afterId: source.id }),
        content: splitsContent ? payload.after : EMPTY_RICH_TEXT,
        placement: insertsBefore || payload.atEnd ? cursorEnd() : cursorStart(),
      },
      async (change) => {
        if (!await source.settlement.current) return null;
        const operation = splitsContent
          ? () => api.splitNode(source.id, payload.before, payload.after, {}, change.id)
          : () => api.createNodeRelativeTo(
              source.id,
              source.parentId,
              insertsBefore ? 'before' : 'after',
              EMPTY_RICH_TEXT,
              change.id,
            );
        return props.run(operation, {
          applyFocus: false,
        });
      },
      () => undefined,
      true,
    );
  };

  const restoreFocusAfterStructuralFailure = (hadProjectedNode: boolean) => {
    props.setUi((prev) => requestFocusState(
      prev,
      hadProjectedNode
        ? rowFocusTarget(props.nodeId, props.parentId, props.panelId)
        : focusTarget(props.parentId, props.parentId, props.panelId, 'trailing'),
      cursorEnd(),
    ));
  };

  const startOptimisticReferenceReplacement = (
    target: NodeProjection,
    content: RichText,
    pendingBeforeReplacement: Promise<unknown>,
  ) => {
    const replacementId = freshNodeId();
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const anchors = optimisticReplacementAnchors(siblings, props.nodeId);
    const clearReplacementState = () => {
      flushSync(() => {
        props.setUi((previous) => {
          const restored = clearOptimisticRemovals(previous, [props.nodeId]);
          const withoutConversion = restored.pendingReferenceConversion?.nodeId === replacementId
            ? { ...restored, pendingReferenceConversion: null }
            : restored;
          return requestFocusState(
            withoutConversion,
            rowFocusTarget(props.nodeId, props.parentId, props.panelId),
            cursorEnd(),
          );
        });
      });
    };
    const { settlement } = startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: replacementId,
        parentId: props.parentId,
        ...anchors,
        content,
        nodeOverride: makeDraftNode(replacementId, props.parentId, content),
        placement: cursorAtOffset(0, 'after'),
        updateUi: (previous) => ({
          ...addOptimisticRemovals(previous, [props.nodeId]),
          pendingReferenceConversion: {
            nodeId: replacementId,
            parentId: props.parentId,
            targetId: target.id,
          },
        }),
      },
      command: async (change) => {
        await pendingBeforeReplacement;
        return props.run(() => api.replaceNodeWithReferenceConversion(
          props.nodeId,
          target.id,
          textOf(target),
          change.id,
        ), { applyFocus: false });
      },
      reconcile: async (_result, change) => {
        if (!await reconcilePendingStructuralChange(change)) return false;
        clearPendingRemoval(props.nodeId);
        return true;
      },
      onRejected: clearReplacementState,
      onFailed: clearReplacementState,
    });
    pendingTextPatchRef.current = settlement;
  };

  const startOptimisticFieldConversion = () => {
    const priorChange = props.optimisticChange;
    const hadProjectedNode = Boolean(realNode) || Boolean(priorChange);
    const previousContent = draftContentRef.current;
    const pendingBeforeConversion = pendingTextPatchRef.current;
    const { settlement } = startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: props.nodeId,
        parentId: props.parentId,
        originatesFromDraft: !hadProjectedNode || priorChange?.originatesFromDraft === true,
        beforeId: priorChange?.beforeId,
        afterId: priorChange?.afterId ?? props.draftAfterId,
        presentation: 'field',
        content: EMPTY_RICH_TEXT,
        placement: cursorAll(),
        updateSource: () => replaceLocalDraftContent(EMPTY_RICH_TEXT),
      },
      command: async (change) => {
        if (priorChange && !await priorChange.settlement.current) return null;
        await pendingBeforeConversion;
        const operation = virtualFieldValueDraft && props.fieldValue
          ? () => props.fieldValue!.materializeField(change.id)
          : hadProjectedNode
            ? () => createPlaceholderInlineFieldAfterNode(change.id, 'plain')
            : () => createPlaceholderInlineField(
                props.parentId,
                currentDraftCreateIndex(),
                'plain',
                change.id,
              );
        return props.run(operation, {
          applyFocus: false,
          beforeApply: virtualFieldValueDraft ? rememberMaterializedFieldEntry : undefined,
        });
      },
      reconcile: async (outcome, change) => {
        if (!('update' in outcome)) return true;
        const fieldDefId = fieldDefinitionIdFromInlineFieldOutcome(outcome, change.id);
        if (change.resolvedFieldDefId) change.resolvedFieldDefId.current = fieldDefId;
        const name = change.latestFieldName?.current.trim() ?? '';
        if (!fieldDefId || !name) return true;
        return await props.run(() => api.replaceNodeText(fieldDefId, plainText(name)), {
          applyFocus: false,
        }) !== null;
      },
      onRejected: () => {
        replaceLocalDraftContent(previousContent);
        restoreFocusAfterStructuralFailure(hadProjectedNode);
        materializeStartedRef.current = false;
      },
      onFailed: () => {
        materializeStartedRef.current = false;
      },
    });
    pendingTextPatchRef.current = settlement;
  };

  const startOptimisticContentConversion = (params: {
    content: RichText;
    presentation: 'content' | 'codeBlock';
    nodeOverride?: ContentBearingNodeProjection;
    fieldValueTree: CreateNodeTree;
    convert: (nodeId: NodeId, content: RichText) => Promise<CommandResult>;
    create: (
      parentId: NodeId,
      index: number | null,
      content: RichText,
      id: NodeId,
    ) => Promise<CommandResult>;
  }) => {
    const priorChange = props.optimisticChange;
    const hadProjectedNode = Boolean(realNode) || Boolean(priorChange);
    const previousContent = draftContentRef.current;
    const pendingBeforeConversion = pendingTextPatchRef.current;
    const { settlement } = startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: props.nodeId,
        parentId: props.parentId,
        originatesFromDraft: !hadProjectedNode || priorChange?.originatesFromDraft === true,
        beforeId: priorChange?.beforeId,
        afterId: priorChange?.afterId ?? props.draftAfterId,
        presentation: params.presentation,
        content: params.content,
        nodeOverride: params.nodeOverride,
        placement: cursorEnd(),
        updateSource: () => replaceLocalDraftContent(params.content),
      },
      command: async (change) => {
        if (priorChange && !await priorChange.settlement.current) return null;
        await pendingBeforeConversion;
        const operation = virtualFieldValueDraft && props.fieldValue
          ? () => props.fieldValue!.materializeNodes(change.id, [params.fieldValueTree])
          : hadProjectedNode
            ? () => params.convert(change.id, params.content)
            : () => params.create(
                props.parentId,
                currentDraftCreateIndex(),
                params.content,
                change.id,
              );
        return props.run(operation, {
          applyFocus: false,
          beforeApply: virtualFieldValueDraft ? rememberMaterializedFieldEntry : undefined,
        });
      },
      reconcile: (_outcome, change) => reconcilePendingStructuralChange(change),
      onRejected: () => {
        replaceLocalDraftContent(previousContent);
        restoreFocusAfterStructuralFailure(hadProjectedNode);
        materializeStartedRef.current = false;
      },
      onFailed: () => {
        materializeStartedRef.current = false;
      },
    });
    pendingTextPatchRef.current = settlement;
  };

  const startOptimisticCodeBlockConversion = (content: RichText = EMPTY_RICH_TEXT) => {
    startOptimisticContentConversion({
      content,
      presentation: 'codeBlock',
      fieldValueTree: { content, children: [], type: 'codeBlock' },
      convert: api.convertNodeToCodeBlock,
      create: api.createCodeBlock,
    });
  };

  const startOptimisticHeadingConversion = (content: RichText) => {
    const source = props.optimisticChange?.nodeOverride?.current
      ?? realNode
      ?? makeDraftNode(props.nodeId, props.parentId, content);
    startOptimisticContentConversion({
      content,
      presentation: 'content',
      nodeOverride: { ...source, content },
      fieldValueTree: { content, children: [] },
      convert: api.replaceNodeText,
      create: api.createRichTextNode,
    });
  };

  const startOptimisticCheckboxConversion = (content: RichText) => {
    const source = props.optimisticChange?.nodeOverride?.current
      ?? realNode
      ?? makeDraftNode(props.nodeId, props.parentId, content);
    startOptimisticContentConversion({
      content,
      presentation: 'content',
      nodeOverride: { ...source, content, completedAt: 0 },
      fieldValueTree: { content, children: [], checkbox: true, done: false },
      convert: api.convertNodeToCheckbox,
      create: api.createCheckboxNode,
    });
  };

  const handleEnter = async (payload: EditorSplitPayload) => {
    if (props.trigger?.nodeId === props.nodeId) return;
    if (props.optimisticChange?.phase === 'submitting' && !realNode) {
      if (props.fieldValue) {
        focusTrailingDraft(null, props.parentId);
      } else if (props.optimisticChange.presentation === 'content') {
        startDependentContentEnter(props.optimisticChange, payload);
      }
      return;
    }
    if (props.draft && !realNode) {
      const buffered = draftContentRef.current;
      const bodyDraftHasContent = !props.fieldValue
        && (buffered.text.trim().length > 0 || buffered.inlineRefs.length > 0);
      if (bodyDraftHasContent) {
        // A body draft with typed text: materialize it into a real node, then open a
        // real empty continuation sibling below and focus it — Enter both commits the
        // text and lands on a fresh line, exactly like Enter at the end of a normal
        // row. (An empty body draft, or any field-value draft, instead advances to the
        // renderer trailing draft via materializeDraftAndAdvance, so Enter there never
        // leaks a stray empty sibling.)
        if (!payload.atEnd) replaceLocalDraftContent(payload.before);
        materializeDraft();
        const source = props.uiRef.current.pendingStructuralChanges.find((change) => (
          change.id === props.nodeId && change.panelId === props.panelId
        ));
        if (source) {
          startDependentContentEnter(source, payload);
          return;
        }
        const materializedIndex = currentDraftCreateIndex();
        const continuationIndex = materializedIndex === null ? null : materializedIndex + 1;
        await pendingTextPatchRef.current;
        await props.run(() => api.createNode(
          props.parentId,
          continuationIndex,
          payload.atEnd ? '' : payload.after.text,
        ));
        return;
      }
      await materializeDraftAndAdvance();
      return;
    }
    if (props.fieldValue) {
      // A committed field value row. Every field value (option reference or plain
      // text) appends the next value through the trailing draft, so Enter points
      // focus there rather than splitting/creating a sibling node directly.
      focusTrailingDraft();
      return;
    }
    if (props.tableNextRowId) {
      void commitDraft(draftContentRef.current);
      requestRowFocus(props.tableNextRowId, cursorStart(), props.parentId);
      return;
    }
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    if (payload.atStart && !payload.atEnd) {
      await startPendingStructuralCommand(
        {
          parentId: props.parentId,
          beforeId: props.nodeId,
          content: EMPTY_RICH_TEXT,
          placement: cursorEnd(),
        },
        async (pendingDraft) => {
          await pendingTextPatchRef.current;
          return props.run(
            () => api.createNode(
              props.parentId,
              rowIndex >= 0 ? rowIndex : null,
              '',
              pendingDraft.id,
            ),
            { applyFocus: false },
          );
        },
        () => {
          flushSync(() => {
            props.setUi((prev) => requestFocusState(
              prev,
              rowFocusTarget(props.nodeId, props.parentId, props.panelId),
              cursorStart(),
            ));
          });
        },
      );
      return;
    }
    if (!payload.atEnd) {
      const contentBeforeSplit = draftContentRef.current;
      const expandedNow = isRowExpanded(
        props.nodeId,
        props.index.byId,
        props.uiRef.current.expanded,
      );
      const splitIntoChildren = node.type !== 'reference'
        && expandedNow
        && rowScopeChildIds.length > 0;
      const targetParentId = splitIntoChildren ? props.nodeId : props.parentId;
      const targetIndex = splitIntoChildren
        ? firstContentChildIndex >= 0 ? firstContentChildIndex : null
        : rowIndex >= 0 ? rowIndex + 1 : null;
      await startPendingStructuralCommand(
        {
          parentId: targetParentId,
          ...(splitIntoChildren
            ? { beforeId: firstContentChildId ?? null }
            : { afterId: props.nodeId }),
          content: payload.after,
          placement: cursorStart(),
          updateSource: () => replaceLocalDraftContent(payload.before),
        },
        async (pendingDraft) => {
          await pendingTextPatchRef.current;
          return props.run(() => api.splitNode(targetEditId, payload.before, payload.after, {
            ...(node.type === 'reference'
              ? { targetParentId: props.parentId, targetIndex: rowIndex >= 0 ? rowIndex + 1 : null }
              : splitIntoChildren
                ? { targetParentId: props.nodeId, targetIndex }
                : {}),
            focusPlacement: { kind: 'start' },
          }, pendingDraft.id), { applyFocus: false });
        },
        () => {
          flushSync(() => {
            replaceLocalDraftContent(contentBeforeSplit);
            props.setUi((prev) => requestFocusState(
              prev,
              rowFocusTarget(props.nodeId, props.parentId, props.panelId),
              cursorAtOffset(payload.before.text.length),
            ));
          });
        },
      );
      return;
    }
    const expandedNow = isRowExpanded(
      props.nodeId,
      props.index.byId,
      props.uiRef.current.expanded,
    );
    const createInExpandedScope = expandedNow && rowScopeChildIds.length > 0;
    const targetParentId = createInExpandedScope ? childParentId : props.parentId;
    const targetIndex = createInExpandedScope
      ? firstContentChildIndex >= 0 ? firstContentChildIndex : null
      : rowIndex >= 0 ? rowIndex + 1 : null;
    await startPendingStructuralCommand(
      {
        parentId: targetParentId,
        ...(createInExpandedScope
          ? { beforeId: firstContentChildId ?? null }
          : { afterId: props.nodeId }),
        content: EMPTY_RICH_TEXT,
        placement: cursorEnd(),
      },
      async (pendingDraft) => {
        await commitDraft(payload.before);
        return props.run(
          () => api.createNode(targetParentId, targetIndex, '', pendingDraft.id),
          { applyFocus: false },
        );
      },
      () => {
        flushSync(() => {
          props.setUi((prev) => requestFocusState(
            prev,
            rowFocusTarget(props.nodeId, props.parentId, props.panelId),
            cursorEnd(),
          ));
        });
      },
    );
  };

  const handleModEnter = (content: RichText) => {
    const emptyDraft = content.text.trim().length === 0 && content.inlineRefs.length === 0;
    if (props.draft && !realNode) {
      draftContentRef.current = content;
      setDraftContent(content);
      // Empty field values intentionally do not materialize. Every other trailing
      // draft must become a real node before checkbox commands target it.
      if (props.fieldValue && emptyDraft) return;
    }
    void startDoneTransition('cycle', async () => {
      if (props.draft && !realNode) {
        if (!await materializeDraft()) return null;
      } else {
        setDraftContent(content);
        await commitDraft(content);
      }
      return props.run(() => api.cycleDoneState(targetEditId));
    });
  };

  const handleCodeBlockTextChange = (text: string) => {
    const content = plainText(text);
    handleEditorChange(content);
    applyTextPatch(replaceAllRichTextPatch(content));
  };

  const handleCodeBlockExit = async () => {
    const content = draftContentRef.current;
    await handleEnter({
      before: content,
      after: EMPTY_RICH_TEXT,
      atStart: content.text.length === 0 && content.inlineRefs.length === 0,
      atEnd: true,
    });
  };

  const handleSetCodeLanguage = (language: string) => {
    void props.run(() => api.setCodeLanguage(targetEditId, language), { applyFocus: false });
  };

  const handleBackspaceAtStart = async (isEmpty: boolean) => {
    if (props.draft && !realNode) {
      // The trailing draft has no real node: never trash/merge. When it is the
      // lone affordance under an empty expanded body node, Backspace collapses
      // that node back to a leaf (mirrors the former trailing-input behaviour);
      // otherwise it just steps up to the previous visible row.
      const parentIsEmptyLeaf = !props.fieldValue
        && props.parentId !== props.rootId
        && outlinerChildren(props.index.byId.get(props.parentId), props.index.byId).length === 0;
      if (parentIsEmptyLeaf) {
        props.setUi((prev) => {
          const expanded = new Set(prev.expanded);
          expanded.delete(props.parentId);
          return { ...prev, expanded };
        });
      }
      focusPreviousFromDraft();
      return;
    }
    const intent = resolveContentRowBackspaceAtStartIntent({
      isEmpty,
      hasChildren: rowScopeChildIds.length > 0,
    });
    if (intent === 'block_delete_parent') {
      return;
    }
    if (intent === 'delete_empty') {
      const liveUi = props.uiRef.current;
      const visibleRows = flattenVisibleRows(
        props.rootId,
        props.index.byId,
        liveUi.expanded,
        liveUi.expandedHiddenFields,
      );
      const currentIndex = visibleRows.indexOf(props.nodeId);
      const previousId = currentIndex > 0 ? visibleRows[currentIndex - 1] : null;
      const nextId = currentIndex >= 0 && currentIndex < visibleRows.length - 1 ? visibleRows[currentIndex + 1] : null;
      const targetForId = (id: NodeId) => {
        const targetRow = selectableRowForId(id, props.selectionRootId, props.index.byId);
        const targetParentId = targetRow?.parentId ?? null;
        return outlinerNavigationFocusTarget(
          id,
          targetParentId,
          props.panelId,
          targetRow?.kind ?? 'content',
        );
      };
      // A field value routes through removeFieldValue so an auto-collected value
      // also drops its mirror reference in the option pool (no orphan options);
      // a body node just goes to Trash. The renderer owns focus because the
      // deleted row may be the first or only visible row in the current scope.
      const focusAfterRemoval = (prev: UiState) => {
        if (previousId) {
          return requestFocusState(prev, targetForId(previousId), cursorEnd());
        }
        if (nextId) {
          return requestFocusState(prev, targetForId(nextId), cursorStart());
        }
        return requestFocusState(
          prev,
          focusTarget(props.parentId, props.parentId, props.panelId, 'trailing'),
          cursorEnd(),
        );
      };
      await startOptimisticRemoval({
        ids: [props.nodeId],
        setUi: props.setUi,
        updateUi: focusAfterRemoval,
        command: () => props.fieldValue
          ? props.run(() => api.removeFieldValue(props.nodeId), { applyFocus: false })
          : props.run(() => api.trashNode(props.nodeId), { applyFocus: false }),
        onRejected: () => {
          flushSync(() => {
            props.setUi((prev) => requestFocusState(
              prev,
              rowFocusTarget(props.nodeId, props.parentId, props.panelId),
              cursorStart(),
            ));
          });
        },
      });
      return;
    }

    const visibleRows = flattenVisibleRows(
      props.rootId,
      props.index.byId,
      props.uiRef.current.expanded,
      props.uiRef.current.expandedHiddenFields,
    );
    const previousId = previousVisibleRowId(visibleRows, props.nodeId);
    if (!previousId) return;

    const previousNode = props.index.byId.get(previousId);
    if (!previousNode || !isContentBearingNode(previousNode)) return;

    // Backspacing a reference row itself has nothing to merge away — just step
    // up. But merging *into* a reference is allowed: core converts that
    // reference into a leading inline reference on the joined row.
    if (node.type === 'reference') {
      requestRowFocus(previousId);
      return;
    }

    if (!previousNode.parentId) return;
    const resolvedReferenceTargetId = previousNode.type === 'reference' && previousNode.targetId
      ? resolveReferenceTargetId(previousNode.targetId, props.index.byId) ?? undefined
      : undefined;
    const mergedNode = optimisticMergedNode({
      target: previousNode,
      source: node,
      sourceContent: draftContentRef.current,
      resolvedReferenceTargetId,
      referenceDisplayName: resolvedReferenceTargetId
        ? contentTextForNode(props.index.byId.get(resolvedReferenceTargetId)) || undefined
        : undefined,
    });
    const joinOffset = previousNode.type === 'reference'
      ? 0
      : previousNode.content.text.length;
    const pendingCommit = commitDraft();
    startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: previousId,
        parentId: previousNode.parentId,
        content: mergedNode.content,
        nodeOverride: mergedNode,
        placement: cursorAtOffset(joinOffset),
        updateUi: (previous) => addOptimisticRemovals(previous, [props.nodeId]),
      },
      command: async () => {
        await pendingCommit;
        return props.run(() => api.mergeNodeInto(props.nodeId, previousId), {
          applyFocus: false,
        });
      },
      reconcile: async (_result, change) => {
        if (!await reconcilePendingStructuralChange(change)) return false;
        clearPendingRemoval(props.nodeId);
        return true;
      },
      onRejected: () => {
        flushSync(() => {
          clearPendingRemoval(props.nodeId);
          props.setUi((previous) => requestFocusState(
            previous,
            rowFocusTarget(props.nodeId, props.parentId, props.panelId),
            cursorStart(),
          ));
        });
      },
    });
  };

  const handleTab = async (shiftKey: boolean, cursorOffset: number) => {
    const relocate = (input: {
      targetParentId: NodeId;
      beforeId?: NodeId | null;
      afterId?: NodeId | null;
      expandId?: NodeId;
      collapseIds?: ReadonlySet<NodeId>;
      operation: () => Promise<CommandResult>;
    }) => {
      const pendingCommit = commitDraft();
      animateOutlinerRowMovementAfterNextCommit();
      const { settlement } = startOptimisticRelocation({
        panelId: props.panelId,
        setUi: props.setUi,
        currentUi: props.uiRef.current,
        id: props.nodeId,
        sourceParentId: props.parentId,
        targetParentId: input.targetParentId,
        beforeId: input.beforeId,
        afterId: input.afterId,
        content: draftContentRef.current,
        placement: cursorAtOffset(cursorOffset),
        expandId: input.expandId,
        collapseIds: input.collapseIds,
        command: async () => {
          await pendingCommit;
          return props.run(input.operation, { applyFocus: false });
        },
        reconcile: (_result, change) => reconcilePendingStructuralChange(change),
      });
      return settlement;
    };
    if (props.draft && !realNode) {
      // Structural keys RELOCATE the empty trailing draft instead of materializing
      // a node: it stays a draft and nothing is created until the user types
      // (matching the "draft stays a draft" model and the Trailing Input Matrix).
      // The draft sits after its parent's last child:
      //   Tab       → move it under that last child (the previous sibling), expanding it;
      //   Shift+Tab → move it up to the grandparent's trailing.
      // Relocation is pure focus + expand — no create, no indent IPC, so there is
      // no materialize→indent flicker and no stray empty node.
      if (!shiftKey) {
        const siblingRows = buildOutlinerRows(
          parentNode,
          props.index.byId,
          { expandedHiddenFields: props.uiRef.current.expandedHiddenFields },
        );
        const indentTarget = previousDraftSiblingId(siblingRows, props.draftAfterId ?? null);
        if (!indentTarget) return; // no previous sibling to nest under
        const buffered = draftContentRef.current;
        const hasBufferedValue = Boolean(props.fieldValue)
          && (buffered.text.trim().length > 0 || buffered.inlineRefs.length > 0);
        if (hasBufferedValue) {
          // Materialization and indent are one visible transaction. Runtime still
          // creates the value before moving it, but the renderer places the stable
          // draft id under its target immediately instead of showing an entry-level
          // row until both requests settle.
          const materialized = materializeDraft();
          const target = props.index.byId.get(indentTarget);
          const { settlement } = startOptimisticRelocation({
            panelId: props.panelId,
            setUi: props.setUi,
            currentUi: props.uiRef.current,
            id: props.nodeId,
            sourceParentId: props.parentId,
            targetParentId: indentTarget,
            afterId: outlinerChildren(target, props.index.byId).at(-1) ?? null,
            content: buffered,
            placement: cursorAtOffset(cursorOffset),
            expandId: indentTarget,
            retainOnRejected: true,
            command: async () => {
              if (!await materialized) return null;
              return props.run(() => api.indentNode(props.nodeId), { applyFocus: false });
            },
            reconcile: (_result, change) => reconcilePendingStructuralChange(change),
          });
          pendingTextPatchRef.current = settlement;
          await settlement;
          return;
        }
        props.setUi((prev) => {
          const expanded = new Set(prev.expanded);
          expanded.add(indentTarget);
          return requestFocusState(
            { ...prev, expanded },
            focusTarget(indentTarget, indentTarget, props.panelId, 'trailing'),
            cursorEnd(),
          );
        });
        return;
      }
      if (props.parentId === props.rootId) return; // already at the top level
      const grandParentId = props.index.byId.get(props.parentId)?.parentId;
      if (!grandParentId) return;
      props.setUi((prev) => ({
        ...requestFocusState(
          prev,
          focusTarget(grandParentId, grandParentId, props.panelId, 'trailing'),
          cursorEnd(),
        ),
        trailingDraftPlacement: {
          parentId: grandParentId,
          afterId: props.parentId,
          panelId: props.panelId,
        },
      }));
      return;
    }
    if (!shiftKey) {
      const targetParentId = indentTargetParentId(props.nodeId, props.index.byId);
      if (!targetParentId) return;
      const target = props.index.byId.get(targetParentId);
      await relocate({
        targetParentId,
        afterId: outlinerChildren(target, props.index.byId).at(-1) ?? null,
        expandId: targetParentId,
        operation: () => api.indentNode(props.nodeId),
      });
      return;
    }
    if (props.parentId === props.rootId) return;
    const emptiedParentIds = parentIdsEmptiedByOutdent([props.nodeId], props.index.byId, props.rootId);
    const targetParentId = props.index.byId.get(props.parentId)?.parentId;
    if (!targetParentId) return;
    await relocate({
      targetParentId,
      afterId: props.parentId,
      collapseIds: emptiedParentIds,
      operation: () => api.outdentNode(props.nodeId),
    });
  };

  const moveCurrentNode = async (direction: 'up' | 'down') => {
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const currentIndex = siblings.indexOf(props.nodeId);
    const anchorId = direction === 'up'
      ? siblings[currentIndex - 1]
      : siblings[currentIndex + 1];
    if (currentIndex < 0 || !anchorId) return;
    const pendingCommit = commitDraft();
    animateOutlinerRowMovementAfterNextCommit();
    await startOptimisticRelocation({
      panelId: props.panelId,
      setUi: props.setUi,
      currentUi: props.uiRef.current,
      id: props.nodeId,
      sourceParentId: props.parentId,
      targetParentId: props.parentId,
      ...(direction === 'up' ? { beforeId: anchorId } : { afterId: anchorId }),
      content: draftContentRef.current,
      placement: cursorEnd(),
      command: async () => {
        await pendingCommit;
        return props.run(() => (
          direction === 'up'
            ? api.batchMoveNodesUp([props.nodeId])
            : api.batchMoveNodesDown([props.nodeId])
        ), { applyFocus: false });
      },
      reconcile: (_result, change) => reconcilePendingStructuralChange(change),
    }).settlement;
  };

  const exitToSelection = () => {
    if (props.trigger?.nodeId === props.nodeId) {
      props.setTrigger(null);
      return;
    }
    void commitDraft();
    const selectionId = props.nodeId;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: selectionId,
      selectedIds: new Set([selectionId]),
      selectionAnchorId: selectionId,
      selectionRootId: props.selectionRootId,
      selectionSource: 'global',
    }));
  };

  const openContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: props.nodeId,
      selectedIds: prev.selectedIds.has(props.nodeId) ? new Set(prev.selectedIds) : new Set([props.nodeId]),
      selectionAnchorId: prev.selectedIds.has(props.nodeId) ? prev.selectionAnchorId ?? props.nodeId : props.nodeId,
      selectionRootId: props.selectionRootId,
      selectionSource: 'global',
    }));
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const focusEditorFromRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('button, a, input, textarea, select, [data-preserve-selection]')) return;

    if (node.type === 'reference') {
      event.preventDefault();
      event.stopPropagation();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      selectRow(props.nodeId);
      return;
    }

    if (displayed.locked) return;

    const editor = event.currentTarget.querySelector<HTMLElement>('.ProseMirror');
    if (!editor) return;

    const clickedInsideEditor = Boolean(target?.closest('.ProseMirror'));
    const rightEdge = renderedTextRightEdge(editor);
    if (clickedInsideEditor && (rightEdge === null || event.clientX <= rightEdge + 1)) return;

    event.preventDefault();
    event.stopPropagation();
    const offset = resolveTextOffsetFromPoint({
      container: editor,
      clientX: event.clientX,
      clientY: event.clientY,
      textLength: draftContent.text.length,
    });
    const editorRect = editor.getBoundingClientRect();
    const inlineRefBias = event.clientX <= editorRect.left + 2 ? 'before' : 'after';
    if (props.draft && !realNode) {
      // A draft editor consumes the parent's trailing focus request (its
      // focusTarget is the trailing surface), so route the click there too; once
      // focused, onFocus settles the signal to this row's own id.
      props.setUi((prev) => requestFocusState(
        prev,
        focusTarget(props.parentId, props.parentId, props.panelId, 'trailing'),
        cursorAtOffset(offset, inlineRefBias),
      ));
      return;
    }
    requestRowFocus(props.nodeId, cursorAtOffset(offset, inlineRefBias), props.parentId);
  };

  const selectReferenceLikeRowFromPointer = (event: MouseEvent<HTMLDivElement>) => {
    if (!referenceLikeRow || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('button, a, input, textarea, select, [data-preserve-selection]')) return;
    const pendingConversion = props.ui.pendingReferenceConversion;
    if (
      pendingConversion?.nodeId === props.nodeId
      && isOnlyInlineReference(draftContentRef.current, pendingConversion.targetId)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== 'click') return;
      const content = draftContentRef.current;
      void restorePendingReferenceConversion(content).then((result) => {
        if (result.restored) selectRow(result.nodeId);
      });
      return;
    }
    const clickedInlineReference = Boolean(target?.closest('[data-inline-ref], .inline-ref'));
    if (clickedInlineReference) return;
    const editor = event.currentTarget.querySelector<HTMLElement>('.ProseMirror');
    if (row.focused && editor && target && event.currentTarget.contains(target)) {
      if (editor.contains(target)) return;
      if (displayed.locked) return;
      event.preventDefault();
      event.stopPropagation();
      const offset = resolveTextOffsetFromPoint({
        container: editor,
        clientX: event.clientX,
        clientY: event.clientY,
        textLength: draftContent.text.length,
      });
      const editorRect = editor.getBoundingClientRect();
      const inlineRefBias = event.clientX <= editorRect.left + 2 ? 'before' : 'after';
      requestRowFocus(props.nodeId, cursorAtOffset(offset, inlineRefBias), props.parentId);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (props.uiRef.current.selectedIds.size > 1 && !displayed.locked) {
      if (!editor) return;
      const offset = resolveTextOffsetFromPoint({
        container: editor,
        clientX: event.clientX,
        clientY: event.clientY,
        textLength: draftContent.text.length,
      });
      const editorRect = editor.getBoundingClientRect();
      const inlineRefBias = event.clientX <= editorRect.left + 2 ? 'before' : 'after';
      requestRowFocus(props.nodeId, cursorAtOffset(offset, inlineRefBias), props.parentId);
      return;
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    selectRow(props.nodeId);
  };

  const focusReferenceTargetFromDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((!referenceLikeRow || displayed.locked)) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('button, a, input, textarea, select, [data-preserve-selection]')) return;
    if (target?.closest('[data-inline-ref], .inline-ref') && !pendingReferenceConversion) return;
    event.preventDefault();
    event.stopPropagation();
    const editor = event.currentTarget.querySelector<HTMLElement>('.ProseMirror');
    if (!editor) return;
    const offset = resolveTextOffsetFromPoint({
      container: editor,
      clientX: event.clientX,
      clientY: event.clientY,
      textLength: draftContent.text.length,
    });
    const editorRect = editor.getBoundingClientRect();
    const inlineRefBias = event.clientX <= editorRect.left + 2 ? 'before' : 'after';
    requestRowFocus(props.nodeId, cursorAtOffset(offset, inlineRefBias), props.parentId);
  };
  const showSelectedReferenceOptionPicker = Boolean(
    props.optionField
    && props.onSelectOption
    && node.type === 'reference'
    && !props.ui.focusedId
    && props.ui.selectedIds.size === 1
    && props.ui.selectedIds.has(props.nodeId),
  );
  const appendSelectedOption = (optionId: NodeId) => {
    if (!props.onSelectOption) return;
    const option = props.index.byId.get(optionId);
    if (!option) return;
    const dependency = latestOptimisticStructuralDependency(
      props.uiRef.current,
      props.panelId,
      props.parentId,
      props.nodeId,
    );
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const valueId = freshNodeId();
    startOptimisticStructuralEdit({
      panelId: props.panelId,
      setUi: props.setUi,
      input: {
        id: valueId,
        parentId: props.parentId,
        afterId: dependency?.id ?? siblings.at(-1) ?? null,
        content: EMPTY_RICH_TEXT,
        nodeOverride: {
          ...makeDraftNode(valueId, props.parentId),
          type: 'reference',
          targetId: optionId,
        },
        placement: cursorStart(),
        preserveFocus: true,
      },
      command: async (change) => {
        if (dependency && !await dependency.settlement.current) return null;
        return props.onSelectOption!(optionId, change.id);
      },
    });
  };

  const outlineSourcePreview = realNode && props.outlineSourcePreviewKey ? (
    <OutlineSourcePreview
      accessibleName={realNode.content.text.trim() || undefined}
      index={props.index}
      ownerId={realNode.id}
      run={props.run}
    />
  ) : null;
  const fieldValueAffordances = hasFieldValueAffordances ? (
    <span className="field-value-affordances" data-preserve-selection>
      {fieldValueHint && (
        <span
          className="field-value-hint"
          role="img"
          title={fieldValueHint}
          aria-label={fieldValueHint}
        >
          <WarningIcon size={ICON_SIZE.menu} />
        </span>
      )}
      {fieldValueHref && (
        <ButtonControl
          className="field-value-affordance field-value-open"
          aria-label={tf.openLink}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void api.openExternalUrl(fieldValueHref)}
        ><OpenIcon size={12} strokeWidth={1.8} /></ButtonControl>
      )}
      {showDateTrigger && (
        <ButtonControl
          className="field-value-affordance field-value-date-trigger"
          aria-label={tf.pickADate}
          aria-expanded={dateOverlayOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setDateOverlayOpen((open) => !open)}
        >
          <CalendarIcon size={13} strokeWidth={1.8} />
        </ButtonControl>
      )}
      {sourcePreviewAction}
    </span>
  ) : null;

  // The row's primary focus surface. Checkbox drafts and committed values keep
  // the same control and Node ID, so materialization cannot remount the editor.
  const rowEditorElement = checkboxFieldValue && props.fieldValue ? (
    <CheckboxFieldControl
      value={realNode
        ? displayed.content.text
        : draftContent.text || props.fieldValue.displayValue || ''}
      inherited={!realNode && props.fieldValue.inheritedDisplayValue}
      onToggle={(value) => {
        const content = plainText(value);
        if (!realNode) {
          replaceLocalDraftContent(content);
          void materializeDraft();
          return;
        }
        void startOptimisticNodePatch({
          currentUi: props.uiRef.current,
          setUi: props.setUi,
          patch: pendingNodePatch(targetEditId, { content }),
          command: () => props.run(
            () => api.replaceNodeText(targetEditId, content),
            { applyFocus: false },
          ),
        });
      }}
      focusTarget={editorFocusTarget}
      focusRequest={props.ui.focusRequest}
      onFocus={row.updateSelection}
      onFocusRequestConsumed={(request) => {
        props.setUi((prev) => clearFocusRequestState(prev, request));
      }}
      onTab={(shiftKey) => void handleTab(shiftKey, 0)}
      onArrowUpAtStart={() => row.moveFocus(-1)}
      onArrowDownAtEnd={() => row.moveFocus(1)}
      onShiftArrow={() => selectRow(props.nodeId, 'global')}
      onEscape={() => selectRow(props.nodeId, 'global')}
    />
  ) : isCodeBlock ? (
    <CodeBlockRow
      nodeId={props.nodeId}
      text={renderedDraftContent.text}
      language={displayed.codeLanguage}
      readOnly={displayed.locked}
      onFocus={row.updateSelection}
      onTextChange={handleCodeBlockTextChange}
      onCommit={(text) => void commitDraft(plainText(text))}
      onSetLanguage={handleSetCodeLanguage}
      onExitToNewRow={() => void handleCodeBlockExit()}
      onBackspaceAtStart={() => void handleBackspaceAtStart(true)}
      onArrowUpAtStart={() => row.moveFocus(-1)}
      onArrowDownAtEnd={() => row.moveFocus(1)}
      onShiftArrow={() => void exitToSelection()}
      onEscape={() => void exitToSelection()}
      onUndo={() => void props.run(() => api.undo())}
      onRedo={() => void props.run(() => api.redo())}
      focusTarget={editorFocusTarget}
      focusRequest={props.ui.focusRequest}
      pendingInput={props.ui.pendingInputChar}
      onFocusRequestConsumed={(request) => {
        props.setUi((prev) => clearFocusRequestState(prev, request));
      }}
      onPendingInputConsumed={(input) => {
        props.setUi((prev) => clearPendingInputState(prev, input));
      }}
    />
  ) : (
    <RichTextEditor
      nodeId={props.nodeId}
      content={renderedDraftContent}
      contentRevision={editorContentRevision}
      inlineSlotEl={inlineContentSlot}
      readOnly={displayed.locked}
      completed={Boolean(displayed.completedAt)}
      placeholder={fieldValueDraft
        ? props.fieldValue?.placeholder
        : (props.draft === true && !realNode ? props.draftPlaceholder : undefined)}
      onFocus={() => {
        row.updateSelection();
        // optionPicker: open the picker overlay on a genuine user focus (click)
        // so you can type-to-filter. Suppress it
        // when focus arrived programmatically via a focus request — advancing
        // to the next value draft after committing one (Enter / pick) should
        // land closed, not immediately reopen the picker. Typing still reopens
        // it (handleEditorChange).
        const programmaticFocus = Boolean(props.ui.focusRequest)
          && focusTargetMatches(props.ui.focusRequest!.target, editorRequestTarget);
        if (optionPickerDraft && !programmaticFocus) setOptionsOpen(true);
      }}
      onChange={handleEditorChange}
      onPatch={applyTextPatch}
      onCommit={(content) => void commitDraft(content)}
      onEnter={(payload) => void handleEnter(payload)}
      onBackspaceAtStart={(isEmpty) => void handleBackspaceAtStart(isEmpty)}
      onTab={(shiftKey, cursorOffset) => void handleTab(shiftKey, cursorOffset)}
      onArrowUpAtStart={() => (props.draft && !realNode ? focusPreviousFromDraft() : row.moveFocus(-1))}
      onArrowDownAtEnd={() => row.moveFocus(1)}
      onShiftArrow={() => void exitToSelection()}
      onMove={(direction) => void moveCurrentNode(direction)}
      onUndo={() => void props.run(() => api.undo())}
      onRedo={() => void props.run(() => api.redo())}
      onSelectAllRows={selectAllVisibleRows}
      onDescriptionToggle={virtualFieldValueDraft ? undefined : ({ cursorOffset }) => {
        descriptionReturnPlacementRef.current = cursorAtOffset(cursorOffset);
        props.setUi((prev) => requestFocusState(
          { ...prev, editingDescriptionId: targetEditId },
          descriptionFocusTarget,
          cursorEnd(),
        ));
      }}
      onModEnter={(content) => void handleModEnter(content)}
      onEscape={() => void exitToSelection()}
      onSpace={dateFieldValue ? () => {
        // Space summons the date picker only on an empty value, so a typed
        // value (e.g. "next monday") can still contain literal spaces.
        if (draftContentRef.current.text.trim().length > 0) return false;
        setDateOverlayOpen(true);
        return true;
      } : undefined}
      resolveInlineReferenceColor={(targetId) => inlineReferenceTextColor(targetId, props.index)}
      resolveInlineReferenceDisplayName={(targetId) => contentTextForNode(props.index.byId.get(targetId)).trim() || undefined}
      onFieldTriggerFire={suppressTextTriggers ? undefined : () => {
        props.setTrigger(null);
        // Claim the draft synchronously. Replacing the ProseMirror row with the
        // field presentation blurs the old editor; its blur commit must not start
        // a competing plain-node materialization for the same reserved id.
        semanticTriggerResolutionRef.current = true;
        // ProseMirror is still dispatching the transaction that recognized `>`.
        // Switch row presentation in the next microtask so React never tears down
        // the editor from inside that dispatch callback.
        queueMicrotask(() => startOptimisticFieldConversion());
      }}
      onCodeFenceFire={
        !suppressTextTriggers
          && node.type === undefined && !pendingReferenceConversion && !displayed.locked
          ? convertRowToCodeBlock
          : undefined
      }
      onTriggerChange={(nextTrigger) => {
        // optionPicker free text feeds the options filter, not triggers.
        if (suppressTextTriggers) return;
        // Record trigger state synchronously so the patch callback that fires
        // later in this same transaction can suppress eager materialization
        // while a trigger query is open.
        draftTriggerActiveRef.current = Boolean(nextTrigger);
        if (nextTrigger) {
          props.setTrigger({ nodeId: props.nodeId, ...nextTrigger });
        } else if (props.trigger?.nodeId === props.nodeId) {
          props.setTrigger(null);
        }
      }}
      onPasteOutliner={node.type === 'reference' ? undefined : handlePasteOutliner}
      onPasteImage={node.type === 'reference' ? undefined : (images) => void handlePasteImage(images)}
      onPasteFiles={node.type === 'reference' ? undefined : (files) => void handlePasteFiles(files)}
      onPasteBareUrl={
        node.type === undefined && !props.fieldValue && !displayed.locked
          ? handlePasteBareUrl
          : undefined
      }
      onInlineReferenceClick={pendingReferenceConversion
        ? undefined
        : (target, options) => {
          if (target.kind === 'node') {
            props.onRoot(target.nodeId, {
              focus: false,
              newPane: options?.newPane,
            });
            return;
          }
        }}
      focusTarget={editorRequestTarget}
      focusRequest={props.ui.focusRequest}
      pendingInput={props.ui.pendingInputChar}
      onFocusRequestConsumed={(request) => {
        props.setUi((prev) => clearFocusRequestState(prev, request));
      }}
      onPendingInputConsumed={(input) => {
        props.setUi((prev) => clearPendingInputState(prev, input));
      }}
      onCompositionHandoff={(text) => {
        props.setUi((prev) => relayCompositionHandoffState(prev, text));
      }}
    />
  );
  const outlinerWrapProps = {
    ...row.wrapProps,
    ...(exposesTrailingDraftMarker ? { 'data-trailing-parent-id': props.parentId } : {}),
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (hasFileTransfer(event.dataTransfer)) {
        handleExternalFileDragOver(event);
        return;
      }
      row.wrapProps.onDragOver?.(event);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (hasFileTransfer(event.dataTransfer)) {
        handleExternalFileDragLeave(event);
        return;
      }
      row.wrapProps.onDragLeave?.(event);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (hasFileTransfer(event.dataTransfer)) {
        handleExternalFileDrop(event);
        return;
      }
      row.wrapProps.onDrop?.(event);
    },
  };
  const rowLeadingElement = (
    <RowLeading
      hasChildren={row.hasChildren}
      expanded={row.expanded}
      variant={leadingVariant}
      fieldType={projectFieldTypeById(props.index.byId, displayed.id)}
      bulletColors={appliedTagColors}
      tagDefColor={tagDefColor}
      onToggleExpand={toggleRowDisclosure}
      onDrillDown={() => props.onRoot(drillDownId)}
      draggable={row.dragHandleProps.draggable}
      onDragStart={row.dragHandleProps.onDragStart}
      onDragEnd={row.dragHandleProps.onDragEnd}
    />
  );

  return (
    <OutlinerRowShell
      hasChildren={row.hasChildren}
      expandable={row.hasChildren}
      expanded={row.expanded}
      level={props.depth + 1}
      selected={row.rowSelected}
      semanticRole={props.semanticRole}
      wrapProps={outlinerWrapProps}
      rowClassName={row.rowClassName([
        referenceLikeRow ? 'reference-row' : '',
        externalFileDropPosition ? `drop-${externalFileDropPosition}` : '',
        pendingReferenceConversion ? 'ref-converting' : '',
        // Only the ordinary trailing draft reads as a fainter "next" slot. A
        // pending structural row already represents the exact submitted Node ID,
        // so it uses real-row presentation before and after settlement.
        ordinaryTrailingDraft ? 'node-draft' : '',
        props.optimisticChange && !realNode ? 'node-pending-structure' : '',
      ].filter(Boolean).join(' '))}
      onSelectFromPointer={row.selectFromPointer}
      onContextMenu={virtualFieldValueDraft ? undefined : openContextMenu}
      beforeRow={outlineSourcePreview ? (
        <div className="outline-source-preview-row">
          {rowLeadingElement}
          {outlineSourcePreview}
        </div>
      ) : undefined}
      rowContent={(
        <>
        {outlineSourcePreview
          ? <span className="row-leading-spacer" aria-hidden="true" />
          : rowLeadingElement}
        <div
          ref={optionAnchorRef}
          className="row-content-line"
          onMouseDownCapture={referenceLikeRow ? selectReferenceLikeRowFromPointer : undefined}
          onMouseDown={referenceLikeRow ? undefined : focusEditorFromRowClick}
          onClickCapture={referenceLikeRow ? selectReferenceLikeRowFromPointer : undefined}
          onDoubleClick={focusReferenceTargetFromDoubleClick}
        >
          {showDoneCheckbox && (
            <DoneCheckbox
              checked={Boolean(displayed.completedAt)}
              readOnly={displayed.locked}
              onToggle={() => void startDoneTransition(
                'toggle',
                () => props.run(() => api.toggleDone(targetEditId)),
              )}
            />
          )}
          {rowEditorElement}
          {inlineContentSlot && createPortal(
            <>
              {hasTags && (
                <TagBar
                  nodeId={targetEditId}
                  tagIds={displayed.tags}
                  index={props.index}
                  ui={props.ui}
                  setUi={props.setUi}
                  run={props.run}
                  onRoot={props.onRoot}
                />
              )}
              {fieldValueAffordances}
            </>,
            inlineContentSlot,
          )}
          {hasTags && !useInlineContentSlot && (
            <TagBar
                nodeId={targetEditId}
                tagIds={displayed.tags}
                index={props.index}
                ui={props.ui}
                setUi={props.setUi}
                run={props.run}
                onRoot={props.onRoot}
              />
          )}
          {!useInlineContentSlot && fieldValueAffordances}
          {!props.hideDisplayFields ? (
            <ViewDisplayFields ariaLabel={t.outliner.viewToolbar.displayedFieldsAriaLabel} values={displayValues} />
          ) : null}
          {dateFieldValue && props.fieldValue && (
            <DateValuePicker
              anchorRef={optionAnchorRef}
              value={realNode ? displayed.content.text : ''}
              open={dateOverlayOpen}
              onOpenChange={setDateOverlayOpen}
              onCommit={commitDateValue}
            />
          )}
          {!virtualFieldValueDraft && <NodeDescription
            node={displayed}
            targetId={targetEditId}
            editing={descriptionEditing}
            run={props.run}
            onEditingChange={(editing) => {
              props.setUi((prev) => ({
                ...prev,
                editingDescriptionId: editing ? targetEditId : null,
              }));
            }}
            focusTarget={descriptionFocusTarget}
            focusRequest={props.ui.focusRequest}
            pendingInput={props.ui.pendingInputChar}
            onFocusTarget={(target) => {
              props.setUi((prev) => selectFocusState(prev, target));
            }}
            onReturnToSource={() => {
              props.setUi((prev) => requestFocusState(
                { ...prev, editingDescriptionId: null },
                editorFocusTarget,
                descriptionReturnPlacementRef.current,
              ));
            }}
            onFocusRequestConsumed={(request) => {
              props.setUi((prev) => clearFocusRequestState(prev, request));
            }}
            onPendingInputConsumed={(input) => {
              props.setUi((prev) => clearPendingInputState(prev, input));
            }}
          />}
          {showSelectedReferenceOptionPicker && props.optionField && props.onSelectOption && (
            <SelectedReferenceOptionPicker
              anchorRef={optionAnchorRef}
              byId={props.index.byId}
              optionField={props.optionField}
              valueNode={node}
              onSelectOption={appendSelectedOption}
            />
          )}
          {/* The additive options overlay for an optionPicker field-value draft.
              It does NOT own the create: picking an existing option references it
              (selectOptionAndAdvance), while a novel value materializes through the
              same draft path as Enter (materializeDraftAndAdvance) — core dedups a
              typed-existing name into a reference. Mutually exclusive with
              SelectedReferenceOptionPicker above, which targets a committed
              reference row, not a draft. */}
          {optionPickerDraft && props.fieldValue?.optionField && (
            <TrailingOptionsPopover
              anchorRef={optionAnchorRef}
              optionField={props.fieldValue.optionField}
              byId={props.index.byId}
              autocollect={props.fieldValue.autocollect}
              open={optionsOpen}
              query={draftContent.text}
              onOpenChange={setOptionsOpen}
              onSelect={(optionId) => void selectOptionAndAdvance(optionId)}
              onCreate={() => {
                setOptionsOpen(false);
                void materializeDraftAndAdvance();
              }}
            />
          )}
        </div>
        </>
      )}
    >
      {activeTrigger && (
        <TriggerPopover
          trigger={activeTrigger}
          index={props.index}
          nodeId={targetEditId}
          run={props.run}
          close={() => props.setTrigger(null)}
          applyReference={(target) => runSemanticTriggerResolution(() => applyReference(target))}
          applyTag={(tag) => runSemanticTriggerResolution(() => (
            onDraftTrigger ? applyDraftTag(tag) : applyMaterializedTag(tag)
          ))}
          createTagAndApply={(name) => runSemanticTriggerResolution(() => (
            onDraftTrigger ? createAndApplyDraftTag(name) : createAndApplyMaterializedTag(name)
          ))}
          executeSlashCommand={(commandId) => runSemanticTriggerResolution(
            () => executeSlashCommand(commandId),
          )}
          enabledSlashCommandIds={['field', 'reference', 'heading', 'checkbox', 'code', 'image', 'attachment', 'command_palette']}
          treeReferenceParentId={
            triggerOwnsWholeDraft
              ? virtualFieldValueDraft
                ? props.fieldValue!.ownerId
                : props.parentId
              : null
          }
          existingTagIds={displayed.tags}
        />
      )}

      {contextMenu && !virtualFieldValueDraft && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={node}
          targetId={targetEditId}
          visualRowId={props.nodeId}
          viewToolbarVisibleInRow={row.expanded}
          openId={drillDownId}
          // The live selection from uiRef, not the memoized props.ui: a selected
          // row skips re-render when *another* row joins/leaves the block
          // selection (its own selected-ness is unchanged), so props.ui.selectedIds
          // can be stale here. The context menu's batch actions ("N nodes: …")
          // need the current full set. uiRef is refreshed every NodePanel render.
          panelId={props.panelId}
          selectionRootId={props.selectionRootId}
          selectedIds={props.uiRef.current.selectedIds}
          index={props.index}
          isPinned={props.isNodePinned(drillDownId)}
          isNodePinned={props.isNodePinned}
          onRoot={props.onRoot}
          onTogglePin={props.onTogglePin}
          onEditDescription={() => {
            descriptionReturnPlacementRef.current = cursorEnd();
            props.setUi((prev) => requestFocusState(
              { ...prev, editingDescriptionId: targetEditId },
              descriptionFocusTarget,
              cursorEnd(),
            ));
          }}
          onRevealViewToolbar={(visualRowId) => {
            props.setUi((prev) => {
              if (prev.expanded.has(visualRowId)) return prev;
              const expanded = new Set(prev.expanded);
              expanded.add(visualRowId);
              return { ...prev, expanded };
            });
          }}
          onOpenViewSection={(nodeId, section) => {
            props.setUi((prev) => ({
              ...prev,
              toolbarDropdownRequest: { nodeId, section, nonce: Date.now() },
            }));
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

    </OutlinerRowShell>
  );
}

interface SelectedReferenceOptionPickerProps {
  anchorRef: RefObject<HTMLDivElement | null>;
  byId: Map<NodeId, NodeProjection>;
  optionField: NodeProjection;
  valueNode: NodeProjection;
  onSelectOption: (optionId: NodeId) => void;
}

function selectedOptionIndex(options: readonly FieldOption[], selectedOptionId: NodeId | undefined) {
  const index = selectedOptionId ? options.findIndex((option) => option.id === selectedOptionId) : -1;
  return Math.max(0, index);
}

function SelectedReferenceOptionPicker({
  anchorRef,
  byId,
  optionField,
  valueNode,
  onSelectOption,
}: SelectedReferenceOptionPickerProps) {
  const tf = useT().outliner.field;
  const options = resolveFieldOptions(optionField, byId);
  const selectedOptionId = resolveSelectedOptionId(valueNode, options);
  const [open, setOpen] = useState(true);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectionKey = `${valueNode.id}:${selectedOptionId ?? ''}:${options.map((option) => option.id).join('|')}`;
  const [activeIndex, setActiveIndex] = usePopoverSelection({
    initialIndex: selectedOptionIndex(options, selectedOptionId),
    itemCount: options.length,
    listRef: menuRef,
    open,
    selectionKey,
  });
  const stateRef = useRef({ activeIndex, options, onSelectOption });
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open || options.length === 0,
    layoutKey: `${options.map((option) => option.id).join('|')}:${activeIndex}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 280,
  });
  stateRef.current = { activeIndex, options, onSelectOption };

  useLayoutEffect(() => {
    setOpen(true);
  }, [selectionKey]);

  const selectOption = (optionId: NodeId) => {
    setOpen(false);
    void onSelectOption(optionId);
  };

  useLayoutEffect(() => {
    if (!open || options.length === 0) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const action = resolveSelectedReferenceShortcut(event, { optionsOpen: true });
      if (
        action !== 'options_up'
        && action !== 'options_down'
        && action !== 'options_confirm'
        && action !== 'options_cancel'
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const state = stateRef.current;
      if (action === 'options_cancel') {
        setOpen(false);
        return;
      }
      if (action === 'options_up') {
        setActiveIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (action === 'options_down') {
        setActiveIndex((current) => Math.min(state.options.length - 1, current + 1));
        return;
      }
      const option = state.options[state.activeIndex];
      if (option) {
        setOpen(false);
        void state.onSelectOption(option.id);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!open || options.length === 0) return null;

  return createPortal(
    <div data-preserve-selection>
      <PopoverListbox
        ref={menuRef}
        className="node-picker-popover trailing-options-popover"
        label={tf.selectedFieldOptions}
        style={menuStyle}
      >
        {options.map((option, index) => (
          <PopoverListItem
            key={option.id}
            active={index === activeIndex}
            icon={<PopoverBulletIcon />}
            label={option.label}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => selectOption(option.id)}
          />
        ))}
      </PopoverListbox>
    </div>,
    document.body,
  );
}

function ViewDisplayFields({ ariaLabel, values }: { ariaLabel: string; values: ViewFieldValue[] }) {
  if (values.length === 0) return null;
  return (
    <div className="view-display-fields" aria-label={ariaLabel}>
      {values.map((field) => (
        <span className="view-display-field" key={field.id}>
          <span className="view-display-field-label">{field.label}</span>
          <span className="view-display-field-value">{field.values.join(', ')}</span>
        </span>
      ))}
    </div>
  );
}

function referencePathEqual(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// A focus/pending-input request targeting a descendant must reach that row, but
// rows render through their ancestor flat projection — so an ancestor that
// skips re-render freezes the whole subtree and the request never propagates to
// the target editor (focus silently falls to <body>; see the eager Tab/indent and
// nested-continuation paths). Return the request when this row sits on the path to
// its target so the comparator re-renders the ancestor whenever that changes.
// Walks only while a request is live (null on the typing hot path → O(1)).
function focusAncestorToken(
  props: OutlinerItemProps,
  request: { target: { nodeId: NodeId } } | null,
): unknown {
  if (!request) return null;
  const byId = props.index.byId;
  let cur = byId.get(request.target.nodeId)?.parentId ?? null;
  while (cur) {
    if (cur === props.nodeId) return request;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return null;
}

function outlinerItemOpenId(props: OutlinerItemProps): NodeId {
  const node = props.index.byId.get(props.nodeId);
  if (node?.type === 'reference' && node.targetId) {
    return resolveReferenceTargetId(node.targetId, props.index.byId) ?? node.id;
  }
  return props.nodeId;
}

function outlinerItemPinned(props: OutlinerItemProps): boolean {
  return props.isNodePinned(outlinerItemOpenId(props));
}

function inlineReferencePresentationKey(props: OutlinerItemProps): string {
  const openId = outlinerItemOpenId(props);
  const displayed = props.index.byId.get(openId) ?? props.index.byId.get(props.nodeId);
  const content = displayed && isContentBearingNode(displayed) ? displayed.content : EMPTY_RICH_TEXT;
  return content.inlineRefs.map((ref) => {
    const targetId = inlineRefNodeId(ref);
    if (!targetId) return '';
    const title = contentTextForNode(props.index.byId.get(targetId)).trim();
    const color = inlineReferenceTextColor(targetId, props.index) ?? '';
    return `${targetId}\u001f${title}\u001f${color}`;
  }).join('\u001e');
}

function contentTextForNode(node: NodeProjection | undefined): string {
  return node && isContentBearingNode(node) ? node.content.text : '';
}

function textRenderRevision(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Skip re-rendering a row when neither its tracked data revision nor the global
// UI generation changed and its structural position is unchanged. Most function
// props (run/onRoot/setUi/...) are intentionally not compared: they are either
// stable (useState/useCallback) or close only over stable values, so a retained
// closure stays correct. Pin state is derived explicitly below because it is
// renderer chrome state outside the document revision stream. Draft rows are
// never memoized — they are not in the projection, so renderRev cannot track
// them. Missing revision info forces a re-render.
function outlinerItemPropsEqual(prev: OutlinerItemProps, next: OutlinerItemProps): boolean {
  if (prev.draft || next.draft) return false;
  if (prev.nodeId !== next.nodeId) return false;
  if (prev.panelId !== next.panelId) return false;
  if (prev.parentId !== next.parentId) return false;
  if (prev.rootId !== next.rootId) return false;
  if (prev.depth !== next.depth) return false;
  if (prev.semanticRole !== next.semanticRole) return false;
  if (prev.hideDisplayFields !== next.hideDisplayFields) return false;
  if (prev.suppressChildFieldEntries !== next.suppressChildFieldEntries) return false;
  if (prev.outlineSourcePreviewKey !== next.outlineSourcePreviewKey) return false;
  if (prev.tableNextRowId !== next.tableNextRowId) return false;
  if (prev.optimisticChange !== next.optimisticChange) return false;
  if (prev.fieldValue?.sourcePreviewPlacement !== next.fieldValue?.sourcePreviewPlacement) return false;
  // Drag start/end is infrequent; re-render every row so drag handlers close over
  // the current dragId and the dragged row picks up its 'dragging' class.
  if (prev.dragId !== next.dragId) return false;
  const prevOpenId = outlinerItemOpenId(prev);
  const nextOpenId = outlinerItemOpenId(next);
  if (prevOpenId !== nextOpenId) return false;
  if (prev.ui.pendingNodePatches.get(prevOpenId) !== next.ui.pendingNodePatches.get(nextOpenId)) return false;
  // Description editing toggles rarely and a reference row edits its target's
  // description (keyed by the resolved target, not nodeId), so a per-row check
  // would miss reference rows — compare it globally instead.
  if (prev.ui.editingDescriptionId !== next.ui.editingDescriptionId) return false;
  const prevRev = prev.index.renderRev?.get(prev.nodeId);
  const nextRev = next.index.renderRev?.get(next.nodeId);
  if (prevRev === undefined || nextRev === undefined || prevRev !== nextRev) return false;
  if (inlineReferencePresentationKey(prev) !== inlineReferencePresentationKey(next)) return false;
  if (outlinerItemPinned(prev) !== outlinerItemPinned(next)) return false;
  if (!referencePathEqual(prev.referencePath, next.referencePath)) return false;
  // Propagate a focus/pending-input request down to a nested target (see above).
  if (focusAncestorToken(prev, prev.ui.focusRequest) !== focusAncestorToken(next, next.ui.focusRequest)) return false;
  if (focusAncestorToken(prev, prev.ui.pendingInputChar) !== focusAncestorToken(next, next.ui.pendingInputChar)) return false;
  // Nested rows receive `ui` through their owning flat projection, so the
  // expanded row, so a memoized ancestor that bails out freezes its descendants'
  // `ui`. Whenever a field a *descendant's* render reads moves — even if this
  // row's own memo state is unchanged — an expanded row must re-render to forward
  // the fresh `ui` down. Expansion needed this; selection/focus do too: without
  // it a drag- or modifier-click-selected descendant keeps a stale
  // `selected`/`focused` class until something unrelated forces its ancestor to
  // render (the "drag-select among a tagged node's children does nothing until I
  // re-enter a node" bug). This forwards the full set of `ui` slices a
  // descendant's `deriveRowMemoState` reads, EXCEPT `focusRequest` /
  // `pendingInputChar`, which already get precise descendant detection via
  // `focusAncestorToken` above. Each slice is replaced by identity on change, so
  // reference comparison suffices. Gated on this row being expanded so only
  // ancestors that actually own a nested view pay the cost; the moves themselves
  // are infrequent and user-driven.
  const rowExpanded = prev.ui.expanded.has(prev.nodeId) || next.ui.expanded.has(next.nodeId);
  if (rowExpanded && (
    prev.ui.expanded !== next.ui.expanded
    || prev.ui.focusedId !== next.ui.focusedId
    || prev.ui.focusSurface !== next.ui.focusSurface
    || prev.ui.focusedPanelId !== next.ui.focusedPanelId
    || prev.ui.selectedId !== next.ui.selectedId
    || prev.ui.selectedIds !== next.ui.selectedIds
    || prev.ui.selectionSource !== next.ui.selectionSource
    || prev.ui.pendingReferenceConversion !== next.ui.pendingReferenceConversion
    || prev.ui.trailingDraftPlacement !== next.ui.trailingDraftPlacement
    || prev.ui.pendingNodePatches !== next.ui.pendingNodePatches
  )) {
    return false;
  }
  // Re-render only when *this row's* UI state moved (focus/selection/expand/…),
  // not on every global UI change. Behavioural ui reads go through a live ref
  // (useOutlinerRowInteraction), so a row that skips re-render stays correct.
  return rowMemoStateEqual(
    deriveRowMemoState(prev.ui, prev.trigger, prev.nodeId, prev.parentId, prev.panelId),
    deriveRowMemoState(next.ui, next.trigger, next.nodeId, next.parentId, next.panelId),
  );
}

export const OutlinerItem = memo(OutlinerItemImpl, outlinerItemPropsEqual);

function isOnlyInlineReference(content: RichText, targetId: NodeId) {
  const textEmpty = content.text.replace(/\u200B/g, '').trim().length === 0;
  if (textEmpty && content.inlineRefs.length === 0) return true;
  return textEmpty
    && content.marks.length === 0
    && content.inlineRefs.length === 1
    && content.inlineRefs[0].offset === 0
    && inlineRefNodeId(content.inlineRefs[0]) === targetId;
}

function cursorOffsetAfterInlineReference(content: RichText, offset: number): number {
  return /\s/u.test(content.text[offset] ?? '') ? offset + 1 : offset;
}
