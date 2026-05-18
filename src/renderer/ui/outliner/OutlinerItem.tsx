import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from 'react';
import { api } from '../../api/client';
import type { CreateNodeTree, NodeId, NodeProjection, RichText, RichTextPatch } from '../../api/types';
import { EMPTY_RICH_TEXT, plainText } from '../../api/types';
import type { CursorPlacement } from '../../state/document';
import { flattenVisibleRows, type DocumentIndex, type UiState } from '../../state/document';
import { RichTextEditor, type EditorSplitPayload } from '../editor/RichTextEditor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
} from '../editor/richTextCodec';
import { indentTargetParentId, previousVisibleRowId } from '../interactions/outlinerStructure';
import {
  resolveContentRowBackspaceAtStartIntent,
  resolveReferenceSelectionAction,
} from '../interactions/rowInteractions';
import type { SlashCommandId } from '../interactions/slashCommands';
import type { CommandRunner, TriggerState } from '../shared';
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
import { TrailingInput } from './TrailingInput';
import { TriggerPopover } from './TriggerPopover';
import { DoneCheckbox } from './DoneCheckbox';
import { NodeContextMenu } from './NodeContextMenu';
import { NodeDescription } from './NodeDescription';
import { OutlinerRowShell } from './OutlinerRowShell';
import { OutlinerView } from './OutlinerView';
import { IndentGuide } from './IndentGuide';
import { RowLeading } from './RowLeading';
import { buildOutlinerRows, shouldShowTrailingInput } from './row-model';
import { createTrailingField, createTrailingTriggerNode } from './trailingTriggers';
import { useOutlinerRowInteraction } from './useOutlinerRowInteraction';

interface OutlinerItemProps {
  panelId: string;
  nodeId: NodeId;
  parentId: NodeId;
  rootId: NodeId;
  onRoot: (nodeId: NodeId) => void;
  depth: number;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
}

export function OutlinerItem(props: OutlinerItemProps) {
  const node = props.index.byId.get(props.nodeId);
  const [draftContent, setDraftContent] = useState<RichText>(node?.content ?? EMPTY_RICH_TEXT);
  const [draftContentRevision, setDraftContentRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const pendingTextPatchRef = useRef<Promise<unknown>>(Promise.resolve());
  const rowChildIds = outlinerChildren(node, props.index.byId);
  const row = useOutlinerRowInteraction({
    rowId: props.nodeId,
    parentId: props.parentId,
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
  const displayed = node?.type === 'reference' && node.targetId ? props.index.byId.get(node.targetId) ?? node : node;

  useEffect(() => {
    setDraftContent(displayed?.content ?? EMPTY_RICH_TEXT);
  }, [displayed?.id, displayed?.content, displayed?.targetId]);

  if (!node || !displayed) return null;

  const replaceLocalDraftContent = (content: RichText) => {
    setDraftContent(content);
    setDraftContentRevision((revision) => revision + 1);
  };

  const targetEditId = node.type === 'reference' && node.targetId ? node.targetId : node.id;
  const drillDownId = node.type === 'reference' && node.targetId ? node.targetId : node.id;
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
  const childRows = buildOutlinerRows(node, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  });
  const showTrailingInput = shouldShowTrailingInput(childRows);
  const leadingVariant = node.type === 'reference'
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

  const commitDraft = async (_content = draftContent) => {
    await pendingTextPatchRef.current;
  };

  const applyTextPatch = (patch: RichTextPatch) => {
    pendingTextPatchRef.current = pendingTextPatchRef.current.then(() =>
      props.run(() => api.applyNodeTextPatch(targetEditId, patch)));
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
    setDraftContent(content);
  };

  const handlePasteOutliner = (payload: {
    content: RichText;
    children: CreateNodeTree[];
    siblingsAfter: CreateNodeTree[];
  }) => {
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

  const parentAlreadyContainsReferenceTarget = (targetId: NodeId) => {
    const parent = props.index.byId.get(props.parentId);
    return Boolean(parent?.children.some((childId) => {
      if (childId === props.nodeId) return false;
      if (childId === targetId) return true;
      const child = props.index.byId.get(childId);
      return child?.type === 'reference' && child.targetId === targetId;
    }));
  };

  const applyReference = async (target: NodeProjection) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return;
    await pendingTextPatchRef.current;
    const action = resolveReferenceSelectionAction({
      text: draftContent.text,
      inlineRefCount: draftContent.inlineRefs.length,
      triggerFrom: trigger.from,
      triggerTo: trigger.to,
      canCreateTreeReference: node.type !== 'reference'
        && !parentAlreadyContainsReferenceTarget(target.id),
    });
    if (action === 'tree_reference') {
      return api.replaceNodeWithReference(props.nodeId, target.id);
    }

    const nextContent = replaceRichTextRangeWithInlineRef(
      draftContent,
      trigger.from,
      trigger.to,
      {
        targetNodeId: target.id,
        displayName: textOf(target),
      },
    );
    replaceLocalDraftContent(nextContent);
    return api.replaceNodeText(targetEditId, nextContent);
  };

  const executeSlashCommand = async (commandId: SlashCommandId) => {
    const trigger = props.trigger?.nodeId === props.nodeId ? props.trigger : null;
    if (!trigger) return null;

    if (commandId === 'field') {
      return api.createInlineFieldAfterNode(props.nodeId, 'Field', 'plain');
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
      await props.run(() => api.createNode(props.nodeId, 0, payload.after.text));
      return;
    }
    await props.run(() => api.createNode(props.parentId, rowIndex >= 0 ? rowIndex + 1 : null, ''));
  };

  const handleModEnter = async (content: RichText) => {
    setDraftContent(content);
    await commitDraft(content);
    await props.run(() => api.cycleDoneState(targetEditId));
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
      const expandTargetAndRememberCursor = () => props.setUi((prev) => {
        const expanded = new Set(prev.expanded);
        expanded.add(targetParentId);
        return requestFocusState(
          { ...prev, expanded },
          rowFocusTarget(props.nodeId, null, props.panelId),
          cursorAtOffset(cursorOffset),
        );
      });
      expandTargetAndRememberCursor();
      const result = await props.run(() => api.indentNode(props.nodeId));
      if (result) {
        expandTargetAndRememberCursor();
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
    await commitDraft();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: props.nodeId,
      selectedIds: new Set([props.nodeId]),
      selectionAnchorId: props.nodeId,
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
      || displayed.locked
    ) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('button, a, input, textarea, select, [data-preserve-selection]')) return;

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

  return (
    <OutlinerRowShell
      hasChildren={row.hasChildren}
      expanded={row.expanded}
      wrapProps={row.wrapProps}
      rowClassName={row.rowClassName()}
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
        <div className="row-content-line" onMouseDown={focusEditorFromRowClick}>
          {showDoneCheckbox && (
            <DoneCheckbox
              checked={Boolean(displayed.completedAt)}
              onToggle={() => void props.run(() => api.toggleDone(targetEditId))}
            />
          )}
          <RichTextEditor
            nodeId={props.nodeId}
            content={draftContent}
            contentRevision={draftContentRevision}
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
            onModEnter={(content) => void handleModEnter(content)}
            onEscape={() => void exitToSelection()}
            resolveInlineReferenceColor={(targetId) => inlineReferenceTextColor(targetId, props.index)}
            onFieldTriggerFire={() => {
              props.setTrigger(null);
              void props.run(() => api.createInlineFieldAfterNode(props.nodeId, 'Field', 'plain'));
            }}
            onTriggerChange={(nextTrigger) => {
              if (nextTrigger) {
                props.setTrigger({ nodeId: props.nodeId, ...nextTrigger });
              } else if (props.trigger?.nodeId === props.nodeId) {
                props.setTrigger(null);
              }
            }}
            onPasteOutliner={node.type === 'reference' ? undefined : handlePasteOutliner}
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

      {props.trigger?.nodeId === props.nodeId && (
        <TriggerPopover
          trigger={props.trigger}
          index={props.index}
          nodeId={targetEditId}
          run={props.run}
          close={() => props.setTrigger(null)}
          clearTriggerText={applyTextWithoutTrigger}
          applyReference={applyReference}
          executeSlashCommand={executeSlashCommand}
          enabledSlashCommandIds={['field', 'reference', 'heading', 'checkbox', 'command_palette']}
          treeReferenceParentId={props.parentId}
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
            props.setUi((prev) => requestFocusState(
              { ...prev, editingDescriptionId: targetEditId },
              descriptionFocusTarget,
              cursorEnd(),
            ));
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {row.expanded && (
        <div className="children">
          <OutlinerView
            panelId={props.panelId}
            parentId={props.nodeId}
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
          />
          {showTrailingInput && (
            <TrailingInput
              panelId={props.panelId}
              parentId={props.nodeId}
              index={props.index}
              expanded={props.ui.expanded}
              focusRequest={props.ui.focusRequest}
              onFocusRequestConsumed={(request) => {
                props.setUi((prev) => clearFocusRequestState(prev, request));
              }}
              onCreate={async (parentId, text) => {
                const result = await props.run(() => api.createNode(parentId, null, text));
                return result && 'focus' in result ? result.focus?.nodeId ?? null : null;
              }}
              onCreateTree={(parentId, nodes) => (
                props.run(() => api.createNodesFromTree(parentId, nodes))
              )}
              onUpdateCreated={async (nodeId, text) => {
                await props.run(() => api.replaceNodeText(nodeId, plainText(text)));
              }}
              onToggleCreated={async (nodeId) => {
                await props.run(() => api.toggleDone(nodeId));
              }}
              onCreateTrigger={(params) => {
                return createTrailingTriggerNode({
                  getText: params.getText,
                  parentId: params.parentId,
                  text: params.text,
                  trigger: params.trigger,
                  run: props.run,
                  setTrigger: props.setTrigger,
                });
              }}
              onCreateField={(parentId) => {
                void createTrailingField({
                  parentId,
                  run: props.run,
                });
              }}
              onExpand={(nodeId) => {
                props.setUi((prev) => {
                  const expanded = new Set(prev.expanded);
                  expanded.add(nodeId);
                  return { ...prev, expanded };
                });
              }}
              onFocusNode={focusNode}
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
