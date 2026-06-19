import type { ReactNode } from 'react';
import { ICON_SIZE, type AppIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentDisclosureIndicator } from './AgentDisclosureIndicator';

interface AgentToolCallDisclosureProps {
  attachments?: ReactNode;
  children: ReactNode;
  expanded: boolean;
  hasDetails: boolean;
  images: ReactNode;
  onToggle: (anchorElement?: HTMLElement | null) => void;
  status: 'pending' | 'done' | 'error';
  statusIcon: AppIcon;
  statusIconClassName?: string;
  summary: string;
}

export function AgentToolCallDisclosure({
  attachments,
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
          onClick={(event) => onToggle(event.currentTarget)}
        >
          <AgentDisclosureIndicator
            className="agent-tool-call-icon-slot"
            expanded={expanded}
            icon={<StatusIcon className={statusIconClassName} size={ICON_SIZE.menu} />}
            interactive={hasDetails}
          />
          <span className="agent-tool-call-summary">{summary}</span>
        </ButtonControl>
      </div>
      {images}
      {attachments}
      {expanded && hasDetails ? (
        <div className="agent-tool-call-panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}
