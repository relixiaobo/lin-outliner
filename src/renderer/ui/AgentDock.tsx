import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentUserViewContext } from '../../core/agentTypes';
import type { DocumentIndex } from '../state/document';
import { AgentChatPanel } from './agent/AgentChatPanel';
import type { AgentNodeReferenceOpenHandler } from './agent/AgentInlineReferenceText';
import { ResizeHandle } from './primitives/ResizeHandle';
import { useT } from '../i18n/I18nProvider';

// The agent rail is a 2-state surface:
//   collapsed — a bare icon seed at the top-right toggle footprint (hover feedback
//               lives on the window-chrome toggle, not a glass chip behind it)
//   open      — the full panel
// Crucially, AgentChatPanel is rendered in BOTH states (never conditionally
// unmounted) so chat scroll + composer draft survive — CSS hides/reveals the body
// via the rail-state classes.
export type AgentRailState = 'collapsed' | 'open';

interface AgentDockProps {
  index: DocumentIndex;
  railState: AgentRailState;
  userViewContext: AgentUserViewContext;
  onOpenNodeReference: AgentNodeReferenceOpenHandler;
  onOpenDebugPanel: (conversationId: string | null) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeReset: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function AgentDock(props: AgentDockProps) {
  const t = useT();
  const open = props.railState === 'open';
  return (
    <aside
      className={`agent-dock agent-dock-${props.railState}`}
      data-rail-state={props.railState}
      aria-label={t.shell.agentDock.ariaLabel}
      inert={open ? undefined : true}
    >
      <AgentChatPanel
        index={props.index}
        dockOpen={open}
        userViewContext={props.userViewContext}
        onOpenNodeReference={props.onOpenNodeReference}
        onOpenDebugPanel={props.onOpenDebugPanel}
      />
      {/* Resize handle is inert unless the rail is open (collapsed/chip have no
          resizable width). tabIndex -1 + pointer-events:none in CSS when closed. */}
      <ResizeHandle
        className="dock-resize-handle agent-resize-handle"
        disabled={!open}
        label={t.shell.agentDock.resizeLabel}
        onDoubleClick={props.onResizeReset}
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
        title={t.shell.agentDock.resizeTitle}
      />
    </aside>
  );
}
