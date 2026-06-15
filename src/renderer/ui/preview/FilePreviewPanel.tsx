import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { type DocumentIndex, type UiState } from '../../state/document';
import { referenceSummaryForIndex } from '../../state/referenceSummary';
import { BacklinksSection } from '../BacklinksSection';
import { AddChildIcon, CheckIcon, FolderIcon, ICON_SIZE, LibraryIcon, LoaderIcon, MoreIcon, OpenIcon } from '../icons';
import { buildOutlinerRows } from '../outliner/row-model';
import { ButtonControl } from '../primitives/ButtonControl';
import type { CommandRunner, NavigateRootOptions, TriggerState } from '../shared';
import { buildPanelBreadcrumb } from '../panelBreadcrumb';
import { PanelChildrenOutline, PanelStickyBreadcrumb, usePanelTitleDock } from '../PanelShared';
import { canAddPreviewTargetToOutline, requestAddPreviewTargetToOutline } from './previewIngest';
import { fileNodeTarget, fileNodeTitle, isFileNode } from './fileNode';
import {
  FileNodePreviewActions,
  fileNodePreviewMeta,
} from './FilePreviewBody';
import {
  FilePreviewShell,
  canOpenPreviewSource,
  openPreviewSource,
  sourceMeta,
  sourceTitle,
  targetTitleFallback,
  usePreviewSource,
} from './previewRenderers';

const PANEL_BREADCRUMB_ORIGIN_ICON_SIZE = 13;

interface FilePreviewPanelProps {
  canGoBack: boolean;
  dragId: NodeId | null;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  nodeId?: NodeId;
  onBack: () => void;
  onClose: () => void;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  onTogglePin: (nodeId: NodeId) => void;
  panelId: string;
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
 * The unified file surface. A loose source (agent payload / trusted local file /
 * url) and an ingested file node share this same mounted frame: read-only filename,
 * breadcrumb, preview hero, and optional children outline.
 */
export function FilePreviewPanel(props: FilePreviewPanelProps) {
  const t = useT();
  const previewLabels = t.shell.filePreview;
  const attachmentLabels = t.outliner.field.attachment;
  const state = usePreviewSource(props.target);
  const rootNode = props.nodeId ? props.index.byId.get(props.nodeId) : undefined;
  const fileRoot = isFileNode(rootNode) ? rootNode : null;
  const nodeTarget = fileRoot ? fileNodeTarget(fileRoot) : null;
  const previewTitle = state.status === 'ready'
    ? sourceTitle(state.source)
    : props.target.label ?? targetTitleFallback(props.target);
  const title = fileRoot ? fileNodeTitle(fileRoot) || previewTitle : previewTitle;
  const canOpen = state.status === 'ready' && canOpenPreviewSource(state.source);
  const canAdd = canAddPreviewTargetToOutline(props.target);
  const {
    mainPanelRef,
    requestTitleDockMeasure,
    resetPanelViewport,
    stickyBreadcrumbRef,
    titleDocked,
    titleRowRef,
    updateTitleDockedState,
  } = usePanelTitleDock();
  const [breadcrumbExpanded, setBreadcrumbExpanded] = useState(false);
  const targetKey = useMemo(() => previewTargetFallbackKey(props.target), [props.target]);
  const resetStateRef = useRef<{ nodeId: NodeId | null; targetKey: string } | null>(null);
  const uiRef = useRef(props.ui);
  uiRef.current = props.ui;
  const referenceSummary = useMemo(() => referenceSummaryForIndex(props.index), [props.index]);
  const systemFieldContext = useMemo(() => ({ referenceSummary }), [referenceSummary]);
  const panelRows = useMemo(() => buildOutlinerRows(fileRoot ?? undefined, props.index.byId, {
    expandedHiddenFields: props.ui.expandedHiddenFields,
    systemFieldContext,
  }), [fileRoot, props.index.byId, props.ui.expandedHiddenFields, systemFieldContext]);

  const openOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void openPreviewSource(state.source);
  }, [state]);

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
      resetPanelViewport();
      return;
    }
    requestTitleDockMeasure();
  }, [fileRoot?.id, props.nodeId, requestTitleDockMeasure, resetPanelViewport, targetKey]);

  useEffect(() => {
    requestTitleDockMeasure();
  }, [fileRoot?.id, requestTitleDockMeasure]);

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

  const meta = fileRoot
    ? fileNodePreviewMeta(fileRoot, state, attachmentLabels, previewLabels)
    : state.status === 'ready' ? sourceMeta(state.source, previewLabels) : null;
  const actions = fileRoot ? (
    <FileNodePreviewActions node={fileRoot} target={nodeTarget ?? props.target} />
  ) : (canAdd || canOpen) ? (
    <>
      {canAdd ? (
        <AddToOutlineButton panelId={props.panelId} target={props.target} />
      ) : null}
      {canOpen ? (
        <ButtonControl aria-label={previewLabels.open} className="file-node-action" onClick={openOriginal}>
          <OpenIcon size={ICON_SIZE.toolbar} />
        </ButtonControl>
      ) : null}
    </>
  ) : null;
  const ingestedBreadcrumb = fileRoot ? buildPanelBreadcrumb(fileRoot, props.index) : null;
  const ingestedBreadcrumbNodes = ingestedBreadcrumb
    ? ingestedBreadcrumb.collapsed && breadcrumbExpanded
      ? [ingestedBreadcrumb.nodes[0], ...ingestedBreadcrumb.hiddenNodes, ...ingestedBreadcrumb.nodes.slice(1)]
      : ingestedBreadcrumb.nodes
    : [];
  const looseBreadcrumbSegments = !fileRoot
    ? looseBreadcrumbFor(props.target, state, previewLabels)
    : [];

  return (
    <main
      className="main-panel file-preview-panel"
      ref={mainPanelRef}
      aria-label={title}
      onScroll={updateTitleDockedState}
    >
      <PanelStickyBreadcrumb
        breadcrumbAriaLabel={t.nodePanel.breadcrumbAriaLabel}
        canGoBack={props.canGoBack}
        closeLabel={t.nodePanel.closePanel}
        currentTitle={title}
        origin={fileRoot ? (
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
        {fileRoot ? (
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
          </>
        ) : (
          <>
            {looseBreadcrumbSegments.map((segment) => (
              <span className="panel-breadcrumb-segment file-preview-path-segment" key={segment.key}>
                <span className="panel-breadcrumb-divider">/</span>
                <span className="file-preview-path-label">{segment.label}</span>
              </span>
            ))}
          </>
        )}
      </PanelStickyBreadcrumb>
      <div className="panel-inner file-preview-content">
        <header className="panel-header">
          <div className="panel-title-row" ref={titleRowRef}>
            <div className="panel-title-editor" aria-label={t.nodePanel.pageTitleAriaLabel}>
              <h1 className="panel-title-file-heading" title={title}>{title}</h1>
            </div>
          </div>
        </header>
        <FilePreviewShell
          meta={meta}
          actions={actions}
          state={state}
          onOpenTarget={props.onOpenTarget}
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

function AddToOutlineButton({ panelId, target }: { panelId: string; target: PreviewTarget }) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<'idle' | 'inserting' | 'inserted'>('idle');
  // A ref guards re-entry: `disabled` only lands next paint, so two clicks in one
  // frame would both read a stale `idle` and double-insert.
  const insertingRef = useRef(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function add() {
    if (insertingRef.current) return;
    insertingRef.current = true;
    setState('inserting');
    let added = false;
    try {
      added = await requestAddPreviewTargetToOutline({ panelId, target });
    } catch {
      added = false;
    } finally {
      insertingRef.current = false;
    }
    if (!mountedRef.current) return;
    if (!added) {
      setState('idle');
      return;
    }
    setState('inserted');
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setState('idle');
      resetTimerRef.current = null;
    }, 1200);
  }

  const label = state === 'inserted' ? labels.addedToOutline : labels.addToOutline;
  const StateIcon = state === 'inserted' ? CheckIcon : state === 'inserting' ? LoaderIcon : AddChildIcon;
  return (
    <ButtonControl
      aria-label={label}
      className="file-node-action"
      disabled={state === 'inserting'}
      onClick={() => void add()}
      title={label}
    >
      <StateIcon
        aria-hidden="true"
        className={state === 'inserting' ? 'agent-tool-call-spinner' : undefined}
        size={ICON_SIZE.toolbar}
      />
    </ButtonControl>
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
  if (target.kind === 'agent-payload') return [{ key: 'agent-payload', label: labels.sourceAgentPayload }];
  if (target.kind === 'url') return [{ key: 'url', label: labels.sourceUrl }];
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

function previewTargetFallbackKey(target: PreviewTarget): string {
  if (target.kind === 'asset') return target.assetId;
  if (target.kind === 'agent-payload') return target.payloadId;
  if (target.kind === 'local-file') return target.path;
  return target.url;
}
