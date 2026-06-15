import type { NodeId } from '../api/types';
import type { PreviewTarget } from '../../core/preview';

export interface WorkspacePanelBase {
  id: string;
  // Tile flex ratio within the canvas row. Was WorkspaceTabState.panelSizes[id];
  // normalized onto the panel so a single array is the whole layout truth.
  size: number;
}

export interface OutlinerPanelView {
  kind: 'outliner';
  rootId: NodeId;
}

export interface FilePreviewPanelView {
  kind: 'file-preview';
  nodeId?: NodeId;
  target: PreviewTarget;
}

export type PanelView = OutlinerPanelView | FilePreviewPanelView;

export interface WorkspaceContentPanelState extends WorkspacePanelBase {
  type: 'workspace';
  view: PanelView;
  // Per-pane view-navigation history. Always present — the panel factory and the
  // persistence sanitizer both seed it — so consumers never need to guard for
  // absence.
  backStack: PanelView[];
  forwardStack: PanelView[];
}

export interface AgentDebugPanelState extends WorkspacePanelBase {
  type: 'agent-debug';
  conversationId: string | null;
}

export type WorkspacePanelState = WorkspaceContentPanelState | AgentDebugPanelState;

export interface WorkspaceLayout {
  activePanelId: string;
  panels: WorkspacePanelState[];
}
