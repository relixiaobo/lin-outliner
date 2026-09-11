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
  scrollTop?: number;
}

export interface FilePreviewPanelView {
  kind: 'file-preview';
  nodeId?: NodeId;
  presentation?: FilePreviewPresentation;
  scrollTop?: number;
  target: PreviewTarget;
}

export interface ThreadTrajectoryPanelView {
  kind: 'thread-trajectory';
  threadId: string;
  selectedRecordId?: string;
  turnId?: string;
}

export type FilePreviewPresentation = 'reader';

export interface FilePreviewNavigationOptions {
  newPane?: boolean;
  nodeId?: NodeId;
  presentation?: FilePreviewPresentation;
}

export type PanelView = OutlinerPanelView | FilePreviewPanelView | ThreadTrajectoryPanelView;

export interface WorkspaceContentPanelState extends WorkspacePanelBase {
  type: 'workspace';
  view: PanelView;
  // Last live outliner root associated with this pane. Fresh split previews have
  // no Back entry, so restore uses this root if their current node disappears.
  recoveryRootId?: NodeId;
  // Per-pane view-navigation history. Always present — the panel factory and the
  // persistence sanitizer both seed it — so consumers never need to guard for
  // absence.
  backStack: PanelView[];
  forwardStack: PanelView[];
}

export type WorkspacePanelState = WorkspaceContentPanelState;

export interface WorkspaceLayout {
  activePanelId: string;
  panels: WorkspacePanelState[];
}
