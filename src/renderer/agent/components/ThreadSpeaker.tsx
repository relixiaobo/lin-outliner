import { useCallback, useRef, type PointerEvent, type ReactNode } from 'react';
import type { ThreadId } from '../../../core/agent/protocol';
import { resolveAgentIdentity } from '../agentIdentity';
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
   * What the identity resolves from. The main conversation uses `main`.
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
 * Every non-reader block wears this, so the conversation agent and host-authored
 * messages share one clear speaker structure.
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
  threadId,
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
  /** The transcript whose cwd resolves the roster. */
  readonly threadId: ThreadId;
  /** The roster source; the app's own store unless a test says otherwise. */
  readonly source?: ThreadSnapshotSource;
}) {
  const catalog = useIdentityCatalog(threadId, source);
  // Resolve the configured main identity and retain the caller's name as a
  // fallback for host-authored participants.
  const identity = resolveAgentIdentity(catalog, speaker.avatarKey, speaker.name);
  // Gaze: the face turns toward the pointer while it crosses the HEADER — the
  // row is wide enough for the turn to read, where hovering only the 28px mark
  // would move the eyes by a hair. Events fire only over the header, so a
  // still pointer costs nothing anywhere else (A9).
  const markHandle = useRef<AgentMarkHandle>(null);
  // The mark's rect is measured ONCE per pointer entry, not per move: reading
  // it on every event forces a synchronous layout flush at pointer rate, and
  // in a streaming transcript that is the hot path (A9). It cannot move while
  // the pointer is inside without a scroll, which ends the hover anyway.
  const markRect = useRef<DOMRect | null>(null);
  const onPointerEnter = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const anchor = event.currentTarget.querySelector('.thread-speaker-avatar');
    markRect.current = anchor?.getBoundingClientRect() ?? null;
  }, []);
  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const rect = markRect.current;
    if (!rect) return;
    const unit = Math.max(rect.width, 1);
    markHandle.current?.setPointer(
      (event.clientX - (rect.left + rect.width / 2)) / unit,
      (event.clientY - (rect.top + rect.height / 2)) / unit,
    );
  }, []);
  const onPointerLeave = useCallback(() => {
    markRect.current = null;
    markHandle.current?.clearPointer();
  }, []);
  return (
    <div className="thread-speaker">
      <div
        className="thread-speaker-header"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
      >
        <span aria-hidden className="thread-speaker-avatar">
          <AgentMark mood={speaker.mood ?? 'idle'} ref={markHandle} size={28} tint={identity.tint} />
        </span>
        <div className="thread-speaker-identity">
          <div className="thread-speaker-title">
            <span className="thread-speaker-name">{identity.name}</span>
          </div>
          {meta}
        </div>
      </div>
      <div className="thread-speaker-content">{children}</div>
    </div>
  );
}
