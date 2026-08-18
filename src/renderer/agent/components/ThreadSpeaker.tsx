import type { ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { MAIN_IDENTITY_KEY, resolveAgentIdentity } from '../agentIdentity';
import { agentPortraitSvg } from '../agentPortraits';
import { useIdentityCatalog, type ThreadSnapshotSource } from '../store/threadStore';

/** Who said the block beneath: which participant, what it looks like, its name. */
export interface ThreadSpeaker {
  /**
   * WHICH participant this is — an Agent id, or `main`. Consecutive blocks
   * merge under one header only within a single participant, so this cannot be
   * the type: a `general-purpose` child inside a `general-purpose` parent would
   * swallow the brief its parent wrote into its own header, and wear its own
   * elapsed above someone else's words.
   */
  readonly participantId: string;
  /**
   * What the hue is derived from: the Agent TYPE, or `main` for the
   * conversation's own agent. One type, one avatar — everywhere, in every
   * conversation. It is not the displayed name, which is translated for `main`
   * and would repaint every disc when the language changed; and it is not the
   * participant, which gave two siblings of one type the same NAME and
   * different discs, and repainted an Agent on the way into its own view.
   */
  readonly avatarKey: string;
  readonly name: string;
}

/**
 * One participant speaking, in the shape every message stream uses: a portrait
 * and a name over what they said.
 *
 * The header is a portrait beside TWO stacked lines — who this is, then what
 * they did — and the words below hang from the NAME, sharing its left edge.
 * Stacked rather than run together because the second line grows: an elapsed
 * time ticking up beside a name squeezes the name at deck width, and the
 * persona is the one thing here that must never truncate. The portrait lane
 * costs a tenth of the reading measure in a 344px deck, which is only worth
 * paying because it carries a face: a portrait identifies a speaker before its
 * name is read, so the lane says something the header does not repeat. (It
 * deliberately reverses this component's first shape, where a 16px initial disc
 * sat over full-width text — an initial IS a restatement of the name, and paying
 * a margin for one was the wrong trade.) The measure that remains is what
 * mobile IM reads at, which is where this layout is proven.
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
  meta,
  source,
  speaker,
}: {
  readonly children: ReactNode;
  /**
   * What this participant did, on its own line under who they are: the Turn's
   * work summary for the transcript's own agent, a delegated child's own
   * elapsed for its report. Still one header and one control — the line that
   * says how long it took is the line that opens the timeline.
   */
  readonly meta?: ReactNode;
  readonly speaker: ThreadSpeaker;
  /** The roster to resolve against; the app's own store unless a test says otherwise. */
  readonly source?: ThreadSnapshotSource;
}) {
  const t = useT();
  const catalog = useIdentityCatalog(source);
  // Resolved from the TYPE the caller named, with the caller's own name as the
  // fallback: a participant that is not a type at all — an isolated Skill —
  // keeps the name it came with and simply has no persona to find.
  const identity = resolveAgentIdentity(catalog, speaker.avatarKey, speaker.name);
  const portrait = agentPortraitSvg(identity.avatarKey);
  // What it IS, beside what it is called. Present only when the participant is
  // a known type: `main` reads as a translated word because it is a role in
  // this conversation rather than a name a user types, and every other type
  // appears verbatim because that IS the string they configure and pass to
  // `subagent_type`. A Skill has no type line — its name already says it.
  const roleLabel = speaker.avatarKey === MAIN_IDENTITY_KEY
    ? t.agent.thread.agent.main
    : catalog.has(speaker.avatarKey) ? speaker.avatarKey : null;
  return (
    <div className="thread-speaker">
      <div className="thread-speaker-header">
        <span
          aria-hidden
          className="thread-speaker-avatar"
          // The disc colour rides along even under a portrait: it is what shows
          // if the portrait is missing, and what the initial sits on.
          style={portrait === undefined
            ? { background: identity.color.background, color: identity.color.text }
            : undefined}
          {...(portrait === undefined
            ? { children: identity.initial }
            // Vendored markup, not user content: these files are in the bundle.
            : { dangerouslySetInnerHTML: { __html: portrait } })}
        />
        <div className="thread-speaker-identity">
          <div className="thread-speaker-title">
            <span className="thread-speaker-name">{identity.name}</span>
            {roleLabel === null ? null : <span className="thread-speaker-role">{roleLabel}</span>}
          </div>
          {meta}
        </div>
      </div>
      <div className="thread-speaker-content">{children}</div>
    </div>
  );
}
