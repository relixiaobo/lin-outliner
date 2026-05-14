import type { PointerEvent as ReactPointerEvent } from 'react';
import { AgentChatPanel } from './agent/AgentChatPanel';

interface AgentDockProps {
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function AgentDock(props: AgentDockProps) {
  return (
    <aside className="agent-dock" aria-label="Agent">
      <AgentChatPanel />
      <button
        aria-label="Resize agent"
        className="dock-resize-handle agent-resize-handle"
        onPointerDown={props.onResizeStart}
        title="Resize agent"
        type="button"
      />
    </aside>
  );
}
