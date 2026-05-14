import type { NodeId } from '../api/types';

export interface OutlinePanelState {
  id: string;
  rootId: NodeId;
}

export interface WorkspaceTabState {
  id: string;
  activePanelId: string;
  title?: string;
  panelSizes: Record<string, number>;
  panels: OutlinePanelState[];
}
