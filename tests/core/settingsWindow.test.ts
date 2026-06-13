import { describe, expect, test } from 'bun:test';
import { settingsOpenTargetFromSearch } from '../../src/core/settingsWindow';

describe('settings window query routing', () => {
  test('keeps create as a valid agent id and uses agentMode for creation', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agents&agent=create')).toEqual({
      category: 'agents',
      agentId: 'create',
    });
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agents&agentMode=create')).toEqual({
      category: 'agents',
      agentCreate: true,
    });
  });
});
