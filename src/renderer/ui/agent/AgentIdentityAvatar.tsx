type AgentIdentityAvatarSize = 'xs' | 'sm' | 'md';

interface AgentIdentityAvatarProps {
  label: string;
  mention?: string | null;
  size?: AgentIdentityAvatarSize;
}

export function AgentIdentityAvatar({
  label,
  mention = null,
  size = 'sm',
}: AgentIdentityAvatarProps) {
  const initial = identityInitial(label, mention ?? undefined);
  return (
    <span
      aria-hidden="true"
      className={`agent-identity-avatar is-${size}`}
    >
      {initial}
    </span>
  );
}

function identityInitial(label: string, mention?: string): string {
  const source = label.trim() || mention?.trim() || 'A';
  return source.slice(0, 1).toUpperCase();
}
