import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentUserViewContext } from '../../core/agentTypes';
import type { DocumentIndex } from '../state/document';
import { AgentChatPanel } from './agent/AgentChatPanel';
import type { AgentNodeReferenceOpenHandler } from './agent/AgentInlineReferenceText';
import { ResizeHandle } from './primitives/ResizeHandle';

// The agent rail is a 3-state surface (Motion → Rail unfurl):
//   collapsed — a bare icon seed at the top-right toggle footprint
//   chip      — the hover-revealed glass chip (CSS-only :hover, no React state)
//   open      — the full unfurled panel
// Only `collapsed` and `open` are driven by React; the chip is a pure :hover
// affordance so it never causes a remount. Crucially, AgentChatPanel is rendered
// in ALL states (never conditionally unmounted) so chat scroll + composer draft
// survive the unfurl — CSS hides/reveals the body via the rail-state classes.
export type AgentRailState = 'collapsed' | 'open';

interface AgentDockProps {
  index: DocumentIndex;
  railState: AgentRailState;
  userViewContext: AgentUserViewContext;
  onOpenNodeReference: AgentNodeReferenceOpenHandler;
  onOpenDebugPanel: (sessionId: string | null) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function AgentDock(props: AgentDockProps) {
  const open = props.railState === 'open';
  return (
    <aside
      className={`agent-dock agent-dock-${props.railState}`}
      data-rail-state={props.railState}
      aria-label="Agent"
      aria-hidden={open ? undefined : true}
    >
      <AgentChatPanel
        index={props.index}
        userViewContext={props.userViewContext}
        onOpenNodeReference={props.onOpenNodeReference}
        onOpenDebugPanel={props.onOpenDebugPanel}
      />
      {/* Resize handle is inert unless the rail is open (collapsed/chip have no
          resizable width). tabIndex -1 + pointer-events:none in CSS when closed. */}
      <ResizeHandle
        className="dock-resize-handle agent-resize-handle"
        disabled={!open}
        label="Resize agent"
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
        title="Resize agent"
      />
    </aside>
  );
}
