import { describe, expect, test } from 'bun:test';
import { settingsOpenTargetFromSearch } from '../../src/core/settingsWindow';

describe('settings window query routing', () => {
  test('routes Security through the capability-era category id only', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=security')).toEqual({
      category: 'security',
    });
    expect(settingsOpenTargetFromSearch('?surface=settings&category=permissions')).toEqual({});
  });

  test('ignores unknown categories and unrelated detail parameters', () => {
    expect(settingsOpenTargetFromSearch('?surface=settings&category=unknown&detail=create')).toEqual({});
    expect(settingsOpenTargetFromSearch('?surface=settings&category=skills&detail=create')).toEqual({
      category: 'skills',
    });
  });
});
