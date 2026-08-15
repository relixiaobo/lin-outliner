import type { ReactNode } from 'react';
import { agentAvatarColor, agentAvatarInitial } from '../agentAvatarColor';

/** Who said the block beneath: the avatar's colour key, and the name shown. */
export interface ThreadSpeaker {
  /**
   * What the hue is derived from — an Agent id, or `main` for the
   * conversation's own agent. NOT the display name: two siblings a task
   * description named alike must still differ.
   */
  readonly identity: string;
  readonly name: string;
}

/**
 * One participant speaking, in the shape every message stream uses: an avatar
 * and a name over what they said.
 *
 * The header is ONE line and the words below it keep the full column. An avatar
 * lane down the margin is the familiar desktop-IM shape, but this deck is 344px
 * wide, where a 34px lane is a tenth of the reading measure spent on saying the
 * same thing the header already says.
 *
 * Every non-reader block wears this — the conversation's own agent, a delegated
 * child delivering a result, the Agent that wrote a brief. One structure for
 * everyone, so `main` answering and a Subagent reporting are visibly the same
 * kind of event: somebody spoke. Before this, `main` was unattributed prose and
 * a child's report was a labelled bubble, which made two participants look like
 * two different sorts of thing.
 *
 * The reader is the exception, and deliberately: their own messages keep the
 * right-hand bubble and no avatar. Position is the fastest identity signal in
 * the stream, and Tenon has no user profile to draw a face from.
 */
export function ThreadSpeakerGroup({
  children,
  speaker,
}: {
  readonly children: ReactNode;
  readonly speaker: ThreadSpeaker;
}) {
  const color = agentAvatarColor(speaker.identity);
  return (
    <div className="thread-speaker">
      <div className="thread-speaker-header">
        <span
          aria-hidden
          className="thread-speaker-avatar"
          style={{ background: color.background, color: color.text }}
        >
          {agentAvatarInitial(speaker.name)}
        </span>
        <span className="thread-speaker-name">{speaker.name}</span>
      </div>
      <div className="thread-speaker-content">{children}</div>
    </div>
  );
}
