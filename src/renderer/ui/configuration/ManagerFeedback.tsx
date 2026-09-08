export function ManagerFeedback({ error, notice }: { error?: string | null; notice?: string | null }) {
  return error || notice ? <div className="agent-settings-feedback">
    {error ? <div className="agent-settings-alert" role="alert">{error}</div> : null}
    {notice ? <div className="agent-settings-notice" role="status">{notice}</div> : null}
  </div> : null;
}
