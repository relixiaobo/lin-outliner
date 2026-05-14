import { Fragment, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react';
import type { FocusHint, NodeId } from '../api/types';
import type { DocumentIndex, UiState } from '../state/document';
import { CloseIcon, ICON_SIZE } from './icons';
import { NodePanel } from './NodePanel';
import { AgentDebugPanel } from './agent/AgentDebugPanel';
import type { CommandRunner, TriggerState } from './shared';
import type { WorkspacePanelState, WorkspaceTabState } from './workspaceLayoutTypes';

interface WorkspaceCanvasProps {
  activeTab: WorkspaceTabState | null;
  canvasRef: RefObject<HTMLElement | null>;
  dragId: NodeId | null;
  index: DocumentIndex;
  onActivatePanel: (panel: WorkspacePanelState) => void;
  onClosePanel: (panelId: string) => void;
  onNavigatePanelRoot: (panelId: string, nodeId: NodeId) => void;
  onPanelResizeStart: (
    leftPanelId: string,
    rightPanelId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  pendingFocus: FocusHint | null;
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
          <div
            className={[
              'outline-panel-surface',
              `is-${panel.type}`,
              props.activeTab?.activePanelId === panel.id ? 'active-panel' : '',
            ].filter(Boolean).join(' ')}
            onFocusCapture={() => props.onActivatePanel(panel)}
            onPointerDownCapture={() => props.onActivatePanel(panel)}
            style={{
              '--panel-size': props.activeTab?.panelSizes[panel.id] ?? 1,
            } as CSSProperties}
          >
            {activePanels.length > 1 && (
              <button
                className="outline-panel-close"
                onClick={() => props.onClosePanel(panel.id)}
                title="Close panel"
                type="button"
              >
                <CloseIcon size={ICON_SIZE.menu} />
              </button>
            )}
            {panel.type === 'outliner' ? (
              <NodePanel
                rootId={panel.rootId}
                onRoot={(nodeId) => props.onNavigatePanelRoot(panel.id, nodeId)}
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
            ) : (
              <AgentDebugPanel sessionId={panel.sessionId} />
            )}
          </div>
          {panelIndex < activePanels.length - 1 && (
            <div className="panel-resize-slot">
              <button
                aria-label="Resize panels"
                className="panel-resize-handle"
                onPointerDown={(event) => (
                  props.onPanelResizeStart(panel.id, activePanels[panelIndex + 1].id, event)
                )}
                type="button"
              />
            </div>
          )}
        </Fragment>
      ))}
    </section>
  );
}
