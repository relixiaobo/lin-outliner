import { Fragment, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react';
import type { NodeId } from '../api/types';
import type { DocumentIndex, UiState } from '../state/document';
import { NodePanel } from './NodePanel';
import { WorkspacePanelSurface } from './WorkspacePanelSurface';
import { AgentDebugPanel } from './agent/AgentDebugPanel';
import { FilePreviewPanel } from './preview/FilePreviewPanel';
import { ResizeHandle } from './primitives/ResizeHandle';
import type { CommandRunner, NavigateRootOptions, TriggerState } from './shared';
import type { FilePreviewNavigationOptions, WorkspacePanelState } from './workspaceLayoutTypes';
import type { PreviewTarget } from '../../core/preview';
import { useT } from '../i18n/I18nProvider';

interface WorkspaceCanvasProps {
  activePanelId: string | null;
  panels: WorkspacePanelState[];
  canvasRef: RefObject<HTMLElement | null>;
  dragId: NodeId | null;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  onActivatePanel: (panel: WorkspacePanelState) => void;
  onClosePanel: (panelId: string) => void;
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

  return (
    <section
      className={`workspace-canvas ${activePanels.length === 1 ? 'single-panel' : ''}`}
      aria-label={t.shell.workspace.canvasAriaLabel}
      ref={props.canvasRef}
    >
      {activePanels.map((panel, panelIndex) => (
        <Fragment key={panel.id}>
          <WorkspacePanelSurface
            active={props.activePanelId === panel.id}
            onActivate={() => props.onActivatePanel(panel)}
            onClose={() => props.onClosePanel(panel.id)}
            panel={panel}
            showClose={activePanels.length > 1}
            size={panel.size}
          >
            {panel.type === 'workspace' && panel.view.kind === 'outliner' ? (
              <NodePanel
                panelId={panel.id}
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
            ) : panel.type === 'workspace' && panel.view.kind === 'file-preview' ? (
              <FilePreviewPanel
                panelId={panel.id}
                canGoBack={Boolean(panel.backStack.length)}
                dragId={props.dragId}
                index={props.index}
                isNodePinned={props.isNodePinned}
                nodeId={panel.view.nodeId}
                presentation={panel.view.presentation}
                initialScrollTop={panel.view.scrollTop}
                onBack={() => props.onNavigatePanelBack(panel.id)}
                onClose={() => props.onClosePanel(panel.id)}
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
            ) : panel.type === 'agent-debug' ? (
              <AgentDebugPanel conversationId={panel.conversationId} runId={panel.runId} />
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
