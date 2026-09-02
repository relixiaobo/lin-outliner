import { describe, expect, test } from 'bun:test';
import { settingsOpenTargetFromSearch, settingsTargetPath } from '../../src/core/settingsWindow';

describe('settings window query routing', () => {
  test('routes the three categories', () => {
    for (const category of ['general', 'agent', 'preview'] as const) {
      expect(settingsOpenTargetFromSearch(`?surface=settings&category=${category}`)).toEqual({ category });
    }
  });

  test('routes a sub-page in path form, and names the category that owns it', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agent/skills')).toEqual({
      category: 'agent',
      page: 'skills',
    });
    expect(settingsOpenTargetFromSearch('?surface=settings&category=general/about')).toEqual({
      category: 'general',
      page: 'about',
    });
  });

  test('a page claimed by the wrong category does not route', () => {
    // `skills` is an Agent page; asking General for it is a malformed link, not a
    // reason to land somewhere plausible.
    expect(settingsOpenTargetFromSearch('?surface=settings&category=general/skills')).toEqual({});
  });

  test('the retired ids are gone, not aliased', () => {
    // `providers`, `security`, and `skills`-as-a-category were replaced when the
    // rail was re-cut. Exactly one in-app caller ever passed a category and no
    // link is persisted anywhere, so an alias would be permanent weight for a
    // migration nobody needs — the same call `permissions` got before them.
    for (const retired of ['providers', 'security', 'skills', 'permissions']) {
      expect(settingsOpenTargetFromSearch(`?surface=settings&category=${retired}`)).toEqual({});
    }
  });

  test('carries an anchor so a deep link can land on its group', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agent&anchor=memory')).toEqual({
      category: 'agent',
      anchor: 'memory',
    });
    // An anchor alone routes nowhere: it qualifies a destination, it is not one.
    expect(settingsOpenTargetFromSearch('?surface=settings&anchor=memory')).toEqual({});
  });

  test('carries a bounded Agent type only for the Agents page', () => {
    expect(settingsOpenTargetFromSearch(
      '?surface=settings&category=agent/agents&agent=custom_reviewer',
    )).toEqual({
      category: 'agent',
      page: 'agents',
      agentType: 'custom_reviewer',
    });
    expect(settingsOpenTargetFromSearch(
      '?surface=settings&category=agent/skills&agent=custom_reviewer',
    )).toEqual({ category: 'agent', page: 'skills' });
    for (const agentType of ['', '-leading', 'contains space', 'a'.repeat(65), 'x&category=general']) {
      expect(settingsOpenTargetFromSearch(
        `?surface=settings&category=agent/agents&agent=${encodeURIComponent(agentType)}`,
      )).toEqual({ category: 'agent', page: 'agents' });
    }
  });

  test('rejects anchors that cannot be used as bounded selector slugs', () => {
    for (const anchor of ['UPPERCASE', '-leading', 'contains space', 'a'.repeat(65), 'x\"] .inset-card']) {
      expect(settingsOpenTargetFromSearch(`?surface=settings&category=agent&anchor=${encodeURIComponent(anchor)}`))
        .toEqual({ category: 'agent' });
    }
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agent&anchor=agent-access')).toEqual({
      category: 'agent',
      anchor: 'agent-access',
    });
  });

  test('ignores unknown categories and unrelated detail parameters', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=unknown&detail=create')).toEqual({});
    expect(settingsOpenTargetFromSearch('?surface=settings&category=agent&detail=create')).toEqual({
      category: 'agent',
    });
  });

  test('builds the path a link carries', () => {
    expect(settingsTargetPath({ category: 'agent' })).toBe('agent');
    expect(settingsTargetPath({ category: 'agent', page: 'skills' })).toBe('agent/skills');
    // The page names its own category, so a caller cannot mislabel one.
    expect(settingsTargetPath({ category: 'general', page: 'services' })).toBe('agent/services');
  });
});
