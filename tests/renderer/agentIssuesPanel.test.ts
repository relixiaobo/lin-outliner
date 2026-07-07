import { describe, expect, test } from 'bun:test';
import { issueSearchInputForWorkPreset } from '../../src/renderer/ui/agent/AgentIssuesPanel';

describe('AgentIssuesPanel work presets', () => {
  test('translate UI tabs into canonical Issue filters', () => {
    expect(issueSearchInputForWorkPreset('triage')).toEqual({
      filter: { archived: false, confirmed: false },
      limit: 100,
    });
    expect(issueSearchInputForWorkPreset('scheduled')).toEqual({
      filter: { archived: false, statusCategories: ['scheduled'] },
      limit: 100,
    });
    expect(issueSearchInputForWorkPreset('activity')).toEqual({
      filter: { archived: false },
      include: ['activity-summary'],
      limit: 100,
    });
  });

  test('keeps active and completed lists scoped to concrete Issues', () => {
    expect(issueSearchInputForWorkPreset('active')).toMatchObject({
      targets: ['issue'],
      filter: {
        archived: false,
        statusCategories: ['triage', 'unstarted', 'started', 'blocked', 'attention-needed'],
      },
    });
    expect(issueSearchInputForWorkPreset('completed')).toMatchObject({
      targets: ['issue'],
      filter: {
        archived: false,
        statusCategories: ['completed', 'canceled'],
      },
    });
  });
});
