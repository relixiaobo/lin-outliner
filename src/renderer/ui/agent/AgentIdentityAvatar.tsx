import { agentAvatarTintIndex } from './agentAvatarColor';

type AgentIdentityAvatarSize = 'xs' | 'sm' | 'md';

interface AgentIdentityAvatarProps {
  label: string;
  mention?: string | null;
  size?: AgentIdentityAvatarSize;
  /**
   * Stable identity key the tint hashes on; defaults to the mention token (then
   * the label). Pass the agentId where available for a key that survives a rename.
   */
  colorKey?: string | null;
}

export function AgentIdentityAvatar({
  label,
  mention = null,
  size = 'sm',
  colorKey,
}: AgentIdentityAvatarProps) {
  const initial = identityInitial(label, mention ?? undefined);
  // No tint class for an unkeyed avatar (-1) → the CSS keeps the neutral fill.
  const tint = agentAvatarTintIndex(colorKey ?? mention ?? label);
  const tintClass = tint >= 0 ? ` is-tint-${tint}` : '';
  return (
    <span
      aria-hidden="true"
      className={`agent-identity-avatar is-${size}${tintClass}`}
    >
      {initial}
    </span>
  );
}

function identityInitial(label: string, mention?: string): string {
  const source = label.trim() || mention?.trim() || 'A';
  return source.slice(0, 1).toUpperCase();
}
