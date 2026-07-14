export type IssueNotificationState = 'complete' | 'error' | 'canceled';

const ISSUE_NOTIFICATION_SUMMARY_PATTERNS: Record<IssueNotificationState, RegExp> = {
  complete: /^Issue "(.*)" completed\.$/u,
  error: /^Agent Session for Issue "(.*)" failed; the Issue remains open\.$/u,
  canceled: /^Issue "(.*)" was canceled\.$/u,
};

export function issueNotificationDisplayTitle(title: string, state: IssueNotificationState): string {
  return ISSUE_NOTIFICATION_SUMMARY_PATTERNS[state].exec(title)?.[1]?.trim() || title;
}
