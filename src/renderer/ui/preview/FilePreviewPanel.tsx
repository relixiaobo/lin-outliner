import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { composeProviderQualifiedModel } from '../../../core/agentModelId';
import type { PreviewTarget } from '../../../core/preview';
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from '../../../core/translationLanguage';
import { api } from '../../api/client';
import type { AgentProviderSettingsView, NodeId } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { type DocumentIndex, type UiState } from '../../state/document';
import { referenceSummaryForIndex } from '../../state/referenceSummary';
import { BacklinksSection } from '../BacklinksSection';
import {
  AddChildIcon,
  FolderIcon,
  HideIcon,
  ICON_SIZE,
  LanguagesIcon,
  LibraryIcon,
  LoaderIcon,
  MoreIcon,
  OpenIcon,
  UrlIcon,
} from '../icons';
import { buildOutlinerRows } from '../outliner/row-model';
import { RECURSIVE_OUTLINER_FALLBACK_ENABLED } from '../outliner/OutlinerFlatView';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard, type MenuInitialFocus } from '../primitives/useMenuKeyboard';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import type { FilePreviewNavigationOptions, FilePreviewPresentation } from '../workspaceLayoutTypes';
import { buildPanelBreadcrumb } from '../panelBreadcrumb';
import { PanelChildrenOutline, PanelStickyBreadcrumb, usePanelTitleDock } from '../PanelShared';
import { canAddPreviewTargetToOutline, requestAddPreviewTargetToOutline } from './previewIngest';
import { fileNodeTarget, fileNodeTitle, isFileNode } from './fileNode';
import {
  fileNodePreviewControls,
  fileNodePreviewMeta,
} from './FilePreviewBody';
import type { FilePreviewMenuAction } from './FilePreviewPill';
import {
  FilePreviewShell,
  canOpenPreviewSource,
  canRevealPreviewSource,
  openPreviewSource,
  revealPreviewSource,
  sourceMeta,
  sourceTitle,
  targetTitleFallback,
  usePreviewSource,
  isEpubSource,
  type UrlPreviewPageMetadata,
} from './previewRenderers';
import { useEpubTranslation } from './useEpubTranslation';
import { epubPreviewTranslationCacheSourceId } from './previewTranslationCache';
import { useUrlPageTranslation } from './useUrlPageTranslation';
import { useTranslationLanguagePreference } from './translationLanguagePreference';
import { useUrlPageTranslationPreferences } from './urlPageTranslationPreferences';
import type { UrlPageTranslationStatus } from './urlPageTranslationController';
import { isProviderUsable } from '../agent/providerUsability';

const PANEL_BREADCRUMB_ORIGIN_ICON_SIZE = 13;

interface FilePreviewPanelProps {
  activePanel: boolean;
  canGoBack: boolean;
  dragId: NodeId | null;
  initialScrollTop?: number;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  nodeId?: NodeId;
  onBack: () => void;
  onClose: () => void;
  onError?: (message: string) => void;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  onScrollPositionChange?: (scrollTop: number) => void;
  onTogglePin: (nodeId: NodeId) => void;
  panelId: string;
  presentation?: FilePreviewPresentation;
  run: CommandRunner;
  setDragId: (nodeId: NodeId | null) => void;
  setTrigger: (trigger: TriggerState) => void;
  setUi: Dispatch<SetStateAction<UiState>>;
  showClose: boolean;
  target: PreviewTarget;
  trigger: TriggerState;
  ui: UiState;
}

interface LooseBreadcrumbSegment {
  key: string;
  label: string;
}

/**
 * The unified file surface. A loose source (trusted local file /
 * url) and an ingested file node share this same mounted frame: read-only filename,
 * breadcrumb, preview hero, and optional children outline.
 */
export function FilePreviewPanel(props: FilePreviewPanelProps) {
  const t = useT();
  const previewLabels = t.shell.filePreview;
  const attachmentLabels = t.outliner.field.attachment;
  const state = usePreviewSource(props.target);
  const rootNode = props.nodeId ? props.index.byId.get(props.nodeId) : undefined;
  const readerMode = props.presentation === 'reader';
  const boundFileNode = isFileNode(rootNode) ? rootNode : null;
  const fileRoot = readerMode ? null : boundFileNode;
  const nodeTarget = boundFileNode ? fileNodeTarget(boundFileNode) : null;
  const looseUrlPreview = !readerMode && !boundFileNode && props.target.kind === 'url';
  const epubTranslationSource = state.status === 'ready'
    && state.source.kind === 'file'
    && isEpubSource(state.source)
    ? state.source
    : null;
  const epubPreviewSource = epubTranslationSource !== null;
  const epubCacheSourceId = epubTranslationSource
    ? epubPreviewTranslationCacheSourceId(epubTranslationSource)
    : undefined;
  const [epubTranslationAvailable, setEpubTranslationAvailable] = useState(false);
  const translationLanguage = useTranslationLanguagePreference();
  const translationPreferences = useUrlPageTranslationPreferences();
  const [translationPopoverOpen, setTranslationPopoverOpen] = useState(false);
  const translationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const translationDismissRefs = useMemo(() => [translationTriggerRef], []);
  const closeTranslationPopover = useCallback(() => setTranslationPopoverOpen(false), []);
  const handleTranslationError = useCallback((error: 'invalid-response' | 'not-configured' | 'provider-error') => {
    props.onError?.(error === 'not-configured'
      ? previewLabels.translationNotConfigured
      : previewLabels.translationFailed);
  }, [previewLabels.translationFailed, previewLabels.translationNotConfigured, props.onError]);
  const urlTranslation = useUrlPageTranslation({
    active: looseUrlPreview,
    autoTranslate: translationPreferences.autoTranslateUrls,
    labels: {
      retry: previewLabels.retryBlockTranslation,
      translating: previewLabels.translatingBlock,
    },
    shortcutActive: props.activePanel,
    model: translationPreferences.translationModel,
    targetLanguage: translationLanguage.language,
    onError: handleTranslationError,
  });
  const epubTranslation = useEpubTranslation({
    active: epubPreviewSource,
    autoTranslate: translationPreferences.autoTranslateEpubs,
    ...(epubCacheSourceId ? { cacheSourceId: epubCacheSourceId } : {}),
    shortcutActive: props.activePanel,
    model: translationPreferences.translationModel,
    targetLanguage: translationLanguage.language,
    onError: handleTranslationError,
  });
  const handleEpubTranslationSurfaceChange = useCallback((surface: Parameters<typeof epubTranslation.attachSurface>[0]) => {
    setEpubTranslationAvailable(surface !== null);
    epubTranslation.attachSurface(surface);
  }, [epubTranslation.attachSurface]);
  const epubPreview = epubPreviewSource && epubTranslationAvailable;
  const translatablePreview = looseUrlPreview || epubPreview;
  const activeTranslation = looseUrlPreview
    ? urlTranslation
    : epubPreview ? epubTranslation : null;
  const translationStatus = activeTranslation?.status ?? 'off';
  const translationEnabled = translationStatus !== 'off';
  const translationCompleted = translationEnabled && (activeTranslation?.completed ?? false);
  const translationStatusLabel = translationStatus === 'off'
    ? previewLabels.translationOff
    : translationStatus === 'starting'
      ? previewLabels.translatingBlock
      : previewLabels.translationOn;
  const translationControlLabel = `${previewLabels.translationSettings}: ${translationStatusLabel}`;
  const previewTitle = state.status === 'ready'
    ? sourceTitle(state.source)
    : props.target.label ?? targetTitleFallback(props.target);
  const title = boundFileNode ? fileNodeTitle(boundFileNode) || previewTitle : previewTitle;
  const [urlPageMetadata, setUrlPageMetadata] = useState<UrlPreviewPageMetadata>({});
  const displayTitle = looseUrlPreview ? urlPageMetadata.title ?? title : title;
  const canOpen = state.status === 'ready' && canOpenPreviewSource(state.source);
  const canReveal = state.status === 'ready' && canRevealPreviewSource(state.source);
  const canAdd = canAddPreviewTargetToOutline(props.target);
  const {
    mainPanelRef,
    requestTitleDockMeasure,
    stickyBreadcrumbRef,
    titleDocked,
    titleRowRef,
    updateTitleDockedState,
  } = usePanelTitleDock();
  const [breadcrumbExpanded, setBreadcrumbExpanded] = useState(false);
  const targetKey = useMemo(() => previewTargetFallbackKey(props.target), [props.target]);
  const resetStateRef = useRef<{ nodeId: NodeId | null; targetKey: string } | null>(null);
  const [previewShellKey, setPreviewShellKey] = useState(() =>
    filePreviewShellKey(props.nodeId ?? null, targetKey, props.presentation),
  );
  const initialScrollTopRef = useRef(props.initialScrollTop ?? 0);
  initialScrollTopRef.current = props.initialScrollTop ?? 0;
  const scrollReportFrameRef = useRef<number | null>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const restoringScrollRef = useRef(false);
  const uiRef = useRef(props.ui);
  uiRef.current = props.ui;
  const referenceSummary = useMemo(() => referenceSummaryForIndex(props.index), [props.index]);
  const panelRows = useMemo(() => (
    RECURSIVE_OUTLINER_FALLBACK_ENABLED
      ? buildOutlinerRows(fileRoot ?? undefined, props.index.byId, {
        expandedHiddenFields: props.ui.expandedHiddenFields,
        systemFieldContext: { referenceSummary },
      })
      : undefined
  ), [fileRoot, props.index.byId, props.ui.expandedHiddenFields, referenceSummary]);

  useEffect(() => {
    if (!looseUrlPreview) {
      setUrlPageMetadata({});
      return;
    }
    setUrlPageMetadata({ title });
  }, [looseUrlPreview, targetKey, title]);

  useEffect(() => {
    if (!translatablePreview) setTranslationPopoverOpen(false);
  }, [translatablePreview]);

  useEffect(() => {
    if (!epubPreviewSource) setEpubTranslationAvailable(false);
  }, [epubPreviewSource, targetKey]);

  const handleUrlMetadataChange = useCallback((metadata: UrlPreviewPageMetadata) => {
    setUrlPageMetadata((prev) => {
      const next = {
        ...prev,
        ...(metadata.title ? { title: metadata.title } : {}),
        ...(metadata.faviconUrl ? { faviconUrl: metadata.faviconUrl } : {}),
      };
      return next.title === prev.title && next.faviconUrl === prev.faviconUrl ? prev : next;
    });
  }, []);

  const openOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void openPreviewSource(state.source);
  }, [state]);

  const revealOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void revealPreviewSource(state.source);
  }, [state]);

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
    const previous = resetStateRef.current;
    const next = { nodeId: fileRoot?.id ?? props.nodeId ?? null, targetKey };
    resetStateRef.current = next;
    // Add-to-outline intentionally rebinds a loose source into an ingested node
    // without a visual jump. Other identity changes, including node A -> node B
    // with the same asset target, reset scroll and expanded breadcrumbs.
    const looseToIngested = previous
      && previous.nodeId === null
      && next.nodeId !== null;
    if (!looseToIngested) {
      setBreadcrumbExpanded(false);
      setPreviewShellKey(filePreviewShellKey(next.nodeId, next.targetKey, props.presentation));
      restorePanelScroll();
      return;
    }
    requestTitleDockMeasure();
  }, [fileRoot?.id, props.nodeId, props.presentation, requestTitleDockMeasure, restorePanelScroll, targetKey]);

  useEffect(() => {
    requestTitleDockMeasure();
  }, [fileRoot?.id, requestTitleDockMeasure]);

  useEffect(() => () => {
    if (scrollReportFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollReportFrameRef.current);
    }
    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }
  }, []);

  const handlePanelScroll = () => {
    updateTitleDockedState();
    if (restoringScrollRef.current) return;
    if (!props.onScrollPositionChange || scrollReportFrameRef.current !== null) return;
    scrollReportFrameRef.current = window.requestAnimationFrame(() => {
      scrollReportFrameRef.current = null;
      const panel = mainPanelRef.current;
      if (panel) props.onScrollPositionChange?.(panel.scrollTop);
    });
  };

  const handleOutlinerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!props.dragId || !fileRoot) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const handleOutlinerDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!props.dragId || !fileRoot) return;
    event.preventDefault();
    event.stopPropagation();
    const draggedId = props.dragId;
    props.setDragId(null);
    if (draggedId === fileRoot.id) return;
    void props.run(() => api.moveNode(draggedId, fileRoot.id, null));
  };

  const meta = boundFileNode
    ? fileNodePreviewMeta(boundFileNode, state, attachmentLabels, previewLabels)
    : state.status === 'ready' ? sourceMeta(state.source, previewLabels) : null;
  // An ingested node carries Open-with-default + Reveal/Copy; a loose source carries
  // Open (if openable) + Show-in-Finder (on-disk sources) + Add-to-outline.
  const openSplitReader = boundFileNode && !readerMode
    ? () => props.onOpenTarget(nodeTarget ?? props.target, {
        newPane: true,
        nodeId: boundFileNode.id,
        presentation: 'reader',
      })
    : undefined;
  const fileControls = boundFileNode
    ? fileNodePreviewControls(boundFileNode, nodeTarget ?? props.target, attachmentLabels, previewLabels, {
        openInSplit: openSplitReader,
      })
    : null;
  const primaryOpen = readerMode
    ? null
    : fileControls
    ? fileControls.primaryOpen
    : canOpen
      // A url opens in the browser; an on-disk source opens with its default app.
      ? {
          label: props.target.kind === 'url' ? previewLabels.openInBrowser : previewLabels.openWithDefault,
          run: openOriginal,
        }
      : null;
  const menuActions: FilePreviewMenuAction[] = fileControls
    ? fileControls.menuActions
    : [
        ...(canReveal
          ? [{ key: 'reveal', label: previewLabels.reveal, icon: FolderIcon, run: revealOriginal }]
          : []),
        ...(canAdd
          ? [{
              key: 'add',
              label: previewLabels.addToOutline,
              icon: AddChildIcon,
              run: () => {
                void requestAddPreviewTargetToOutline({ panelId: props.panelId, target: props.target });
              },
            }]
          : []),
      ];
  const looseUrlOpenAction = !readerMode && !boundFileNode && props.target.kind === 'url' && canOpen
    ? {
        label: previewLabels.openInBrowser,
        run: openOriginal,
      }
    : null;
  const readerOpenAction = readerMode && canOpen
    ? fileControls?.primaryOpen ?? {
        label: props.target.kind === 'url' ? previewLabels.openInBrowser : previewLabels.openWithDefault,
        run: openOriginal,
      }
    : null;
  const readerMenuActions: FilePreviewMenuAction[] = readerMode
    ? [
        ...(readerOpenAction
          ? [{ key: 'open', label: readerOpenAction.label, icon: OpenIcon, run: readerOpenAction.run }]
          : []),
        ...menuActions,
      ]
    : [];
  const ingestedBreadcrumb = fileRoot ? buildPanelBreadcrumb(fileRoot, props.index) : null;
  const ingestedBreadcrumbNodes = ingestedBreadcrumb
    ? ingestedBreadcrumb.collapsed && breadcrumbExpanded
      ? [ingestedBreadcrumb.nodes[0], ...ingestedBreadcrumb.hiddenNodes, ...ingestedBreadcrumb.nodes.slice(1)]
      : ingestedBreadcrumb.nodes
    : [];
  const looseBreadcrumbSegments = !fileRoot && !readerMode
    ? looseBreadcrumbFor(props.target, state, previewLabels)
    : [];
  const automaticTranslationEnabled = looseUrlPreview
    ? translationPreferences.autoTranslateUrls
    : translationPreferences.autoTranslateEpubs;
  const setAutomaticTranslation = looseUrlPreview
    ? translationPreferences.setAutoTranslateUrls
    : translationPreferences.setAutoTranslateEpubs;
  const translationControl = activeTranslation ? (
    <>
      <ButtonControl
        aria-expanded={translationPopoverOpen}
        aria-haspopup="dialog"
        aria-label={translationControlLabel}
        className={`file-preview-reader-actions file-preview-translation-toggle ${translationStatus === 'starting' ? 'is-starting' : ''}`}
        data-translation-completed={translationCompleted}
        data-translation-enabled={translationEnabled}
        onClick={(event) => {
          event.stopPropagation();
          setTranslationPopoverOpen((open) => !open);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        ref={translationTriggerRef}
        title={`${translationControlLabel} (${translationShortcutLabel()})`}
      >
        {translationStatus === 'starting' ? (
          <LoaderIcon size={ICON_SIZE.menu} />
        ) : (
          <LanguagesIcon size={ICON_SIZE.menu} />
        )}
      </ButtonControl>
      {translationPopoverOpen ? (
        <TranslationPopover
          anchorRef={translationTriggerRef}
          autoTranslate={automaticTranslationEnabled}
          dismissIgnoreRefs={translationDismissRefs}
          language={translationLanguage.language}
          model={translationPreferences.translationModel}
          onAutoTranslateChange={setAutomaticTranslation}
          onClose={closeTranslationPopover}
          onLanguageChange={translationLanguage.setLanguage}
          onModelChange={translationPreferences.setTranslationModel}
          onToggle={() => {
            activeTranslation.toggle();
            setTranslationPopoverOpen(false);
          }}
          status={translationStatus}
        />
      ) : null}
    </>
  ) : null;

  const fillPreviewPane = readerMode || looseUrlPreview;

  return (
    <main
      className={`main-panel file-preview-panel ${readerMode ? 'file-preview-panel--reader' : ''} ${fillPreviewPane ? 'file-preview-panel--fill' : ''}`}
      ref={mainPanelRef}
      aria-label={displayTitle}
      onScroll={handlePanelScroll}
    >
      <PanelStickyBreadcrumb
        breadcrumbAriaLabel={t.nodePanel.breadcrumbAriaLabel}
        canGoBack={props.canGoBack}
        closeLabel={t.nodePanel.closePanel}
        currentTitle={displayTitle}
        origin={readerMode ? null : looseUrlPreview ? (
          <span className="panel-breadcrumb-origin file-preview-path-origin" aria-hidden="true">
            {urlPageMetadata.faviconUrl ? (
              <img className="file-preview-url-favicon" alt="" src={urlPageMetadata.faviconUrl} />
            ) : (
              <UrlIcon size={PANEL_BREADCRUMB_ORIGIN_ICON_SIZE} />
            )}
          </span>
        ) : fileRoot ? (
          <ButtonControl
            aria-label={t.nodePanel.openLibrary}
            className="panel-breadcrumb-origin"
            onClick={() => props.onRoot(props.index.projection.libraryId)}
          >
            <LibraryIcon size={PANEL_BREADCRUMB_ORIGIN_ICON_SIZE} />
          </ButtonControl>
        ) : (
          <span className="panel-breadcrumb-origin file-preview-path-origin" aria-hidden="true">
            <FolderIcon size={PANEL_BREADCRUMB_ORIGIN_ICON_SIZE} />
          </span>
        )}
        onBack={props.onBack}
        onClose={props.onClose}
        previousPageLabel={t.nodePanel.previousPage}
        showClose={props.showClose}
        stickyRef={stickyBreadcrumbRef}
        titleDocked={titleDocked}
      >
        {readerMode ? (
          <>
            <span className="panel-breadcrumb-segment panel-breadcrumb-current file-preview-reader-title">
              <span className="panel-breadcrumb-current-label" data-current-page-title title={displayTitle}>
                {displayTitle}
              </span>
            </span>
            {translationControl}
            {readerMenuActions.length > 0 ? (
              <FilePreviewHeaderMenu
                actions={readerMenuActions}
                ariaLabel={previewLabels.actions}
                meta={meta}
              />
            ) : null}
          </>
        ) : fileRoot ? (
          <>
            {ingestedBreadcrumbNodes.map((node, index) => {
              const label = node.content.text || t.common.untitled;
              const showCollapsedMarker = ingestedBreadcrumb?.collapsed && !breadcrumbExpanded && index === 1;
              return (
                <span className="panel-breadcrumb-segment" key={node.id}>
                  <span className="panel-breadcrumb-divider">/</span>
                  {showCollapsedMarker && (
                    <>
                      <ButtonControl
                        className="panel-breadcrumb-ellipsis"
                        aria-label={t.nodePanel.showHiddenBreadcrumbLevels({ count: ingestedBreadcrumb.hiddenNodes.length })}
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
            {translationControl}
          </>
        ) : looseUrlPreview ? (
          <>
            <span className="panel-breadcrumb-segment panel-breadcrumb-current file-preview-url-title">
              <span className="panel-breadcrumb-current-label" data-current-page-title title={displayTitle}>
                {displayTitle}
              </span>
            </span>
            {translationControl}
            {looseUrlOpenAction ? (
              <FilePreviewHeaderMenu
                actions={[{
                  key: 'open',
                  label: looseUrlOpenAction.label,
                  icon: OpenIcon,
                  run: looseUrlOpenAction.run,
                }]}
                ariaLabel={previewLabels.actions}
                meta={meta}
              />
            ) : null}
          </>
        ) : (
          <>
            {looseBreadcrumbSegments.map((segment) => (
              <span className="panel-breadcrumb-segment file-preview-path-segment" key={segment.key}>
                <span className="panel-breadcrumb-divider">/</span>
                <span className="file-preview-path-label">{segment.label}</span>
              </span>
            ))}
            {translationControl}
            {looseUrlOpenAction ? (
              <FilePreviewHeaderMenu
                actions={[{
                  key: 'open',
                  label: looseUrlOpenAction.label,
                  icon: OpenIcon,
                  run: looseUrlOpenAction.run,
                }]}
                ariaLabel={previewLabels.actions}
                meta={meta}
              />
            ) : null}
          </>
        )}
      </PanelStickyBreadcrumb>
      <div className="panel-inner file-preview-content">
        {!readerMode && !looseUrlPreview ? (
          <header className="panel-header">
            <div className="panel-title-row" ref={titleRowRef}>
              <div className="panel-title-editor" aria-label={t.nodePanel.pageTitleAriaLabel}>
                <h1 className="panel-title-file-heading" title={title}>{title}</h1>
              </div>
            </div>
          </header>
        ) : null}
        <FilePreviewShell
          key={previewShellKey}
          state={state}
          onOpenTarget={props.onOpenTarget}
          primaryOpen={primaryOpen}
          menuActions={readerMode ? [] : menuActions}
          meta={meta}
          initialExpanded={readerMode}
          readerMode={readerMode}
          onEpubTranslationSurfaceChange={epubPreviewSource ? handleEpubTranslationSurfaceChange : undefined}
          onUrlMetadataChange={looseUrlPreview ? handleUrlMetadataChange : undefined}
          onUrlWebviewChange={looseUrlPreview ? urlTranslation.attachWebview : undefined}
        />
        {fileRoot && (
          <>
            <PanelChildrenOutline
              dragId={props.dragId}
              index={props.index}
              isNodePinned={props.isNodePinned}
              onDragOver={handleOutlinerDragOver}
              onDrop={handleOutlinerDrop}
              onRoot={props.onRoot}
              onTogglePin={props.onTogglePin}
              panelId={props.panelId}
              parentId={fileRoot.id}
              rootId={fileRoot.id}
              rows={panelRows}
              run={props.run}
              scrollParentRef={mainPanelRef}
              setDragId={props.setDragId}
              setTrigger={props.setTrigger}
              setUi={props.setUi}
              trailingDraft="always"
              trigger={props.trigger}
              ui={props.ui}
              uiRef={uiRef}
            />
            <BacklinksSection
              targetId={fileRoot.id}
              index={props.index}
              summary={referenceSummary}
              run={props.run}
              onRoot={props.onRoot}
            />
          </>
        )}
      </div>
    </main>
  );
}

function looseBreadcrumbFor(
  target: PreviewTarget,
  state: ReturnType<typeof usePreviewSource>,
  labels: ReturnType<typeof useT>['shell']['filePreview'],
): LooseBreadcrumbSegment[] {
  const path = state.status === 'ready' && state.source.kind === 'file'
    ? state.source.displayPath
    : target.kind === 'local-file' ? target.path : null;
  if (path) return collapsePathSegments(path);
  if (target.kind === 'url') {
    const title = state.status === 'ready' && state.source.kind === 'url'
      ? state.source.title
      : target.label ?? target.url;
    return [{ key: 'url-title', label: title }];
  }
  return [{ key: previewTargetFallbackKey(target), label: target.label ?? targetTitleFallback(target) }];
}

function collapsePathSegments(path: string): LooseBreadcrumbSegment[] {
  const rawSegments = path.split('/').filter(Boolean);
  const segments = rawSegments.length ? rawSegments : [path];
  const visible = segments.length > 4
    ? [segments[0], '...', ...segments.slice(-3)]
    : segments;
  return visible.map((label, index) => ({ key: `${index}:${label}`, label }));
}

function TranslationPopover({
  anchorRef,
  autoTranslate,
  dismissIgnoreRefs,
  language,
  model,
  onAutoTranslateChange,
  onClose,
  onLanguageChange,
  onModelChange,
  onToggle,
  status,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  autoTranslate: boolean;
  dismissIgnoreRefs: Array<RefObject<HTMLElement | null>>;
  language: TranslationLanguage;
  model: string | null;
  onAutoTranslateChange: (enabled: boolean) => void;
  onClose: () => void;
  onLanguageChange: (language: TranslationLanguage) => void;
  onModelChange: (model: string | null) => void;
  onToggle: () => void;
  status: UrlPageTranslationStatus;
}) {
  const labels = useT().shell.filePreview;
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(popoverRef, {
    anchorRef,
    maxHeight: 360,
    placement: 'bottom-end',
    width: 288,
  });
  useDismissibleOverlay(popoverRef, onClose, { escape: false, ignoreRefs: dismissIgnoreRefs });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: popoverRef,
    onClose,
    kind: 'dialog',
    getRestoreTarget: () => (anchorRef.current instanceof HTMLElement ? anchorRef.current : null),
    initialFocus: 'auto',
  });
  const enabled = status !== 'off';
  const modelGroups = translationModelGroups(providerSettings);
  const modelAvailable = model === null || modelGroups.some((group) => (
    group.models.some((entry) => entry.value === model)
  ));

  useEffect(() => {
    let active = true;
    void api.agentGetProviderSettings()
      .then((settings) => {
        if (active) setProviderSettings(settings);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setModelsLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return createPortal(
    <>
      <div aria-hidden="true" className="file-preview-translation-scrim" />
      <MenuSurface
        aria-label={labels.translationSettings}
        className="node-context-menu file-preview-translation-popover"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={popoverRef}
        role="dialog"
        style={style}
      >
        <label className="file-preview-translation-option-row">
          <span>{labels.targetLanguage}</span>
          <SelectControl
            label={labels.targetLanguage}
            onChange={(event) => onLanguageChange(event.target.value as TranslationLanguage)}
            value={language}
            variant="popup"
          >
            {TRANSLATION_LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>{entry.nativeName}</option>
            ))}
          </SelectControl>
        </label>
        <Button
          aria-pressed={enabled}
          className="file-preview-translation-command"
          onClick={onToggle}
          variant={enabled ? 'secondary' : 'primary'}
        >
          <span className="file-preview-translation-command-label">
            {enabled ? <HideIcon size={ICON_SIZE.menu} /> : <LanguagesIcon size={ICON_SIZE.menu} />}
            <span>{enabled ? labels.showOriginal : labels.translatePage}</span>
          </span>
          <kbd>{translationShortcutLabel()}</kbd>
        </Button>
        <div className="file-preview-translation-divider" role="presentation" />
        <SwitchControl
          checked={autoTranslate}
          className="file-preview-translation-auto-switch"
          label={labels.autoTranslateWebpages}
          onCheckedChange={onAutoTranslateChange}
        >
          <span>{labels.autoTranslateWebpages}</span>
          <SwitchMark checked={autoTranslate} />
        </SwitchControl>
        <label className="file-preview-translation-option-row">
          <span>{labels.translationModel}</span>
          <SelectControl
            label={labels.translationModel}
            onChange={(event) => onModelChange(event.target.value || null)}
            value={model ?? ''}
            variant="popup"
          >
            <option value="">{labels.followAgentModel}</option>
            {model && !modelsLoaded ? (
              <option value={model}>{translationModelName(model)}</option>
            ) : null}
            {model && modelsLoaded && !modelAvailable ? (
              <option disabled value={model}>
                {labels.translationModelUnavailable({ model: translationModelName(model) })}
              </option>
            ) : null}
            {!modelsLoaded ? <option disabled>{labels.translationModelsLoading}</option> : null}
            {modelGroups.map((group) => (
              <optgroup key={group.providerId} label={translationProviderName(group.providerId)}>
                {group.models.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </optgroup>
            ))}
          </SelectControl>
        </label>
      </MenuSurface>
    </>,
    document.body,
  );
}

interface TranslationModelGroup {
  providerId: string;
  models: Array<{ label: string; value: string }>;
}

function translationModelGroups(settings: AgentProviderSettingsView | null): TranslationModelGroup[] {
  if (!settings) return [];
  const providers = [...settings.providers].sort((left, right) => {
    if (left.providerId === settings.activeProviderId) return -1;
    if (right.providerId === settings.activeProviderId) return 1;
    return left.providerId.localeCompare(right.providerId);
  });
  return providers.flatMap((provider) => {
    if (!isProviderUsable(settings, provider)) return [];
    const models = settings.availableProviders
      .find((entry) => entry.providerId === provider.providerId)
      ?.models.map((model) => ({
        label: model.name,
        value: composeProviderQualifiedModel(provider.providerId, model.id),
      })) ?? [];
    return models.length > 0 ? [{ providerId: provider.providerId, models }] : [];
  });
}

function translationModelName(model: string): string {
  const separator = model.indexOf('/');
  return separator >= 0 ? model.slice(separator + 1) : model;
}

function translationProviderName(providerId: string): string {
  const tokens: Record<string, string> = {
    ai: 'AI',
    api: 'API',
    github: 'GitHub',
    openai: 'OpenAI',
  };
  return providerId
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => tokens[part] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function translationShortcutLabel(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform)
    ? '⌥A'
    : 'Alt+A';
}

function previewTargetFallbackKey(target: PreviewTarget): string {
  if (target.kind === 'asset') return target.assetId;
  if (target.kind === 'local-file') return target.path;
  return target.url;
}

function filePreviewShellKey(
  nodeId: NodeId | null,
  targetKey: string,
  presentation: FilePreviewPresentation | undefined,
): string {
  return `${nodeId ?? 'loose'}:${targetKey}:${presentation ?? 'default'}`;
}

function FilePreviewHeaderMenu({
  actions,
  ariaLabel,
  meta,
}: {
  actions: FilePreviewMenuAction[];
  ariaLabel: string;
  meta: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [menuInitialFocus, setMenuInitialFocus] = useState<MenuInitialFocus>('surface');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dismissIgnoreRefs = useMemo(() => [triggerRef], []);

  return (
    <>
      <ButtonControl
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className="file-preview-reader-actions"
        onClick={(event) => {
          event.stopPropagation();
          const nextOpen = !open;
          if (nextOpen) setMenuInitialFocus(event.detail === 0 ? 'auto' : 'surface');
          setOpen(nextOpen);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          event.stopPropagation();
          setMenuInitialFocus('auto');
          setOpen(true);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        ref={triggerRef}
      >
        <MoreIcon size={ICON_SIZE.menu} />
      </ButtonControl>
      {open ? (
        <FilePreviewHeaderActionMenu
          actions={actions}
          anchorRef={triggerRef}
          ariaLabel={ariaLabel}
          dismissIgnoreRefs={dismissIgnoreRefs}
          initialFocus={menuInitialFocus}
          meta={meta}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function FilePreviewHeaderActionMenu({
  actions,
  anchorRef,
  ariaLabel,
  dismissIgnoreRefs,
  initialFocus,
  meta,
  onClose,
}: {
  actions: FilePreviewMenuAction[];
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  dismissIgnoreRefs: Array<RefObject<HTMLElement | null>>;
  initialFocus: MenuInitialFocus;
  meta: string | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    maxHeight: 280,
    placement: 'bottom-end',
    width: 220,
  });
  useDismissibleOverlay(menuRef, onClose, { escape: false, ignoreRefs: dismissIgnoreRefs });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose,
    kind: 'menu',
    getRestoreTarget: () => (anchorRef.current instanceof HTMLElement ? anchorRef.current : null),
    initialFocus,
  });

  return createPortal(
    <MenuSurface
      aria-label={ariaLabel}
      className="node-context-menu"
      preserveSelection
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      ref={menuRef}
      role="menu"
      style={style}
    >
      {meta ? <div className="file-preview-menu-meta" aria-hidden="true">{meta}</div> : null}
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <MenuItem
            key={action.key}
            className="node-context-item"
            icon={<Icon size={ICON_SIZE.menu} />}
            label={action.label}
            onClick={() => {
              onClose();
              action.run();
            }}
            role="menuitem"
          />
        );
      })}
    </MenuSurface>,
    document.body,
  );
}
