import type { AgentIssueNotificationEntry } from '../../agent/runtime';
import { ChevronRightIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';

interface AgentIssueNotificationRowProps {
  entry: AgentIssueNotificationEntry;
  onOpenIssue: (issueId: string, title: string) => void;
}

export function AgentIssueNotificationRow({ entry, onOpenIssue }: AgentIssueNotificationRowProps) {
  const t = useT();
  const status = t.agent.issue.notification[entry.state];

  return (
    <div className="agent-issue-notification" role="note">
      <ButtonControl
        aria-label={t.agent.issue.notification.open({ status, title: entry.title })}
        className="agent-issue-notification-button"
        onClick={() => onOpenIssue(entry.issueId, entry.title)}
      >
        <span className="agent-issue-notification-copy">
          <span className="agent-issue-notification-title" title={entry.title}>{`"${entry.title}"`}</span>
          <span className="agent-issue-notification-status">{status}</span>
        </span>
        <ChevronRightIcon aria-hidden="true" className="agent-issue-notification-chevron" size={ICON_SIZE.menu} />
      </ButtonControl>
    </div>
  );
}
