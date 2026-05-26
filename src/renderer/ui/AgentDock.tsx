import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentUserViewContext } from '../../core/agentTypes';
import type { DocumentIndex } from '../state/document';
import { AgentChatPanel } from './agent/AgentChatPanel';
import type { AgentNodeReferenceOpenHandler } from './agent/AgentInlineReferenceText';
import { ResizeHandle } from './primitives/ResizeHandle';

interface AgentDockProps {
  index: DocumentIndex;
  userViewContext: AgentUserViewContext;
  onOpenNodeReference: AgentNodeReferenceOpenHandler;
  onOpenDebugPanel: (sessionId: string | null) => void;
  onProviderSettingsOpenChange: (open: boolean) => void;
  providerSettingsRestoreFocus?: () => HTMLElement | null;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  providerSettingsOpen: boolean;
}

export function AgentDock(props: AgentDockProps) {
  return (
    <aside className="agent-dock" aria-label="Agent">
      <AgentChatPanel
        index={props.index}
        userViewContext={props.userViewContext}
        onOpenNodeReference={props.onOpenNodeReference}
        onOpenDebugPanel={props.onOpenDebugPanel}
        onProviderSettingsOpenChange={props.onProviderSettingsOpenChange}
        providerSettingsRestoreFocus={props.providerSettingsRestoreFocus}
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
