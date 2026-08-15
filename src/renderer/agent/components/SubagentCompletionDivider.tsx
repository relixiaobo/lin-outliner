import type { ThreadId } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { useSubagentActions, useSubagentEntry } from './SubagentRegistryContext';

/**
 * Why the agent just spoke.
 *
 * A background Agent's result reaches the conversation as a host-authored
 * continuation: the model reads a task notification and carries on. Without an
 * attribution the reader sees the conversation resume by itself, and with the
 * raw notification shown as a message they read a wall of host framing that was
 * never addressed to them. One muted line answers it, and its centre is the way
 * into the Agent — so reviewing a finished Agent never means scrolling back to
 * find where it was spawned.
 *
 * It says REPORTED BACK, not complete. This anchor marks delivery, and delivery
 * is not settlement: a terminal generation queues its notification, and the
 * parent materializes it at its next idle boundary — arbitrarily later, while it
 * is busy. `Completed` is the state word, and it is already the chip's; this
 * line needs the verb for the event that actually happened here, which is also
 * the delegation contract's own: the result is PUSHED to the delegator.
 */
export function SubagentCompletionDivider({ agentId }: { readonly agentId: ThreadId }) {
  const t = useT();
  const entry = useSubagentEntry(agentId);
  const actions = useSubagentActions();
  if (!entry) return null;
  // A user-stopped Agent gets its own note instead: the conversation continued
  // because the user ended it, which is not the same event as a result arriving.
  if (entry.stoppedByUser) {
    return (
      <div className="thread-item thread-agent-note">
        <span>{t.agent.thread.agent.stoppedNote({ name: entry.displayName })}</span>
      </div>
    );
  }
  return (
    <div className="thread-item thread-agent-divider">
      <span aria-hidden className="thread-agent-divider-rule" />
      <button
        className="thread-agent-divider-button"
        onClick={() => actions.openAgent(agentId)}
        type="button"
      >
        <span className="thread-agent-divider-label">
          {t.agent.thread.agent.completion({ name: entry.displayName })}
        </span>
        <span aria-hidden className="thread-agent-divider-separator">·</span>
        <span className="thread-agent-divider-action">{t.agent.thread.agent.details}</span>
      </button>
      <span aria-hidden className="thread-agent-divider-rule" />
    </div>
  );
}
