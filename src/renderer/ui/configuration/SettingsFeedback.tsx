export interface SettingsFeedbackState {
  readonly error?: string | null;
  readonly notice?: string | null;
}

/** Render at the operation's row, group, or dialog, never in a floating page banner. */
export function SettingsFeedback({ feedback }: { feedback?: SettingsFeedbackState | null }) {
  const message = feedback?.error || feedback?.notice;
  return message ? <div className={`settings-operation-feedback${feedback?.error ? ' is-error' : ''}`}
    role={feedback?.error ? 'alert' : 'status'} aria-atomic="true">{message}</div> : null;
}
