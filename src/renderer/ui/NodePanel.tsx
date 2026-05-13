import { useEffect, useState, type Dispatch, type MouseEvent, type SetStateAction } from 'react';
import { api } from '../api/client';
import type { FocusHint, NodeId, RichText } from '../api/types';
import { EMPTY_RICH_TEXT, plainText } from '../api/types';
import { flattenVisibleRows, type DocumentIndex, type UiState } from '../state/document';
import { RichTextEditor, type EditorSplitPayload } from './editor/RichTextEditor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
  richTextEquals,
} from './editor/richTextCodec';
import { DefinitionConfigPanel } from './definition/DefinitionConfigPanel';
import { definitionKind, definitionOutlinerLabel } from './definition/definitionConfig';
import type { SlashCommandId } from './interactions/slashCommands';
import type { CommandRunner, EditorTrigger, TriggerState } from './shared';
import { focusRowInput, focusTrailingInput } from './shared';
import {
  CalendarIcon,
  HashIcon,
  LibraryIcon,
  SearchIcon,
  TrashIcon,
} from './icons';
import { FieldTypeIcon } from './outliner/fieldTypePresentation';
import { DoneCheckbox } from './outliner/DoneCheckbox';
import { NodeContextMenu } from './outliner/NodeContextMenu';
import { NodeDescription } from './outliner/NodeDescription';
import { OutlinerView } from './outliner/OutlinerView';
import { TrailingInput } from './outliner/TrailingInput';
import { TriggerPopover } from './outliner/TriggerPopover';
import { createTrailingField, createTrailingTriggerNode } from './outliner/trailingTriggers';
import { inlineReferenceTextColor, resolveTagColor } from './tags/tagColors';
import { TagBar } from './tags/TagBar';

interface NodePanelProps {
  rootId: NodeId;
  onRoot: (nodeId: NodeId) => void;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  pendingFocus: FocusHint | null;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
}

export function NodePanel(props: NodePanelProps) {
  const rootNode = props.index.byId.get(props.rootId);
  const projection = props.index.projection;
  const [titleContent, setTitleContent] = useState<RichText>(rootNode?.content ?? EMPTY_RICH_TEXT);
  const [titleTrigger, setTitleTrigger] = useState<EditorTrigger | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const rootDefinitionKind = definitionKind(rootNode);
  const definitionTemplateLabel = rootNode ? definitionOutlinerLabel(rootNode) : null;
  const showOutliner = Boolean(rootNode && (!rootDefinitionKind || definitionTemplateLabel));
  const showTrailingInput = Boolean(rootNode && showOutliner);

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
      focusTrailingInput(props.rootId);
      return;
    }
    props.setUi((prev) => ({
      ...prev,
      focusedId: first,
      selectedId: first,
      selectedIds: new Set([first]),
      selectionAnchorId: first,
    }));
    focusRowInput(first, 'start');
  };

  const focusNode = (nodeId: NodeId) => {
    props.setUi((prev) => ({
      ...prev,
      focusedId: nodeId,
      selectedId: nodeId,
      selectedIds: new Set([nodeId]),
      selectionAnchorId: nodeId,
    }));
    focusRowInput(nodeId, 'end');
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
    props.setUi((prev) => ({
      ...prev,
      focusedId: props.rootId,
      selectedId: props.rootId,
      selectedIds: new Set([props.rootId]),
      selectionAnchorId: props.rootId,
    }));
  };

  const clearHeaderFocus = () => {
    props.setUi((prev) => (
      prev.focusedId === props.rootId
        ? { ...prev, focusedId: null }
        : prev
    ));
  };

  const commitTitle = async (content = titleContent) => {
    if (!rootNode || rootNode.locked || richTextEquals(content, rootNode.content)) {
      clearHeaderFocus();
      return;
    }
    await props.run(() => api.updateNodeText(props.rootId, content));
    clearHeaderFocus();
  };

  const blurActiveElement = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleTitleEnter = (_payload: EditorSplitPayload) => {
    void commitTitle().then(blurActiveElement);
  };

  const openHeaderContextMenu = (event: MouseEvent) => {
    if (!rootNode) return;
    event.preventDefault();
    event.stopPropagation();
    blurActiveElement();
    props.setUi((prev) => ({
      ...prev,
      focusedId: null,
      selectedId: props.rootId,
      selectedIds: prev.selectedIds.has(props.rootId) ? new Set(prev.selectedIds) : new Set([props.rootId]),
      selectionAnchorId: prev.selectedIds.has(props.rootId) ? prev.selectionAnchorId ?? props.rootId : props.rootId,
    }));
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const clearTitleTriggerText = async () => {
    if (!titleTrigger || !rootNode) return;
    const nextContent = deleteRichTextRange(titleContent, titleTrigger.from, titleTrigger.to);
    setTitleContent(nextContent);
    await api.updateNodeText(props.rootId, nextContent);
  };

  const applyTitleInlineReference = async (target: { id: NodeId; content: RichText }) => {
    if (!titleTrigger || !rootNode) return;
    const nextContent = replaceRichTextRangeWithInlineRef(
      titleContent,
      titleTrigger.from,
      titleTrigger.to,
      {
        targetNodeId: target.id,
        displayName: target.content.text,
      },
    );
    setTitleContent(nextContent);
    return api.updateNodeText(props.rootId, nextContent);
  };

  const executeTitleSlashCommand = async (commandId: SlashCommandId) => {
    if (!titleTrigger || !rootNode) return null;

    if (commandId === 'reference') {
      const nextContent = replaceRichTextRangeWithText(titleContent, titleTrigger.from, titleTrigger.to, '@');
      setTitleContent(nextContent);
      const result = await api.updateNodeText(props.rootId, nextContent);
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
      const withoutTrigger = deleteRichTextRange(titleContent, titleTrigger.from, titleTrigger.to);
      const nextContent = markWholeTextAsHeading(withoutTrigger);
      setTitleContent(nextContent);
      return api.updateNodeText(props.rootId, nextContent);
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
          {headerIcon && <span className="panel-header-icon">{headerIcon}</span>}
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
              readOnly={rootNode?.locked}
              completed={Boolean(rootNode?.completedAt)}
              onFocus={selectHeader}
              onChange={setTitleContent}
              onCommit={(content) => void commitTitle(content)}
              onEnter={handleTitleEnter}
              onBackspaceAtStart={() => undefined}
              onTab={() => undefined}
              onArrowUpAtStart={() => undefined}
              onArrowDownAtEnd={focusFirstVisibleRowOrTrailing}
              onUndo={() => void props.run(() => api.undo())}
              onRedo={() => void props.run(() => api.redo())}
              onModEnter={() => void props.run(() => api.toggleDone(props.rootId))}
              resolveInlineReferenceColor={(targetId) => inlineReferenceTextColor(targetId, props.index)}
              onEscape={() => {
                setTitleContent(rootNode?.content ?? EMPTY_RICH_TEXT);
                setTitleTrigger(null);
                blurActiveElement();
                clearHeaderFocus();
              }}
              onTriggerChange={(nextTrigger) => {
                setTitleTrigger(nextTrigger);
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
            {rootNode && rootNode.tags.length > 0 && (
              <TagBar
                nodeId={props.rootId}
                tagIds={rootNode.tags}
                index={props.index}
                run={props.run}
                onRoot={props.onRoot}
              />
            )}
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
              />
            )}
          </div>
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
              props.setUi((prev) => ({ ...prev, editingDescriptionId: props.rootId }));
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
              pendingFocus={props.pendingFocus}
              dragId={props.dragId}
              setDragId={props.setDragId}
            />
            {showTrailingInput && (
              <TrailingInput
                parentId={props.rootId}
                index={props.index}
                expanded={props.ui.expanded}
                onCreate={async (parentId, text) => {
                  const result = await props.run(() => api.createNode(parentId, null, text));
                  return result && 'focus' in result ? result.focus?.nodeId ?? null : null;
                }}
                onCreateTree={(parentId, nodes) => (
                  props.run(() => api.createNodesFromTree(parentId, nodes))
                )}
                onUpdateCreated={async (nodeId, text) => {
                  await props.run(() => api.updateNodeText(nodeId, plainText(text)));
                }}
                onToggleCreated={async (nodeId) => {
                  await props.run(() => api.toggleDone(nodeId));
                }}
                onCreateTrigger={(params) => {
                  void createTrailingTriggerNode({
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
