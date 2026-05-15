import type { PointerEvent as ReactPointerEvent } from 'react';
import { AgentChatPanel } from './agent/AgentChatPanel';
import { ResizeHandle } from './primitives/ResizeHandle';

interface AgentDockProps {
  onOpenDebugPanel: (sessionId: string | null) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function AgentDock(props: AgentDockProps) {
  return (
    <aside className="agent-dock" aria-label="Agent">
      <AgentChatPanel onOpenDebugPanel={props.onOpenDebugPanel} />
      <ResizeHandle
        className="dock-resize-handle agent-resize-handle"
        label="Resize agent"
        onPointerDown={props.onResizeStart}
        title="Resize agent"
      />
    </aside>
  );
}
