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
import type { NodeId, NodeProjection, RichText, RichTextPatch } from '../api/types';
import { freshNodeId } from '../../core/nodeId';
import { EMPTY_RICH_TEXT, isContentBearingNode, nodeReferenceTarget, plainText } from '../api/types';
import { flattenVisibleRows, resolveReferenceTargetId, type DocumentIndex, type UiState } from '../state/document';
import { dayNoteIsoDateForNode } from '../state/dayNoteCounts';
import { RichTextEditor, type EditorSplitPayload } from './editor/RichTextEditor';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
  replaceRichTextRangeWithText,
  richTextEquals,
} from './editor/richTextCodec';
import { applyRichTextPatchToContent } from './editor/richTextPatchApply';
import { CoalescedTextPatchQueue } from './editor/coalescedTextPatchQueue';
import { DefinitionConfigPanel } from './definition/DefinitionConfigPanel';
import { definitionKind, definitionOutlinerLabel, definitionOutlinerPlaceholder } from './definition/definitionConfig';
import { projectFieldTypeById, nodeShowsCheckbox } from '../../core/configProjection';
import type { SlashCommandId } from './interactions/slashCommands';
import { commandRunnerNoop, type CommandRunner, type EditorTrigger, type NavigateRootOptions, type TriggerState } from './shared';
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
import { referenceTriggerFromSlash } from './outliner/trailingTriggers';
import { DoneCheckbox } from './outliner/DoneCheckbox';
import { NodeContextMenu } from './outliner/NodeContextMenu';
import { NodeDescription } from './outliner/NodeDescription';
import { TriggerPopover } from './outliner/TriggerPopover';
import { ButtonControl } from './primitives/ButtonControl';
import { IconButton } from './primitives/IconButton';
import { SearchQueryBuilderPanel } from './search/SearchQueryBuilderPanel';
import { inlineReferenceTextColor, resolveTagColor } from './tags/tagColors';
import { TagBar } from './tags/TagBar';
import { BacklinksSection } from './BacklinksSection';
import { NodeSourcesSection } from './preview/NodeSourcesSection';
import { buildPanelBreadcrumb } from './panelBreadcrumb';
import { PanelDateNavigation } from './PanelDateNavigation';
import { PanelChildrenOutline, PanelStickyBreadcrumb, usePanelTitleDock, type PanelDragHandle } from './PanelShared';
import {
  nodeWithPendingPatch,
  optimisticTagPatch,
  pendingNodePatch,
  startOptimisticDoneTransition,
  startOptimisticNodePatch,
} from './outliner/optimisticNodePatch';
import { useT } from '../i18n/I18nProvider';
import { referenceSummaryForIndex } from '../state/referenceSummary';

const PANEL_HEADER_ICON_SIZE = 20;
const PANEL_BREADCRUMB_ORIGIN_ICON_SIZE = 13;

interface NodePanelProps {
  panelId: string;
  panelDragHandle?: PanelDragHandle;
  rootId: NodeId;
  canGoBack: boolean;
  initialScrollTop?: number;
  onBack: () => void;
  showClose: boolean;
  onClose: () => void;
  onScrollPositionChange?: (scrollTop: number) => void;
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
  const projectedRootCandidate = props.index.byId.get(resolvedRootId);
  const projectedRootNode = projectedRootCandidate && isContentBearingNode(projectedRootCandidate)
    ? projectedRootCandidate
    : undefined;
  const rootNode = projectedRootNode
    ? nodeWithPendingPatch(projectedRootNode, props.ui.pendingNodePatches.get(resolvedRootId))
    : projectedRootNode;
  const projection = props.index.projection;
  const [titleContent, setTitleContent] = useState<RichText>(rootNode?.content ?? EMPTY_RICH_TEXT);
  const [titleContentRevision, setTitleContentRevision] = useState(0);
  const [titleTrigger, setTitleTrigger] = useState<EditorTrigger | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [breadcrumbExpanded, setBreadcrumbExpanded] = useState(false);
  const [searchQueryOpen, setSearchQueryOpen] = useState(false);
  const {
    mainPanelRef,
    requestTitleDockMeasure,
    stickyBreadcrumbRef,
    titleDocked,
    titleRowRef,
  } = usePanelTitleDock();
  // Always-current ui for row handlers. NodePanel re-renders on every ui change,
  // so this ref stays live even for rows whose per-row memo skips re-render.
  const uiRef = useRef(props.ui);
  uiRef.current = props.ui;
  const initialScrollTopRef = useRef(props.initialScrollTop ?? 0);
  initialScrollTopRef.current = props.initialScrollTop ?? 0;
  const scrollReportFrameRef = useRef<number | null>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const restoringScrollRef = useRef(false);
  const pendingTitlePatchRef = useRef<Promise<unknown>>(Promise.resolve());
  const titlePatchQueueRef = useRef<CoalescedTextPatchQueue | null>(null);
  if (!titlePatchQueueRef.current) titlePatchQueueRef.current = new CoalescedTextPatchQueue();
  const titlePatchQueue = titlePatchQueueRef.current;
  const titleContentRef = useRef<RichText>(rootNode?.content ?? EMPTY_RICH_TEXT);
  const localTitleSyncRef = useRef<{ nodeId: NodeId; content: RichText } | null>(null);
  const titleTriggerActiveRef = useRef(false);
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
  const showOutliner = Boolean(rootNode && (!rootDefinitionKind || definitionTemplateLabel));
  const showTrailingInput = Boolean(rootNode && showOutliner && rootNode.type !== 'search');
  const breadcrumb = buildPanelBreadcrumb(rootNode, props.index);
  const titleFocusTarget = focusTarget(resolvedRootId, null, props.panelId, 'panel-title');
  const descriptionFocusTarget = focusTarget(resolvedRootId, null, props.panelId, 'description');
  const titleEditorFocused = props.ui.focusedId === resolvedRootId
    && props.ui.focusSurface === 'panel-title'
    && props.ui.focusedPanelId === props.panelId;
  const referenceSummary = useMemo(() => referenceSummaryForIndex(props.index), [props.index]);
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
    titleContentRef.current = nextContent;
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
    titleContentRef.current = content;
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
  const panelIsoDate = dayNoteIsoDateForNode(rootNode, props.index.dayNoteCounts);
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
  const currentPageTitle = dayTitleLabel ?? (rootNode?.content.text || t.common.untitled);

  const restorePanelScroll = useCallback(() => {
    const panel = mainPanelRef.current;
    if (!panel) {
      requestTitleDockMeasure();
      return;
    }
    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }
    restoringScrollRef.current = true;
    panel.scrollTop = initialScrollTopRef.current;
    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      scrollRestoreFrameRef.current = null;
      restoringScrollRef.current = false;
      requestTitleDockMeasure();
    });
  }, [mainPanelRef, requestTitleDockMeasure]);

  useEffect(() => {
    setBreadcrumbExpanded(false);
    restorePanelScroll();
  }, [resolvedRootId, restorePanelScroll]);

  useEffect(() => () => {
    if (scrollReportFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollReportFrameRef.current);
    }
    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }
  }, []);

  const handlePanelScroll = () => {
    requestTitleDockMeasure();
    if (restoringScrollRef.current) return;
    if (!props.onScrollPositionChange || scrollReportFrameRef.current !== null) return;
    scrollReportFrameRef.current = window.requestAnimationFrame(() => {
      scrollReportFrameRef.current = null;
      const panel = mainPanelRef.current;
      if (panel) props.onScrollPositionChange?.(panel.scrollTop);
    });
  };

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

  const commitTitle = async (_content = titleContentRef.current) => {
    clearHeaderFocus();
    await pendingTitlePatchRef.current;
  };

  const applyTitlePatch = (patch: RichTextPatch) => {
    const nextContent = applyRichTextPatchToContent(titleContentRef.current, patch);
    localTitleSyncRef.current = { nodeId: resolvedRootId, content: nextContent };
    titleContentRef.current = nextContent;
    if (titleTriggerActiveRef.current || patch.ops.some((op) => op.type === 'replace_all')) {
      setTitleContent(nextContent);
    }
    pendingTitlePatchRef.current = titlePatchQueue.enqueue({
      key: resolvedRootId,
      patch,
      latestContent: nextContent,
      send: (nextPatch) => props.run(() => api.applyNodeTextPatch(resolvedRootId, nextPatch), {
        applyFocus: false,
      }),
    });
  };

  const handleTitleChange = (content: RichText) => {
    localTitleSyncRef.current = { nodeId: resolvedRootId, content };
    titleContentRef.current = content;
    setTitleContent(content);
  };

  const blurActiveElement = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleTitleEnter = (_payload: EditorSplitPayload) => {
    blurActiveElement();
    void commitTitle();
  };

  const startRootDoneTransition = (
    transition: 'toggle' | 'cycle',
    command: () => ReturnType<CommandRunner>,
  ) => {
    if (!rootNode) return Promise.resolve(false);
    return startOptimisticDoneTransition({
      index: props.index,
      node: rootNode,
      currentUi: uiRef.current,
      setUi: props.setUi,
      transition,
      command,
    });
  };

  const handleTitleModEnter = (content: RichText) => {
    replaceLocalTitleContent(content);
    void startRootDoneTransition('cycle', async () => {
      await pendingTitlePatchRef.current;
      return props.run(() => api.cycleDoneState(resolvedRootId));
    });
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

  const applyTitleTag = async (tag: NodeProjection) => {
    if (!titleTrigger || !rootNode) return null;
    const previousContent = titleContentRef.current;
    const pendingBeforeReplacement = pendingTitlePatchRef.current;
    const content = deleteRichTextRange(previousContent, titleTrigger.from, titleTrigger.to);
    replaceLocalTitleContent(content);
    void startOptimisticNodePatch({
      currentUi: uiRef.current,
      setUi: props.setUi,
      patch: optimisticTagPatch({
        node: rootNode,
        ui: uiRef.current,
        tagId: tag.id,
        action: 'add',
        content,
      }),
      command: async () => {
        await pendingBeforeReplacement;
        return props.run(() => api.applyTagWithContent(resolvedRootId, tag.id, content), {
          applyFocus: false,
        });
      },
      onRejected: () => replaceLocalTitleContent(previousContent),
    });
    return commandRunnerNoop();
  };

  const createAndApplyTitleTag = async (name: string) => {
    if (!titleTrigger || !rootNode) return null;
    const previousContent = titleContentRef.current;
    const pendingBeforeReplacement = pendingTitlePatchRef.current;
    const content = deleteRichTextRange(previousContent, titleTrigger.from, titleTrigger.to);
    const tagId = freshNodeId();
    replaceLocalTitleContent(content);
    void startOptimisticNodePatch({
      currentUi: uiRef.current,
      setUi: props.setUi,
      patch: optimisticTagPatch({
        node: rootNode,
        ui: uiRef.current,
        tagId,
        action: 'add',
        content,
        pendingTagName: name,
      }),
      command: async () => {
        await pendingBeforeReplacement;
        return props.run(
          () => api.createTagAndApplyWithContent(resolvedRootId, name, content, tagId),
          { applyFocus: false },
        );
      },
      onRejected: () => replaceLocalTitleContent(previousContent),
    });
    return commandRunnerNoop();
  };

  const applyTitleTextWithoutTrigger = async () => {
    if (!titleTrigger || !rootNode) return;
    const pendingBeforeReplacement = pendingTitlePatchRef.current;
    const content = deleteRichTextRange(
      titleContentRef.current,
      titleTrigger.from,
      titleTrigger.to,
    );
    replaceLocalTitleContent(content);
    await pendingBeforeReplacement;
    await props.run(() => api.replaceNodeText(resolvedRootId, content), {
      applyFocus: false,
    });
  };

  const applyTitleInlineReference = async (target: NodeProjection) => {
    if (!isContentBearingNode(target)) return;
    if (!titleTrigger || !rootNode) {
      return;
    }
    const pendingBeforeReplacement = pendingTitlePatchRef.current;
    const nextContent = replaceRichTextRangeWithInlineRef(
      titleContentRef.current,
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
    await pendingBeforeReplacement;
    return props.run(() => api.replaceNodeText(resolvedRootId, nextContent), {
      applyFocus: false,
    });
  };

  const executeTitleSlashCommand = async (commandId: SlashCommandId) => {
    if (!titleTrigger || !rootNode) return null;

    if (commandId === 'reference') {
      const pendingBeforeReplacement = pendingTitlePatchRef.current;
      const nextContent = replaceRichTextRangeWithText(
        titleContentRef.current,
        titleTrigger.from,
        titleTrigger.to,
        '@',
      );
      replaceLocalTitleContent(nextContent);
      setTitleTrigger(referenceTriggerFromSlash(titleTrigger));
      await pendingBeforeReplacement;
      return props.run(() => api.replaceNodeText(resolvedRootId, nextContent), {
        applyFocus: false,
      });
    }

    if (commandId === 'heading') {
      const pendingBeforeReplacement = pendingTitlePatchRef.current;
      const withoutTrigger = deleteRichTextRange(
        titleContentRef.current,
        titleTrigger.from,
        titleTrigger.to,
      );
      const nextContent = markWholeTextAsHeading(withoutTrigger);
      replaceLocalTitleContent(nextContent);
      await pendingBeforeReplacement;
      return props.run(() => api.replaceNodeText(resolvedRootId, nextContent), {
        applyFocus: false,
      });
    }

    if (commandId === 'checkbox') {
      const previousContent = titleContentRef.current;
      const nextContent = deleteRichTextRange(
        previousContent,
        titleTrigger.from,
        titleTrigger.to,
      );
      const pendingBeforeReplacement = pendingTitlePatchRef.current;
      replaceLocalTitleContent(nextContent);
      void startOptimisticNodePatch({
        currentUi: uiRef.current,
        setUi: props.setUi,
        patch: pendingNodePatch(resolvedRootId, { content: nextContent, completedAt: 0 }),
        command: async () => {
          await pendingBeforeReplacement;
          return props.run(() => api.convertNodeToCheckbox(resolvedRootId, nextContent), {
            applyFocus: false,
          });
        },
        onRejected: () => replaceLocalTitleContent(previousContent),
      });
      return commandRunnerNoop();
    }

    if (commandId === 'command_palette') {
      const clear = applyTitleTextWithoutTrigger();
      void window.lin?.showLauncher?.();
      await clear;
      return commandRunnerNoop();
    }

    return null;
  };
  const breadcrumbNodes = breadcrumb.collapsed && breadcrumbExpanded
    ? [breadcrumb.nodes[0], ...breadcrumb.hiddenNodes, ...breadcrumb.nodes.slice(1)]
    : breadcrumb.nodes;

  return (
    <main className="main-panel" ref={mainPanelRef} onScroll={handlePanelScroll}>
      {rootNode && (
        <PanelStickyBreadcrumb
          breadcrumbAriaLabel={t.nodePanel.breadcrumbAriaLabel}
          canGoBack={props.canGoBack}
          closeLabel={t.nodePanel.closePanel}
          currentTitle={currentPageTitle}
          dragHandle={props.panelDragHandle}
          origin={(
            <ButtonControl
              aria-label={t.nodePanel.openLibrary}
              className="panel-breadcrumb-origin"
              onClick={() => props.onRoot(projection.libraryId)}
            >
              <LibraryIcon size={PANEL_BREADCRUMB_ORIGIN_ICON_SIZE} />
            </ButtonControl>
          )}
          onBack={props.onBack}
          onClose={props.onClose}
          previousPageLabel={t.nodePanel.previousPage}
          showClose={props.showClose}
          stickyRef={stickyBreadcrumbRef}
          titleDocked={titleDocked}
        >
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
                  title={label}
                >
                  {label}
                </ButtonControl>
              </span>
            );
          })}
        </PanelStickyBreadcrumb>
      )}
      <div className="panel-inner">
        {rootNode?.type === undefined ? (
          <NodeSourcesSection
            accessibleName={rootNode.content.text.trim() || undefined}
            index={props.index}
            ownerId={resolvedRootId}
            run={props.run}
          />
        ) : null}
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
                  onToggle={() => void startRootDoneTransition(
                    'toggle',
                    () => props.run(() => api.toggleDone(resolvedRootId)),
                  )}
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
                  resolveInlineReferenceDisplayName={(targetId) => {
                    const target = props.index.byId.get(targetId);
                    return target && isContentBearingNode(target) ? target.content.text.trim() || undefined : undefined;
                  }}
                  onInlineReferenceClick={(target, options) => {
                    if (target.kind === 'node') {
                      props.onRoot(target.nodeId, {
                        focus: false,
                        newPane: options?.newPane,
                      });
                      return;
                    }
                  }}
                  onEscape={() => {
                    replaceLocalTitleContent(rootNode?.content ?? EMPTY_RICH_TEXT);
                    setTitleTrigger(null);
                    blurActiveElement();
                    clearHeaderFocus();
                  }}
                  onTriggerChange={(nextTrigger) => {
                    titleTriggerActiveRef.current = Boolean(nextTrigger);
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
                  applyTag={applyTitleTag}
                  createTagAndApply={createAndApplyTitleTag}
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
                ui={props.ui}
                setUi={props.setUi}
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
              dayNoteCounts={props.index.dayNoteCounts}
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
            visualRowId={resolvedRootId}
            viewToolbarVisibleInRow={true}
            openId={resolvedRootId}
            panelId={props.panelId}
            selectionRootId={resolvedRootId}
            selectedIds={props.ui.selectedIds}
            index={props.index}
            isPinned={props.isNodePinned(resolvedRootId)}
            isNodePinned={props.isNodePinned}
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
            onRevealViewToolbar={() => {}}
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
          <PanelChildrenOutline
            className={rootDefinitionKind ? 'definition-template-outliner' : undefined}
            dragId={props.dragId}
            draftPlaceholder={definitionTemplatePlaceholder ?? undefined}
            index={props.index}
            isNodePinned={props.isNodePinned}
            label={definitionTemplateLabel ? (
              // Sits inside role="tree"; presentation keeps it from masquerading
              // as a tree item.
              <div className="definition-template-label" role="presentation">{definitionTemplateLabel}</div>
            ) : null}
            onDragOver={handleOutlinerDragOver}
            onDrop={handleOutlinerDrop}
            onRoot={props.onRoot}
            onTogglePin={props.onTogglePin}
            panelId={props.panelId}
            parentId={resolvedRootId}
            rootId={resolvedRootId}
            rootSourcePreview={rootNode?.type === undefined}
            run={props.run}
            scrollParentRef={mainPanelRef}
            setDragId={props.setDragId}
            setTrigger={props.setTrigger}
            setUi={props.setUi}
            showViewToolbar={!searchQueryOpen}
            trailingDraft={showTrailingInput ? 'always' : 'none'}
            trigger={props.trigger}
            ui={props.ui}
            uiRef={uiRef}
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
