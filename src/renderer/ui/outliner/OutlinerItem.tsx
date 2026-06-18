import {
  memo,
  useEffect,
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
import type { AssetMetadata, CreateNodeTree, NodeId, NodeProjection, PasteRowMeta, RichText, RichTextPatch } from '../../api/types';
import { EMPTY_RICH_TEXT, inlineRefNodeId, nodeReferenceTarget, plainText, replaceAllRichTextPatch } from '../../api/types';
import { projectFieldTypeById, nodeShowsCheckbox } from '../../../core/configProjection';
import type { CursorPlacement } from '../../state/document';
import {
  flattenVisibleRows,
  resolveReferenceTargetId,
  type DocumentIndex,
  type UiState,
} from '../../state/document';
import { deriveRowMemoState, rowMemoStateEqual } from '../../state/rowUiState';
import { RichTextEditor, type EditorSplitPayload } from '../editor/RichTextEditor';
import { FileNodeKeyboardAnchor } from './FileNodeKeyboardAnchor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
  richTextEquals,
} from '../editor/richTextCodec';
import { expandIndentTargets, indentTargetParentId, previousVisibleRowId } from '../interactions/outlinerStructure';
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
import { armReferenceTypeAhead } from '../interactions/referenceTypeAhead';
import { resolveFieldOptions, resolveSelectedOptionId, type FieldOption } from '../interactions/fieldOptions';
import { resolveSelectedReferenceShortcut } from '../interactions/selectedReferenceShortcuts';
import {
  resolveContentRowBackspaceAtStartIntent,
  resolveContentRowUpdateAction,
  resolveReferenceSelectionAction,
} from '../interactions/rowInteractions';
import type { SlashCommandId } from '../interactions/slashCommands';
import type { CommandRunner, CommandRunnerOptions, NavigateRootOptions, TriggerAnchor, TriggerState } from '../shared';
import { collapseExpandedParentIds, outlinerChildren, parentIdsEmptiedByOutdent, textOf } from '../shared';
import {
  clearFocusRequestState,
  clearFocusState,
  clearPendingInputState,
  cursorEnd,
  cursorStart,
  cursorOffset as cursorAtOffset,
  focusTarget,
  focusTargetMatches,
  relayCompositionHandoffState,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from '../focus/focusModel';
import { renderedTextRightEdge, resolveTextOffsetFromPoint } from '../interactions/domCaret';
import { TagBar } from '../tags/TagBar';
import { inlineReferenceTextColor, resolveTagColor, tagBulletColors } from '../tags/tagColors';
import { fileNodeIconKind, fileNodeTitle, isFileNode } from '../preview/fileNode';
import { FileNodeImage } from '../preview/FileNodeImage';
import { FilePreviewBody } from '../preview/FilePreviewBody';
import { dispatchPreviewTargetOpen } from '../preview/previewEvents';
import { CodeBlockRow } from './CodeBlockRow';
import { TriggerPopover } from './TriggerPopover';
import { DoneCheckbox } from './DoneCheckbox';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { OutlinerRowShell } from './OutlinerRowShell';
import { OutlinerView } from './OutlinerView';
import { animateOutlinerRowMovementAfterNextCommit } from './rowMoveAnimation';
import { buildOutlinerRows } from './row-model';
import { draftCreateIndex, previousDraftSiblingId } from '../../state/trailingDraftPlacement';
import { IndentGuide } from './IndentGuide';
import { RowLeading } from './RowLeading';
import { CommandRunButton, useCommandRun } from './CommandFieldValue';
import { makeDraftNode } from './draftRow';
import { TrailingOptionsPopover } from './TrailingOptionsPopover';
import { TrailingReferencePopover } from './TrailingReferencePopover';
import { DateValuePicker } from './DateValuePicker';
import type { FieldValueContext } from '../fields/fieldValueEditors';
import { fieldValueOpenHref, validateFieldValue } from '../fields/fieldValueValidation';
import { CalendarIcon, ICON_SIZE, OpenIcon, WarningIcon } from '../icons';
import {
  createPlaceholderInlineField,
  createPlaceholderInlineFieldAfterNode,
  triggerOwnsWholeText,
} from './trailingTriggers';
import {
  announceDropTarget,
  DROP_TARGET_CHANGE_EVENT,
  useOutlinerRowInteraction,
} from './useOutlinerRowInteraction';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import {
  PopoverBulletIcon,
  PopoverListbox,
  PopoverListItem,
} from './PopoverList';
import { noteOutlinerItemRender } from './renderProbe';
import { useT } from '../../i18n/I18nProvider';

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
  onSelectOption?: (optionId: NodeId) => Promise<unknown> | unknown;
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
  // Empty-state placeholder shown on this trailing draft's editor (definition
  // template / options blocks), so an empty section reads "add here" instead of
  // a lone label over a near-invisible ghost bullet. Ignored once materialized.
  draftPlaceholder?: string;
  // Flat (virtualized) rendering: the row's children are emitted as sibling rows
  // by the flat producer, so this row must not render its own nested OutlinerView.
  // Indentation comes from `depth` (cumulative) instead of nested `.children`.
  flat?: boolean;
}

function OutlinerItemImpl(props: OutlinerItemProps) {
  noteOutlinerItemRender();
  const t = useT();
  const tf = t.outliner.field;
  const realNode = props.index.byId.get(props.nodeId);
  const parentNode = props.index.byId.get(props.parentId);
  // A draft row synthesizes an empty plain node so the normal render path runs;
  // `realNode` distinguishes "not materialized yet" from a real node.
  const node = realNode ?? (props.draft ? makeDraftNode(props.nodeId, props.parentId) : undefined);
  const [draftContent, setDraftContent] = useState<RichText>(node?.content ?? EMPTY_RICH_TEXT);
  const [draftContentRevision, setDraftContentRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // optionPicker / referencePicker field-value draft: the editor is the free-text
  // filter for the additive picker popover (options pool / node search). Open on
  // focus; the typed text drives the query. The two interactions are mutually
  // exclusive on a draft, so they share this one open-state.
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Date value rows summon their picker overlay additively (Space / calendar
  // affordance); it is never a separate editing mode.
  const [dateOverlayOpen, setDateOverlayOpen] = useState(false);
  // A command node's attended run (engaged from the title Run button). Cheap for
  // every row — just local state + a callback — so it stays an unconditional hook.
  const commandRun = useCommandRun(props.nodeId);
  const draftContentRef = useRef<RichText>(node?.content ?? EMPTY_RICH_TEXT);
  const localDraftSyncRef = useRef<{ nodeId: NodeId; content: RichText } | null>(null);
  const pendingTextPatchRef = useRef<Promise<unknown>>(Promise.resolve());
  // Guards materialization so the create fires exactly once per draft. This alone
  // prevents a double-commit: Enter materializes, then the resulting blur re-enters
  // commitDraft, but the guard makes the second materializeDraft a no-op.
  const materializeStartedRef = useRef(false);
  // Synchronous mirror of the active trigger, set by onTriggerChange *before* the
  // patch callback runs in the same editor transaction (props.trigger is React
  // state and lags one render). applyTextPatch reads it to decide whether a body
  // draft eager-materializes (normal typing) or stays buffered (a #/@/`/`/`>` query
  // resolving atomically).
  const draftTriggerActiveRef = useRef(false);
  const restoredReferenceConversionNodeRef = useRef<NodeId | null>(null);
  const descriptionReturnPlacementRef = useRef<CursorPlacement>(cursorEnd());
  const optionAnchorRef = useRef<HTMLDivElement | null>(null);
  const referenceTargetId = node?.type === 'reference' && node.targetId
    ? resolveReferenceTargetId(node.targetId, props.index.byId)
    : null;
  const displayed = referenceTargetId ? props.index.byId.get(referenceTargetId) ?? node : node;
  const childParentId = referenceTargetId ?? props.nodeId;
  const childParentNode = props.index.byId.get(childParentId);
  const referenceCycle = node?.type === 'reference'
    && Boolean(referenceTargetId)
    && props.referencePath.includes(childParentId);
  const rowChildIds = referenceCycle ? [] : outlinerChildren(childParentNode, props.index.byId);
  // A file node is a full node — the bullet drills to the node page, the chevron
  // expands an inline preview. Its row content depends on the kind: a non-image file is
  // a lightweight name row (file-type bullet, read-only filename, hover ⋯ menu); an
  // image renders the image itself inline (FileNodeImage: an image's content is its
  // identity), with the filename displayed read-only on the preview surface.
  // A reference whose target is a file node must still render as a reference row,
  // not as the file's own card/image: `displayed` resolves to the target only when
  // `referenceTargetId` is set, so guard on `!referenceTargetId`. Otherwise an
  // agent-created reference→file (the agent's add_reference does no type-check)
  // would render inline and a click would drill to the target instead of selecting
  // the reference. Only a row that IS the file node gets the file presentation.
  const fileNodeRow = !referenceTargetId && isFileNode(displayed) ? displayed : null;
  const imageFileRow = fileNodeRow?.type === 'image' ? fileNodeRow : null;
  // A non-image file renders as a lightweight row (file-icon bullet + read-only
  // filename, expand → inline preview); an image keeps its inline-image presentation.
  const nonImageFileRow = fileNodeRow && fileNodeRow.type !== 'image' ? fileNodeRow : null;
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
    // Tag a not-yet-materialized draft wrap with data-trailing-parent-id so the
    // trailing editor is findable the way the legacy TrailingInput row was.
    draft: props.draft === true && !realNode,
    draftAfterId: props.draftAfterId,
  });
  // A not-yet-materialized draft is also "focused" when keyboard navigation
  // targets the parent's trailing surface (the existing trailing-focus signal);
  // once the editor takes focus, onFocus settles it to this row's own id.
  const trailingDraftFocused = props.draft === true
    && !realNode
    && props.ui.focusedId === props.parentId
    && props.ui.focusSurface === 'trailing'
    && props.ui.focusedPanelId === props.panelId;
  const rowEditorFocused = (props.ui.focusedId === props.nodeId
    && props.ui.focusSurface === 'row'
    && props.ui.focusedPanelId === props.panelId)
    || trailingDraftFocused;

  useEffect(() => {
    const nextContent = displayed?.content ?? EMPTY_RICH_TEXT;
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

  if (!node || !displayed) return null;

  const replaceLocalDraftContent = (content: RichText) => {
    localDraftSyncRef.current = { nodeId: targetEditId, content };
    draftContentRef.current = content;
    setDraftContent(content);
    setDraftContentRevision((revision) => revision + 1);
  };

  const targetEditId = referenceTargetId ?? node.id;
  const drillDownId = referenceTargetId ?? node.id;
  // Field-value editing flags. A field value's trailing draft is NOT a separate
  // editing mode: it materializes through the same materializeDraft path as a body
  // node, differing only in WHICH create command runs (injected via
  // props.fieldValue.materializeValue). The draft buffers text until commit
  // (Enter/blur) so the create sees the full text — this lets core dedup a typed
  // value against an existing pool option in one shot, instead of per keystroke.
  const fieldValueDraft = Boolean(props.fieldValue) && props.draft === true && !realNode;
  const fieldDescriptor = props.fieldValue?.descriptor;
  // An options field's draft shows the additive options overlay and treats free
  // text as the filter query, so #/@// and the code fence are plain text there.
  const optionPickerDraft = fieldValueDraft && fieldDescriptor?.interaction === 'optionPicker';
  // A reference field's draft is a node-search box: free text is the search query
  // (so #/@// and the code fence are plain text there) and the additive picker
  // appends a reference to the chosen node instead of materializing free text.
  const referencePickerDraft = fieldValueDraft && fieldDescriptor?.interaction === 'referencePicker';
  // Both pickers treat the typed text as their filter query, never as a trigger.
  const suppressTextTriggers = optionPickerDraft || referencePickerDraft;
  // A date field value (draft or committed) is an editable row that additively
  // offers a calendar overlay; Space on an empty value summons it.
  const dateFieldValue = Boolean(props.fieldValue) && fieldDescriptor?.interaction === 'datePicker';
  const editorFocusTarget = rowFocusTarget(props.nodeId, props.parentId, props.panelId);
  // A not-yet-materialized draft consumes the parent's trailing focus request
  // (keyboard nav into the trailing line targets `(parentId, 'trailing')`); once
  // the editor focuses, onFocus settles the signal to this row's own id.
  const editorRequestTarget = props.draft && !realNode
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
  // A non-image file row's chevron toggles its inline preview (peek), not the
  // trailing-child-draft toggle a childless content row uses. It flips this row's
  // membership in the expanded set (which `row.expanded` reads) and selects the row —
  // like `toggleExpandOrSelect`, so clicking a file row's chevron makes it the active
  // row rather than leaving focus/selection on whatever row was active before.
  const toggleFilePreview = () => {
    props.setUi((prev) => {
      const expandedSet = new Set(prev.expanded);
      if (expandedSet.has(props.nodeId)) expandedSet.delete(props.nodeId);
      else expandedSet.add(props.nodeId);
      return { ...prev, expanded: expandedSet };
    });
    row.updateSelection();
  };
  const childReferencePath = [...props.referencePath, childParentId];
  const pendingReferenceConversion = props.ui.pendingReferenceConversion?.nodeId === props.nodeId;
  const pendingReferenceTypeAhead = props.ui.pendingReferenceTypeAhead?.nodeId === props.nodeId;
  // A non-image file node shows its file-type icon as the bullet (the row text is the
  // read-only filename); an image keeps the neutral content bullet (its inline image is
  // its identity). The bullet still drills to the node page on click.
  const leadingVariant = node.type === 'reference' || pendingReferenceConversion
    ? 'reference'
    : displayed.type === 'tagDef'
      ? 'tag'
      : displayed.type === 'fieldDef'
        ? 'fieldDef'
        : displayed.type === 'command'
          ? 'command'
          : nonImageFileRow
            ? 'file'
            : 'content';
  const isCommandNode = leadingVariant === 'command';
  const appliedTags = displayed.tags
    .map((tagId) => props.index.byId.get(tagId))
    .filter((tag): tag is NodeProjection => Boolean(tag));
  const appliedTagColors = tagBulletColors(appliedTags, props.index.byId);
  const tagDefColor = leadingVariant === 'tag' ? resolveTagColor(displayed, props.index.byId).text : undefined;
  const showDoneCheckbox = nodeShowsCheckbox(props.index.byId, displayed);
  const descriptionEditing = props.ui.editingDescriptionId === targetEditId;
  const referenceLikeRow = node.type === 'reference' || pendingReferenceConversion;
  const isCodeBlock = displayed.type === 'codeBlock' && !referenceLikeRow;
  // Plain text rows host their tag chips INSIDE the editor (an inline widget at the
  // end of the text) so the chips flow after the last word and wrap with it. Code
  // rows have no inline text editor, so they keep the tag bar as a sibling below.
  const isPlainTextRow = !isCodeBlock;
  const hasTags = displayed.tags.length > 0;
  // A file node renders its editor visually hidden (the sr-only keyboard anchor), so
  // the inline tag slot inside that editor would be invisible. File rows render
  // their tags in the read-only filename row instead; code rows keep the sibling bar.
  const useInlineTagSlot = isPlainTextRow && !fileNodeRow;
  const inlineTagSlotRef = useRef<HTMLSpanElement | null>(null);
  if (useInlineTagSlot && hasTags && inlineTagSlotRef.current === null) {
    const el = document.createElement('span');
    el.className = 'row-inline-tag-slot';
    el.contentEditable = 'false';
    inlineTagSlotRef.current = el;
  }
  const inlineTagSlot = useInlineTagSlot && hasTags ? inlineTagSlotRef.current : null;
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
  const editorContentRevision = pendingReferenceConversion
    ? displayed.updatedAt
    : draftContentRevision;
  const activeTrigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
  const activeFileTagTrigger = fileNodeRow && activeTrigger?.kind === '#' ? activeTrigger : null;
  const triggerOwnsWholeDraft = activeTrigger?.kind === '@'
    && draftContent.inlineRefs.length === 0
    && triggerOwnsWholeText(draftContent.text, activeTrigger);
  // A trigger resolving on the not-yet-materialized trailing draft creates its
  // node atomically (under props.parentId), instead of materializing a plain node
  // first and then mutating it. `materializeStartedRef` guards the window after a
  // blur/Enter materialize is already in flight but the real node has not landed.
  const onDraftTrigger = props.draft === true && !realNode && !materializeStartedRef.current;

  const restorePendingReferenceConversion = async (
    content: RichText,
    options: { rearmTypeAhead?: boolean } = {},
  ) => {
    await pendingTextPatchRef.current;
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
    const outcome = await props.run(() => api.restoreInlineReferenceNodeToReference(
      props.nodeId,
      pendingConversion.targetId,
    ), { applyFocus: false });
    const referenceId = outcome && 'focus' in outcome ? outcome.focus?.nodeId ?? null : null;
    const referenceParentId = outcome && 'focus' in outcome
      ? outcome.focus?.parentId ?? parentId
      : parentId;
    if (!referenceId) restoredReferenceConversionNodeRef.current = null;

    if (options.rearmTypeAhead && referenceId) {
      props.setUi((prev) => (
        prev.pendingReferenceConversion?.nodeId === props.nodeId
          ? { ...prev, pendingReferenceConversion: null }
          : prev
      ));
      window.requestAnimationFrame(() => {
        armReferenceTypeAhead({
          referenceId,
          parentId: referenceParentId,
          targetId: pendingConversion.targetId,
          panelId: props.panelId,
          selectionRootId: props.selectionRootId,
          run: props.run,
          setUi: props.setUi,
        });
      });
      return { restored: true, nodeId: referenceId };
    }

    props.setUi((prev) => (
      prev.pendingReferenceConversion?.nodeId === props.nodeId
        ? { ...prev, pendingReferenceConversion: null }
        : prev
    ));
    return { restored: true, nodeId: referenceId ?? props.nodeId };
  };

  const commitDraft = async (content = draftContent) => {
    if (props.draft && !realNode) {
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
    return result.nodeId;
  };

  const currentDraftCreateIndex = () => draftCreateIndex(parentNode, props.draftAfterId ?? null);
  const placementAfterMaterializedDraft = () => (
    props.draftAfterId && !props.fieldValue
      ? { parentId: props.parentId, afterId: props.nodeId, panelId: props.panelId }
      : null
  );
  const materializedDraftFocusState = (state: UiState) => ({
    ...selectFocusState(
      state,
      rowFocusTarget(props.nodeId, props.parentId, props.panelId),
    ),
    trailingDraftPlacement: placementAfterMaterializedDraft(),
  });

  // Materialization: turn the draft into a real node under its stable id on
  // commit. Runs once; the create and the text patches that follow share one undo
  // group (see DocumentService). Keystrokes that land during the IPC round-trip
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
  const materializeDraft = () => {
    if (realNode || materializeStartedRef.current) return;
    // A reference field value is only ever a reference to an existing node (picked
    // from the node-search overlay), never the typed query — so a reference draft
    // has nothing to materialize from its text. Enter/blur on it is a no-op; the
    // value is appended by addReferenceAndAdvance when a node is chosen.
    if (referencePickerDraft) return;
    materializeStartedRef.current = true;
    const seed = draftContentRef.current;
    const fieldValue = props.fieldValue;
    const createIndex = currentDraftCreateIndex();
    const runCreate = fieldValue
      ? () => fieldValue.materializeValue(props.nodeId, seed.text)
      : () => props.run(
        () => api.materializeDraftNode(props.parentId, createIndex, seed.text, props.nodeId),
        {
          applyFocus: false,
          beforeApply: () => {
            props.setUi(materializedDraftFocusState);
          },
        },
      );
    pendingTextPatchRef.current = pendingTextPatchRef.current
      .then(runCreate)
      .then(() => {
        const latest = draftContentRef.current;
        const needsReconcile = latest.text !== seed.text
          || latest.marks.length > 0
          || latest.inlineRefs.length > 0;
        if (needsReconcile) {
          return props.run(
            () => api.applyNodeTextPatch(props.nodeId, replaceAllRichTextPatch(latest)),
            { applyFocus: false },
          );
        }
      })
      .then(() => {
        props.setUi(materializedDraftFocusState);
      });
    void pendingTextPatchRef.current;
  };

  const applyTextPatch = (patch: RichTextPatch) => {
    if (props.draft && !realNode) {
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
      const fireAction = resolveContentRowUpdateAction({
        text: draftContentRef.current.text,
        inlineRefCount: draftContentRef.current.inlineRefs.length,
        enableFieldTrigger: !suppressTextTriggers,
        enableCodeFence: !suppressTextTriggers
          && node.type === undefined
          && !pendingReferenceConversion
          && !displayed.locked,
      });
      const willFireTrigger = fireAction.type !== 'none';
      if (!props.fieldValue && !draftTriggerActiveRef.current && !willFireTrigger) {
        materializeDraft();
      }
      return;
    }
    pendingTextPatchRef.current = pendingTextPatchRef.current.then(() =>
      props.run(() => api.applyNodeTextPatch(targetEditId, patch), {
        applyFocus: false,
      }));
    void pendingTextPatchRef.current;
  };

  const applyTextWithoutTrigger = async () => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    await pendingTextPatchRef.current;
    const nextContent = trigger
      ? deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to)
        : plainText(draftContentRef.current.text.replace(/(?:^|\s)([#@/>])([^\s#@/>]*)$/, '').trimEnd());
    replaceLocalDraftContent(nextContent);
    // A draft has no node to patch yet — the de-triggered text stays buffered until
    // it materializes on Enter/blur.
    if (onDraftTrigger) return;
    await props.run(() => api.replaceNodeText(targetEditId, nextContent));
  };

  const clearTriggerText = async () => {
    if (activeFileTagTrigger) return;
    await applyTextWithoutTrigger();
  };

  const handleEditorChange = (content: RichText) => {
    localDraftSyncRef.current = { nodeId: targetEditId, content };
    draftContentRef.current = content;
    setDraftContent(content);
    // optionPicker / referencePicker free text drives the picker filter; keep the
    // popover open.
    if ((optionPickerDraft || referencePickerDraft) && !optionsOpen) setOptionsOpen(true);
  };

  const handlePasteOutliner = (payload: {
    content: RichText;
    children: CreateNodeTree[];
    siblingsAfter: CreateNodeTree[];
    firstMeta?: PasteRowMeta;
  }) => {
    // The pristine trailing draft has no core node yet (it materializes on the
    // first committed character), so there is nothing to paste *into*: calling
    // paste_nodes_into_node with its client-proposed id throws "node not found".
    // Append the pasted trees at the trailing position instead and leave the
    // draft empty — it re-spawns below the new rows.
    if (props.draft && !realNode && !materializeStartedRef.current) {
      const trees: CreateNodeTree[] = [];
      const firstHasBody = payload.content.text.trim().length > 0
        || payload.content.inlineRefs.length > 0
        || payload.children.length > 0;
      if (firstHasBody) {
        trees.push({
          content: payload.content,
          children: payload.children,
          ...payload.firstMeta,
        });
      }
      trees.push(...payload.siblingsAfter);
      if (trees.length > 0) void props.run(() => api.createNodesFromTree(props.parentId, trees));
      return;
    }

    localDraftSyncRef.current = { nodeId: targetEditId, content: payload.content };
    draftContentRef.current = payload.content;
    setDraftContent(payload.content);
    if (payload.children.length > 0) {
      props.setUi((prev) => {
        const expanded = new Set(prev.expanded);
        expanded.add(props.nodeId);
        return { ...prev, expanded };
      });
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
      pendingTextPatchRef.current = pendingTextPatchRef.current.then(() => props.run(pasteIntoNode));
      void pendingTextPatchRef.current;
      return;
    }
    void props.run(pasteIntoNode);
  };

  const insertImagesFromAssets = async (assets: AssetMetadata[]) => {
    if (assets.length === 0) return;
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    let insertIndex = rowIndex >= 0 ? rowIndex + 1 : null;
    for (const asset of assets) {
      // Clipboard images are image nodes by construction (filtered on the declared
      // type upstream), so force an image node rather than re-sniffing the bytes.
      await props.run(() => api.createImageNode(props.parentId, insertIndex, {
        assetId: asset.id,
        width: asset.imageWidth,
        height: asset.imageHeight,
      }));
      if (insertIndex !== null) insertIndex += 1;
    }
  };

  const insertAssetNodesAt = async (
    assets: AssetMetadata[],
    initialIndex: number | null,
    parentId = props.parentId,
    options?: CommandRunnerOptions,
  ) => {
    let insertIndex = initialIndex;
    for (const asset of assets) {
      await createAssetNode(props.run, parentId, insertIndex, asset, options);
      if (insertIndex !== null) insertIndex += 1;
    }
  };

  const insertAssetNodesAfterCurrentRow = async (assets: AssetMetadata[], options?: CommandRunnerOptions) => {
    if (assets.length === 0) return;
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    await insertAssetNodesAt(assets, rowIndex >= 0 ? rowIndex + 1 : null, props.parentId, options);
  };

  // Land images "here": convert the current row into the first image when it is
  // a plain, *empty*, childless row (so no typed text is buried under an image
  // body that never renders it) rather than spawning an empty row beside the
  // image; remaining images become siblings. Used by both clipboard paste and
  // the `/image` slash command. Focus lands on the new image block via its
  // `BlockNodeRow` shell.
  const landImagesOnCurrentRow = async (assets: AssetMetadata[]) => {
    if (assets.length === 0) return;
    if (props.draft && !realNode && !materializeStartedRef.current) {
      await insertAssetNodesAt(assets, currentDraftCreateIndex());
      return;
    }
    const draft = draftContentRef.current;
    const rowTextEmpty = draft.text.trim().length === 0 && draft.inlineRefs.length === 0;
    const canConvertInPlace = shouldConvertRowToImage({
      referenceLikeRow,
      nodeType: displayed.type,
      hasChildren: row.hasChildren,
      rowTextEmpty,
    });
    if (canConvertInPlace) {
      const [first, ...rest] = assets;
      await props.run(() => api.setNodeImage(targetEditId, {
        assetId: first.id,
        width: first.imageWidth,
        height: first.imageHeight,
      }));
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
      hasChildren: row.hasChildren,
      rowTextEmpty,
    });
    if (!canConvertFirstImage) {
      await insertAssetNodesAfterCurrentRow(assets, options);
      return;
    }
    await props.run(() => api.setNodeImage(targetEditId, {
      assetId: first.id,
      width: first.imageWidth,
      height: first.imageHeight,
    }), options);
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

    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    if (position === 'inside') {
      return { parentId: props.nodeId, index: 0, expandTargetId: props.nodeId };
    }
    if (position === 'after' && row.hasChildren && row.expanded) {
      return { parentId: props.nodeId, index: 0 };
    }
    return {
      parentId: props.parentId,
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

  // A pasted remote image URL: same land-here logic as a local image, but the
  // node is backed by `mediaUrl` instead of an ingested asset.
  const handlePasteMediaUrl = async (url: string) => {
    await commitDraft();
    const draft = draftContentRef.current;
    const rowTextEmpty = draft.text.trim().length === 0 && draft.inlineRefs.length === 0;
    const convertInPlace = shouldConvertRowToImage({
      referenceLikeRow,
      nodeType: displayed.type,
      hasChildren: row.hasChildren,
      rowTextEmpty,
    });
    if (convertInPlace) {
      await props.run(() => api.setNodeImage(targetEditId, { mediaUrl: url }));
    } else {
      const siblings = props.index.byId.get(props.parentId)?.children ?? [];
      const rowIndex = siblings.indexOf(props.nodeId);
      await props.run(() => api.createImageNode(props.parentId, rowIndex >= 0 ? rowIndex + 1 : null, { mediaUrl: url }));
    }
  };

  // Atomic tag application on the trailing draft: a `#tag` query resolves straight
  // into a tagged node (create_tagged_node / create_tag_and_tagged_node) carrying
  // the draft's non-trigger text, instead of materializing a plain node and then
  // applying the tag. Wired only when onDraftTrigger; a real node falls back to the
  // TagSelector's own apply_tag path.
  const applyDraftTag = async (tag: NodeProjection) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;
    await pendingTextPatchRef.current;
    const content = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
    const outcome = await api.createTaggedNode(props.parentId, content, tag.id);
    // Clear the buffered query only after the tagged node lands, so the draft keeps
    // showing "#query" through a slow create (and never re-materializes the query as
    // a stray plain node on the blur that follows).
    replaceLocalDraftContent(EMPTY_RICH_TEXT);
    return outcome;
  };

  const createAndApplyDraftTag = async (name: string) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;
    await pendingTextPatchRef.current;
    const content = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
    const outcome = await api.createTagAndTaggedNode(props.parentId, content, name);
    replaceLocalDraftContent(EMPTY_RICH_TEXT);
    return outcome;
  };

  const applyReference = async (target: NodeProjection) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) {
      return;
    }
    await pendingTextPatchRef.current;
    const currentDraft = draftContentRef.current;
    const byIdWithTarget = props.index.byId.has(target.id)
      ? props.index.byId
      : new Map(props.index.byId).set(target.id, target);
    const treeBlockReason = getTreeReferenceBlockReason({
      parentId: props.parentId,
      targetId: target.id,
      byId: byIdWithTarget,
    });
    const action = resolveReferenceSelectionAction({
      text: currentDraft.text,
      inlineRefCount: currentDraft.inlineRefs.length,
      triggerFrom: trigger.from,
      triggerTo: trigger.to,
      treeBlockReason,
      sourceIsReference: node.type === 'reference',
    });
    if (action === 'blocked') return api.getProjection();
    if (action === 'tree_reference') {
      // Whole-text @ref. A draft has no node yet, so it creates a fresh
      // inline-conversion row (add_reference_conversion); a real (empty) row
      // converts itself in place (replace_node_with_reference_conversion).
      const outcome = onDraftTrigger
        ? await api.addReferenceConversion(props.parentId, target.id)
        : await api.replaceNodeWithReferenceConversion(props.nodeId, target.id);
      if (onDraftTrigger) replaceLocalDraftContent(EMPTY_RICH_TEXT);
      const inlineNodeId = outcome.focus?.nodeId;
      if (!inlineNodeId) {
        return outcome;
      }
      const inlineParentId = outcome.focus?.parentId ?? props.parentId;
      props.setUi((prev) => ({
        ...prev,
        pendingReferenceConversion: {
          nodeId: inlineNodeId,
          parentId: inlineParentId,
          targetId: target.id,
        },
        pendingReferenceTypeAhead: null,
      }));
      return outcome;
    }

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
    );
    if (onDraftTrigger) {
      // Inline @ref inside buffered draft text (e.g. "See @Alpha"): commit one
      // rich-text row atomically (create_rich_text_node) rather than materializing
      // a plain node first and patching it.
      const outcome = await api.createRichTextNode(props.parentId, null, nextContent);
      replaceLocalDraftContent(EMPTY_RICH_TEXT);
      return outcome;
    }
    replaceLocalDraftContent(nextContent);
    requestRowFocus(
      props.nodeId,
      cursorAtOffset(cursorOffsetAfterInlineReference(nextContent, trigger.from), 'after'),
      props.parentId,
    );
    return api.replaceNodeText(targetEditId, nextContent);
  };

  const executeSlashCommand = async (commandId: SlashCommandId) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;

    if (commandId === 'field') {
      await pendingTextPatchRef.current;
      // Draft: create the inline field as a child of the parent (create_inline_field);
      // a real node anchors it right after itself (create_inline_field_after_node).
      if (!onDraftTrigger) return createPlaceholderInlineFieldAfterNode(props.nodeId, 'plain');
      const outcome = await createPlaceholderInlineField(props.parentId, null, 'plain');
      // Drop the buffered "/" query so it does not re-materialize as a stray node
      // when the field name input steals focus from the draft.
      replaceLocalDraftContent(EMPTY_RICH_TEXT);
      return outcome;
    }

    if (commandId === 'reference') {
      await pendingTextPatchRef.current;
      const nextContent = replaceRichTextRangeWithText(draftContentRef.current, trigger.from, trigger.to, '@');
      replaceLocalDraftContent(nextContent);
      if (onDraftTrigger) {
        // No node to patch yet — the '@' stays buffered. Re-focus the draft with the
        // caret right after the '@' (cursorEnd) so the editor itself re-detects an
        // empty @ trigger and continued typing extends its query. (A bare rAF
        // setTrigger would arm the popover but leave the caret before the '@', so
        // typing would land in front of it.)
        focusTrailingDraft();
        return api.getProjection();
      }
      const result = await api.replaceNodeText(targetEditId, nextContent);
      window.requestAnimationFrame(() => {
        props.setTrigger({
          nodeId: props.nodeId,
          kind: '@',
          query: '',
          from: trigger.from,
          to: trigger.from + 1,
          anchor: trigger.anchor,
        });
      });
      return result;
    }

    if (commandId === 'heading') {
      await pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      const nextContent = markWholeTextAsHeading(withoutTrigger);
      if (onDraftTrigger) {
        const outcome = await api.createRichTextNode(props.parentId, null, nextContent);
        replaceLocalDraftContent(EMPTY_RICH_TEXT);
        return outcome;
      }
      replaceLocalDraftContent(nextContent);
      return api.replaceNodeText(targetEditId, nextContent);
    }

    if (commandId === 'checkbox') {
      if (onDraftTrigger) {
        await pendingTextPatchRef.current;
        const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
        const created = await api.createRichTextNode(props.parentId, null, withoutTrigger);
        replaceLocalDraftContent(EMPTY_RICH_TEXT);
        const nodeId = created.focus?.nodeId;
        if (!nodeId) return created;
        return api.toggleDone(nodeId);
      }
      await applyTextWithoutTrigger();
      return api.toggleDone(targetEditId);
    }

    if (commandId === 'code') {
      await pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      if (onDraftTrigger) {
        const created = await api.createRichTextNode(props.parentId, null, withoutTrigger);
        replaceLocalDraftContent(EMPTY_RICH_TEXT);
        const nodeId = created.focus?.nodeId;
        if (!nodeId) return created;
        return api.setCodeBlock(nodeId);
      }
      replaceLocalDraftContent(withoutTrigger);
      await api.replaceNodeText(targetEditId, withoutTrigger);
      return api.setCodeBlock(targetEditId);
    }

    if (commandId === 'command') {
      await pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      if (onDraftTrigger) {
        const created = await api.createRichTextNode(props.parentId, null, withoutTrigger);
        replaceLocalDraftContent(EMPTY_RICH_TEXT);
        const nodeId = created.focus?.nodeId;
        if (!nodeId) return created;
        return api.setCommandNode(nodeId);
      }
      replaceLocalDraftContent(withoutTrigger);
      await api.replaceNodeText(targetEditId, withoutTrigger);
      return api.setCommandNode(targetEditId);
    }

    if (commandId === 'image') {
      await pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      replaceLocalDraftContent(withoutTrigger);
      if (onDraftTrigger) {
        // Picking files needs a real row to land them on; materialize the
        // de-triggered draft first, then drop the images onto it.
        materializeDraft();
        await pendingTextPatchRef.current;
      } else {
        await api.replaceNodeText(targetEditId, withoutTrigger);
      }
      const assets = await api.pickImageFiles();
      await landImagesOnCurrentRow(assets);
      return api.getProjection();
    }

    if (commandId === 'attachment') {
      await pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to);
      replaceLocalDraftContent(withoutTrigger);
      if (onDraftTrigger) {
        const assets = await api.pickAttachmentFiles();
        if (assets.length > 0) {
          replaceLocalDraftContent(EMPTY_RICH_TEXT);
          await insertAssetNodesAt(assets, currentDraftCreateIndex());
        }
        return api.getProjection();
      } else {
        await api.replaceNodeText(targetEditId, withoutTrigger);
      }
      const assets = await api.pickAttachmentFiles();
      await landAssetsOnCurrentRow(assets);
      return api.getProjection();
    }

    if (commandId === 'command_palette') {
      await pendingTextPatchRef.current;
      if (onDraftTrigger) {
        replaceLocalDraftContent(deleteRichTextRange(draftContentRef.current, trigger.from, trigger.to));
      } else {
        await applyTextWithoutTrigger();
      }
      props.setUi((prev) => ({ ...prev, commandOpen: true }));
      return api.getProjection();
    }

    return null;
  };

  // Markdown-style shortcut: a bare ``` / ~~~ owning a plain row converts it into
  // an empty code block (the fence text is dropped), mirroring the `/code` command
  // and how a pasted fence becomes a `codeBlock` node. Focus lands in the new
  // code editor via a focus request the CodeBlockRow consumes on mount.
  const convertRowToCodeBlock = () => {
    void (async () => {
      if (props.draft && !realNode) materializeDraft();
      await pendingTextPatchRef.current;
      replaceLocalDraftContent(EMPTY_RICH_TEXT);
      await props.run(() => api.replaceNodeText(targetEditId, EMPTY_RICH_TEXT));
      await props.run(() => api.setCodeBlock(targetEditId));
      requestRowFocus(props.nodeId, cursorEnd());
    })();
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
  const focusTrailingDraft = (afterId: NodeId | null = null) => {
    props.setUi((prev) => {
      const next = requestFocusState(
        prev,
        focusTarget(props.parentId, props.parentId, props.panelId, 'trailing'),
        cursorEnd(),
      );
      return afterId
        ? {
          ...next,
          trailingDraftPlacement: { parentId: props.parentId, afterId, panelId: props.panelId },
        }
        : next;
    });
  };

  const fileTitleSelectionAnchor = (): TriggerAnchor | undefined => {
    const host = optionAnchorRef.current;
    const selection = window.getSelection();
    if (!host || !selection || selection.rangeCount === 0) return undefined;
    const anchorNode = selection.anchorNode;
    if (anchorNode && !host.contains(anchorNode)) return undefined;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return undefined;
    if (rect.width === 0 && rect.height === 0) return undefined;
    return { left: rect.left, top: rect.top, bottom: rect.bottom };
  };

  const openFileTagTrigger = (anchor?: TriggerAnchor) => {
    const rect = optionAnchorRef.current?.getBoundingClientRect();
    row.updateSelection();
    props.setTrigger({
      nodeId: props.nodeId,
      kind: '#',
      query: '',
      from: 0,
      to: 1,
      anchor: anchor ?? fileTitleSelectionAnchor() ?? (rect
        ? { left: rect.left, top: rect.top, bottom: rect.bottom }
        : undefined),
    });
  };

  const updateFileTagTriggerQuery = (query: string) => {
    if (!activeFileTagTrigger) return;
    props.setTrigger({
      ...activeFileTagTrigger,
      query,
      to: query.length + 1,
    });
  };

  const handleFileTitleKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (!nonImageFileRow) return;
    const mod = event.metaKey || event.ctrlKey;
    if (activeFileTagTrigger) {
      if (event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        if (activeFileTagTrigger.query.length === 0) {
          props.setTrigger(null);
        } else {
          updateFileTagTriggerQuery(activeFileTagTrigger.query.slice(0, -1));
        }
        return;
      }
      if (!mod && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        event.stopPropagation();
        if (/\s/.test(event.key)) {
          props.setTrigger(null);
        } else {
          updateFileTagTriggerQuery(`${activeFileTagTrigger.query}${event.key}`);
        }
      }
      return;
    }
    if (!mod && !event.altKey && event.key === '#') {
      event.preventDefault();
      event.stopPropagation();
      openFileTagTrigger();
    }
  };

  // Append an existing pool option as a reference (the additive options overlay),
  // then return to the trailing draft for the next value. The typed query is
  // discarded — the user picked an option rather than creating from the text.
  const selectOptionAndAdvance = async (optionId: NodeId) => {
    setOptionsOpen(false);
    replaceLocalDraftContent(EMPTY_RICH_TEXT);
    await props.fieldValue?.onSelectOption(optionId);
    focusTrailingDraft();
  };

  // Append a reference to the picked node (the reference-field picker), then
  // return to the trailing draft for the next value. Mirrors selectOptionAndAdvance:
  // the typed query is the search term, discarded once a node is chosen.
  const addReferenceAndAdvance = async (targetId: NodeId) => {
    setOptionsOpen(false);
    replaceLocalDraftContent(EMPTY_RICH_TEXT);
    await props.fieldValue?.onAddReference(targetId);
    focusTrailingDraft();
  };

  // Materialize the current draft (body or field value) then advance to the next
  // trailing draft. Shared by Enter and the options overlay's create affordance —
  // both create a value from the typed text via the same path.
  const materializeDraftAndAdvance = async () => {
    materializeDraft();
    await pendingTextPatchRef.current;
    focusTrailingDraft(!props.fieldValue ? props.nodeId : null);
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
    pendingTextPatchRef.current = pendingTextPatchRef.current.then(() =>
      props.run(() => api.replaceNodeText(targetEditId, text), { applyFocus: false }));
    void pendingTextPatchRef.current;
  };

  const handleEnter = async (payload: EditorSplitPayload) => {
    if (props.trigger?.nodeId === props.nodeId) return;
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
        const materializedIndex = currentDraftCreateIndex();
        const continuationIndex = materializedIndex === null ? null : materializedIndex + 1;
        materializeDraft();
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
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    if (!payload.atEnd) {
      await props.run(() => api.splitNode(targetEditId, payload.before, payload.after, {
        // A file node's `expanded` means "preview open", not "children visible to
        // type into", so Enter on a file row always adds a sibling (never a child).
        ...(node.type === 'reference'
          ? { targetParentId: props.parentId, targetIndex: rowIndex >= 0 ? rowIndex + 1 : null }
          : !fileNodeRow && row.expanded && row.hasChildren
            ? { targetParentId: props.nodeId, targetIndex: 0 }
            : {}),
        focusPlacement: { kind: 'start' },
      }));
      return;
    }
    await commitDraft(payload.before);
    if (!fileNodeRow && row.expanded && row.hasChildren) {
      await props.run(() => api.createNode(childParentId, 0, payload.after.text));
      return;
    }
    await props.run(() => api.createNode(props.parentId, rowIndex >= 0 ? rowIndex + 1 : null, ''));
  };

  const handleModEnter = async (content: RichText) => {
    setDraftContent(content);
    await commitDraft(content);
    await props.run(() => api.cycleDoneState(targetEditId));
  };

  const handleCodeBlockTextChange = (text: string) => {
    const content = plainText(text);
    handleEditorChange(content);
    applyTextPatch(replaceAllRichTextPatch(content));
  };

  const handleCodeBlockExit = async () => {
    await commitDraft();
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    await props.run(() => api.createNode(props.parentId, rowIndex >= 0 ? rowIndex + 1 : null, ''));
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
      hasChildren: row.hasChildren,
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
        const targetNode = props.index.byId.get(id);
        const targetParentId = targetNode?.parentId ?? null;
        return targetNode?.type === 'fieldEntry'
          ? focusTarget(id, targetParentId, props.panelId, 'field-name')
          : rowFocusTarget(id, targetParentId, props.panelId);
      };
      // A field value routes through removeFieldValue so an auto-collected value
      // also drops its mirror reference in the option pool (no orphan options);
      // a body node just goes to Trash. The renderer owns focus because the
      // deleted row may be the first or only visible row in the current scope.
      if (props.fieldValue) {
        await props.run(() => api.removeFieldValue(props.nodeId), { applyFocus: false });
      } else {
        await props.run(() => api.trashNode(props.nodeId), { applyFocus: false });
      }
      props.setUi((prev) => {
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
    if (!previousNode) return;

    // Backspacing a reference row itself has nothing to merge away — just step
    // up. But merging *into* a reference is allowed: core converts that
    // reference into a leading inline reference on the joined row.
    if (node.type === 'reference') {
      requestRowFocus(previousId);
      return;
    }

    const joinOffset = previousNode.content.text.length;
    await commitDraft();
    const result = await props.run(() => api.mergeNodeInto(props.nodeId, previousId));
    if (result) {
      requestRowFocus(previousId, cursorAtOffset(joinOffset));
    }
  };

  const handleTab = async (shiftKey: boolean, cursorOffset: number) => {
    // Field values are a flat list: a field's children ARE its values, so a value
    // can never be indented under another value (that would make a grandchild of
    // the field). Tab is inert in the field-value context.
    if (props.fieldValue) return;
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
    await commitDraft();
    if (!shiftKey) {
      const targetParentId = indentTargetParentId(props.nodeId, props.index.byId);
      if (!targetParentId) return;
      await props.run(() => api.indentNode(props.nodeId), {
        applyFocus: false,
        beforeApply: () => {
          animateOutlinerRowMovementAfterNextCommit();
          props.setUi((prev) => {
            const expanded = expandIndentTargets(prev.expanded, [props.nodeId], props.index.byId);
            return requestFocusState(
              { ...prev, expanded },
              rowFocusTarget(props.nodeId, null, props.panelId),
              cursorAtOffset(cursorOffset),
            );
          });
        },
      });
      return;
    }
    if (props.parentId === props.rootId) return;
    const emptiedParentIds = parentIdsEmptiedByOutdent([props.nodeId], props.index.byId, props.rootId);
    await props.run(() => api.outdentNode(props.nodeId), {
      applyFocus: false,
      beforeApply: () => {
        animateOutlinerRowMovementAfterNextCommit();
        props.setUi((prev) => {
          const next = emptiedParentIds.size > 0
            ? { ...prev, expanded: collapseExpandedParentIds(prev.expanded, emptiedParentIds) }
            : prev;
          return requestFocusState(
            next,
            rowFocusTarget(props.nodeId, null, props.panelId),
            cursorAtOffset(cursorOffset),
          );
        });
      },
    });
  };

  const moveCurrentNode = async (direction: 'up' | 'down') => {
    await commitDraft();
    const result = await props.run(() => (
      direction === 'up'
        ? api.batchMoveNodesUp([props.nodeId])
        : api.batchMoveNodesDown([props.nodeId])
    ));
    if (result) requestRowFocus(props.nodeId);
  };

  const exitToSelection = async () => {
    if (props.trigger?.nodeId === props.nodeId) {
      props.setTrigger(null);
      return;
    }
    const selectionId = await commitDraft() ?? props.nodeId;
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

    if (nonImageFileRow) {
      const editor = event.currentTarget.querySelector<HTMLElement>('.file-node-row-name .ProseMirror');
      if (!editor) return;

      const clickedInsideEditor = Boolean(target?.closest('.ProseMirror'));
      const rightEdge = renderedTextRightEdge(editor);
      if (clickedInsideEditor && (rightEdge === null || event.clientX <= rightEdge + 1)) return;

      event.preventDefault();
      event.stopPropagation();
      const title = fileNodeTitle(nonImageFileRow);
      const offset = resolveTextOffsetFromPoint({
        container: editor,
        clientX: event.clientX,
        clientY: event.clientY,
        textLength: title.length,
      });
      const editorRect = editor.getBoundingClientRect();
      const inlineRefBias = event.clientX <= editorRect.left + 2 ? 'before' : 'after';
      requestRowFocus(props.nodeId, cursorAtOffset(offset, inlineRefBias), props.parentId);
      return;
    }

    if (imageFileRow) {
      // An image row has no filename caret surface: a click on the image or the
      // empty area beside it selects the row. Maximize lives in the image menu so
      // a plain click behaves like other outliner content.
      event.preventDefault();
      event.stopPropagation();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      selectRow(props.nodeId, 'global');
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

  // Additive layers on a committed field value: a non-blocking validation hint
  // and (for a well-formed url / email) an open-link affordance. The hint takes
  // precedence — a malformed value shows the hint, not a broken link.
  const fieldValueText = realNode ? displayed.content.text : '';
  const fieldValueHint = props.fieldValue && fieldDescriptor?.validates && realNode
    ? validateFieldValue(props.fieldValue.fieldType, fieldValueText, props.fieldValue.constraints)
    : null;
  const fieldValueHref = props.fieldValue && fieldDescriptor?.isLink && realNode && !fieldValueHint
    ? fieldValueOpenHref(props.fieldValue.fieldType, fieldValueText)
    : null;
  // The calendar affordance reopens the picker on a committed date value. The
  // empty draft is guided by its "Press Space…" placeholder instead, so it shows
  // no button (avoids a redundant icon beside the placeholder).
  const showDateTrigger = dateFieldValue && Boolean(realNode);

  // The row's text editor for ordinary nodes. Non-image file nodes mount a
  // separate read-only title editor below; image file nodes use a hidden anchor
  // because the visible row content is the image itself.
  const rowEditorElement = isCodeBlock ? (
    <CodeBlockRow
      nodeId={props.nodeId}
      text={draftContent.text}
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
      content={draftContent}
      contentRevision={editorContentRevision}
      inlineSlotEl={inlineTagSlot}
      readOnly={displayed.locked}
      completed={Boolean(displayed.completedAt)}
      placeholder={fieldValueDraft
        ? props.fieldValue?.placeholder
        : (props.draft === true && !realNode ? props.draftPlaceholder : undefined)}
      onFocus={() => {
        row.updateSelection();
        // optionPicker / referencePicker: open the picker overlay on a
        // genuine user focus (click) so you can type-to-filter. Suppress it
        // when focus arrived programmatically via a focus request — advancing
        // to the next value draft after committing one (Enter / pick) should
        // land closed, not immediately reopen the picker. Typing still reopens
        // it (handleEditorChange).
        const programmaticFocus = Boolean(props.ui.focusRequest)
          && focusTargetMatches(props.ui.focusRequest!.target, editorRequestTarget);
        if ((optionPickerDraft || referencePickerDraft) && !programmaticFocus) setOptionsOpen(true);
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
      onDescriptionToggle={({ cursorOffset }) => {
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
      onFieldTriggerFire={suppressTextTriggers ? undefined : () => {
        props.setTrigger(null);
        // A draft has no real node to anchor "after"; create the field as a
        // child of the parent (create_inline_field). A real row anchors it
        // right after itself (create_inline_field_after_node).
        const createField = onDraftTrigger
          ? () => createPlaceholderInlineField(props.parentId, null, 'plain')
          : () => createPlaceholderInlineFieldAfterNode(props.nodeId, 'plain');
        if (onDraftTrigger) replaceLocalDraftContent(EMPTY_RICH_TEXT);
        void pendingTextPatchRef.current.then(() => props.run(createField));
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
      onPasteMediaUrl={node.type === 'reference' ? undefined : (url) => void handlePasteMediaUrl(url)}
      onInlineReferenceClick={pendingReferenceConversion
        ? undefined
        : (targetId, options) => props.onRoot(targetId, {
          focus: false,
          newPane: options?.newPane,
        })}
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
  const nonImageFileTitle = nonImageFileRow ? fileNodeTitle(nonImageFileRow) : '';
  const fileTitleEditorElement = nonImageFileRow ? (
    <RichTextEditor
      nodeId={props.nodeId}
      className="file-node-row-name file-node-row-name-editor"
      content={plainText(nonImageFileTitle)}
      contentRevision={textRenderRevision(nonImageFileTitle)}
      readOnly
      readOnlyCaret
      onFocus={row.updateSelection}
      onChange={() => undefined}
      onPatch={() => undefined}
      onCommit={() => undefined}
      onEnter={() => void handleEnter({
        atEnd: true,
        before: EMPTY_RICH_TEXT,
        after: EMPTY_RICH_TEXT,
      })}
      onBackspaceAtStart={() => void handleBackspaceAtStart(true)}
      onTab={(shiftKey, cursorOffset) => void handleTab(shiftKey, cursorOffset)}
      onArrowUpAtStart={() => row.moveFocus(-1)}
      onArrowDownAtEnd={() => row.moveFocus(1)}
      onShiftArrow={() => void exitToSelection()}
      onUndo={() => void props.run(() => api.undo())}
      onRedo={() => void props.run(() => api.redo())}
      onSelectAllRows={selectAllVisibleRows}
      onModEnter={() => void handleModEnter(EMPTY_RICH_TEXT)}
      onPasteFiles={(files) => void handlePasteFiles(files)}
      onEscape={() => void exitToSelection()}
      onTriggerChange={() => undefined}
      focusTarget={editorRequestTarget}
      focusRequest={props.ui.focusRequest}
      onFocusRequestConsumed={(request) => {
        props.setUi((prev) => clearFocusRequestState(prev, request));
      }}
    />
  ) : null;
  const outlinerWrapProps = {
    ...row.wrapProps,
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

  return (
    <OutlinerRowShell
      hasChildren={row.hasChildren}
      // A non-image file row's chevron toggles its inline preview, so it is
      // expandable even with no children (its `expanded` reflects the preview).
      expandable={row.hasChildren || Boolean(nonImageFileRow)}
      expanded={row.expanded}
      level={props.depth + 1}
      selected={row.rowSelected}
      wrapProps={outlinerWrapProps}
      rowClassName={row.rowClassName([
        referenceLikeRow ? 'reference-row' : '',
        // A non-image file row is a lightweight name row (file-icon bullet, read-only
        // filename) that expands to an inline preview; the class shows the chevron and
        // styles the name/preview.
        nonImageFileRow ? 'file-node-row' : '',
        externalFileDropPosition ? `drop-${externalFileDropPosition}` : '',
        pendingReferenceConversion ? 'ref-converting' : '',
        pendingReferenceTypeAhead ? 'ref-typeahead' : '',
        // A not-yet-materialized trailing draft reads as a fainter bullet, so it
        // is visually distinct from a real (empty) node.
        props.draft && !realNode ? 'node-draft' : '',
      ].filter(Boolean).join(' '))}
      onSelectFromPointer={row.selectFromPointer}
      onContextMenu={openContextMenu}
      rowContent={(
        <>
        <RowLeading
          hasChildren={row.hasChildren}
          expanded={row.expanded}
          variant={leadingVariant}
          fieldType={projectFieldTypeById(props.index.byId, displayed.id)}
          fileIconKind={nonImageFileRow ? fileNodeIconKind(nonImageFileRow) : undefined}
          processing={isCommandNode && commandRun.running}
          bulletColors={appliedTagColors}
          tagDefColor={tagDefColor}
          onToggleExpand={nonImageFileRow ? toggleFilePreview : row.toggleExpandOrSelect}
          onDrillDown={() => props.onRoot(drillDownId)}
          draggable={row.dragHandleProps.draggable}
          onDragStart={row.dragHandleProps.onDragStart}
          onDragEnd={row.dragHandleProps.onDragEnd}
        />
        <div
          ref={optionAnchorRef}
          className="row-content-line"
          onMouseDownCapture={referenceLikeRow ? selectReferenceLikeRowFromPointer : undefined}
          onMouseDown={referenceLikeRow ? undefined : focusEditorFromRowClick}
          onClickCapture={referenceLikeRow ? selectReferenceLikeRowFromPointer : undefined}
          onDoubleClick={focusReferenceTargetFromDoubleClick}
        >
          {isCommandNode && (
            // Run lives at the start of the command title; the command bullet's
            // spinner (driven by commandRun.running below) is the running indicator.
            <CommandRunButton labels={tf.command} onRun={commandRun.run} />
          )}
          {showDoneCheckbox && (
            <DoneCheckbox
              checked={Boolean(displayed.completedAt)}
              readOnly={displayed.locked}
              onToggle={() => void props.run(() => api.toggleDone(targetEditId))}
            />
          )}
          {fileNodeRow ? (
            // A file node renders as content, not a rename field. Non-image files use a
            // read-only title editor so the caret can land in the filename and drive
            // structural commands/tags without mutating the filename. Images render as
            // the image itself and keep the hidden keyboard anchor for parity.
            <>
              {imageFileRow ? (
                <FileNodeImage node={imageFileRow} onMaximize={() => props.onRoot(drillDownId)} />
              ) : nonImageFileRow ? (
                <div className="file-node-row-main">
                  <div
                    className="file-node-row-labels"
                    title={nonImageFileTitle}
                    onKeyDownCapture={handleFileTitleKeyDownCapture}
                  >
                    {fileTitleEditorElement}
                    {hasTags && (
                      <TagBar
                        nodeId={targetEditId}
                        tagIds={displayed.tags}
                        index={props.index}
                        run={props.run}
                        onRoot={props.onRoot}
                      />
                    )}
                  </div>
                </div>
              ) : null}
              {imageFileRow && (
                <FileNodeKeyboardAnchor
                  label={fileNodeTitle(fileNodeRow)}
                  onFocus={() => row.updateSelection()}
                  tagTriggerQuery={activeFileTagTrigger?.query ?? null}
                  onOpenTagTrigger={openFileTagTrigger}
                  onUpdateTagTriggerQuery={updateFileTagTriggerQuery}
                  onCloseTagTrigger={() => props.setTrigger(null)}
                  onArrowUp={() => row.moveFocus(-1)}
                  onArrowDown={() => row.moveFocus(1)}
                  onEnter={() => void handleEnter({ atEnd: true, before: draftContentRef.current, after: EMPTY_RICH_TEXT })}
                  onBackspace={() => void handleBackspaceAtStart(true)}
                  onEscape={() => void exitToSelection()}
                  onShiftArrow={() => void exitToSelection()}
                  onTab={(shiftKey) => void handleTab(shiftKey, 0)}
                  onSelectAllRows={selectAllVisibleRows}
                  onUndo={() => void props.run(() => api.undo())}
                  onRedo={() => void props.run(() => api.redo())}
                  focusTarget={editorRequestTarget}
                  focusRequest={props.ui.focusRequest}
                  onFocusRequestConsumed={(request) => {
                    props.setUi((prev) => clearFocusRequestState(prev, request));
                  }}
                />
              )}
              {hasTags && imageFileRow && (
                <TagBar
                  nodeId={targetEditId}
                  tagIds={displayed.tags}
                  index={props.index}
                  run={props.run}
                  onRoot={props.onRoot}
                />
              )}
            </>
          ) : (
            rowEditorElement
          )}
          {hasTags && !fileNodeRow && (
            useInlineTagSlot ? (
              // Portal the chips into the editor's inline slot so they sit in the
              // text flow (after the last word, wrapping with it). The slot node
              // lives inside this row's editor DOM, so it stays within the row.
              inlineTagSlot && createPortal(
                <TagBar
                  nodeId={targetEditId}
                  tagIds={displayed.tags}
                  index={props.index}
                  run={props.run}
                  onRoot={props.onRoot}
                />,
                inlineTagSlot,
              )
            ) : (
              <TagBar
                nodeId={targetEditId}
                tagIds={displayed.tags}
                index={props.index}
                run={props.run}
                onRoot={props.onRoot}
              />
            )
          )}
          {props.fieldValue && (showDateTrigger || fieldValueHint || fieldValueHref) && (
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
                <button
                  type="button"
                  className="field-value-affordance field-value-open"
                  aria-label={tf.openLink}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void api.openExternalUrl(fieldValueHref)}
                ><OpenIcon size={12} strokeWidth={1.8} /></button>
              )}
              {showDateTrigger && (
                <button
                  type="button"
                  className="field-value-affordance field-value-date-trigger"
                  aria-label={tf.pickADate}
                  aria-expanded={dateOverlayOpen}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setDateOverlayOpen((open) => !open)}
                >
                  <CalendarIcon size={13} strokeWidth={1.8} />
                </button>
              )}
            </span>
          )}
          {dateFieldValue && props.fieldValue && (
            <DateValuePicker
              anchorRef={optionAnchorRef}
              value={realNode ? displayed.content.text : ''}
              open={dateOverlayOpen}
              onOpenChange={setDateOverlayOpen}
              onCommit={commitDateValue}
            />
          )}
          <NodeDescription
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
          />
          {showSelectedReferenceOptionPicker && props.optionField && props.onSelectOption && (
            <SelectedReferenceOptionPicker
              anchorRef={optionAnchorRef}
              byId={props.index.byId}
              optionField={props.optionField}
              valueNode={node}
              onSelectOption={props.onSelectOption}
            />
          )}
          {/* The additive options overlay for an optionPicker field-value draft.
              It does NOT own the create: picking an existing option references it
              (selectOptionAndAdvance), while a novel value materializes through the
              same draft path as Enter (materializeDraftAndAdvance) — core dedups a
              typed-existing name into a reference. Mutually exclusive with
              SelectedReferenceOptionPicker above, which targets a committed
              reference row, not a draft. */}
          {optionPickerDraft && props.fieldValue && (
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
          {/* The node-search overlay for a reference field-value draft. Picking a
              node appends a reference to it (add_field_reference) and advances to
              the next trailing draft — the reference peer of the options overlay. */}
          {referencePickerDraft && props.fieldValue && (
            <TrailingReferencePopover
              anchorRef={optionAnchorRef}
              index={props.index}
              entryId={props.fieldValue.entryId}
              open={optionsOpen}
              query={draftContent.text}
              onOpenChange={setOptionsOpen}
              onPick={(targetId) => void addReferenceAndAdvance(targetId)}
            />
          )}
        </div>
        </>
      )}
    >

      {!props.flat && row.expanded && (!nonImageFileRow || row.hasChildren) && (
        <IndentGuide onToggleChildren={row.toggleDirectChildrenExpansion} />
      )}

      {nonImageFileRow && row.expanded && (
        // The inline file preview lives below the row (inside row-wrap, outside .row),
        // so it is not painted by the row's selection highlight; it starts collapsed
        // (peek) and the pill's Expand grows it to a full vertical scroll.
        <div className="file-node-row-preview">
          <FilePreviewBody
            node={nonImageFileRow}
            onOpenTarget={(target, options) => dispatchPreviewTargetOpen({ target, newPane: options?.newPane })}
            initialExpanded={false}
          />
        </div>
      )}

      {activeTrigger && (
        <TriggerPopover
          trigger={activeTrigger}
          index={props.index}
          nodeId={targetEditId}
          run={props.run}
          close={() => props.setTrigger(null)}
          clearTriggerText={clearTriggerText}
          applyReference={applyReference}
          applyTag={onDraftTrigger ? applyDraftTag : undefined}
          createTagAndApply={onDraftTrigger ? createAndApplyDraftTag : undefined}
          executeSlashCommand={executeSlashCommand}
          enabledSlashCommandIds={['field', 'reference', 'heading', 'checkbox', 'code', 'image', 'attachment', 'command', 'command_palette']}
          treeReferenceParentId={triggerOwnsWholeDraft ? props.parentId : null}
          existingTagIds={displayed.tags}
        />
      )}

      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={node}
          targetId={targetEditId}
          openId={drillDownId}
          // The live selection from uiRef, not the memoized props.ui: a selected
          // row skips re-render when *another* row joins/leaves the block
          // selection (its own selected-ness is unchanged), so props.ui.selectedIds
          // can be stale here. The context menu's batch actions ("N nodes: …")
          // need the current full set. uiRef is refreshed every NodePanel render.
          selectedIds={props.uiRef.current.selectedIds}
          index={props.index}
          isPinned={props.isNodePinned(drillDownId)}
          run={props.run}
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
          onOpenViewSection={(nodeId, section) => {
            props.setUi((prev) => ({
              ...prev,
              toolbarDropdownRequest: { nodeId, section, nonce: Date.now() },
            }));
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {!props.flat && row.expanded && !props.fieldValue && (!nonImageFileRow || row.hasChildren) && (
        // role="group" owns the nested treeitems under this row, completing the
        // ARIA tree nesting (treeitem → group → treeitems). A file row's expansion
        // means "preview open"; it only renders this children group when it has real
        // children, and never a trailing draft (see `trailingDraft` below), so an
        // empty file node shows no phantom child draft under its preview.
        <div className="children" role="group">
          <OutlinerView
            panelId={props.panelId}
            parentId={childParentId}
            rootId={props.rootId}
            selectionRootId={props.selectionRootId}
            onRoot={props.onRoot}
            depth={0}
            index={props.index}
            isNodePinned={props.isNodePinned}
            ui={props.ui}
            uiRef={props.uiRef}
            setUi={props.setUi}
            run={props.run}
            onTogglePin={props.onTogglePin}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            dragId={props.dragId}
            setDragId={props.setDragId}
            referencePath={childReferencePath}
            // The trailing draft (eager materialization) replaces the old child
            // TrailingInput: shown for an empty child list or when nav focuses
            // the trailing surface, unless this is a reference cycle — or a file
            // node, whose container is preview-only and never typed into.
            trailingDraft={referenceCycle || nonImageFileRow ? 'none' : 'auto'}
          />
        </div>
      )}

    </OutlinerRowShell>
  );
}

interface SelectedReferenceOptionPickerProps {
  anchorRef: RefObject<HTMLDivElement | null>;
  byId: Map<NodeId, NodeProjection>;
  optionField: NodeProjection;
  valueNode: NodeProjection;
  onSelectOption: (optionId: NodeId) => Promise<unknown> | unknown;
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
  const [activeIndex, setActiveIndex] = useState(() => selectedOptionIndex(options, selectedOptionId));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ activeIndex, options });
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open || options.length === 0,
    layoutKey: `${options.map((option) => option.id).join('|')}:${activeIndex}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 280,
  });
  stateRef.current = { activeIndex, options };

  useEffect(() => {
    setOpen(true);
    setActiveIndex(selectedOptionIndex(options, selectedOptionId));
  }, [options.length, selectedOptionId, valueNode.id]);

  const selectOption = (optionId: NodeId) => {
    setOpen(false);
    void onSelectOption(optionId);
  };

  useEffect(() => {
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
      if (option) selectOption(option.id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onSelectOption, open, options.length]);

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

function referencePathEqual(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// A focus/pending-input request targeting a descendant must reach that row, but
// rows render through their ancestors' nested OutlinerView — so an ancestor that
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

function outlinerItemFileRenderKey(props: OutlinerItemProps): string {
  const node = props.index.byId.get(props.nodeId);
  if (!isFileNode(node)) return '';
  if (node.type === 'attachment') {
    return [
      node.type,
      node.assetId,
      node.content.text,
      node.originalFilename ?? '',
      node.mimeType ?? '',
      node.fileSize ?? '',
      node.pdfPageCount ?? '',
      node.audioDurationMs ?? '',
      node.videoDurationMs ?? '',
    ].join('\u001f');
  }
  return [
    node.type,
    node.assetId ?? '',
    node.content.text,
    node.mediaUrl ?? '',
    node.mediaAlt ?? '',
    node.imageWidth ?? '',
    node.imageHeight ?? '',
  ].join('\u001f');
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
  // Drag start/end is infrequent; re-render every row so drag handlers close over
  // the current dragId and the dragged row picks up its 'dragging' class.
  if (prev.dragId !== next.dragId) return false;
  // Description editing toggles rarely and a reference row edits its target's
  // description (keyed by the resolved target, not nodeId), so a per-row check
  // would miss reference rows — compare it globally instead.
  if (prev.ui.editingDescriptionId !== next.ui.editingDescriptionId) return false;
  const prevRev = prev.index.renderRev?.get(prev.nodeId);
  const nextRev = next.index.renderRev?.get(next.nodeId);
  if (prevRev === undefined || nextRev === undefined || prevRev !== nextRev) return false;
  if (outlinerItemFileRenderKey(prev) !== outlinerItemFileRenderKey(next)) return false;
  if (outlinerItemPinned(prev) !== outlinerItemPinned(next)) return false;
  if (!referencePathEqual(prev.referencePath, next.referencePath)) return false;
  // Propagate a focus/pending-input request down to a nested target (see above).
  if (focusAncestorToken(prev, prev.ui.focusRequest) !== focusAncestorToken(next, next.ui.focusRequest)) return false;
  if (focusAncestorToken(prev, prev.ui.pendingInputChar) !== focusAncestorToken(next, next.ui.pendingInputChar)) return false;
  // Nested OutlinerViews receive `ui` by prop-drilling through their owning
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
    || prev.ui.pendingReferenceTypeAhead !== next.ui.pendingReferenceTypeAhead
    || prev.ui.trailingDraftPlacement !== next.ui.trailingDraftPlacement
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
