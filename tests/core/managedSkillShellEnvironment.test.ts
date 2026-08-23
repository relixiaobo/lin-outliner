import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManagedSkillShellEnvironmentRegistry } from '../../src/main/managedSkillShellEnvironment';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed Skill shell environment registry', () => {
  test('contributes only active Skills and memoizes active state per Turn plus environments per execution', async () => {
    const active = new Set(['browser-pilot']);
    let activeLookups = 0;
    let browserCalls = 0;
    let inactiveCalls = 0;
    const registry = new ManagedSkillShellEnvironmentRegistry({
      activeSkillIds: async () => {
        activeLookups += 1;
        return active;
      },
      outputRootBoundary: tmpdir(),
      contributors: [{
        skillId: 'browser-pilot',
        processEnvironment: async ({ executionId }) => {
          browserCalls += 1;
          return {
            env: {
              BROWSER_PILOT_CLIENT_KEY: 'tenon.thread',
              BROWSER_PILOT_EXECUTION: executionId,
            },
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

    const first = await registry.processEnvironment('thread-1', 'turn-1', shellContext('call-1'));
    const repeated = await registry.processEnvironment('thread-1', 'turn-1', shellContext('call-1'));
    const nextExecution = await registry.processEnvironment('thread-1', 'turn-1', shellContext('call-2'));
    expect(repeated).toBe(first);
    expect(first).toEqual({
      env: {
        BROWSER_PILOT_CLIENT_KEY: 'tenon.thread',
        BROWSER_PILOT_EXECUTION: 'call-1',
      },
      leadingToolPathSegments: ['/managed/browser-pilot/bin'],
    });
    expect(nextExecution.env?.BROWSER_PILOT_EXECUTION).toBe('call-2');
    expect(activeLookups).toBe(1);
    expect(browserCalls).toBe(2);
    expect(inactiveCalls).toBe(0);

    registry.clearTurn('turn-1');
    await registry.processEnvironment('thread-1', 'turn-1', shellContext('call-1'));
    expect(activeLookups).toBe(2);
    expect(browserCalls).toBe(3);

    active.clear();
    registry.invalidate();
    expect(await registry.processEnvironment('thread-1', 'turn-2', shellContext('call-3'))).toEqual({});
    expect(activeLookups).toBe(3);
    expect(browserCalls).toBe(3);
  });

  test('isolates contributor and active-record failures', async () => {
    const errors: string[] = [];
    const registry = new ManagedSkillShellEnvironmentRegistry({
      activeSkillIds: async () => new Set(['broken', 'healthy']),
      outputRootBoundary: tmpdir(),
      contributors: [{
        skillId: 'broken',
        processEnvironment: async () => { throw new Error('broken host'); },
      }, {
        skillId: 'healthy',
        processEnvironment: async () => ({ env: { HEALTHY: 'true' } }),
      }],
      onError: (message) => errors.push(message),
    });

    expect(await registry.processEnvironment('thread-1', 'turn-1', shellContext('call-1'))).toEqual({
      env: { HEALTHY: 'true' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('broken');

    const lookupFailure = new ManagedSkillShellEnvironmentRegistry({
      activeSkillIds: async () => { throw new Error('store unavailable'); },
      outputRootBoundary: tmpdir(),
      contributors: [],
      onError: (message) => errors.push(message),
    });
    expect(await lookupFailure.processEnvironment('thread-1', 'turn-2', shellContext('call-2'))).toEqual({});
    expect(errors.at(-1)).toContain('active Skill lookup failed');
  });

  test('validates typed output-root ownership and omits conflicting contributions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-managed-shell-roots-'));
    const outsideBoundary = await mkdtemp(path.join(tmpdir(), 'tenon-managed-shell-outside-'));
    roots.push(root, outsideBoundary);
    const browserPath = path.join(root, 'browser');
    const duplicatePath = path.join(root, 'duplicate');
    const wrongOwnerPath = path.join(root, 'wrong-owner');
    const outsidePath = path.join(outsideBoundary, 'outside');
    await Promise.all([browserPath, duplicatePath, wrongOwnerPath, outsidePath].map((directory) => mkdir(directory)));
    const [browserRoot, duplicateRoot, wrongOwnerRoot, outsideRoot] = await Promise.all([
      realpath(browserPath),
      realpath(duplicatePath),
      realpath(wrongOwnerPath),
      realpath(outsidePath),
    ]);
    const errors: string[] = [];
    const registry = new ManagedSkillShellEnvironmentRegistry({
      activeSkillIds: async () => new Set(['browser-pilot', 'duplicate-id', 'wrong-owner', 'outside-boundary']),
      outputRootBoundary: root,
      contributors: [{
        skillId: 'browser-pilot',
        processEnvironment: async () => ({
          env: { BROWSER_ACTIVE: 'true' },
          declaredOutputRoots: [{
            id: 'browser-output',
            skillId: 'browser-pilot',
            path: browserRoot,
            label: ' Browser output ',
          }],
        }),
      }, {
        skillId: 'duplicate-id',
        processEnvironment: async () => ({
          env: { DUPLICATE_ACTIVE: 'true' },
          declaredOutputRoots: [{
            id: 'browser-output',
            skillId: 'duplicate-id',
            path: duplicateRoot,
            label: 'Duplicate output',
          }],
        }),
      }, {
        skillId: 'wrong-owner',
        processEnvironment: async () => ({
          env: { WRONG_OWNER_ACTIVE: 'true' },
          declaredOutputRoots: [{
            id: 'wrong-owner-output',
            skillId: 'different-skill',
            path: wrongOwnerRoot,
            label: 'Wrong owner output',
          }],
        }),
      }, {
        skillId: 'outside-boundary',
        processEnvironment: async () => ({
          env: { OUTSIDE_ACTIVE: 'true' },
          declaredOutputRoots: [{
            id: 'outside-output',
            skillId: 'outside-boundary',
            path: outsideRoot,
            label: 'Outside output',
          }],
        }),
      }],
      onError: (message) => errors.push(message),
    });

    expect(await registry.processEnvironment('thread-1', 'turn-1', shellContext('call-1'))).toEqual({
      env: { BROWSER_ACTIVE: 'true' },
      declaredOutputRoots: [{
        id: 'browser-output',
        skillId: 'browser-pilot',
        path: browserRoot,
        label: 'Browser output',
      }],
    });
    expect(errors).toHaveLength(3);
    expect(errors.every((message) => message.includes('declared an invalid output root'))).toBe(true);
  });
});

function shellContext(toolCallId: string) {
  return { toolCallId, command: 'true' };
}
