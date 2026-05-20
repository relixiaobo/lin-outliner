import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AgentChatPanel } from './agent/AgentChatPanel';
import { ResizeHandle } from './primitives/ResizeHandle';

interface AgentDockProps {
  onOpenDebugPanel: (sessionId: string | null) => void;
  onProviderSettingsOpenChange: (open: boolean) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  providerSettingsOpen: boolean;
}

export function AgentDock(props: AgentDockProps) {
  return (
    <aside className="agent-dock" aria-label="Agent">
      <AgentChatPanel
        onOpenDebugPanel={props.onOpenDebugPanel}
        onProviderSettingsOpenChange={props.onProviderSettingsOpenChange}
        providerSettingsOpen={props.providerSettingsOpen}
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
