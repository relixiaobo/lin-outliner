import { useEffect, useState } from 'react';
import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';
import { useT } from '../../i18n/I18nProvider';
import { ClickIcon, ICON_SIZE } from '../../ui/icons';
import type { DocumentIndex } from '../../state/document';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import { threadStore, useThreadTurns } from '../store/threadStore';
import { subagentSpeakerName, type SubagentDelivery } from '../subagentPresentation';
import { ThreadMarkdown } from './ThreadMarkdown';
import {
  ExecutionFallbackWarning,
  generationReceiptDelivery,
  generationReceiptStatus,
} from './SubagentChip';
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
  const receipt = entry?.generationReceipts.get(delivery.generation) ?? null;
  const parentEntry = useSubagentEntry(receipt?.parentThreadId ?? null);
  // This card needs one Agent's Turns, not the whole store: subscribed to the
  // snapshot it re-rendered — and re-parsed its markdown — on every streaming
  // delta in the conversation around it.
  const turns = useThreadTurns(delivery.agentId);
  const loaded = turns !== undefined;
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    // Once, per Agent. Loaded history stays current through notifications, and
    // a conversation with thirty delivered results otherwise opened thirty
    // history reads every time it was rendered.
    if (loaded) return;
    setUnreachable(false);
    // A read that FAILS — a child retired while its execution record survived,
    // or an IPC failure — leaves nothing to load and nothing to retry, since
    // these deps cannot change again. Swallowed, the card said `Loading` for
    // the rest of the session over a result the reader could not reach any
    // other way.
    void threadStore.ensureThreadHistory(delivery.agentId).catch(() => setUnreachable(true));
  }, [delivery.agentId, loaded]);

  if (!entry) return null;
  // Stop ownership belongs to this generation receipt. The stable Agent may
  // already be running again, but that cannot erase who ended this report.
  if (receipt?.stopProvenance === 'user') {
    return (
      <div className="thread-item thread-agent-report-shell">
        <div className="thread-agent-note">
          <span>{t.agent.thread.agent.stoppedNote({ name: entry.displayName })}</span>
        </div>
        {entry.executionSelectionFallback ? (
          <ExecutionFallbackWarning agentType={entry.agentType} />
        ) : null}
      </div>
    );
  }
  const reported = receipt === null
    ? undefined
    : turns?.find((candidate) => candidate.id === receipt.turnId);
  const report = reported ? turnTerminalAnswer(reported.items) : '';
  const parentName = parentEntry?.displayName ?? t.agent.thread.agent.main;
  // Duration already belongs to the report's speaker metadata. Repeating it in
  // the card would make one immutable generation fact look like two statuses.
  const status = receipt === null ? null : generationReceiptStatus(receipt, t, false);
  const deliveryStatus = receipt === null ? null : generationReceiptDelivery(receipt, parentName, t);
  const partial = receipt?.partialOutputAvailable && receipt.terminalStatus !== 'finished'
    ? t.agent.thread.agent.partialOutputAvailable
    : null;
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
        {status === null ? null : (
          <p className={`thread-agent-report-status thread-agent-report-status-${receipt!.terminalStatus}`}>
            {[status, deliveryStatus, partial].filter(Boolean).join(' · ')}
          </p>
        )}
        <div className="thread-agent-report-body">
          {report ? (
            <ThreadMarkdown index={index} onNodeReferenceOpen={onOpenNodeReference} text={report} />
          ) : (
            <p className="thread-agent-report-empty">
              {turns === undefined && !unreachable
                ? t.agent.thread.loading
                : t.agent.thread.agent.reportUnavailable}
            </p>
          )}
        </div>
      </div>
      {entry.executionSelectionFallback ? (
        <ExecutionFallbackWarning agentType={entry.agentType} />
      ) : null}
      {/* The hint takes the slot the message actions hold everywhere else — the
          same height, the same row — so revealing it on hover moves nothing
          (B7) and a report ends exactly where any other message ends — the same
          height and the same glyph size as the copy and fork buttons a message
          carries there. The icon is a pointer, not a chevron: what this row
          teaches is that the card TAKES A CLICK, which is the thing a reader
          cannot see. */}
      <div className="thread-message-actions-slot">
        <div className="thread-message-actions">
          <span className="thread-agent-report-hint">
            <ClickIcon aria-hidden size={ICON_SIZE.menu} />
            <span>{t.agent.thread.agent.clickForDetails}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
