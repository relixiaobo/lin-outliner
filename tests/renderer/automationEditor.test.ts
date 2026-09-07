import { describe, expect, test } from 'bun:test';
import { toAutomationContextHintInput } from '../../src/renderer/agent/automations/AutomationEditor';

describe('AutomationEditor protocol boundaries', () => {
  test('strips UI-only context hint row ids before submission', () => {
    const input = toAutomationContextHintInput({
      id: 'ui-row-id',
      contextHintId: '01920000-0000-7000-8000-000000000001',
      executionMode: 'local',
    }, '/Users/developer/project');

    expect(input).toEqual({
      contextHintId: '01920000-0000-7000-8000-000000000001',
      source: { kind: 'directory', rootHint: '/Users/developer/project' },
      executionMode: 'local',
    });
    expect(input).not.toHaveProperty('id');
  });

  test('omits an empty persisted id for newly added rows', () => {
    const input = toAutomationContextHintInput({ id: 'ui-only', executionMode: 'worktree' }, '/tmp/project');
    expect(input).toEqual({
      source: { kind: 'directory', rootHint: '/tmp/project' },
      executionMode: 'worktree',
    });
  });
});
