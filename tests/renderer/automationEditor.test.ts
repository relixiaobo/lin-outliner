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

  test('preserves the stable slot identity when selecting a Project source', () => {
    expect(toAutomationContextHintInput({ id: 'ui-only', contextHintId: '01920000-0000-7000-8000-000000000001',
      projectId: '01920000-0000-7000-8000-000000000002', executionMode: 'local' }, '/ignored')).toEqual({
      contextHintId: '01920000-0000-7000-8000-000000000001',
      source: { kind: 'project', projectId: '01920000-0000-7000-8000-000000000002' }, executionMode: 'local',
    });
  });

  test('omits an empty persisted id for newly added rows', () => {
    const input = toAutomationContextHintInput({ id: 'ui-only', executionMode: 'worktree' }, '/tmp/project');
    expect(input).toEqual({
      source: { kind: 'directory', rootHint: '/tmp/project' },
      executionMode: 'worktree',
    });
  });
});
