import type { ReactNode } from 'react';
import type { AppIcon } from '../icons';
import {
  ChevronDownIcon,
  ChevronRightIcon,
} from '../icons';

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
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className={`agent-tool-call is-${status}`}>
      <div className="agent-tool-call-row">
        <button
          aria-expanded={expanded}
          className="agent-tool-call-toggle"
          disabled={!hasDetails}
          onClick={onToggle}
          type="button"
        >
          <Chevron className="agent-tool-call-chevron" size={12} />
          <StatusIcon className={statusIconClassName} size={14} />
          <span>{summary}</span>
        </button>
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
