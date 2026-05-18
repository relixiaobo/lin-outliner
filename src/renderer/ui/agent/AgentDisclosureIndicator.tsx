import type { ReactNode } from 'react';
import { ChevronDownIcon } from '../icons';

interface AgentDisclosureIndicatorProps {
  chevronSize?: number;
  className?: string;
  expanded: boolean;
  icon: ReactNode;
  interactive?: boolean;
  statusPersistent?: boolean;
}

export function AgentDisclosureIndicator({
  chevronSize = 14,
  className = '',
  expanded,
  icon,
  interactive = true,
  statusPersistent = false,
}: AgentDisclosureIndicatorProps) {
  return (
    <span
      className={[
        'agent-disclosure-indicator',
        interactive ? 'is-interactive' : '',
        expanded ? 'is-expanded' : '',
        statusPersistent ? 'is-status-persistent' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      <span className="agent-disclosure-status">{icon}</span>
      {interactive ? (
        <span className="agent-disclosure-chevron">
          <ChevronDownIcon
            className={expanded ? 'is-expanded' : ''}
            size={chevronSize}
          />
        </span>
      ) : null}
    </span>
  );
}
