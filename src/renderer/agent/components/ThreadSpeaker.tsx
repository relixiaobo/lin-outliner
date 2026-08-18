import { useCallback, useRef, type PointerEvent, type ReactNode } from 'react';
import { MAIN_IDENTITY_KEY, resolveAgentIdentity } from '../agentIdentity';
import type { MarkMood } from '../agentMarkGeometry';
import { useIdentityCatalog, type ThreadSnapshotSource } from '../store/threadStore';
import { AgentMark, type AgentMarkHandle } from './AgentMark';

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
   * What the identity resolves from: the Agent TYPE, or `main` for the
   * conversation's own agent. One type, one mark — everywhere, in every
   * conversation. It is not the displayed name, which is a persona the user
   * can rename; and it is not the participant, which would give two siblings
   * of one type the same NAME and different marks, and repaint an Agent on
   * the way into its own view.
   */
  readonly avatarKey: string;
  readonly name: string;
  /**
   * The state the mark's eyes express — working, needs-you, reported, stopped,
   * failed — supplied by the caller that knows it (the Turn, the registry
   * entry). Absent means awake and unhurried. Expressions restate what the
   * text beside them already says; they never say something it does not.
   */
  readonly mood?: MarkMood;
}

/**
 * One participant speaking, in the shape every message stream uses: a mark
 * and a name over what they said.
 *
 * The header is the identity mark beside TWO stacked lines — who this is, then what
 * they did — and the words below take the WHOLE column. Stacked rather than run
 * together because the second line grows: an elapsed time ticking up beside a
 * name squeezes the name at deck width, and the persona is the one thing here
 * that must never truncate. Full width rather than hung from the name because
 * an avatar lane is what a chat app spends on short bubbles, and what arrives
 * here is documents — tables, code, galleries — in the narrowest column this
 * app has. The lane's real prize is a visible change of speaker, and this
 * header already says that louder: a portrait, and a name in the content
 * register.
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
  const catalog = useIdentityCatalog(source);
  // Resolved from the TYPE the caller named, with the caller's own name as the
  // fallback: a participant that is not a type at all — an isolated Skill —
  // keeps the name it came with and simply has no persona to find.
  const identity = resolveAgentIdentity(catalog, speaker.avatarKey, speaker.name);
  // What it IS, beside what it is called — for DELEGATES only. The
  // conversation's own agent needs no label: there is exactly one of it, the
  // reader is talking to it, and `main` beside its name states the only thing
  // about this participant nobody was wondering. What the label answers is
  // "which kind of helper is this", a question only a delegate raises.
  //
  // A type appears verbatim because that IS the string a user configures and
  // passes as `subagent_type`. A Skill has no type line — its name already
  // says what it is.
  const roleLabel = speaker.avatarKey === MAIN_IDENTITY_KEY || !catalog.has(speaker.avatarKey)
    ? null
    : speaker.avatarKey;
  // Gaze: the face turns toward the pointer while it crosses the HEADER — the
  // row is wide enough for the turn to read, where hovering only the 28px mark
  // would move the eyes by a hair. Events fire only over the header, so a
  // still pointer costs nothing anywhere else (A9).
  const markHandle = useRef<AgentMarkHandle>(null);
  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const mark = markHandle.current;
    const header = event.currentTarget;
    const anchor = header.querySelector('.thread-speaker-avatar');
    if (!mark || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const unit = Math.max(rect.width, 1);
    mark.setPointer(
      (event.clientX - (rect.left + rect.width / 2)) / unit,
      (event.clientY - (rect.top + rect.height / 2)) / unit,
    );
  }, []);
  const onPointerLeave = useCallback(() => markHandle.current?.clearPointer(), []);
  return (
    <div className="thread-speaker">
      <div
        className="thread-speaker-header"
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
      >
        <span aria-hidden className="thread-speaker-avatar">
          <AgentMark mood={speaker.mood ?? 'idle'} ref={markHandle} size={28} tint={identity.tint} />
        </span>
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
