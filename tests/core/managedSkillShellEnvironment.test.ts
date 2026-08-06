import { describe, expect, test } from 'bun:test';
import { ManagedSkillShellEnvironmentRegistry } from '../../src/main/managedSkillShellEnvironment';

describe('managed Skill shell environment registry', () => {
  test('contributes only active Skills and memoizes one environment per Turn', async () => {
    const active = new Set(['browser-pilot']);
    let browserCalls = 0;
    let inactiveCalls = 0;
    const registry = new ManagedSkillShellEnvironmentRegistry({
      activeSkillIds: async () => active,
      contributors: [{
        skillId: 'browser-pilot',
        processEnvironment: async () => {
          browserCalls += 1;
          return {
            env: { BROWSER_PILOT_CLIENT_KEY: 'tenon.thread' },
            leadingToolPathSegments: ['/managed/browser-pilot/bin'],
          };
        },
      }, {
        skillId: 'inactive-skill',
        processEnvironment: async () => {
          inactiveCalls += 1;
          return { env: { INACTIVE: 'true' } };
        },
      }],
    });

    const first = await registry.processEnvironment('thread-1', 'turn-1');
    const repeated = await registry.processEnvironment('thread-1', 'turn-1');
    expect(repeated).toBe(first);
    expect(first).toEqual({
      env: { BROWSER_PILOT_CLIENT_KEY: 'tenon.thread' },
      leadingToolPathSegments: ['/managed/browser-pilot/bin'],
    });
    expect(browserCalls).toBe(1);
    expect(inactiveCalls).toBe(0);

    registry.clearTurn('turn-1');
    await registry.processEnvironment('thread-1', 'turn-1');
    expect(browserCalls).toBe(2);

    active.clear();
    registry.invalidate();
    expect(await registry.processEnvironment('thread-1', 'turn-2')).toEqual({});
    expect(browserCalls).toBe(2);
  });

  test('isolates contributor and active-record failures', async () => {
    const errors: string[] = [];
    const registry = new ManagedSkillShellEnvironmentRegistry({
      activeSkillIds: async () => new Set(['broken', 'healthy']),
      contributors: [{
        skillId: 'broken',
        processEnvironment: async () => { throw new Error('broken host'); },
      }, {
        skillId: 'healthy',
        processEnvironment: async () => ({ env: { HEALTHY: 'true' } }),
      }],
      onError: (message) => errors.push(message),
    });

    expect(await registry.processEnvironment('thread-1', 'turn-1')).toEqual({
      env: { HEALTHY: 'true' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('broken');

    const lookupFailure = new ManagedSkillShellEnvironmentRegistry({
      activeSkillIds: async () => { throw new Error('store unavailable'); },
      contributors: [],
      onError: (message) => errors.push(message),
    });
    expect(await lookupFailure.processEnvironment('thread-1', 'turn-2')).toEqual({});
    expect(errors.at(-1)).toContain('active Skill lookup failed');
  });
});
