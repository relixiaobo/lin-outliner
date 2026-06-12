import type { MouseEventHandler, ReactNode } from 'react';
import { ICON_SIZE, WarningIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';

export function AgentMessageFrame({
  children,
  highlighted = false,
  messageId,
  onContextMenu,
  role,
}: {
  children: ReactNode;
  highlighted?: boolean;
  messageId?: string | null;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  role: 'assistant' | 'user';
}) {
  return (
    <div
      className={`agent-message-row ${role}${highlighted ? ' is-highlighted' : ''}`}
      data-agent-message-id={messageId ?? undefined}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
}

export function AgentMessageActions({
  assistant = false,
  children,
}: {
  assistant?: boolean;
  children: ReactNode;
}) {
  const className = assistant ? 'agent-message-actions is-assistant' : 'agent-message-actions';
  return (
    <div className={className}>
      {children}
    </div>
  );
}

export function AgentAssistantContent({ children }: { children: ReactNode }) {
  return <div className="agent-assistant-content">{children}</div>;
}

export function AgentStreamingCapsule({ labelled = false }: { labelled?: boolean }) {
  const t = useT();
  // "Still generating" mark: an SVG whose `d` morphs triangle -> square -> circle
  // (rounded corners throughout) — see `.agent-streaming-capsule` in CSS. The path
  // is decorative; the wrapper / aria-label carries the meaning.
  return (
    <svg
      aria-hidden={labelled ? undefined : true}
      aria-label={labelled ? t.agent.message.assistantResponding : undefined}
      className="agent-streaming-capsule"
      role={labelled ? 'img' : undefined}
      viewBox="0 0 48 48"
    >
      <defs>
        <linearGradient className="agent-shape-grad" id="agentShapeFill" x1="0" x2="0" y1="0" y2="1">
          <stop className="agent-shape-stop-0" offset="0%" />
          <stop className="agent-shape-stop-1" offset="55%" />
          <stop className="agent-shape-stop-2" offset="100%" />
        </linearGradient>
      </defs>
      <path />
    </svg>
  );
}

export function AgentStreamingIndicator() {
  const t = useT();
  return (
    <div className="agent-streaming-indicator" aria-label={t.agent.message.assistantResponding}>
      <AgentStreamingCapsule />
    </div>
  );
}

export function AgentMessageError({ message }: { message: string }) {
  return (
    <div className="agent-message-error">
      <WarningIcon size={ICON_SIZE.menu} />
      <span>{message}</span>
    </div>
  );
}
