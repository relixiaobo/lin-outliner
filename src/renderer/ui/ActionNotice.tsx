import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { CloseIcon, ICON_SIZE } from './icons';
import { ButtonControl } from './primitives/ButtonControl';

/**
 * "That didn't work" — for every action in the app, in one place.
 *
 * An outliner command, a palette command, a pane operation and an agent dock
 * action all fail the same way from the user's side: they asked for something
 * and it did not happen. So they report to one surface, anchored to the WINDOW
 * (top centre, below the chrome band that the pane breadcrumb owns) rather than
 * to whichever region raised it. The anchor is the whole point: the previous
 * one sat bottom-right, which is the agent dock's territory, so an outliner
 * failure read as the agent failing.
 *
 * What does NOT belong here: a condition that persists (a provider that is not
 * configured, a thread list that failed to load) belongs to the surface it
 * describes, because a notification can be dismissed and a condition cannot; a
 * failed Turn, tool row or automation run is part of a record and belongs in
 * the record. This surface is only ever the result of one action.
 *
 * It leaves on its own, because an event rendered as a permanent fixture makes
 * the user file it away as clutter rather than read it.
 */
export const ACTION_NOTICE_TIMEOUT_MS = 6_000;

export interface ActionNoticeState {
  readonly message: string;
  readonly seq: number;
}

/**
 * Sequenced so that repeating an action which fails the same way restarts the
 * countdown. Compared by value, the second attempt would inherit whatever was
 * left of the first one's and could vanish the instant it arrived — the user
 * would see their retry produce no feedback at all.
 *
 * The counter is the CALLER's and only ever climbs. Deriving it from the slot
 * being overwritten looks equivalent and is not: the slot is empty far more
 * often than not, so nearly every notice would be numbered 1, and a repeat of
 * the message already on screen would be indistinguishable from it — which is
 * precisely the case this exists to catch.
 */
export function nextActionNotice(message: string | null, seq: number): ActionNoticeState | null {
  // Blank is nothing to say, not something to say blankly: `new Error()` yields
  // an empty message, and a card with no text and a lone close button is worse
  // than staying quiet.
  const text = message?.trim() ?? '';
  return text === '' ? null : { message: text, seq };
}

export function ActionNotice({
  message,
  onDismiss,
  seq,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
  /** Changing this restarts the countdown; see `nextActionNotice`. */
  readonly seq: number;
}) {
  const t = useT();
  // Two independent reasons to wait, held ACROSS notices rather than reset per
  // notice: this component is not keyed on `seq`, because remounting would drop
  // a hold the user is currently relying on — a pointer already resting on the
  // card does not move, so no fresh event would arrive to re-establish it.
  const [pointerHeld, setPointerHeld] = useState(false);
  const [focusHeld, setFocusHeld] = useState(false);
  const held = pointerHeld || focusHeld;
  // The timer must not depend on the callback's identity. This renders inside
  // the app shell, which re-renders on every keystroke in the outliner; an
  // unmemoized `onDismiss` would restart the countdown on each one and the
  // notice would never leave.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  // Where focus was before the notice took it, so dismissing the control does
  // not strand the user at <body> with their place in the outline lost.
  const focusOriginRef = useRef<Element | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const rectRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    if (held) return undefined;
    const timer = window.setTimeout(() => dismissRef.current(), ACTION_NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [held, seq]);

  /**
   * Resting the pointer over the card waits, even though the card cannot
   * receive the pointer.
   *
   * Being click-through is not negotiable — the card floats over the outline's
   * first rows — but `:hover` and enter/leave events both need the element to
   * take the pointer, so the region is tested against the card's rect instead.
   * Restricting the hold to the close control would technically satisfy "hover
   * holds" while making it useless: a reader's pointer rests on the TEXT, and a
   * 22px target is one you have to aim for.
   *
   * The rect is cached because the card is `position: fixed` — it can only move
   * when the window resizes, when the message changes its size, or when the
   * entry animation's transform finishes (measuring at mount catches the card
   * mid-slide and would leave the region permanently offset).
   */
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const measure = () => { rectRef.current = card.getBoundingClientRect(); };
    measure();
    card.addEventListener('animationend', measure);
    window.addEventListener('resize', measure);
    return () => {
      card.removeEventListener('animationend', measure);
      window.removeEventListener('resize', measure);
    };
  }, [message, seq]);

  // Bound to the notice's own lifetime: the listener exists only while there is
  // something on screen to hold.
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const rect = rectRef.current;
      setPointerHeld(rect !== null
        && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom);
    };
    document.addEventListener('pointermove', onPointerMove);
    return () => document.removeEventListener('pointermove', onPointerMove);
  }, []);

  const dismiss = () => {
    const origin = focusOriginRef.current;
    focusOriginRef.current = null;
    onDismiss();
    if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
  };

  return (
    <div className="action-notice" ref={cardRef} role="alert">
      <span>{message}</span>
      {/* Focus is the other reason to wait, and it is not the pointer's: without
          it the countdown would unmount this button under a keyboard user's
          focus ring mid-Tab, dropping them to <body> with no way back. */}
      <ButtonControl
        aria-label={t.shell.errorDismiss}
        className="action-notice-close"
        onBlur={() => setFocusHeld(false)}
        onClick={dismiss}
        onFocus={(event) => {
          focusOriginRef.current = event.relatedTarget;
          setFocusHeld(true);
        }}
      >
        <CloseIcon size={ICON_SIZE.menu} />
      </ButtonControl>
    </div>
  );
}
