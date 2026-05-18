import { useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent, type SetStateAction } from 'react';
import { api } from '../api/client';
import type { NodeId, RichText, RichTextPatch } from '../api/types';
import { EMPTY_RICH_TEXT, plainText } from '../api/types';
import { flattenVisibleRows, type DocumentIndex, type UiState } from '../state/document';
import { RichTextEditor, type EditorSplitPayload } from './editor/RichTextEditor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
} from './editor/richTextCodec';
import { DefinitionConfigPanel } from './definition/DefinitionConfigPanel';
import { definitionKind, definitionOutlinerLabel } from './definition/definitionConfig';
import type { SlashCommandId } from './interactions/slashCommands';
import type { CommandRunner, EditorTrigger, TriggerState } from './shared';
import {
  clearFocusRequestState,
  clearFocusState,
  clearPendingInputState,
  cursorEnd,
  cursorStart,
  focusTarget,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from './focus/focusModel';
import {
  CalendarIcon,
  HashIcon,
  LibraryIcon,
  MoreIcon,
  SearchIcon,
  TrashIcon,
} from './icons';
import { FieldTypeIcon } from './outliner/fieldTypePresentation';
import { DoneCheckbox } from './outliner/DoneCheckbox';
import { NodeContextMenu } from './outliner/NodeContextMenu';
import { NodeDescription } from './outliner/NodeDescription';
import { OutlinerView } from './outliner/OutlinerView';
import { buildPanelOutlinerSections } from './outliner/row-model';
import { TrailingInput } from './outliner/TrailingInput';
import { TriggerPopover } from './outliner/TriggerPopover';
import { createTrailingField, createTrailingTriggerNode } from './outliner/trailingTriggers';
import { ButtonControl } from './primitives/ButtonControl';
import { IconButton } from './primitives/IconButton';
import { inlineReferenceTextColor, resolveTagColor } from './tags/tagColors';
import { TagBar } from './tags/TagBar';
import { buildPanelBreadcrumb } from './panelBreadcrumb';

interface NodePanelProps {
  panelId: string;
  rootId: NodeId;
  onRoot: (nodeId: NodeId) => void;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
}

export function NodePanel(props: NodePanelProps) {
  const rootNode = props.index.byId.get(props.rootId);
  const projection = props.index.projection;
  const [titleContent, setTitleContent] = useState<RichText>(rootNode?.content ?? EMPTY_RICH_TEXT);
  const [titleContentRevision, setTitleContentRevision] = useState(0);
  const [titleTrigger, setTitleTrigger] = useState<EditorTrigger | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const pendingTitlePatchRef = useRef<Promise<unknown>>(Promise.resolve());
  const rootDefinitionKind = definitionKind(rootNode);
  const definitionTemplateLabel = rootNode ? definitionOutlinerLabel(rootNode) : null;
  const showOutliner = Boolean(rootNode && (!rootDefinitionKind || definitionTemplateLabel));
  const showTrailingInput = Boolean(rootNode && showOutliner);
  const breadcrumb = buildPanelBreadcrumb(rootNode, props.index);
  const titleFocusTarget = focusTarget(props.rootId, null, props.panelId, 'panel-title');
  const descriptionFocusTarget = focusTarget(props.rootId, null, props.panelId, 'description');
  const panelRows = useMemo(() => buildPanelOutlinerSections(rootNode, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  }), [props.index.byId, props.ui.expandedHiddenFields, rootNode]);
  const hasHeadingFields = panelRows.headingRows.length > 0;

  useEffect(() => {
    setTitleContent(rootNode?.content ?? EMPTY_RICH_TEXT);
    setTitleTrigger(null);
  }, [rootNode?.id, rootNode?.content]);

  const focusFirstVisibleRowOrTrailing = () => {
    const rows = flattenVisibleRows(
      props.rootId,
      props.index.byId,
      props.ui.expanded,
      props.ui.expandedHiddenFields,
    );
    const first = rows[0];
    if (!first) {
      props.setUi((prev) => requestFocusState(
        prev,
        focusTarget(props.rootId, props.rootId, props.panelId, 'trailing'),
        cursorEnd(),
      ));
      return;
    }
    const firstNode = props.index.byId.get(first);
    props.setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(first, firstNode?.parentId ?? props.rootId, props.panelId),
      cursorStart(),
    ));
  };

  const replaceLocalTitleContent = (content: RichText) => {
    setTitleContent(content);
    setTitleContentRevision((revision) => revision + 1);
  };

  const focusNode = (nodeId: NodeId) => {
    const targetNode = props.index.byId.get(nodeId);
    props.setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(nodeId, targetNode?.parentId ?? null, props.panelId),
      cursorEnd(),
    ));
  };

  const collapseNode = (nodeId: NodeId) => {
    props.setUi((prev) => {
      const expanded = new Set(prev.expanded);
      expanded.delete(nodeId);
      return { ...prev, expanded };
    });
  };

  const renderHeaderIcon = () => {
    if (!rootNode) return null;
    if (props.rootId === projection.todayId) return <CalendarIcon size={20} />;
    if (props.rootId === projection.rootId) return <LibraryIcon size={20} />;
    if (props.rootId === projection.schemaId) return <LibraryIcon size={20} />;
    if (props.rootId === projection.trashId) return <TrashIcon size={20} />;
    if (props.rootId === projection.searchesId || rootNode.type === 'search') return <SearchIcon size={20} />;
    if (rootNode.type === 'tagDef') {
      return (
        <span className="panel-header-tag-icon" style={{ background: resolveTagColor(rootNode).text }}>
          <HashIcon size={12} />
        </span>
      );
    }
    if (rootNode.type === 'fieldDef') return <FieldTypeIcon fieldType={rootNode.fieldType} size={20} />;
    return null;
  };

  const headerIcon = renderHeaderIcon();
  const showDoneCheckbox = Boolean(rootNode?.showCheckbox || rootNode?.doneStateEnabled || rootNode?.completedAt);

  const selectHeader = () => {
    props.setUi((prev) => selectFocusState(prev, titleFocusTarget));
  };

  const clearHeaderFocus = () => {
    props.setUi((prev) => (
      prev.focusedId === props.rootId
        ? clearFocusState(prev)
        : prev
    ));
  };

  const commitTitle = async (_content = titleContent) => {
    await pendingTitlePatchRef.current;
    clearHeaderFocus();
  };

  const applyTitlePatch = (patch: RichTextPatch) => {
    pendingTitlePatchRef.current = pendingTitlePatchRef.current.then(() =>
      props.run(() => api.applyNodeTextPatch(props.rootId, patch)));
    void pendingTitlePatchRef.current;
  };

  const blurActiveElement = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleTitleEnter = (_payload: EditorSplitPayload) => {
    void commitTitle().then(blurActiveElement);
  };

  const handleTitleModEnter = async (content: RichText) => {
    replaceLocalTitleContent(content);
    await pendingTitlePatchRef.current;
    await props.run(() => api.cycleDoneState(props.rootId));
  };

  const openHeaderContextMenu = (event: MouseEvent) => {
    if (!rootNode) return;
    event.preventDefault();
    event.stopPropagation();
    blurActiveElement();
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: props.rootId,
      selectedIds: prev.selectedIds.has(props.rootId) ? new Set(prev.selectedIds) : new Set([props.rootId]),
      selectionAnchorId: prev.selectedIds.has(props.rootId) ? prev.selectionAnchorId ?? props.rootId : props.rootId,
    }));
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const openHeaderMoreMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (!rootNode) return;
    event.preventDefault();
    event.stopPropagation();
    blurActiveElement();
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: props.rootId,
      selectedIds: prev.selectedIds.has(props.rootId) ? new Set(prev.selectedIds) : new Set([props.rootId]),
      selectionAnchorId: prev.selectedIds.has(props.rootId) ? prev.selectionAnchorId ?? props.rootId : props.rootId,
    }));
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  const clearTitleTriggerText = async () => {
    if (!titleTrigger || !rootNode) return;
    await pendingTitlePatchRef.current;
    const nextContent = deleteRichTextRange(titleContent, titleTrigger.from, titleTrigger.to);
    replaceLocalTitleContent(nextContent);
    await props.run(() => api.replaceNodeText(props.rootId, nextContent));
  };

  const applyTitleInlineReference = async (target: { id: NodeId; content: RichText }) => {
    if (!titleTrigger || !rootNode) return;
    await pendingTitlePatchRef.current;
    const nextContent = replaceRichTextRangeWithInlineRef(
      titleContent,
      titleTrigger.from,
      titleTrigger.to,
      {
        targetNodeId: target.id,
        displayName: target.content.text,
      },
    );
    replaceLocalTitleContent(nextContent);
    return api.replaceNodeText(props.rootId, nextContent);
  };

  const executeTitleSlashCommand = async (commandId: SlashCommandId) => {
    if (!titleTrigger || !rootNode) return null;

    if (commandId === 'reference') {
      await pendingTitlePatchRef.current;
      const nextContent = replaceRichTextRangeWithText(titleContent, titleTrigger.from, titleTrigger.to, '@');
      replaceLocalTitleContent(nextContent);
      const result = await api.replaceNodeText(props.rootId, nextContent);
      window.requestAnimationFrame(() => {
        setTitleTrigger({
          kind: '@',
          query: '',
          from: titleTrigger.from,
          to: titleTrigger.from + 1,
          anchor: titleTrigger.anchor,
        });
      });
      return result;
    }

    if (commandId === 'heading') {
      await pendingTitlePatchRef.current;
      const withoutTrigger = deleteRichTextRange(titleContent, titleTrigger.from, titleTrigger.to);
      const nextContent = markWholeTextAsHeading(withoutTrigger);
      replaceLocalTitleContent(nextContent);
      return api.replaceNodeText(props.rootId, nextContent);
    }

    if (commandId === 'checkbox') {
      await clearTitleTriggerText();
      return api.toggleDone(props.rootId);
    }

    if (commandId === 'command_palette') {
      await clearTitleTriggerText();
      props.setUi((prev) => ({ ...prev, commandOpen: true }));
      return api.getProjection();
    }

    return null;
  };

  return (
    <main className="main-panel">
      <div className="panel-inner">
        <header className="panel-header">
          {rootNode && (
            <nav className="panel-breadcrumb" aria-label="Panel breadcrumb">
              <ButtonControl
                aria-label="Open workspace root"
                className="panel-breadcrumb-origin"
                onClick={() => props.onRoot(projection.rootId)}
              >
                <LibraryIcon size={13} />
              </ButtonControl>
              {breadcrumb.nodes.map((node, index) => {
                const label = node.content.text || 'Untitled';
                const showCollapsedMarker = breadcrumb.collapsed && index === 1;
                return (
                  <span className="panel-breadcrumb-segment" key={node.id}>
                    <span className="panel-breadcrumb-divider">/</span>
                    {showCollapsedMarker && (
                      <>
                        <span className="panel-breadcrumb-ellipsis" aria-label="Collapsed breadcrumb levels">...</span>
                        <span className="panel-breadcrumb-divider">/</span>
                      </>
                    )}
                    <ButtonControl
                      className="panel-breadcrumb-button"
                      onClick={() => props.onRoot(node.id)}
                    >
                      {label}
                    </ButtonControl>
                  </span>
                );
              })}
            </nav>
          )}
          {headerIcon && (
            <div className="panel-heading-icon-row">
              <span className="panel-header-icon">{headerIcon}</span>
            </div>
          )}
          <div className="panel-title-row">
            <div className="panel-title-editor" aria-label="Page title" onContextMenu={openHeaderContextMenu}>
              {rootNode && showDoneCheckbox && (
                <DoneCheckbox
                  checked={Boolean(rootNode.completedAt)}
                  onToggle={() => void props.run(() => api.toggleDone(props.rootId))}
                />
              )}
              <RichTextEditor
                nodeId={props.rootId}
                content={titleContent}
                contentRevision={titleContentRevision}
                placeholder="Untitled"
                readOnly={rootNode?.locked}
                completed={Boolean(rootNode?.completedAt)}
                onFocus={selectHeader}
                onChange={setTitleContent}
                onPatch={applyTitlePatch}
                onCommit={(content) => void commitTitle(content)}
                onEnter={handleTitleEnter}
                onBackspaceAtStart={() => undefined}
                onTab={() => undefined}
                onArrowUpAtStart={() => undefined}
                onArrowDownAtEnd={focusFirstVisibleRowOrTrailing}
                onUndo={() => void props.run(() => api.undo())}
                onRedo={() => void props.run(() => api.redo())}
                onModEnter={(content) => void handleTitleModEnter(content)}
                resolveInlineReferenceColor={(targetId) => inlineReferenceTextColor(targetId, props.index)}
                onEscape={() => {
                  replaceLocalTitleContent(rootNode?.content ?? EMPTY_RICH_TEXT);
                  setTitleTrigger(null);
                  blurActiveElement();
                  clearHeaderFocus();
                }}
                onTriggerChange={(nextTrigger) => {
                  setTitleTrigger(nextTrigger);
                }}
                focusTarget={titleFocusTarget}
                focusRequest={props.ui.focusRequest}
                pendingInput={props.ui.pendingInputChar}
                onFocusRequestConsumed={(request) => {
                  props.setUi((prev) => clearFocusRequestState(prev, request));
                }}
                onPendingInputConsumed={(input) => {
                  props.setUi((prev) => clearPendingInputState(prev, input));
                }}
              />
              {titleTrigger && (
                <TriggerPopover
                  trigger={{ nodeId: props.rootId, ...titleTrigger }}
                  index={props.index}
                  nodeId={props.rootId}
                  run={props.run}
                  close={() => setTitleTrigger(null)}
                  clearTriggerText={clearTitleTriggerText}
                  applyReference={applyTitleInlineReference}
                  executeSlashCommand={executeTitleSlashCommand}
                  enabledSlashCommandIds={['reference', 'heading', 'checkbox', 'command_palette']}
                  treeReferenceParentId={null}
                  existingTagIds={rootNode?.tags ?? []}
                />
              )}
            </div>
          </div>
          {rootNode && (
            <NodeDescription
              node={rootNode}
              targetId={props.rootId}
              editing={props.ui.editingDescriptionId === props.rootId}
              run={props.run}
              onEditingChange={(editing) => {
                props.setUi((prev) => ({
                  ...prev,
                  editingDescriptionId: editing ? props.rootId : null,
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
          )}
          {rootNode && (
            <div className="panel-title-toolbar-row">
              {rootNode.tags.length > 0 ? (
                <TagBar
                  nodeId={props.rootId}
                  tagIds={rootNode.tags}
                  index={props.index}
                  run={props.run}
                  onRoot={props.onRoot}
                />
              ) : (
                <span />
              )}
              <IconButton
                className="panel-title-more-button"
                icon={MoreIcon}
                iconSize={14}
                label="More node actions"
                onClick={openHeaderMoreMenu}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                title="More"
                variant="panel"
              />
            </div>
          )}
          {rootNode && hasHeadingFields && (
            <div className="panel-heading-fields outliner">
              <OutlinerView
                panelId={props.panelId}
                parentId={props.rootId}
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
                rows={panelRows.headingRows}
                showViewToolbar={false}
              />
            </div>
          )}
        </header>
        {rootNode && contextMenu && (
          <NodeContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            node={rootNode}
            targetId={props.rootId}
            openId={props.rootId}
            selectedIds={props.ui.selectedIds}
            index={props.index}
            run={props.run}
            onRoot={props.onRoot}
            onEditDescription={() => {
              props.setUi((prev) => requestFocusState(
                { ...prev, editingDescriptionId: props.rootId },
                descriptionFocusTarget,
                cursorEnd(),
              ));
            }}
            onClose={() => setContextMenu(null)}
          />
        )}
        {rootNode && rootDefinitionKind && (
          <DefinitionConfigPanel node={rootNode} index={props.index} run={props.run} />
        )}
        {showOutliner && (
          <div className={`outliner ${rootDefinitionKind ? 'definition-template-outliner' : ''}`}>
            {definitionTemplateLabel && (
              <div className="definition-template-label">{definitionTemplateLabel}</div>
            )}
            <OutlinerView
              panelId={props.panelId}
              parentId={props.rootId}
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
              rows={panelRows.bodyRows}
            />
            {showTrailingInput && (
              <TrailingInput
                panelId={props.panelId}
                parentId={props.rootId}
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
      </div>
    </main>
  );
}
