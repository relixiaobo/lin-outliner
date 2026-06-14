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
import { EMPTY_RICH_TEXT, nodeReferenceTarget, plainText } from '../api/types';
import { TAG_DAY_ID } from '../../core/types';
import { flattenVisibleRows, resolveReferenceTargetId, type DocumentIndex, type UiState } from '../state/document';
import { RichTextEditor, type EditorSplitPayload } from './editor/RichTextEditor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
  richTextEquals,
} from './editor/richTextCodec';
import { DefinitionConfigPanel } from './definition/DefinitionConfigPanel';
import { definitionKind, definitionOutlinerLabel, definitionOutlinerPlaceholder } from './definition/definitionConfig';
import { projectFieldTypeById, nodeShowsCheckbox } from '../../core/configProjection';
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
  relayCompositionHandoffState,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from './focus/focusModel';
import {
  ChevronLeftIcon,
  CloseIcon,
  HashIcon,
  ICON_SIZE,
  FilterIcon,
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
import { FLAT_OUTLINER_ENABLED, OutlinerFlatView } from './outliner/OutlinerFlatView';
import { buildOutlinerRows } from './outliner/row-model';
import { TriggerPopover } from './outliner/TriggerPopover';
import { ButtonControl } from './primitives/ButtonControl';
import { IconButton } from './primitives/IconButton';
import { SearchQueryBuilderPanel } from './search/SearchQuerySummaryBar';
import { inlineReferenceTextColor, resolveTagColor } from './tags/tagColors';
import { TagBar } from './tags/TagBar';
import { BacklinksSection } from './BacklinksSection';
import { FilePreviewBody } from './preview/FilePreviewBody';
import { isFileNode } from './preview/fileNode';
import { dispatchPreviewTargetOpen } from './preview/previewEvents';
import { buildPanelBreadcrumb } from './panelBreadcrumb';
import { PanelDateNavigation } from './PanelDateNavigation';
import { useT } from '../i18n/I18nProvider';
import { referenceSummaryForIndex } from '../state/referenceSummary';

const PANEL_HEADER_ICON_SIZE = 20;
const PANEL_BREADCRUMB_ORIGIN_ICON_SIZE = 13;

interface NodePanelProps {
  panelId: string;
  rootId: NodeId;
  canGoBack: boolean;
  onBack: () => void;
  showClose: boolean;
  onClose: () => void;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  onTogglePin: (nodeId: NodeId) => void;
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

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

// Localized strings the day-title formatter needs. `formatDayNodeTitle` runs
// outside React (module-level export), so it can't call useT — the component
// passes these in from `t.dateFormat`.
export interface DayNodeTitleLabels {
  weekdaysShort: readonly string[];
  monthsShort: readonly string[];
  dayName: (parts: { weekday: string; month: string; day: number }) => string;
  today: (parts: { dayName: string }) => string;
  tomorrow: (parts: { dayName: string }) => string;
  yesterday: (parts: { dayName: string }) => string;
}

// Humanize a day node's ISO date for the panel title: the weekday/month/day
// ("Wed, May 27"), prefixed with a relative name for the adjacent days
// ("Today, Wed, May 27"). Day nodes are locked, so this label is read-only
// display only — the underlying `YYYY-MM-DD` content is untouched.
export function formatDayNodeTitle(isoDate: string, now: Date, labels: DayNodeTitleLabels): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dayName = labels.dayName({
    weekday: labels.weekdaysShort[date.getDay()],
    month: labels.monthsShort[date.getMonth()],
    day: date.getDate(),
  });
  const diffDays = Math.round(
    (startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000,
  );
  if (diffDays === 0) return labels.today({ dayName });
  if (diffDays === 1) return labels.tomorrow({ dayName });
  if (diffDays === -1) return labels.yesterday({ dayName });
  return dayName;
}

export function NodePanel(props: NodePanelProps) {
  const t = useT();
  const requestedRootNode = props.index.byId.get(props.rootId);
  const resolvedRootId = requestedRootNode?.type === 'reference' && requestedRootNode.targetId
    ? resolveReferenceTargetId(requestedRootNode.targetId, props.index.byId) ?? props.rootId
    : props.rootId;
  const rootNode = props.index.byId.get(resolvedRootId);
  // A file root (attachment/image) renders its preview as the page body instead
  // of an outliner; the title editor still holds the (editable) filename.
  const fileRoot = isFileNode(rootNode) ? rootNode : null;
  const projection = props.index.projection;
  const [titleContent, setTitleContent] = useState<RichText>(rootNode?.content ?? EMPTY_RICH_TEXT);
  const [titleContentRevision, setTitleContentRevision] = useState(0);
  const [titleTrigger, setTitleTrigger] = useState<EditorTrigger | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [breadcrumbExpanded, setBreadcrumbExpanded] = useState(false);
  const [titleDocked, setTitleDocked] = useState(false);
  const [searchQueryOpen, setSearchQueryOpen] = useState(false);
  const mainPanelRef = useRef<HTMLElement | null>(null);
  // Always-current ui for row handlers. NodePanel re-renders on every ui change,
  // so this ref stays live even for rows whose per-row memo skips re-render.
  const uiRef = useRef(props.ui);
  uiRef.current = props.ui;
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const titleRowRef = useRef<HTMLDivElement | null>(null);
  const pendingTitlePatchRef = useRef<Promise<unknown>>(Promise.resolve());
  const localTitleSyncRef = useRef<{ nodeId: NodeId; content: RichText } | null>(null);
  const descriptionReturnPlacementRef = useRef(cursorEnd());
  const rootDefinitionKind = definitionKind(rootNode);
  const definitionTemplateLabel = rootNode
    ? definitionOutlinerLabel(rootNode, { fieldType: projectFieldTypeById(props.index.byId, rootNode.id) }, t.definition.outliner)
    : null;
  // Empty-state hint for the definition template/options block: the trailing
  // draft carries it so an empty section reads "add here" rather than a lone
  // label over a near-invisible ghost bullet.
  const definitionTemplatePlaceholder = rootNode
    ? definitionOutlinerPlaceholder(rootNode, { fieldType: projectFieldTypeById(props.index.byId, rootNode.id) }, t.definition.outliner)
    : null;
  const showOutliner = Boolean(rootNode && !fileRoot && (!rootDefinitionKind || definitionTemplateLabel));
  const showTrailingInput = Boolean(rootNode && showOutliner && rootNode.type !== 'search');
  const breadcrumb = buildPanelBreadcrumb(rootNode, props.index);
  const titleFocusTarget = focusTarget(resolvedRootId, null, props.panelId, 'panel-title');
  const descriptionFocusTarget = focusTarget(resolvedRootId, null, props.panelId, 'description');
  const titleEditorFocused = props.ui.focusedId === resolvedRootId
    && props.ui.focusSurface === 'panel-title'
    && props.ui.focusedPanelId === props.panelId;
  const referenceSummary = useMemo(() => referenceSummaryForIndex(props.index), [props.index]);
  const systemFieldContext = useMemo(() => ({ referenceSummary }), [referenceSummary]);
  const panelRows = useMemo(() => buildOutlinerRows(rootNode, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
    systemFieldContext,
  }), [props.index.byId, props.ui.expandedHiddenFields, rootNode, systemFieldContext]);

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
    if (draggedId === resolvedRootId) return;
    void props.run(() => api.moveNode(draggedId, resolvedRootId, null));
  };

  useEffect(() => {
    const nextContent = rootNode?.content ?? EMPTY_RICH_TEXT;
    const pendingLocalTitle = localTitleSyncRef.current;
    if (pendingLocalTitle) {
      if (pendingLocalTitle.nodeId !== rootNode?.id) {
        localTitleSyncRef.current = null;
      } else if (richTextEquals(nextContent, pendingLocalTitle.content)) {
        localTitleSyncRef.current = null;
      } else {
        return;
      }
    }
    if (titleEditorFocused) return;
    setTitleContent(nextContent);
    setTitleTrigger(null);
  }, [rootNode?.id, rootNode?.content, titleEditorFocused]);

  useEffect(() => {
    setSearchQueryOpen(false);
  }, [resolvedRootId]);

  const focusFirstVisibleRowOrTrailing = () => {
    const rows = flattenVisibleRows(
      resolvedRootId,
      props.index.byId,
      props.ui.expanded,
      props.ui.expandedHiddenFields,
    );
    const first = rows[0];
    if (!first) {
      props.setUi((prev) => requestFocusState(
        prev,
        focusTarget(resolvedRootId, resolvedRootId, props.panelId, 'trailing'),
        cursorEnd(),
      ));
      return;
    }
    const firstNode = props.index.byId.get(first);
    props.setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(first, firstNode?.parentId ?? resolvedRootId, props.panelId),
      cursorStart(),
    ));
  };

  const replaceLocalTitleContent = (content: RichText) => {
    localTitleSyncRef.current = { nodeId: resolvedRootId, content };
    setTitleContent(content);
    setTitleContentRevision((revision) => revision + 1);
  };

  const renderHeaderIcon = () => {
    if (!rootNode) return null;
    if (resolvedRootId === projection.libraryId) return <LibraryIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (resolvedRootId === projection.schemaId) return <SupertagIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (resolvedRootId === projection.trashId) return <TrashIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (resolvedRootId === projection.searchesId || rootNode.type === 'search') return <SearchIcon size={PANEL_HEADER_ICON_SIZE} />;
    if (rootNode.type === 'tagDef') {
      // Solid accent fill with a white hash. The accent IS the tag's colour, and
      // white-on-accent stays high-contrast in both themes — a soft tinted
      // background instead left the dark accent hash near-invisible in dark mode.
      return (
        <span className="panel-header-tag-icon" style={{ background: resolveTagColor(rootNode, props.index.byId).text }}>
          <HashIcon size={ICON_SIZE.rowGlyph} />
        </span>
      );
    }
    if (rootNode.type === 'fieldDef') return <FieldTypeIcon fieldType={projectFieldTypeById(props.index.byId, rootNode.id)} size={PANEL_HEADER_ICON_SIZE} />;
    return null;
  };

  const headerIcon = renderHeaderIcon();
  const showDoneCheckbox = rootNode ? nodeShowsCheckbox(props.index.byId, rootNode) : false;
  const rootTagIds = rootNode?.tags ?? [];
  const hasTitleTags = rootTagIds.length > 0;
  const panelIsoDate = rootNode && rootTagIds.some((tagId) => isDayTagId(tagId, props.index.byId))
    ? parsePanelDateLabel(rootNode.content.text)
    : null;
  // A day node's title is a locked, read-only ISO string; show a humanized label
  // ("Today, Wed, May 27" / "Wed, May 27") in its place, in both the title editor
  // and the docked breadcrumb. Re-derived per local day so a session crossing
  // midnight still relabels.
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const dayTitleLabel = useMemo(
    () => (panelIsoDate && rootNode?.locked ? formatDayNodeTitle(panelIsoDate, new Date(), t.dateFormat) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t.dateFormat is stable per locale; re-renders cover language change
    [panelIsoDate, rootNode?.locked, todayKey, t.dateFormat],
  );
  const dayTitleContent = useMemo(
    () => (dayTitleLabel != null ? plainText(dayTitleLabel) : null),
    [dayTitleLabel],
  );
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
  }, [resolvedRootId, updateTitleDockedState]);

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
      prev.focusedId === resolvedRootId
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
      props.run(() => api.applyNodeTextPatch(resolvedRootId, patch), {
        applyFocus: false,
      }));
    void pendingTitlePatchRef.current;
  };

  const handleTitleChange = (content: RichText) => {
    localTitleSyncRef.current = { nodeId: resolvedRootId, content };
    setTitleContent(content);
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
    await props.run(() => api.cycleDoneState(resolvedRootId));
  };

  const openHeaderContextMenu = (event: MouseEvent) => {
    if (!rootNode) return;
    event.preventDefault();
    event.stopPropagation();
    blurActiveElement();
    props.setUi((prev) => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: resolvedRootId,
      selectedIds: prev.selectedIds.has(resolvedRootId) ? new Set(prev.selectedIds) : new Set([resolvedRootId]),
      selectionAnchorId: prev.selectedIds.has(resolvedRootId) ? prev.selectionAnchorId ?? resolvedRootId : resolvedRootId,
      selectionRootId: resolvedRootId,
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
      selectedId: resolvedRootId,
      selectedIds: prev.selectedIds.has(resolvedRootId) ? new Set(prev.selectedIds) : new Set([resolvedRootId]),
      selectionAnchorId: prev.selectedIds.has(resolvedRootId) ? prev.selectionAnchorId ?? resolvedRootId : resolvedRootId,
      selectionRootId: resolvedRootId,
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
      label={t.nodePanel.moreActionsLabel}
      onClick={openHeaderMoreMenu}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      title={t.nodePanel.moreActionsTitle}
      variant="panel"
    />
  ) : null;

  const headerSearchQueryButton = rootNode?.type === 'search' ? (
    <IconButton
      className={`panel-title-more-button ${searchQueryOpen ? 'is-active' : ''}`}
      icon={FilterIcon}
      iconSize={14}
      label={searchQueryOpen ? t.nodePanel.hideQuery : t.nodePanel.showQuery}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        blurActiveElement();
        setSearchQueryOpen((open) => !open);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      title={searchQueryOpen ? t.nodePanel.hideQuery : t.nodePanel.showQuery}
      variant="panel"
    />
  ) : null;

  const clearTitleTriggerText = async () => {
    if (!titleTrigger || !rootNode) return;
    await pendingTitlePatchRef.current;
    const nextContent = deleteRichTextRange(titleContent, titleTrigger.from, titleTrigger.to);
    replaceLocalTitleContent(nextContent);
    await props.run(() => api.replaceNodeText(resolvedRootId, nextContent));
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
        target: nodeReferenceTarget(target.id),
        displayName: target.content.text,
      },
    );
    replaceLocalTitleContent(nextContent);
    props.setUi((prev) => requestFocusState(
      prev,
      titleFocusTarget,
      cursorAtOffset(cursorOffsetAfterInlineReference(nextContent, titleTrigger.from), 'after'),
    ));
    return api.replaceNodeText(resolvedRootId, nextContent);
  };

  const executeTitleSlashCommand = async (commandId: SlashCommandId) => {
    if (!titleTrigger || !rootNode) return null;

    if (commandId === 'reference') {
      await pendingTitlePatchRef.current;
      const nextContent = replaceRichTextRangeWithText(titleContent, titleTrigger.from, titleTrigger.to, '@');
      replaceLocalTitleContent(nextContent);
      const result = await api.replaceNodeText(resolvedRootId, nextContent);
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
      return api.replaceNodeText(resolvedRootId, nextContent);
    }

    if (commandId === 'checkbox') {
      await clearTitleTriggerText();
      return api.toggleDone(resolvedRootId);
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
            {/* Per-pane back only. Forward (and the active-pane back) live in the
                global window chrome next to the sidebar toggle (Cmd+[ / Cmd+]) —
                see WindowChrome. */}
            <IconButton
              className="panel-page-back-button"
              disabled={!props.canGoBack}
              icon={ChevronLeftIcon}
              iconSize={14}
              label={t.nodePanel.previousPage}
              onClick={props.onBack}
              title={t.nodePanel.previousPage}
              variant="panel"
            />
            <ButtonControl
              aria-label={t.nodePanel.openLibrary}
              className="panel-breadcrumb-origin"
              onClick={() => props.onRoot(projection.libraryId)}
            >
              <LibraryIcon size={PANEL_BREADCRUMB_ORIGIN_ICON_SIZE} />
            </ButtonControl>
          </div>
          <nav className="panel-breadcrumb" aria-label={t.nodePanel.breadcrumbAriaLabel}>
            {breadcrumbNodes.map((node, index) => {
              const label = node.content.text || t.common.untitled;
              const showCollapsedMarker = breadcrumb.collapsed && !breadcrumbExpanded && index === 1;
              return (
                <span className="panel-breadcrumb-segment" key={node.id}>
                  <span className="panel-breadcrumb-divider">/</span>
                  {showCollapsedMarker && (
                    <>
                      <ButtonControl
                        className="panel-breadcrumb-ellipsis"
                        aria-label={t.nodePanel.showHiddenBreadcrumbLevels({ count: breadcrumb.hiddenNodes.length })}
                        onClick={() => setBreadcrumbExpanded(true)}
                        title={t.nodePanel.showHiddenBreadcrumbLevelsTitle}
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
                  {dayTitleLabel ?? (rootNode.content.text || t.common.untitled)}
                </span>
              </span>
            )}
          </nav>
          {/* Close lives INSIDE the breadcrumb (the pane's toolbar row): it is a no-drag
              DOM descendant of the breadcrumb's drag region — the only reliable carve-out
              on macOS (see breadcrumb.css) — and aligns to the same --panel-content-x as
              the content on the right. */}
          {props.showClose && (
            <IconButton
              className="panel-breadcrumb-close"
              icon={CloseIcon}
              label={t.nodePanel.closePanel}
              onClick={props.onClose}
              title={t.nodePanel.closePanel}
              variant="panel"
            />
          )}
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
            <div className="panel-title-editor" aria-label={t.nodePanel.pageTitleAriaLabel} onContextMenu={openHeaderContextMenu}>
              {rootNode && showDoneCheckbox && (
                <DoneCheckbox
                  checked={Boolean(rootNode.completedAt)}
                  onToggle={() => void props.run(() => api.toggleDone(resolvedRootId))}
                />
              )}
              <RichTextEditor
                nodeId={resolvedRootId}
                content={dayTitleContent ?? titleContent}
                contentRevision={titleContentRevision}
                placeholder={t.common.untitled}
                readOnly={rootNode?.locked}
                completed={Boolean(rootNode?.completedAt)}
                onFocus={selectHeader}
                onChange={handleTitleChange}
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
                    { ...prev, editingDescriptionId: resolvedRootId },
                    descriptionFocusTarget,
                    cursorEnd(),
                  ));
                }}
                onModEnter={(content) => void handleTitleModEnter(content)}
                resolveInlineReferenceColor={(targetId) => inlineReferenceTextColor(targetId, props.index)}
                onInlineReferenceClick={(targetId, options) => props.onRoot(targetId, {
                  focus: false,
                  newPane: options?.newPane,
                })}
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
                onCompositionHandoff={(text) => {
                  props.setUi((prev) => relayCompositionHandoffState(prev, text));
                }}
              />
              {titleTrigger && (
                <TriggerPopover
                  trigger={{ nodeId: resolvedRootId, ...titleTrigger }}
                  index={props.index}
                  nodeId={resolvedRootId}
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
            {!hasTitleTags && (
              <>
                {headerSearchQueryButton}
                {headerMoreButton}
              </>
            )}
          </div>
          {rootNode && (
            <NodeDescription
              node={rootNode}
              targetId={resolvedRootId}
              editing={props.ui.editingDescriptionId === resolvedRootId}
              run={props.run}
              onEditingChange={(editing) => {
                props.setUi((prev) => ({
                  ...prev,
                  editingDescriptionId: editing ? resolvedRootId : null,
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
                nodeId={resolvedRootId}
                tagIds={rootNode.tags}
                index={props.index}
                run={props.run}
                onRoot={props.onRoot}
              />
              {headerSearchQueryButton}
              {headerMoreButton}
            </div>
          )}
          {rootNode?.type === 'search' && searchQueryOpen && (
            <SearchQueryBuilderPanel
              index={props.index}
              nodeId={resolvedRootId}
              run={props.run}
              onClose={() => setSearchQueryOpen(false)}
            />
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
            targetId={resolvedRootId}
            openId={resolvedRootId}
            selectedIds={props.ui.selectedIds}
            index={props.index}
            isPinned={props.isNodePinned(resolvedRootId)}
            run={props.run}
            onRoot={props.onRoot}
            onTogglePin={props.onTogglePin}
            onEditDescription={() => {
              descriptionReturnPlacementRef.current = cursorEnd();
              props.setUi((prev) => requestFocusState(
                { ...prev, editingDescriptionId: resolvedRootId },
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
            {FLAT_OUTLINER_ENABLED ? (
              <OutlinerFlatView
                panelId={props.panelId}
                parentId={resolvedRootId}
                rootId={resolvedRootId}
                onRoot={props.onRoot}
                index={props.index}
                isNodePinned={props.isNodePinned}
                ui={props.ui}
                uiRef={uiRef}
                setUi={props.setUi}
                run={props.run}
                onTogglePin={props.onTogglePin}
                trigger={props.trigger}
                setTrigger={props.setTrigger}
                dragId={props.dragId}
                setDragId={props.setDragId}
                trailingDraft={showTrailingInput ? 'always' : 'none'}
                draftPlaceholder={definitionTemplatePlaceholder ?? undefined}
                scrollParentRef={mainPanelRef}
              />
            ) : (
              <OutlinerView
                panelId={props.panelId}
                parentId={resolvedRootId}
                rootId={resolvedRootId}
                onRoot={props.onRoot}
                depth={0}
                index={props.index}
                isNodePinned={props.isNodePinned}
                ui={props.ui}
                uiRef={uiRef}
                setUi={props.setUi}
                run={props.run}
                onTogglePin={props.onTogglePin}
                trigger={props.trigger}
                setTrigger={props.setTrigger}
                dragId={props.dragId}
                setDragId={props.setDragId}
                rows={panelRows}
                // The body always offers a place to add a node; the trailing draft
                // (eager materialization) subsumes the old body TrailingInput.
                trailingDraft={showTrailingInput ? 'always' : 'none'}
                draftPlaceholder={definitionTemplatePlaceholder ?? undefined}
              />
            )}
          </div>
        )}
        {fileRoot && (
          <FilePreviewBody
            node={fileRoot}
            onOpenTarget={(target, options) => dispatchPreviewTargetOpen({ target, newPane: options?.newPane })}
          />
        )}
        {rootNode && (
          <BacklinksSection
            targetId={resolvedRootId}
            index={props.index}
            summary={referenceSummary}
            run={props.run}
            onRoot={props.onRoot}
          />
        )}
      </div>
    </main>
  );
}

function cursorOffsetAfterInlineReference(content: RichText, offset: number): number {
  return /\s/u.test(content.text[offset] ?? '') ? offset + 1 : offset;
}
