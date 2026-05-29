import { Fragment, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react';
import type { NodeId } from '../api/types';
import type { DocumentIndex, UiState } from '../state/document';
import { NodePanel } from './NodePanel';
import { WorkspacePanelSurface } from './WorkspacePanelSurface';
import { AgentDebugPanel } from './agent/AgentDebugPanel';
import { ResizeHandle } from './primitives/ResizeHandle';
import type { CommandRunner, NavigateRootOptions, TriggerState } from './shared';
import type { WorkspacePanelState, WorkspaceTabState } from './workspaceLayoutTypes';

interface WorkspaceCanvasProps {
  activeTab: WorkspaceTabState | null;
  canvasRef: RefObject<HTMLElement | null>;
  dragId: NodeId | null;
  index: DocumentIndex;
  onActivatePanel: (panel: WorkspacePanelState) => void;
  onClosePanel: (panelId: string) => void;
  onNavigatePanelBack: (panelId: string) => void;
  onNavigatePanelRoot: (panelId: string, nodeId: NodeId, options?: NavigateRootOptions) => void;
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
  run: CommandRunner;
  setDragId: (nodeId: NodeId | null) => void;
  setTrigger: (trigger: TriggerState) => void;
  setUi: Dispatch<SetStateAction<UiState>>;
  trigger: TriggerState;
  ui: UiState;
}

export function WorkspaceCanvas(props: WorkspaceCanvasProps) {
  const activePanels = props.activeTab?.panels ?? [];

  return (
    <section
      className={`workspace-canvas ${activePanels.length === 1 ? 'single-panel' : ''}`}
      aria-label="Workspace canvas"
      ref={props.canvasRef}
    >
      {activePanels.map((panel, panelIndex) => (
        <Fragment key={panel.id}>
          <WorkspacePanelSurface
            active={props.activeTab?.activePanelId === panel.id}
            onActivate={() => props.onActivatePanel(panel)}
            onClose={() => props.onClosePanel(panel.id)}
            panel={panel}
            showClose={activePanels.length > 1}
            size={props.activeTab?.panelSizes[panel.id] ?? 1}
          >
            {panel.type === 'outliner' ? (
              <NodePanel
                panelId={panel.id}
                rootId={panel.rootId}
                canGoBack={Boolean(panel.pageBackStack?.length)}
                onBack={() => props.onNavigatePanelBack(panel.id)}
                showClose={activePanels.length > 1}
                onClose={() => props.onClosePanel(panel.id)}
                onRoot={(nodeId, options) => props.onNavigatePanelRoot(panel.id, nodeId, options)}
                index={props.index}
                ui={props.ui}
                setUi={props.setUi}
                run={props.run}
                trigger={props.trigger}
                setTrigger={props.setTrigger}
                dragId={props.dragId}
                setDragId={props.setDragId}
              />
            ) : (
              <AgentDebugPanel sessionId={panel.sessionId} />
            )}
          </WorkspacePanelSurface>
          {panelIndex < activePanels.length - 1 && (
            <div className="panel-resize-slot">
              <ResizeHandle
                className="panel-resize-handle"
                label="Resize panels"
                onDoubleClick={() => (
                  props.onPanelResizeReset(panel.id, activePanels[panelIndex + 1].id)
                )}
                onKeyDown={(event) => (
                  props.onPanelResizeKeyDown(panel.id, activePanels[panelIndex + 1].id, event)
                )}
                onPointerDown={(event) => (
                  props.onPanelResizeStart(panel.id, activePanels[panelIndex + 1].id, event)
                )}
                title="Resize panels (double-click to reset)"
              />
            </div>
          )}
        </Fragment>
      ))}
    </section>
  );
}
