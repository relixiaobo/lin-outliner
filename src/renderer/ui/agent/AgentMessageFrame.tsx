import type { ReactNode } from 'react';
import { WarningIcon } from '../icons';

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
  return (
    <span
      aria-label={labelled ? 'Assistant is responding' : undefined}
      className="agent-streaming-capsule"
    />
  );
}

export function AgentStreamingIndicator() {
  return (
    <div className="agent-streaming-indicator" aria-label="Assistant is responding">
      <AgentStreamingCapsule />
    </div>
  );
}

export function AgentMessageError({ message }: { message: string }) {
  return (
    <div className="agent-message-error">
      <WarningIcon size={14} />
      <span>{message}</span>
    </div>
  );
}
