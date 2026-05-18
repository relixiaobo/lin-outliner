import type { ReactNode } from 'react';
import type { AppIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentDisclosureIndicator } from './AgentDisclosureIndicator';

interface AgentToolCallDisclosureProps {
  children: ReactNode;
  expanded: boolean;
  hasDetails: boolean;
  images: ReactNode;
  onToggle: () => void;
  status: 'pending' | 'done' | 'error';
  statusIcon: AppIcon;
  statusIconClassName?: string;
  summary: string;
}

export function AgentToolCallDisclosure({
  children,
  expanded,
  hasDetails,
  images,
  onToggle,
  status,
  statusIcon: StatusIcon,
  statusIconClassName,
  summary,
}: AgentToolCallDisclosureProps) {
  return (
    <div className={`agent-tool-call is-${status}`}>
      <div className="agent-tool-call-row">
        <ButtonControl
          aria-expanded={expanded}
          className="agent-tool-call-toggle"
          disabled={!hasDetails}
          onClick={onToggle}
        >
          <AgentDisclosureIndicator
            className="agent-tool-call-icon-slot"
            expanded={expanded}
            icon={<StatusIcon className={statusIconClassName} size={14} />}
            interactive={hasDetails}
          />
          <span className="agent-tool-call-summary">{summary}</span>
        </ButtonControl>
      </div>
      {images}
      {expanded && hasDetails ? (
        <div className="agent-tool-call-panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}
