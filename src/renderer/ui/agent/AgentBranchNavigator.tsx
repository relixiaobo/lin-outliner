import type { AgentMessageBranchState } from '../../../core/agentTypes';
import {
  BackIcon,
  ForwardIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';

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
  if (!branches || branches.ids.length <= 1) return null;

  const canGoPrev = !disabled && branches.currentIndex > 0;
  const canGoNext = !disabled && branches.currentIndex < branches.ids.length - 1;

  return (
    <div className="agent-branch-navigator">
      <IconButton
        className="agent-message-action-button"
        disabled={!canGoPrev}
        icon={BackIcon}
        label="Show previous branch"
        onClick={() => canGoPrev && void onSwitchBranch?.(branches.ids[branches.currentIndex - 1]!)}
        title="Previous branch"
        variant="message"
      />
      <span className="agent-branch-counter">
        {branches.currentIndex + 1}/{branches.ids.length}
      </span>
      <IconButton
        className="agent-message-action-button"
        disabled={!canGoNext}
        icon={ForwardIcon}
        label="Show next branch"
        onClick={() => canGoNext && void onSwitchBranch?.(branches.ids[branches.currentIndex + 1]!)}
        title="Next branch"
        variant="message"
      />
    </div>
  );
}
