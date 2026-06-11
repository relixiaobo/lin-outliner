import type { CSSProperties } from 'react';

type AgentIdentityAvatarSize = 'sm' | 'md';

interface AgentIdentityAvatarProps {
  id: string;
  label: string;
  mention?: string | null;
  size?: AgentIdentityAvatarSize;
}

export function AgentIdentityAvatar({
  id,
  label,
  mention = null,
  size = 'sm',
}: AgentIdentityAvatarProps) {
  const initial = identityInitial(label, mention ?? undefined);
  const hue = identityHue(id || mention || label || 'agent');
  return (
    <span
      aria-hidden="true"
      className={`agent-identity-avatar is-${size}`}
      style={{ '--agent-avatar-hue': `${hue}deg` } as CSSProperties}
    >
      {initial}
    </span>
  );
}

function identityInitial(label: string, mention?: string): string {
  const source = label.trim() || mention?.trim() || 'A';
  return source.slice(0, 1).toLocaleUpperCase();
}

function identityHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}
