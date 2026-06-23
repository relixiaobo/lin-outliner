import type { PreviewTarget } from '../../../core/preview';

export const AGENT_DOCK_FILE_PREVIEW_EVENT = 'lin:agent-dock-file-preview';

export interface AgentDockFilePreviewDetail {
  target: PreviewTarget;
}

export function dispatchAgentDockFilePreview(detail: AgentDockFilePreviewDetail): void {
  window.dispatchEvent(new CustomEvent<AgentDockFilePreviewDetail>(AGENT_DOCK_FILE_PREVIEW_EVENT, { detail }));
}

export function onAgentDockFilePreview(listener: (detail: AgentDockFilePreviewDetail) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<AgentDockFilePreviewDetail>).detail);
  };
  window.addEventListener(AGENT_DOCK_FILE_PREVIEW_EVENT, handler);
  return () => window.removeEventListener(AGENT_DOCK_FILE_PREVIEW_EVENT, handler);
}
