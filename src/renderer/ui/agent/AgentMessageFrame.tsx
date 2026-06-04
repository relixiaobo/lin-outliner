import type { ReactNode } from 'react';
import { ICON_SIZE, WarningIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';

export function AgentMessageFrame({
  children,
  role,
}: {
  children: ReactNode;
  role: 'assistant' | 'user';
}) {
  return <div className={`agent-message-row ${role}`}>{children}</div>;
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
  return (
    <span
      aria-label={labelled ? t.agent.message.assistantResponding : undefined}
      className="agent-streaming-capsule"
    />
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
