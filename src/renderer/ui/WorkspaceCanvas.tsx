import { Fragment, useState, type Dispatch, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react';
import type { NodeId } from '../api/types';
import type { DocumentIndex, UiState } from '../state/document';
import { NodePanel } from './NodePanel';
import { WorkspacePanelSurface } from './WorkspacePanelSurface';
import { FilePreviewPanel } from './preview/FilePreviewPanel';
import { ResizeHandle } from './primitives/ResizeHandle';
import type { CommandRunner, NavigateRootOptions, TriggerState } from './shared';
import type { FilePreviewNavigationOptions, WorkspacePanelState } from './workspaceLayoutTypes';
import type { PreviewTarget } from '../../core/preview';
import { useT } from '../i18n/I18nProvider';
import { ThreadTurnDetailsPanel } from '../agent/components/ThreadTurnDetailsPanel';
import { WORKSPACE_PANEL_REORDER_MIME } from './interactions/dragDrop';
import type { PanelDragHandle } from './PanelShared';

interface WorkspaceCanvasProps {
  activePanelId: string | null;
  panels: WorkspacePanelState[];
  canvasRef: RefObject<HTMLElement | null>;
  dragId: NodeId | null;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  onActivatePanel: (panel: WorkspacePanelState) => void;
  onClosePanel: (panelId: string) => void;
  onError: (message: string) => void;
  onMovePanel: (panelId: string, index: number) => void;
  onNavigatePanelBack: (panelId: string) => void;
  onNavigatePanelPreview: (panelId: string, target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  onNavigatePanelRoot: (panelId: string, nodeId: NodeId, options?: NavigateRootOptions) => void;
  onPanelScrollPositionChange: (panelId: string, scrollTop: number) => void;
  onPanelResizeReset: (leftPanelId: string, rightPanelId: string) => void;
  onPanelResizeStart: (
    leftPanelId: string,
    rightPanelId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPanelResizeKeyDown: (
    leftPanelId: string,
    rightPanelId: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onTogglePin: (nodeId: NodeId) => void;
  run: CommandRunner;
  setDragId: (nodeId: NodeId | null) => void;
  setTrigger: (trigger: TriggerState) => void;
  setUi: Dispatch<SetStateAction<UiState>>;
  trigger: TriggerState;
  ui: UiState;
}

export function WorkspaceCanvas(props: WorkspaceCanvasProps) {
  const t = useT();
  const activePanels = props.panels;
  // Pane drag-to-reorder: the insertion position (0..length) the hovered drop
  // would land on, shown as a line at the matching pane boundary plus a landing
  // wash on the hovered pane. Null when no pane drag hovers the canvas — or when
  // the hovered boundary is one of the dragged pane's own (a no-op drop shows no
  // feedback at all). The dragged pane's id travels in the drag's dataTransfer
  // (WORKSPACE_PANEL_REORDER_MIME); dragPanelId mirrors it in state because
  // dataTransfer payloads are unreadable during dragover.
  const [panelDropIndex, setPanelDropIndex] = useState<number | null>(null);
  const [dragPanelId, setDragPanelId] = useState<string | null>(null);

  const isPanelDrag = (event: ReactDragEvent<HTMLElement>) => (
    event.dataTransfer.types.includes(WORKSPACE_PANEL_REORDER_MIME)
  );
  const panelDragHandleFor = (panel: WorkspacePanelState): PanelDragHandle | undefined => (
    activePanels.length > 1
      ? {
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(WORKSPACE_PANEL_REORDER_MIME, panel.id);
          event.dataTransfer.setData('text/plain', '');
          setDragPanelId(panel.id);
        },
        // dragend fires on the source for drop AND cancel (Escape / drop outside).
        onDragEnd: () => {
          setDragPanelId(null);
          setPanelDropIndex(null);
        },
        title: t.shell.workspace.reorderPanesTitle,
      }
      : undefined
  );
  const updateDropIndex = (index: number) => {
    const sourceIndex = activePanels.findIndex((panel) => panel.id === dragPanelId);
    const noop = sourceIndex >= 0 && (index === sourceIndex || index === sourceIndex + 1);
    setPanelDropIndex(noop ? null : index);
  };
  // Surface-level dragover: before/after the hovered pane by its horizontal
  // midpoint (the pane analogue of the sidebar's pinned-row reorder).
  const handlePanelDragOver = (panelIndex: number) => (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isPanelDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientX - rect.left > rect.width / 2;
    updateDropIndex(after ? panelIndex + 1 : panelIndex);
  };
  // Divider dragover: the resize slot IS the boundary between panelIndex and
  // panelIndex + 1, so hovering it never flickers the line off.
  const handleDividerDragOver = (panelIndex: number) => (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isPanelDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateDropIndex(panelIndex + 1);
  };
  const handlePanelDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isPanelDrag(event)) return;
    const panelId = event.dataTransfer.getData(WORKSPACE_PANEL_REORDER_MIME);
    const dropIndex = panelDropIndex;
    setDragPanelId(null);
    setPanelDropIndex(null);
    if (!panelId || dropIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    props.onMovePanel(panelId, dropIndex);
  };
  const handleCanvasDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setPanelDropIndex(null);
  };
  // Boundary b paints as a line on pane b's left edge; the rightmost boundary
  // (b === length) paints on the last pane's right edge.
  const dropEdgeFor = (panelIndex: number): 'before' | 'after' | null => {
    if (panelDropIndex === null) return null;
    if (panelDropIndex === panelIndex) return 'before';
    if (panelDropIndex === panelIndex + 1 && panelIndex === activePanels.length - 1) return 'after';
    return null;
  };

  return (
    <section
      className={`workspace-canvas ${activePanels.length === 1 ? 'single-panel' : ''}`}
      aria-label={t.shell.workspace.canvasAriaLabel}
      ref={props.canvasRef}
      onDragLeave={handleCanvasDragLeave}
    >
      {activePanels.map((panel, panelIndex) => (
        <Fragment key={panel.id}>
          <WorkspacePanelSurface
            active={props.activePanelId === panel.id}
            dropEdge={dropEdgeFor(panelIndex)}
            onActivate={() => props.onActivatePanel(panel)}
            onPanelDragOver={handlePanelDragOver(panelIndex)}
            onPanelDrop={handlePanelDrop}
            panel={panel}
            size={panel.size}
          >
            {panel.view.kind === 'outliner' ? (
              <NodePanel
                panelId={panel.id}
                panelDragHandle={panelDragHandleFor(panel)}
                rootId={panel.view.rootId}
                canGoBack={Boolean(panel.backStack.length)}
                initialScrollTop={panel.view.scrollTop}
                onBack={() => props.onNavigatePanelBack(panel.id)}
                showClose={activePanels.length > 1}
                onClose={() => props.onClosePanel(panel.id)}
                onScrollPositionChange={(scrollTop) => props.onPanelScrollPositionChange(panel.id, scrollTop)}
                onRoot={(nodeId, options) => props.onNavigatePanelRoot(panel.id, nodeId, options)}
                index={props.index}
                isNodePinned={props.isNodePinned}
                ui={props.ui}
                setUi={props.setUi}
                onTogglePin={props.onTogglePin}
                run={props.run}
                trigger={props.trigger}
                setTrigger={props.setTrigger}
                dragId={props.dragId}
                setDragId={props.setDragId}
              />
            ) : panel.view.kind === 'file-preview' ? (
              <FilePreviewPanel
                activePanel={props.activePanelId === panel.id}
                panelId={panel.id}
                panelDragHandle={panelDragHandleFor(panel)}
                canGoBack={Boolean(panel.backStack.length)}
                dragId={props.dragId}
                index={props.index}
                isNodePinned={props.isNodePinned}
                nodeId={panel.view.nodeId}
                presentation={panel.view.presentation}
                initialScrollTop={panel.view.scrollTop}
                onBack={() => props.onNavigatePanelBack(panel.id)}
                onClose={() => props.onClosePanel(panel.id)}
                onError={props.onError}
                onOpenTarget={(target, options) => props.onNavigatePanelPreview(panel.id, target, options)}
                onRoot={(nodeId, options) => props.onNavigatePanelRoot(panel.id, nodeId, options)}
                onScrollPositionChange={(scrollTop) => props.onPanelScrollPositionChange(panel.id, scrollTop)}
                onTogglePin={props.onTogglePin}
                run={props.run}
                setDragId={props.setDragId}
                setTrigger={props.setTrigger}
                setUi={props.setUi}
                showClose={activePanels.length > 1}
                target={panel.view.target}
                trigger={props.trigger}
                ui={props.ui}
              />
            ) : panel.view.kind === 'thread-turn-details' ? (
              <ThreadTurnDetailsPanel
                canGoBack={Boolean(panel.backStack.length)}
                onBack={() => props.onNavigatePanelBack(panel.id)}
                onClose={() => props.onNavigatePanelBack(panel.id)}
                panelDragHandle={panelDragHandleFor(panel)}
                showClose={activePanels.length > 1}
                threadId={panel.view.threadId}
                turnId={panel.view.turnId}
              />
            ) : (
              null
            )}
          </WorkspacePanelSurface>
          {panelIndex < activePanels.length - 1 && (
            <div
              className="panel-resize-slot"
              onDragOver={handleDividerDragOver(panelIndex)}
              onDrop={handlePanelDrop}
            >
              <ResizeHandle
                className="panel-resize-handle"
                label={t.shell.workspace.resizePanelsLabel}
                onDoubleClick={() => (
                  props.onPanelResizeReset(panel.id, activePanels[panelIndex + 1].id)
                )}
                onKeyDown={(event) => (
                  props.onPanelResizeKeyDown(panel.id, activePanels[panelIndex + 1].id, event)
                )}
                onPointerDown={(event) => (
                  props.onPanelResizeStart(panel.id, activePanels[panelIndex + 1].id, event)
                )}
                title={t.shell.workspace.resizePanelsTitle}
              />
            </div>
          )}
        </Fragment>
      ))}
    </section>
  );
}
