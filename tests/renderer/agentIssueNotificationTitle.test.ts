import { describe, expect, test } from 'bun:test';
import { issueNotificationDisplayTitle } from '../../src/renderer/agent/issueNotificationTitle';

describe('issueNotificationDisplayTitle', () => {
  test('keeps a structured Issue title unchanged', () => {
    expect(issueNotificationDisplayTitle('Compile the report', 'complete')).toBe('Compile the report');
  });

  test('extracts the Issue title from existing terminal summaries', () => {
    expect(issueNotificationDisplayTitle('Issue "Compile the report" completed.', 'complete'))
      .toBe('Compile the report');
    expect(issueNotificationDisplayTitle('Issue "Compile the report" was canceled.', 'canceled'))
      .toBe('Compile the report');
    expect(issueNotificationDisplayTitle(
      'Agent Session for Issue "Compile the report" failed; the Issue remains open.',
      'error',
    )).toBe('Compile the report');
  });
});
