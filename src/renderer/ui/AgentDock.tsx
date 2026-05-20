import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentUserViewContext } from '../../core/agentTypes';
import { AgentChatPanel } from './agent/AgentChatPanel';
import { ResizeHandle } from './primitives/ResizeHandle';

interface AgentDockProps {
  userViewContext: AgentUserViewContext;
  onOpenDebugPanel: (sessionId: string | null) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function AgentDock(props: AgentDockProps) {
  return (
    <aside className="agent-dock" aria-label="Agent">
      <AgentChatPanel
        userViewContext={props.userViewContext}
        onOpenDebugPanel={props.onOpenDebugPanel}
      />
      <ResizeHandle
        className="dock-resize-handle agent-resize-handle"
        label="Resize agent"
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
        title="Resize agent"
      />
    </aside>
  );
}
