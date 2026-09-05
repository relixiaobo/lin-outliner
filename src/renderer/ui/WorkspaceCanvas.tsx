import { useEffect, useRef, useState, type Dispatch, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react';
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
import { ThreadTrajectoryPanel } from '../agent/components/ThreadTrajectoryPanel';
import { listWithItemMovedToIndex, WORKSPACE_PANEL_REORDER_MIME } from './interactions/dragDrop';
import type { PanelDragHandle } from './PanelShared';

// How long a cancelled drag keeps .pane-dragging (and with it the transform
// transition) so the preview can slide back home instead of snapping. Matches
// --motion-layout-duration (160ms) with a little slack.
const PANE_DRAG_SETTLE_MS = 200;

interface WorkspaceCanvasProps {
  activePanelId: string | null;
  panels: WorkspacePanelState[];
  canvasRef: RefObject<HTMLElement | null>;
  dragId: NodeId | null;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  onActivatePanel: (panel: WorkspacePanelState) => void;
  onClosePanel: (panelId: string) => void;
  onError: (message: string | null) => void;
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
  const settleTimeoutRef = useRef<number | null>(null);

  const clearSettleTimeout = () => {
    if (settleTimeoutRef.current === null) return;
    window.clearTimeout(settleTimeoutRef.current);
    settleTimeoutRef.current = null;
  };
  useEffect(() => clearSettleTimeout, []);
  // Hardening: every cleanup path hangs on the source nav's dragend, which
  // never fires if the dragged pane unmounts mid-drag (an async close). Drop
  // the whole drag state when the dragged id leaves the layout.
  useEffect(() => {
    if (!dragPanelId || activePanels.some((panel) => panel.id === dragPanelId)) return;
    clearSettleTimeout();
    dragLayoutRef.current = null;
    setDragPanelId(null);
    setPanelDropIndex(null);
  }, [activePanels, dragPanelId]);

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
          clearSettleTimeout();
          // Freeze the VISUAL-order geometry (panes render in stable DOM
          // order with CSS `order`, so query by id, not DOM position).
          const rects = activePanels.map((activePanel) => (
            props.canvasRef.current
              ?.querySelector<HTMLElement>(`:scope > [data-panel-id="${activePanel.id}"]`)
              ?.getBoundingClientRect() ?? null
          ));
          if (rects.every((rect): rect is DOMRect => rect !== null)) {
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
        // outside). On cancel, clear the transforms first but keep
        // .pane-dragging (the transition carrier) until the panes have slid
        // back home — dropping both at once would snap.
        onDragEnd: () => {
          dragLayoutRef.current = null;
          setPanelDropIndex(null);
          clearSettleTimeout();
          settleTimeoutRef.current = window.setTimeout(() => {
            settleTimeoutRef.current = null;
            setDragPanelId(null);
          }, PANE_DRAG_SETTLE_MS);
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
    // Cancel the default drop unconditionally — a no-op release must not
    // deliver the dragstart text/plain payload into pane content.
    event.preventDefault();
    event.stopPropagation();
    const panelId = event.dataTransfer.getData(WORKSPACE_PANEL_REORDER_MIME);
    const dropIndex = panelDropIndex;
    clearSettleTimeout();
    dragLayoutRef.current = null;
    setDragPanelId(null);
    setPanelDropIndex(null);
    if (!panelId || dropIndex === null) return;
    props.onMovePanel(panelId, dropIndex);
  };
  const handleCanvasDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setPanelDropIndex(null);
  };
  // translateX deltas for the would-be arrangement: replay movePanelToIndex's
  // permutation over the frozen geometry. Panes get the delta between their
  // previewed and original left edge; each divider slot gets the delta to the
  // boundary between the previewed neighbours, so the hairlines ride along
  // instead of cutting through (or vanishing under) the sliding panes.
  const preview = (() => {
    const layout = dragLayoutRef.current;
    if (!layout || !dragPanelId || panelDropIndex === null) return null;
    if (!layout.ids.includes(dragPanelId)) return null;
    // The same reorder helper the commit uses — preview and commit cannot
    // disagree on where the drop lands.
    const order = listWithItemMovedToIndex(layout.ids, dragPanelId, panelDropIndex);
    const panes = new Map<string, number>();
    const slots: number[] = [];
    let x = layout.lefts[0];
    order.forEach((id, position) => {
      const index = layout.ids.indexOf(id);
      panes.set(id, x - layout.lefts[index]);
      x += layout.widths[index];
      if (position < order.length - 1) {
        // Original slot `position` sits at the right edge of original pane
        // `position`; its preview boundary starts right after this pane.
        slots.push(x - (layout.lefts[position] + layout.widths[position]));
      }
      x += layout.gap;
    });
    return { panes, slots };
  })();

  // Pane DOM order stays STABLE across reorders (first-seen order); the visual
  // left-right order is CSS `order` from the array index. React then never
  // moves the pane subtrees on a reorder commit, so embedded iframe/webview
  // preview content neither reloads nor loses state. (Trade-off, decided: with
  // ≤4 panes, focus/reader sequence follows DOM order and can diverge from the
  // visual order after a reorder.)
  const domOrderRef = useRef<string[]>([]);
  {
    const live = new Set(activePanels.map((panel) => panel.id));
    const kept = domOrderRef.current.filter((id) => live.has(id));
    const seen = new Set(kept);
    const added = activePanels.filter((panel) => !seen.has(panel.id)).map((panel) => panel.id);
    domOrderRef.current = [...kept, ...added];
  }
  const domOrderPanels = domOrderRef.current
    .map((id) => activePanels.find((panel) => panel.id === id))
    .filter((panel): panel is WorkspacePanelState => Boolean(panel));

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
      {domOrderPanels.map((panel) => {
        const panelIndex = activePanels.findIndex((candidate) => candidate.id === panel.id);
        return (
          <WorkspacePanelSurface
            key={panel.id}
            active={props.activePanelId === panel.id}
            firstPane={panelIndex === 0}
            lastPane={panelIndex === activePanels.length - 1}
            onActivate={() => props.onActivatePanel(panel)}
            order={panelIndex * 2}
            panel={panel}
            previewOffset={preview?.panes.get(panel.id) ?? null}
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
            ) : panel.view.kind === 'thread-trajectory' ? (
              <ThreadTrajectoryPanel
                canGoBack={Boolean(panel.backStack.length)}
                onBack={() => props.onNavigatePanelBack(panel.id)}
                onClose={() => (
                  panel.backStack.length > 0
                    ? props.onNavigatePanelBack(panel.id)
                    : props.onClosePanel(panel.id)
                )}
                panelDragHandle={panelDragHandleFor(panel)}
                selectedRecordId={panel.view.selectedRecordId}
                showClose={activePanels.length > 1}
                threadId={panel.view.threadId}
                turnId={panel.view.turnId}
              />
            ) : (
              null
            )}
          </WorkspacePanelSurface>
        );
      })}
      {/* Divider slots are stateless, so they render in a separate loop keyed
          by boundary index; CSS `order` interleaves them with the panes. */}
      {activePanels.slice(0, -1).map((panel, panelIndex) => (
        <div
          key={`panel-divider-${panelIndex}`}
          className="panel-resize-slot"
          style={{
            order: panelIndex * 2 + 1,
            ...(preview?.slots[panelIndex]
              ? { transform: `translateX(${preview.slots[panelIndex]}px)` }
              : {}),
          }}
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
      ))}
    </section>
  );
}
