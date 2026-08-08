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
  // Held ACROSS notices rather than reset per notice: this component is not
  // keyed on `seq`, because remounting would drop a hold the user is currently
  // relying on — the pointer resting on the control does not move, so no fresh
  // enter event would arrive to re-establish it.
  const [held, setHeld] = useState(false);
  // The timer must not depend on the callback's identity. This renders inside
  // the app shell, which re-renders on every keystroke in the outliner; an
  // unmemoized `onDismiss` would restart the countdown on each one and the
  // notice would never leave.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  // Where focus was before the notice took it, so dismissing the control does
  // not strand the user at <body> with their place in the outline lost.
  const focusOriginRef = useRef<Element | null>(null);

  useEffect(() => {
    if (held) return undefined;
    const timer = window.setTimeout(() => dismissRef.current(), ACTION_NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [held, seq]);

  const dismiss = () => {
    const origin = focusOriginRef.current;
    focusOriginRef.current = null;
    onDismiss();
    if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
  };

  return (
    <div className="action-notice" role="alert">
      <span>{message}</span>
      {/* The control is the only part that takes the pointer (the card itself
          is click-through), so hovering it is the whole of "hovering the
          notice" — and it is also what a reader reaches for, which is exactly
          when the text must not be yanked away.

          Focus holds too: without it the countdown would unmount the button
          under a keyboard user's focus ring mid-Tab, dropping them to <body>
          with no way back. */}
      <ButtonControl
        aria-label={t.shell.errorDismiss}
        className="action-notice-close"
        onBlur={() => setHeld(false)}
        onClick={dismiss}
        onFocus={(event) => {
          focusOriginRef.current = event.relatedTarget;
          setHeld(true);
        }}
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
      >
        <CloseIcon size={ICON_SIZE.menu} />
      </ButtonControl>
    </div>
  );
}
