import type { NodeId } from '../api/types';

export interface OutlinePanelState {
  type: 'outliner';
  id: string;
  rootId: NodeId;
  pageBackStack?: NodeId[];
  pageForwardStack?: NodeId[];
}

export interface AgentDebugPanelState {
  type: 'agent-debug';
  id: string;
  sessionId: string | null;
}

export type WorkspacePanelState = OutlinePanelState | AgentDebugPanelState;

export interface WorkspaceTabState {
  id: string;
  activePanelId: string;
  title?: string;
  panelSizes: Record<string, number>;
  panels: WorkspacePanelState[];
}
