import { Fragment, useRef, useState, type Dispatch, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react';
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
  // Pane drag-to-reorder with a live arrangement preview: while a pane header
  // drag is active, every pane slides (pure CSS transform — no DOM move, so no
  // iframe reloads, lost scroll, or content resets) to the position it would
  // occupy if the drop landed now; the drop then commits the permutation in one
  // step. All geometry is FROZEN at dragstart and the insertion index derives
  // from clientX against the frozen pane midpoints, which is monotonic in X —
  // the preview can never oscillate as panes slide under the cursor.
  //
  // panelDropIndex is the insertion position (0..length); null when no pane drag
  // hovers the canvas or the hovered boundary is one of the dragged pane's own
  // (a no-op drop previews as "everything stays put"). The dragged pane's id
  // travels in the drag's dataTransfer (WORKSPACE_PANEL_REORDER_MIME);
  // dragPanelId mirrors it in state because dataTransfer payloads are
  // unreadable during dragover.
  const [panelDropIndex, setPanelDropIndex] = useState<number | null>(null);
  const [dragPanelId, setDragPanelId] = useState<string | null>(null);
  const dragLayoutRef = useRef<{
    ids: string[];
    lefts: number[];
    widths: number[];
    mids: number[];
    gap: number;
  } | null>(null);

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
          const surfaces = props.canvasRef.current
            ?.querySelectorAll<HTMLElement>(':scope > .outline-panel-surface');
          if (surfaces && surfaces.length === activePanels.length) {
            const rects = [...surfaces].map((surface) => surface.getBoundingClientRect());
            dragLayoutRef.current = {
              ids: activePanels.map((activePanel) => activePanel.id),
              lefts: rects.map((rect) => rect.left),
              widths: rects.map((rect) => rect.width),
              mids: rects.map((rect) => rect.left + rect.width / 2),
              gap: rects.length > 1 ? Math.max(0, rects[1].left - rects[0].right) : 0,
            };
          } else {
            dragLayoutRef.current = null;
          }
          setDragPanelId(panel.id);
        },
        // dragend fires on the source for drop AND cancel (Escape / drop
        // outside) — cancel slides the preview back to the real order.
        onDragEnd: () => {
          dragLayoutRef.current = null;
          setDragPanelId(null);
          setPanelDropIndex(null);
        },
        title: t.shell.workspace.reorderPanesTitle,
      }
      : undefined
  );
  // One canvas-level dragover (capture, MIME-gated) instead of per-surface
  // handlers: the index needs only clientX + the frozen midpoints, and capture
  // keeps pane drags away from content-level DnD (outliner rows) while every
  // other drag falls through untouched.
  const handleCanvasDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!isPanelDrag(event)) return;
    const layout = dragLayoutRef.current;
    if (!layout || !dragPanelId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const index = layout.mids.filter((mid) => event.clientX > mid).length;
    const sourceIndex = layout.ids.indexOf(dragPanelId);
    const noop = sourceIndex >= 0 && (index === sourceIndex || index === sourceIndex + 1);
    setPanelDropIndex(noop ? null : index);
  };
  const handleCanvasDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!isPanelDrag(event)) return;
    const panelId = event.dataTransfer.getData(WORKSPACE_PANEL_REORDER_MIME);
    const dropIndex = panelDropIndex;
    dragLayoutRef.current = null;
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
  // Per-pane translateX for the would-be arrangement: replay movePanelToIndex's
  // permutation over the frozen geometry and hand each pane the delta between
  // its previewed and original left edge.
  const previewOffsets = (() => {
    const layout = dragLayoutRef.current;
    if (!layout || !dragPanelId || panelDropIndex === null) return null;
    const from = layout.ids.indexOf(dragPanelId);
    if (from < 0) return null;
    const order = layout.ids.filter((id) => id !== dragPanelId);
    let target = panelDropIndex;
    if (from < panelDropIndex) target -= 1;
    target = Math.max(0, Math.min(target, order.length));
    order.splice(target, 0, dragPanelId);
    const offsets = new Map<string, number>();
    let x = layout.lefts[0];
    for (const id of order) {
      const index = layout.ids.indexOf(id);
      offsets.set(id, x - layout.lefts[index]);
      x += layout.widths[index] + layout.gap;
    }
    return offsets;
  })();

  return (
    <section
      className={[
        'workspace-canvas',
        activePanels.length === 1 ? 'single-panel' : '',
        dragPanelId ? 'pane-dragging' : '',
      ].filter(Boolean).join(' ')}
      aria-label={t.shell.workspace.canvasAriaLabel}
      ref={props.canvasRef}
      onDragOverCapture={handleCanvasDragOver}
      onDropCapture={handleCanvasDrop}
      onDragLeave={handleCanvasDragLeave}
    >
      {activePanels.map((panel, panelIndex) => (
        <Fragment key={panel.id}>
          <WorkspacePanelSurface
            active={props.activePanelId === panel.id}
            onActivate={() => props.onActivatePanel(panel)}
            panel={panel}
            previewOffset={previewOffsets?.get(panel.id) ?? null}
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
            <div className="panel-resize-slot">
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
