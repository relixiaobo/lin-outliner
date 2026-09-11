import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readRecentProjectIds, recentProjects, rememberProject } from '../../src/renderer/agent/projects/recentProjects';
import type { Project } from '../../src/core/agent/project';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
const project = (id: string): Project => ({ id, name: id, folders: [], primaryFolder: null, revision: 1, createdAt: 1, updatedAt: 1 });

describe('recent Project choices', () => {
  test('persists bounded recency, deduplicates and filters deleted Projects without treating edits as use', () => {
    for (let index = 0; index < 8; index++) rememberProject(String(index));
    rememberProject('3');
    expect(readRecentProjectIds()).toEqual(['3', '7', '6', '5', '4', '2']);
    const persisted = [...values.values()][0]!;
    values.clear(); values.set('tenon.recent-projects.v1', persisted);
    expect(recentProjects(['3', '5', '2', 'current'].map(project), 'current').map((entry) => entry.id)).toEqual(['current', '3', '5', '2']);
  });
  test('malformed or unavailable preference storage cannot break Project selection UI', () => {
    values.set('tenon.recent-projects.v1', '{bad');
    expect(readRecentProjectIds()).toEqual([]);
    values.set('tenon.recent-projects.v1', '["a",null,1,"a","b"]');
    expect(readRecentProjectIds()).toEqual(['a', 'b']);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('unavailable'); } });
    expect(() => rememberProject('c')).not.toThrow();
    expect(recentProjects([project('c')], 'c')).toEqual([project('c')]);
  });
});
