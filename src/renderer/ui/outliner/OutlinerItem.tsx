import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from 'react';
import { flushSync } from 'react-dom';
import { api } from '../../api/client';
import type { AssetMetadata, CreateNodeTree, NodeId, NodeProjection, RichText, RichTextPatch } from '../../api/types';
import { EMPTY_RICH_TEXT, plainText, replaceAllRichTextPatch } from '../../api/types';
import type { CursorPlacement } from '../../state/document';
import {
  flattenVisibleRows,
  resolveReferenceTargetId,
  type DocumentIndex,
  type UiState,
} from '../../state/document';
import { RichTextEditor, type EditorSplitPayload } from '../editor/RichTextEditor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
  richTextEquals,
} from '../editor/richTextCodec';
import { indentTargetParentId, previousVisibleRowId } from '../interactions/outlinerStructure';
import { appendImageNodes, ingestPastedImages, shouldConvertRowToImage, type PastedImage } from '../interactions/imagePaste';
import { getTreeReferenceBlockReason } from '../interactions/referenceRules';
import { armReferenceTypeAhead } from '../interactions/referenceTypeAhead';
import {
  resolveContentRowBackspaceAtStartIntent,
  resolveReferenceSelectionAction,
} from '../interactions/rowInteractions';
import type { SlashCommandId } from '../interactions/slashCommands';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { outlinerChildren, textOf } from '../shared';
import {
  clearFocusRequestState,
  clearFocusState,
  clearPendingInputState,
  cursorEnd,
  cursorOffset as cursorAtOffset,
  focusTarget,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from '../focus/focusModel';
import { renderedTextRightEdge, resolveTextOffsetFromPoint } from '../interactions/domCaret';
import { TagBar } from '../tags/TagBar';
import { inlineReferenceTextColor, resolveTagColor, tagBulletColors } from '../tags/tagColors';
import { BlockNodeRow, isBlockNodeType } from './BlockNodeRow';
import { CodeBlockRow } from './CodeBlockRow';
import { TrailingInput } from './TrailingInput';
import { TriggerPopover } from './TriggerPopover';
import { DoneCheckbox } from './DoneCheckbox';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { OutlinerRowShell } from './OutlinerRowShell';
import { OutlinerView } from './OutlinerView';
import { IndentGuide } from './IndentGuide';
import { RowLeading } from './RowLeading';
import { buildOutlinerRows } from './row-model';
import {
  applyTrailingReferenceTrigger,
  applyTrailingTagTrigger,
  createAndApplyTrailingTagTrigger,
  createPlaceholderInlineFieldAfterNode,
  createTrailingField,
  executeTrailingSlashTrigger,
  triggerOwnsWholeText,
} from './trailingTriggers';
import { useOutlinerRowInteraction } from './useOutlinerRowInteraction';

interface OutlinerItemProps {
  panelId: string;
  nodeId: NodeId;
  parentId: NodeId;
  rootId: NodeId;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  depth: number;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  referencePath: readonly NodeId[];
}

export function OutlinerItem(props: OutlinerItemProps) {
  const node = props.index.byId.get(props.nodeId);
  const [draftContent, setDraftContent] = useState<RichText>(node?.content ?? EMPTY_RICH_TEXT);
  const [draftContentRevision, setDraftContentRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const draftContentRef = useRef<RichText>(node?.content ?? EMPTY_RICH_TEXT);
  const localDraftSyncRef = useRef<{ nodeId: NodeId; content: RichText } | null>(null);
  const pendingTextPatchRef = useRef<Promise<unknown>>(Promise.resolve());
  const restoredReferenceConversionNodeRef = useRef<NodeId | null>(null);
  const descriptionReturnPlacementRef = useRef<CursorPlacement>(cursorEnd());
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
  const row = useOutlinerRowInteraction({
    rowId: props.nodeId,
    parentId: props.parentId,
    childParentId,
    panelId: props.panelId,
    rootId: props.rootId,
    depth: props.depth,
    childIds: rowChildIds,
    index: props.index,
    ui: props.ui,
    setUi: props.setUi,
    run: props.run,
    locked: node?.locked ?? true,
    dragId: props.dragId,
    setDragId: props.setDragId,
  });
  const rowEditorFocused = props.ui.focusedId === props.nodeId
    && props.ui.focusSurface === 'row'
    && props.ui.focusedPanelId === props.panelId;

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
  }, [displayed?.id, displayed?.content, displayed?.targetId, rowEditorFocused]);

  if (!node || !displayed) return null;

  const replaceLocalDraftContent = (content: RichText) => {
    localDraftSyncRef.current = { nodeId: targetEditId, content };
    draftContentRef.current = content;
    setDraftContent(content);
    setDraftContentRevision((revision) => revision + 1);
  };

  const targetEditId = referenceTargetId ?? node.id;
  const drillDownId = referenceTargetId ?? node.id;
  const editorFocusTarget = rowFocusTarget(props.nodeId, props.parentId, props.panelId);
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
  const selectRow = (rowId: NodeId) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    flushSync(() => {
      props.setUi((prev) => ({
        ...clearFocusState(prev),
        selectedId: rowId,
        selectedIds: new Set([rowId]),
        selectionAnchorId: rowId,
        selectionRootId: props.rootId,
        selectionSource: 'ref-click',
      }));
    });
  };
  const childRows = referenceCycle ? [] : buildOutlinerRows(childParentNode, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  });
  const childTrailingFocused = props.ui.focusedId === childParentId
    && props.ui.focusSurface === 'trailing'
    && props.ui.focusedPanelId === props.panelId;
  const showEmptyChildTrailingInput = !referenceCycle && (childRows.length === 0 || childTrailingFocused);
  const childReferencePath = [...props.referencePath, childParentId];
  const pendingReferenceConversion = props.ui.pendingReferenceConversion?.nodeId === props.nodeId;
  const pendingReferenceTypeAhead = props.ui.pendingReferenceTypeAhead?.nodeId === props.nodeId;
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
  const appliedTagColors = tagBulletColors(appliedTags);
  const tagDefColor = leadingVariant === 'tag' ? resolveTagColor(displayed).text : undefined;
  const showDoneCheckbox = displayed.showCheckbox
    || displayed.doneStateEnabled
    || Boolean(displayed.completedAt);
  const descriptionEditing = props.ui.editingDescriptionId === targetEditId;
  const referenceLikeRow = node.type === 'reference' || pendingReferenceConversion;
  const isCodeBlock = displayed.type === 'codeBlock' && !referenceLikeRow;
  const isBlockNode = !referenceLikeRow && isBlockNodeType(displayed);
  const editorContentRevision = pendingReferenceConversion
    ? displayed.updatedAt
    : draftContentRevision;
  const activeTrigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
  const triggerOwnsWholeDraft = activeTrigger?.kind === '@'
    && draftContent.inlineRefs.length === 0
    && triggerOwnsWholeText(draftContent.text, activeTrigger);

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
          selectionRootId: props.rootId,
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
    const result = await restorePendingReferenceConversion(content);
    return result.nodeId;
  };

  const applyTextPatch = (patch: RichTextPatch) => {
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
      ? deleteRichTextRange(draftContent, trigger.from, trigger.to)
        : plainText(draftContent.text.replace(/(?:^|\s)([#@/>])([^\s#@/>]*)$/, '').trimEnd());
    replaceLocalDraftContent(nextContent);
    await props.run(() => api.replaceNodeText(targetEditId, nextContent));
  };

  const handleEditorChange = (content: RichText) => {
    localDraftSyncRef.current = { nodeId: targetEditId, content };
    draftContentRef.current = content;
    setDraftContent(content);
  };

  const handlePasteOutliner = (payload: {
    content: RichText;
    children: CreateNodeTree[];
    siblingsAfter: CreateNodeTree[];
  }) => {
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
    void props.run(() => api.pasteNodesIntoNode(
      props.nodeId,
      payload.content,
      payload.children,
      payload.siblingsAfter,
    ));
  };

  const insertImagesFromAssets = async (assets: AssetMetadata[]) => {
    if (assets.length === 0) return;
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    let insertIndex = rowIndex >= 0 ? rowIndex + 1 : null;
    for (const asset of assets) {
      await props.run(() => api.createImageNode(props.parentId, insertIndex, {
        assetId: asset.id,
        width: asset.imageWidth,
        height: asset.imageHeight,
      }));
      if (insertIndex !== null) insertIndex += 1;
    }
  };

  // Land images "here": convert the current row into the first image when it is
  // a plain, *empty*, childless row (so no typed text is buried under an image
  // body that never renders it) rather than spawning an empty row beside the
  // image; remaining images become siblings. Used by both clipboard paste and
  // the `/image` slash command. Focus lands on the new image block via its
  // `BlockNodeRow` shell.
  const landImagesOnCurrentRow = async (assets: AssetMetadata[]) => {
    if (assets.length === 0) return;
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
      const outcome = await api.replaceNodeWithReferenceConversion(props.nodeId, target.id);
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
        targetNodeId: target.id,
        displayName: textOf(target),
      },
    );
    replaceLocalDraftContent(nextContent);
    requestRowFocus(
      props.nodeId,
      cursorAtOffset(trigger.from, 'after'),
      props.parentId,
    );
    return api.replaceNodeText(targetEditId, nextContent);
  };

  const executeSlashCommand = async (commandId: SlashCommandId) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;

    if (commandId === 'field') {
      await pendingTextPatchRef.current;
      return createPlaceholderInlineFieldAfterNode(props.nodeId, 'plain');
    }

    if (commandId === 'reference') {
      await pendingTextPatchRef.current;
      const nextContent = replaceRichTextRangeWithText(draftContent, trigger.from, trigger.to, '@');
      replaceLocalDraftContent(nextContent);
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
      const withoutTrigger = deleteRichTextRange(draftContent, trigger.from, trigger.to);
      const nextContent = markWholeTextAsHeading(withoutTrigger);
      replaceLocalDraftContent(nextContent);
      return api.replaceNodeText(targetEditId, nextContent);
    }

    if (commandId === 'checkbox') {
      await applyTextWithoutTrigger();
      return api.toggleDone(targetEditId);
    }

    if (commandId === 'code') {
      await pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContent, trigger.from, trigger.to);
      replaceLocalDraftContent(withoutTrigger);
      await api.replaceNodeText(targetEditId, withoutTrigger);
      return api.setCodeBlock(targetEditId);
    }

    if (commandId === 'image') {
      await pendingTextPatchRef.current;
      const withoutTrigger = deleteRichTextRange(draftContent, trigger.from, trigger.to);
      replaceLocalDraftContent(withoutTrigger);
      await api.replaceNodeText(targetEditId, withoutTrigger);
      const assets = await api.pickImageFiles();
      await landImagesOnCurrentRow(assets);
      return api.getProjection();
    }

    if (commandId === 'command_palette') {
      await applyTextWithoutTrigger();
      props.setUi((prev) => ({ ...prev, commandOpen: true }));
      return api.getProjection();
    }

    return null;
  };

  const handleEnter = async (payload: EditorSplitPayload) => {
    if (props.trigger?.nodeId === props.nodeId) return;
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    if (!payload.atEnd) {
      await props.run(() => api.splitNode(targetEditId, payload.before, payload.after, {
        ...(node.type === 'reference'
          ? { targetParentId: props.parentId, targetIndex: rowIndex >= 0 ? rowIndex + 1 : null }
          : row.expanded && row.hasChildren
            ? { targetParentId: props.nodeId, targetIndex: 0 }
            : {}),
        focusPlacement: { kind: 'start' },
      }));
      return;
    }
    await commitDraft(payload.before);
    if (row.expanded && row.hasChildren) {
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

  // Enter on a block node (image/attachment/embed) opens a fresh text sibling
  // below it, the way Enter on a code block does.
  const handleBlockExit = async () => {
    const siblings = props.index.byId.get(props.parentId)?.children ?? [];
    const rowIndex = siblings.indexOf(props.nodeId);
    await props.run(() => api.createNode(props.parentId, rowIndex >= 0 ? rowIndex + 1 : null, ''));
  };

  // Open the caption editor — a block node's caption is its `description`.
  const openCaptionEditor = () => {
    descriptionReturnPlacementRef.current = cursorEnd();
    props.setUi((prev) => requestFocusState(
      { ...prev, editingDescriptionId: targetEditId },
      descriptionFocusTarget,
      cursorEnd(),
    ));
  };

  const handleSetCodeLanguage = (language: string) => {
    void props.run(() => api.setCodeLanguage(targetEditId, language), { applyFocus: false });
  };

  const handleBackspaceAtStart = async (isEmpty: boolean) => {
    const intent = resolveContentRowBackspaceAtStartIntent({
      isEmpty,
      hasChildren: row.hasChildren,
    });
    if (intent === 'block_delete_parent') {
      return;
    }
    if (intent === 'delete_empty') {
      row.moveFocus(-1);
      await props.run(() => api.trashNode(props.nodeId));
      return;
    }

    const visibleRows = flattenVisibleRows(
      props.rootId,
      props.index.byId,
      props.ui.expanded,
      props.ui.expandedHiddenFields,
    );
    const previousId = previousVisibleRowId(visibleRows, props.nodeId);
    if (!previousId) return;

    const previousNode = props.index.byId.get(previousId);
    if (!previousNode) return;

    if (node.type === 'reference' || previousNode.type === 'reference') {
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
    await commitDraft();
    if (!shiftKey) {
      const targetParentId = indentTargetParentId(props.nodeId, props.index.byId);
      if (!targetParentId) return;
      const expandTarget = () => props.setUi((prev) => {
        const expanded = new Set(prev.expanded);
        expanded.add(targetParentId);
        return { ...prev, expanded };
      });
      const focusIndentedRow = () => props.setUi((prev) => requestFocusState(
        prev,
        rowFocusTarget(props.nodeId, null, props.panelId),
        cursorAtOffset(cursorOffset),
      ));
      expandTarget();
      const result = await props.run(() => api.indentNode(props.nodeId));
      if (result) {
        focusIndentedRow();
      }
      return;
    }
    props.setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(props.nodeId, null, props.panelId),
      cursorAtOffset(cursorOffset),
    ));
    const result = await props.run(() => api.outdentNode(props.nodeId));
    if (result) {
      props.setUi((prev) => requestFocusState(
        prev,
        rowFocusTarget(props.nodeId, null, props.panelId),
        cursorAtOffset(cursorOffset),
      ));
    }
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
      selectionRootId: props.rootId,
      selectionSource: 'global',
    }));
  };

  const focusNode = (nodeId: NodeId) => {
    requestRowFocus(nodeId);
  };

  const collapseNode = (nodeId: NodeId) => {
    props.setUi((prev) => {
      const expanded = new Set(prev.expanded);
      expanded.delete(nodeId);
      return { ...prev, expanded };
    });
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
      selectionRootId: props.rootId,
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
    if (props.ui.selectedIds.size > 1 && !displayed.locked) {
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

  return (
    <OutlinerRowShell
      hasChildren={row.hasChildren}
      expanded={row.expanded}
      wrapProps={row.wrapProps}
      rowClassName={row.rowClassName([
        referenceLikeRow ? 'reference-row' : '',
        pendingReferenceConversion ? 'ref-converting' : '',
        pendingReferenceTypeAhead ? 'ref-typeahead' : '',
      ].filter(Boolean).join(' '))}
      onSelectFromPointer={row.selectFromPointer}
      onContextMenu={openContextMenu}
      rowContent={(
        <>
        <RowLeading
          hasChildren={row.hasChildren}
          expanded={row.expanded}
          variant={leadingVariant}
          fieldType={displayed.fieldType}
          bulletColors={appliedTagColors}
          tagDefColor={tagDefColor}
          onToggleExpand={row.toggleExpandOrSelect}
          onDrillDown={() => props.onRoot(drillDownId)}
          draggable={row.dragHandleProps.draggable}
          onDragStart={row.dragHandleProps.onDragStart}
          onDragEnd={row.dragHandleProps.onDragEnd}
        />
        <div
          className={isBlockNode ? 'row-content-line row-content-line--block' : 'row-content-line'}
          onMouseDownCapture={referenceLikeRow ? selectReferenceLikeRowFromPointer : undefined}
          onMouseDown={referenceLikeRow ? undefined : focusEditorFromRowClick}
          onClickCapture={referenceLikeRow ? selectReferenceLikeRowFromPointer : undefined}
          onDoubleClick={focusReferenceTargetFromDoubleClick}
        >
          {showDoneCheckbox && (
            <DoneCheckbox
              checked={Boolean(displayed.completedAt)}
              onToggle={() => void props.run(() => api.toggleDone(targetEditId))}
            />
          )}
          {isBlockNode ? (
            <BlockNodeRow
              node={displayed}
              readOnly={displayed.locked}
              onFocus={row.updateSelection}
              onArrowUp={() => row.moveFocus(-1)}
              onArrowDown={() => row.moveFocus(1)}
              onEnter={() => void handleBlockExit()}
              // Backspace removes a childless block; a block with children is a
              // no-op (block_delete_parent), matching plain rows so a Backspace
              // never silently trashes a subtree.
              onBackspace={() => void handleBackspaceAtStart(true)}
              onEscape={() => void exitToSelection()}
              onShiftArrow={() => void exitToSelection()}
              onTab={(shiftKey) => void handleTab(shiftKey, 0)}
              onUndo={() => void props.run(() => api.undo())}
              onRedo={() => void props.run(() => api.redo())}
              onAddCaption={openCaptionEditor}
              focusTarget={editorFocusTarget}
              focusRequest={props.ui.focusRequest}
              onFocusRequestConsumed={(request) => {
                props.setUi((prev) => clearFocusRequestState(prev, request));
              }}
            />
          ) : isCodeBlock ? (
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
            readOnly={displayed.locked}
            completed={Boolean(displayed.completedAt)}
            onFocus={row.updateSelection}
            onChange={handleEditorChange}
            onPatch={applyTextPatch}
            onCommit={(content) => void commitDraft(content)}
            onEnter={(payload) => void handleEnter(payload)}
            onBackspaceAtStart={(isEmpty) => void handleBackspaceAtStart(isEmpty)}
            onTab={(shiftKey, cursorOffset) => void handleTab(shiftKey, cursorOffset)}
            onArrowUpAtStart={() => row.moveFocus(-1)}
            onArrowDownAtEnd={() => row.moveFocus(1)}
            onShiftArrow={() => void exitToSelection()}
            onMove={(direction) => void moveCurrentNode(direction)}
            onUndo={() => void props.run(() => api.undo())}
            onRedo={() => void props.run(() => api.redo())}
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
            resolveInlineReferenceColor={(targetId) => inlineReferenceTextColor(targetId, props.index)}
            onFieldTriggerFire={() => {
              props.setTrigger(null);
              void pendingTextPatchRef.current.then(() => props.run(() => (
                createPlaceholderInlineFieldAfterNode(props.nodeId, 'plain')
              )));
            }}
            onTriggerChange={(nextTrigger) => {
              if (nextTrigger) {
                props.setTrigger({ nodeId: props.nodeId, ...nextTrigger });
              } else if (props.trigger?.nodeId === props.nodeId) {
                props.setTrigger(null);
              }
            }}
            onPasteOutliner={node.type === 'reference' ? undefined : handlePasteOutliner}
            onPasteImage={node.type === 'reference' ? undefined : (images) => void handlePasteImage(images)}
            onPasteMediaUrl={node.type === 'reference' ? undefined : (url) => void handlePasteMediaUrl(url)}
            onInlineReferenceClick={pendingReferenceConversion
              ? undefined
              : (targetId) => props.onRoot(targetId, { focus: false })}
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
          )}
          {displayed.tags.length > 0 && (
            <TagBar
              nodeId={targetEditId}
              tagIds={displayed.tags}
              index={props.index}
              run={props.run}
              onRoot={props.onRoot}
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
        </div>
        </>
      )}
    >

      {row.expanded && (
        <IndentGuide onToggleChildren={row.toggleDirectChildrenExpansion} />
      )}

      {activeTrigger && (
        <TriggerPopover
          trigger={activeTrigger}
          index={props.index}
          nodeId={targetEditId}
          run={props.run}
          close={() => props.setTrigger(null)}
          clearTriggerText={applyTextWithoutTrigger}
          applyReference={applyReference}
          executeSlashCommand={executeSlashCommand}
          enabledSlashCommandIds={['field', 'reference', 'heading', 'checkbox', 'code', 'image', 'command_palette']}
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
          selectedIds={props.ui.selectedIds}
          index={props.index}
          run={props.run}
          onRoot={props.onRoot}
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

      {row.expanded && (
        <div className="children">
          <OutlinerView
            panelId={props.panelId}
            parentId={childParentId}
            rootId={props.rootId}
            onRoot={props.onRoot}
            depth={0}
            index={props.index}
            ui={props.ui}
            setUi={props.setUi}
            run={props.run}
            trigger={props.trigger}
            setTrigger={props.setTrigger}
            dragId={props.dragId}
            setDragId={props.setDragId}
            referencePath={childReferencePath}
          />
          {showEmptyChildTrailingInput && (
            <TrailingInput
              panelId={props.panelId}
              parentId={childParentId}
              index={props.index}
              expanded={props.ui.expanded}
              run={props.run}
              focusRequest={props.ui.focusRequest}
              focusedId={props.ui.focusedId}
              focusSurface={props.ui.focusSurface}
              onFocusRequestConsumed={(request) => {
                props.setUi((prev) => clearFocusRequestState(prev, request));
              }}
              onCreate={async (parentId, text) => {
                let createdId: string | null = null;
                await props.run(async () => {
                  const outcome = await api.createNode(parentId, null, text);
                  createdId = outcome.focus?.nodeId ?? null;
                  return outcome.projection;
                }, { applyFocus: false });
                return createdId;
              }}
              onCreateTree={(parentId, nodes) => (
                props.run(() => api.createNodesFromTree(parentId, nodes), { applyFocus: false })
              )}
              onPasteImages={(parentId, images) => appendImageNodes(parentId, images, props.run)}
              onIndentNode={(nodeId) => (
                props.run(() => api.indentNode(nodeId), { applyFocus: false })
              )}
              onUpdateCreated={async (nodeId, text) => {
                await props.run(() => api.replaceNodeText(nodeId, plainText(text)), { applyFocus: false });
              }}
              continueOnEnter
              onToggleCreated={async (nodeId) => {
                await props.run(() => api.toggleDone(nodeId));
              }}
              onApplyTagTrigger={applyTrailingTagTrigger}
              onCreateTagTrigger={createAndApplyTrailingTagTrigger}
              onApplyReferenceTrigger={applyTrailingReferenceTrigger}
              onReferenceConversionCreated={({ nodeId, parentId, targetId }) => {
                props.setUi((prev) => ({
                  ...prev,
                  pendingReferenceConversion: { nodeId, parentId, targetId },
                }));
              }}
              onExecuteSlashTrigger={executeTrailingSlashTrigger}
              onOpenCommandPalette={() => props.setUi((prev) => ({ ...prev, commandOpen: true }))}
              onCreateField={(parentId) => (
                createTrailingField({
                  parentId,
                  run: props.run,
                })
              )}
              onExpand={(nodeId) => {
                props.setUi((prev) => {
                  const expanded = new Set(prev.expanded);
                  expanded.add(nodeId);
                  return { ...prev, expanded };
                });
              }}
              onFocusNode={focusNode}
              onFocusDescription={(nodeId, parentId) => {
                props.setUi((prev) => requestFocusState(
                  { ...prev, editingDescriptionId: nodeId },
                  focusTarget(nodeId, parentId, props.panelId, 'description'),
                  cursorEnd(),
                ));
              }}
              onCollapseNode={collapseNode}
              onUndo={() => void props.run(() => api.undo())}
              onRedo={() => void props.run(() => api.redo())}
            />
          )}
        </div>
      )}
    </OutlinerRowShell>
  );
}

function isOnlyInlineReference(content: RichText, targetId: NodeId) {
  const textEmpty = content.text.replace(/\u200B/g, '').trim().length === 0;
  if (textEmpty && content.inlineRefs.length === 0) return true;
  return textEmpty
    && content.marks.length === 0
    && content.inlineRefs.length === 1
    && content.inlineRefs[0].offset === 0
    && content.inlineRefs[0].targetNodeId === targetId;
}
