import { describe, expect, test } from 'bun:test';
import { settingsOpenTargetFromSearch } from '../../src/core/settingsWindow';

describe('settings window query routing', () => {
  test('routes Security through the capability-era category id only', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=security')).toEqual({
      category: 'security',
    });
    expect(settingsOpenTargetFromSearch('?surface=settings&category=permissions')).toEqual({});
  });

  test('treats a literal "create" agent param as an ordinary agent id', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agents&agent=create')).toEqual({
      category: 'agents',
      agentId: 'create',
    });
    // The one-Neva invariant removed the agent-create surface, so `agentMode` is
    // no longer recognized — only the category survives.
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agents&agentMode=create')).toEqual({
      category: 'agents',
    });
  });
});
