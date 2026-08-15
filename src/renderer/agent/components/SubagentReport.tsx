import { useEffect } from 'react';
import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';
import { useT } from '../../i18n/I18nProvider';
import { ChevronRightIcon, ICON_SIZE } from '../../ui/icons';
import type { DocumentIndex } from '../../state/document';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { threadStore, useThreadStore } from '../store/threadStore';
import type { SubagentDelivery } from '../subagentPresentation';
import { ThreadMarkdown } from './ThreadMarkdown';
import { UserMessageCollapsibleContent, type ThreadDisclosureState } from './items/ThreadItemView';
import { useSubagentActions, useSubagentEntry } from './SubagentRegistryContext';

/**
 * What an Agent reported back, where it arrived.
 *
 * A delegated result reaches the conversation as a host-authored continuation:
 * the model reads a task notification and carries on. That notification is
 * framing addressed to the model, never a message to the reader, so it is not
 * what is shown. What is shown is the Agent's own report — as a MESSAGE from
 * that Agent, in the same bubble every other message in this stream wears.
 *
 * Position is identity: it sits opposite the reader, under the avatar and name
 * of the Agent that sent it, exactly as any other participant's message does.
 * Rendered as a row instead — a pill among the tool rows — it read as one more
 * thing the Turn did rather than as somebody speaking, which is the one thing
 * this anchor exists to say.
 *
 * It never wears the reader's own bubble. Agent output is untrusted content by
 * contract — it cannot answer a question, approve a plan, or grant authority —
 * and a surface that let it look like the reader's own words would be the first
 * step in exactly the laundering the protocol refuses.
 *
 * Long reports fold to a few lines behind the same Show more as any long
 * message, so the conversation stays the narrative: what must be read is the
 * main agent's prose below, and the rest is depth on request.
 */
export function SubagentReport({
  delivery,
  expandState,
  index,
  onOpenNodeReference,
}: {
  readonly delivery: SubagentDelivery;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
}) {
  const t = useT();
  const entry = useSubagentEntry(delivery.agentId);
  const actions = useSubagentActions();
  const snapshot = useThreadStore();

  useEffect(() => {
    void threadStore.ensureThreadHistory(delivery.agentId).catch(() => undefined);
  }, [delivery.agentId]);

  if (!entry) return null;
  // A user-stopped Agent gets a note instead: the conversation continued
  // because the reader ended it, which is not a result arriving.
  if (entry.stoppedByUser) {
    return (
      <div className="thread-item thread-agent-note">
        <span>{t.agent.thread.agent.stoppedNote({ name: entry.displayName })}</span>
      </div>
    );
  }

  const turns = snapshot.turnsByThread.get(delivery.agentId);
  // The Nth delivery is the Nth run; a history that has not caught up yet falls
  // back to the newest, which is the only run it can honestly show.
  const reported = turns?.[delivery.generationIndex] ?? turns?.at(-1);
  const report = reported ? turnTerminalAnswer(reported.items) : '';
  return (
    <article className="thread-item thread-user-message thread-host-event thread-agent-report">
      <div className="thread-user-content-sequence">
        <UserMessageCollapsibleContent expandState={expandState} measureKey={report}>
          {report ? (
            <ThreadMarkdown index={index} onNodeReferenceOpen={onOpenNodeReference} text={report} />
          ) : (
            <p className="thread-agent-report-empty">
              {turns === undefined ? t.agent.thread.loading : t.agent.thread.agent.reportUnavailable}
            </p>
          )}
        </UserMessageCollapsibleContent>
      </div>
      <button
        className="thread-agent-report-open"
        onClick={() => actions.openAgent(delivery.agentId)}
        type="button"
      >
        <span>{t.agent.thread.agent.details}</span>
        <ChevronRightIcon aria-hidden size={ICON_SIZE.tiny} />
      </button>
    </article>
  );
}
