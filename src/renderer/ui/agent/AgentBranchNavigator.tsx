import type { AgentMessageBranchState } from '../../../core/agentTypes';
import {
  BackIcon,
  ForwardIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';
import { useT } from '../../i18n/I18nProvider';

interface AgentBranchNavigatorProps {
  branches: AgentMessageBranchState | null;
  disabled: boolean;
  onSwitchBranch?: (nodeId: string) => void | Promise<void>;
}

export function AgentBranchNavigator({
  branches,
  disabled,
  onSwitchBranch,
}: AgentBranchNavigatorProps) {
  const t = useT();
  if (!branches || branches.ids.length <= 1) return null;

  const canGoPrev = !disabled && branches.currentIndex > 0;
  const canGoNext = !disabled && branches.currentIndex < branches.ids.length - 1;

  return (
    <div className="agent-branch-navigator">
      <IconButton
        className="agent-message-action-button"
        disabled={!canGoPrev}
        icon={BackIcon}
        label={t.agent.message.showPreviousBranch}
        onClick={() => canGoPrev && void onSwitchBranch?.(branches.ids[branches.currentIndex - 1]!)}
        title={t.agent.message.previousBranch}
        variant="message"
      />
      <span className="agent-branch-counter">
        {branches.currentIndex + 1}/{branches.ids.length}
      </span>
      <IconButton
        className="agent-message-action-button"
        disabled={!canGoNext}
        icon={ForwardIcon}
        label={t.agent.message.showNextBranch}
        onClick={() => canGoNext && void onSwitchBranch?.(branches.ids[branches.currentIndex + 1]!)}
        title={t.agent.message.nextBranch}
        variant="message"
      />
    </div>
  );
}
