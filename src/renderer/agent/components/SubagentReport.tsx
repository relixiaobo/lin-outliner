import { useEffect } from 'react';
import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';
import { useT } from '../../i18n/I18nProvider';
import type { DocumentIndex } from '../../state/document';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { threadStore, useThreadStore } from '../store/threadStore';
import { subagentSpeakerName, type SubagentDelivery } from '../subagentPresentation';
import { ThreadMarkdown } from './ThreadMarkdown';
import { useSubagentActions, useSubagentEntry } from './SubagentRegistryContext';

/**
 * What an Agent reported back, where it arrived.
 *
 * A delegated result reaches the conversation as a host-authored continuation:
 * the model reads a task notification and carries on. That notification is
 * framing addressed to the model, never a message to the reader, so it is not
 * what is shown. What is shown is the Agent's own report — as a MESSAGE from
 * that Agent, under its avatar and name like anything else anyone says here.
 *
 * It is an OUTLINED CARD rather than prose, because it is not part of this
 * conversation's narrative: it is a self-contained thing brought back from
 * somewhere else, which the reader may open. An outline says that; a fill would
 * shout it, and bare prose would hide it. Rendered as a row instead — a pill
 * among the tool rows — it read as one more thing the Turn did rather than as
 * somebody speaking, which is the one thing this anchor exists to say.
 *
 * The WHOLE CARD is the control. A preview of something you can open should
 * open when you click it, rather than hiding that behind a link in its corner;
 * and once the card opens the full transcript, an in-place Show more is a
 * second, weaker way to read the same thing. The body is clamped and faded
 * instead, which is what a preview looks like. Content inside takes no pointer
 * events, so there is exactly one thing a click on this card can mean.
 *
 * It never wears the reader's own bubble. Agent output is untrusted content by
 * contract — it cannot answer a question, approve a plan, or grant authority —
 * and a surface that let it look like the reader's own words would be the first
 * step in exactly the laundering the protocol refuses.
 */
export function SubagentReport({
  delivery,
  index,
  onOpenNodeReference,
}: {
  readonly delivery: SubagentDelivery;
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
  // The task it was handed, over what it answered. Suppressed when the speaker
  // above is already saying it — an Agent with no type falls back to its task
  // description for a name, and printing one sentence twice is not a heading.
  const task = entry.displayName === subagentSpeakerName(entry) ? null : entry.displayName;
  const open = () => actions.openAgent(delivery.agentId);
  return (
    <div className="thread-item thread-agent-report-shell">
      <div
        aria-label={t.agent.thread.agent.openAgent({ name: entry.displayName })}
        className="thread-agent-report"
        onClick={open}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open();
        }}
        role="button"
        tabIndex={0}
      >
        {task === null ? null : <p className="thread-agent-report-task">{task}</p>}
        <div className="thread-agent-report-body">
          {report ? (
            <ThreadMarkdown index={index} onNodeReferenceOpen={onOpenNodeReference} text={report} />
          ) : (
            <p className="thread-agent-report-empty">
              {turns === undefined ? t.agent.thread.loading : t.agent.thread.agent.reportUnavailable}
            </p>
          )}
        </div>
      </div>
      {/* The hint takes the slot the message actions hold everywhere else, so
          revealing it on hover moves nothing (B7). */}
      <div className="thread-message-actions-slot">
        <div className="thread-message-actions">
          <span className="thread-agent-report-hint">{t.agent.thread.agent.clickForDetails}</span>
        </div>
      </div>
    </div>
  );
}
