import { requestRevealChatSource, type AgentChatSourceRevealTarget } from '../../agent/agentReveal';
import {
  INLINE_CHAT_SOURCE_ICON_CLASS,
  INLINE_CHAT_SOURCE_LABEL_CLASS,
} from '../editor/inlineChatSourceIcon';

export function AgentChatSourceReference({
  className = 'inline-ref agent-message-inline-ref',
  href,
  label,
  target,
}: {
  className?: string;
  href: string;
  label: string;
  target: AgentChatSourceRevealTarget;
}) {
  return (
    <a
      className={className}
      data-inline-ref-kind="chat-source"
      data-inline-ref-chat-stream={target.stream}
      data-inline-ref-chat-stream-id={target.streamId}
      data-inline-ref-chat-from-seq-exclusive={target.range.fromSeqExclusive}
      data-inline-ref-chat-through-seq={target.range.throughSeq}
      data-inline-ref-chat-through-event-id={target.range.throughEventId ?? undefined}
      data-inline-ref-chat-from-created-at-inclusive={target.range.fromCreatedAtInclusive ?? undefined}
      data-inline-ref-chat-through-created-at-exclusive={target.range.throughCreatedAtExclusive ?? undefined}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void requestRevealChatSource(target);
      }}
    >
      <span aria-hidden="true" className={INLINE_CHAT_SOURCE_ICON_CLASS} />
      <span className={INLINE_CHAT_SOURCE_LABEL_CLASS}>{label}</span>
    </a>
  );
}
