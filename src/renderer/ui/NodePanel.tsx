import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type MouseEvent,
  type SetStateAction,
} from 'react';
import { api } from '../api/client';
import type { NodeId, RichText, RichTextPatch } from '../api/types';
import { EMPTY_RICH_TEXT, plainText } from '../api/types';
import { TAG_DAY_ID } from '../../core/types';
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
import type { CommandRunner, EditorTrigger, NavigateRootOptions, TriggerState } from './shared';
import {
  clearFocusRequestState,
  clearFocusState,
  clearPendingInputState,
  cursorEnd,
  cursorOffset as cursorAtOffset,
  cursorStart,
  focusTarget,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from './focus/focusModel';
import {
  CalendarIcon,
  ChevronLeftIcon,
  HashIcon,
  ICON_SIZE,
  LibraryIcon,
  MoreIcon,
  SearchIcon,
  SupertagIcon,
  TrashIcon,
} from './icons';
import { FieldTypeIcon } from './outliner/fieldTypePresentation';
import { DoneCheckbox } from './outliner/DoneCheckbox';
import { NodeContextMenu } from './outliner/NodeContextMenu';
import { NodeDescription } from './outliner/NodeDescription';
import { OutlinerView } from './outliner/OutlinerView';
import { buildOutlinerRows } from './outliner/row-model';
import { TrailingInput } from './outliner/TrailingInput';
import { TriggerPopover } from './outliner/TriggerPopover';
import {
  applyTrailingReferenceTrigger,
  applyTrailingTagTrigger,
  createAndApplyTrailingTagTrigger,
  createTrailingField,
  executeTrailingSlashTrigger,
} from './outliner/trailingTriggers';
import { ButtonControl } from './primitives/ButtonControl';
import { IconButton } from './primitives/IconButton';
import { SearchQuerySummaryBar } from './search/SearchQuerySummaryBar';
import { inlineReferenceTextColor, resolveTagColor } from './tags/tagColors';
import { TagBar } from './tags/TagBar';
import { buildPanelBreadcrumb } from './panelBreadcrumb';
import { PanelDateNavigation } from './PanelDateNavigation';

const PANEL_HEADER_ICON_SIZE = 20;
const PANEL_BREADCRUMB_ORIGIN_ICON_SIZE = 13;

interface NodePanelProps {
  panelId: string;
  rootId: NodeId;
  canGoBack: boolean;
  onBack: () => void;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  trigger: TriggerState;
  setTrigger: (trigger: TriggerState) => void;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
}

function parsePanelDateLabel(label: string) {
  const trimmed = label.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

function isDayTagId(tagId: NodeId, byId: DocumentIndex['byId']) {
  return tagId === TAG_DAY_ID || byId.get(tagId)?.content.text.toLowerCase() === 'day';
}

export function NodePanel(props: NodePanelProps) {
  const rootNode = props.index.byId.get(props.rootId);
  const projection = props.index.projection;
  const [titleContent, setTitleContent] = useState<RichText>(rootNode?.content ?? EMPTY_RICH_TEXT);
  const [titleContentRevision, setTitleContentRevision] = useState(0);
  const [titleTrigger, setTitleTrigger] = useState<EditorTrigger | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [breadcrumbExpanded, setBreadcrumbExpanded] = useState(false);
  const [titleDocked, setTitleDocked] = useState(false);
  const mainPanelRef = useRef<HTMLElement | null>(null);
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const titleRowRef = useRef<HTMLDivElement | null>(null);
  const pendingTitlePatchRef = useRef<Promise<unknown>>(Promise.resolve());
  const descriptionReturnPlacementRef = useRef(cursorEnd());
  const rootDefinitionKind = definitionKind(rootNode);
  const definitionTemplateLabel = rootNode ? definitionOutlinerLabel(rootNode) : null;
  const showOutliner = Boolean(rootNode && (!rootDefinitionKind || definitionTemplateLabel));
  const showTrailingInput = Boolean(rootNode && showOutliner);
  const breadcrumb = buildPanelBreadcrumb(rootNode, props.index);
  const titleFocusTarget = focusTarget(props.rootId, null, props.panelId, 'panel-title');
  const descriptionFocusTarget = focusTarget(props.rootId, null, props.panelId, 'description');
  const panelRows = useMemo(() => buildOutlinerRows(rootNode, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
  }), [props.index.byId, props.ui.expandedHiddenFields, rootNode]);

  const handleOutlinerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!props.dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const handleOutlinerDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!props.dragId) return;
    event.preventDefault();
    event.stopPropagation();
    const draggedId = props.dragId;
    props.setDragId(null);
    if (draggedId === props.rootId) return;
    void props.run(() => api.moveNode(draggedId, props.rootId, null));
  };

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
    if (props.rootId === projection.todayId) return <CalendarIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (props.rootId === projection.rootId) return <LibraryIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (props.rootId === projection.schemaId) return <SupertagIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (props.rootId === projection.trashId) return <TrashIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (props.rootId === projection.searchesId || rootNode.type === 'search') return <SearchIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (rootNode.type === 'tagDef') {
      return (
        <span className="panel-header-tag-icon" style={{ background: resolveTagColor(rootNode).text }}>
          <HashIcon size={ICON_SIZE.rowGlyph} />
        </span>
      );
    }
    if (rootNode.type === 'fieldDef') return <FieldTypeIcon fieldType={rootNode.fieldType} size={PANEL_HEADER_ICON_SIZE} />;
    return null;
  };

  const headerIcon = renderHeaderIcon();
  const showDoneCheckbox = Boolean(rootNode?.showCheckbox || rootNode?.doneStateEnabled || rootNode?.completedAt);
  const rootTagIds = rootNode?.tags ?? [];
  const hasTitleTags = rootTagIds.length > 0;
  const panelIsoDate = rootNode && rootTagIds.some((tagId) => isDayTagId(tagId, props.index.byId))
    ? parsePanelDateLabel(rootNode.content.text)
    : null;
  const dateNoteCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of props.index.byId.values()) {
      if (!node.tags.some((tagId) => isDayTagId(tagId, props.index.byId))) continue;
      const isoDate = parsePanelDateLabel(node.content.text);
      if (isoDate) counts[isoDate] = node.children.length;
    }
    return counts;
  }, [props.index.byId]);

  const updateTitleDockedState = useCallback(() => {
    const panel = mainPanelRef.current;
    const breadcrumbEl = stickyBreadcrumbRef.current;
    const titleRow = titleRowRef.current;
    if (!panel || !breadcrumbEl || !titleRow) {
      setTitleDocked(false);
      return;
    }
    const threshold = Math.max(0, titleRow.offsetTop - breadcrumbEl.offsetHeight - 1);
    const nextDocked = panel.scrollTop >= threshold;
    setTitleDocked((prev) => (prev === nextDocked ? prev : nextDocked));
  }, []);

  useEffect(() => {
    const panel = mainPanelRef.current;
    if (panel) panel.scrollTop = 0;
    setBreadcrumbExpanded(false);
    setTitleDocked(false);
    window.requestAnimationFrame(updateTitleDockedState);
  }, [props.rootId, updateTitleDockedState]);

  useEffect(() => {
    const handleResize = () => updateTitleDockedState();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateTitleDockedState]);

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
      selectionRootId: props.rootId,
      selectionSource: 'global',
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
      selectionRootId: props.rootId,
      selectionSource: 'global',
    }));
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  const headerMoreButton = rootNode ? (
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
  ) : null;

  const clearTitleTriggerText = async () => {
    if (!titleTrigger || !rootNode) return;
    await pendingTitlePatchRef.current;
    const nextContent = deleteRichTextRange(titleContent, titleTrigger.from, titleTrigger.to);
    replaceLocalTitleContent(nextContent);
    await props.run(() => api.replaceNodeText(props.rootId, nextContent));
  };

  const applyTitleInlineReference = async (target: { id: NodeId; content: RichText }) => {
    if (!titleTrigger || !rootNode) {
      return;
    }
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
    props.setUi((prev) => requestFocusState(
      prev,
      titleFocusTarget,
      cursorAtOffset(titleTrigger.from, 'after'),
    ));
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
  const breadcrumbNodes = breadcrumb.collapsed && breadcrumbExpanded
    ? [breadcrumb.nodes[0], ...breadcrumb.hiddenNodes, ...breadcrumb.nodes.slice(1)]
    : breadcrumb.nodes;

  return (
    <main className="main-panel" ref={mainPanelRef} onScroll={updateTitleDockedState}>
      {rootNode && (
        <div className="panel-sticky-breadcrumb" ref={stickyBreadcrumbRef}>
          <div className="panel-breadcrumb-leading">
            <IconButton
              className="panel-page-back-button"
              disabled={!props.canGoBack}
              icon={ChevronLeftIcon}
              iconSize={14}
              label="Previous page"
              onClick={props.onBack}
              title="Previous page"
              variant="panel"
            />
            <ButtonControl
              aria-label="Open workspace root"
              className="panel-breadcrumb-origin"
              onClick={() => props.onRoot(projection.rootId)}
            >
              <LibraryIcon size={PANEL_BREADCRUMB_ORIGIN_ICON_SIZE} />
            </ButtonControl>
          </div>
          <nav className="panel-breadcrumb" aria-label="Panel breadcrumb">
            {breadcrumbNodes.map((node, index) => {
              const label = node.content.text || 'Untitled';
              const showCollapsedMarker = breadcrumb.collapsed && !breadcrumbExpanded && index === 1;
              return (
                <span className="panel-breadcrumb-segment" key={node.id}>
                  <span className="panel-breadcrumb-divider">/</span>
                  {showCollapsedMarker && (
                    <>
                      <ButtonControl
                        className="panel-breadcrumb-ellipsis"
                        aria-label={`Show ${breadcrumb.hiddenNodes.length} hidden breadcrumb levels`}
                        onClick={() => setBreadcrumbExpanded(true)}
                        title="Show hidden breadcrumb levels"
                      >
                        <MoreIcon size={ICON_SIZE.rowGlyph} />
                      </ButtonControl>
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
            {titleDocked && (
              <span className="panel-breadcrumb-segment panel-breadcrumb-current">
                <span className="panel-breadcrumb-divider">/</span>
                <span className="panel-breadcrumb-current-label" data-current-page-title>
                  {rootNode.content.text || 'Untitled'}
                </span>
              </span>
            )}
          </nav>
        </div>
      )}
      <div className="panel-inner">
        <header className="panel-header">
          {headerIcon && (
            <div className="panel-heading-icon-row">
              <span className="panel-header-icon">{headerIcon}</span>
            </div>
          )}
          <div className="panel-title-row" ref={titleRowRef}>
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
                onDescriptionToggle={({ cursorOffset }) => {
                  descriptionReturnPlacementRef.current = cursorAtOffset(cursorOffset);
                  props.setUi((prev) => requestFocusState(
                    { ...prev, editingDescriptionId: props.rootId },
                    descriptionFocusTarget,
                    cursorEnd(),
                  ));
                }}
                onModEnter={(content) => void handleTitleModEnter(content)}
                resolveInlineReferenceColor={(targetId) => inlineReferenceTextColor(targetId, props.index)}
                onInlineReferenceClick={(targetId) => props.onRoot(targetId, { focus: false })}
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
            {!hasTitleTags && headerMoreButton}
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
              onReturnToSource={() => {
                props.setUi((prev) => requestFocusState(
                  { ...prev, editingDescriptionId: null },
                  titleFocusTarget,
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
          )}
          {rootNode && hasTitleTags && (
            <div className="panel-title-toolbar-row">
              <TagBar
                nodeId={props.rootId}
                tagIds={rootNode.tags}
                index={props.index}
                run={props.run}
                onRoot={props.onRoot}
              />
              {headerMoreButton}
            </div>
          )}
          {panelIsoDate && (
            <PanelDateNavigation
              dateNoteCounts={dateNoteCounts}
              isoDate={panelIsoDate}
              onRoot={props.onRoot}
              run={props.run}
            />
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
              descriptionReturnPlacementRef.current = cursorEnd();
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
          <div
            className={`outliner ${rootDefinitionKind ? 'definition-template-outliner' : ''}`}
            onDragOver={handleOutlinerDragOver}
            onDrop={handleOutlinerDrop}
          >
            {definitionTemplateLabel && (
              <div className="definition-template-label">{definitionTemplateLabel}</div>
            )}
            {rootNode?.type === 'search' && (
              <SearchQuerySummaryBar
                index={props.index}
                nodeId={props.rootId}
                run={props.run}
              />
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
              rows={panelRows}
            />
            {showTrailingInput && (
              <TrailingInput
                panelId={props.panelId}
                parentId={props.rootId}
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
                  });
                  return createdId;
                }}
                onCreateTree={(parentId, nodes) => (
                  props.run(() => api.createNodesFromTree(parentId, nodes))
                )}
                onIndentNode={(nodeId) => (
                  props.run(() => api.indentNode(nodeId))
                )}
                onUpdateCreated={async (nodeId, text) => {
                  await props.run(() => api.replaceNodeText(nodeId, plainText(text)));
                }}
                materializeOnInput
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
      </div>
    </main>
  );
}
