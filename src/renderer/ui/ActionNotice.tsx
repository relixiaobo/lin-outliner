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
 */
export function nextActionNotice(
  current: ActionNoticeState | null,
  message: string | null,
): ActionNoticeState | null {
  return message === null ? null : { message, seq: (current?.seq ?? 0) + 1 };
}

export function ActionNotice({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  const t = useT();
  const [held, setHeld] = useState(false);
  // The timer must not depend on the callback's identity. This renders inside
  // the app shell, which re-renders on every keystroke in the outliner; an
  // unmemoized `onDismiss` would restart the countdown on each one and the
  // notice would never leave.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (held) return undefined;
    const timer = window.setTimeout(() => dismissRef.current(), ACTION_NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [held]);

  return (
    <div
      className="action-notice"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      role="alert"
    >
      <span>{message}</span>
      <ButtonControl
        aria-label={t.shell.errorDismiss}
        className="action-notice-close"
        onClick={onDismiss}
      >
        <CloseIcon size={ICON_SIZE.menu} />
      </ButtonControl>
    </div>
  );
}
