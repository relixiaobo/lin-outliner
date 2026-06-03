import type { NodeId } from '../api/types';

export interface WorkspacePanelBase {
  id: string;
  // Tile flex ratio within the canvas row. Was WorkspaceTabState.panelSizes[id];
  // normalized onto the panel so a single array is the whole layout truth.
  size: number;
}

export interface OutlinePanelState extends WorkspacePanelBase {
  type: 'outliner';
  rootId: NodeId;
  pageBackStack?: NodeId[];
  pageForwardStack?: NodeId[];
}

export interface AgentDebugPanelState extends WorkspacePanelBase {
  type: 'agent-debug';
  sessionId: string | null;
}

export type WorkspacePanelState = OutlinePanelState | AgentDebugPanelState;

export interface WorkspaceLayout {
  activePanelId: string;
  panels: WorkspacePanelState[];
}
