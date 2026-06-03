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
  // Per-pane page-navigation history (a stack of roots). Always present — the
  // panel factory and the persistence sanitizer both seed them — so consumers
  // never need to guard for absence.
  pageBackStack: NodeId[];
  pageForwardStack: NodeId[];
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
