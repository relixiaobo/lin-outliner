import { describe, expect, test } from 'bun:test';
import { DEFAULT_DREAM_CHANNEL_ID } from '../../src/core/agentChannel';
import {
  getRunProfile,
  listRunProfiles,
  modelSelectableRunProfiles,
  objectiveRoleForRun,
  resolveRunProfile,
  runContextPolicyFromContextMode,
  runProfileForAnchor,
  runProfileForIsolatedSkill,
  runProfileForPurpose,
  runProfileFromStartedRun,
} from '../../src/main/agentRunProfiles';

describe('agent run profiles', () => {
  test('registers current active profiles and inactive future slots', () => {
    expect(listRunProfiles().map((profile) => profile.id).sort()).toEqual([
      'browser',
      'coding',
      'default',
      'dream',
      'research',
      'verify',
      'writing',
    ]);
    expect(modelSelectableRunProfiles().map((profile) => profile.id).sort()).toEqual(['default', 'research']);
    expect(getRunProfile('verify')).toMatchObject({
      defaultContext: 'none',
      defaultObjectiveRole: 'verifier',
      internalOnly: true,
      active: true,
    });
    expect(getRunProfile('dream')).toMatchObject({
      defaultContext: 'none',
      defaultDisposition: 'detached',
      internalOnly: true,
      hiddenFromWorkRuns: true,
    });
  });

  test('rejects inactive profiles through the resolver', () => {
    expect(resolveRunProfile(undefined).id).toBe('default');
    expect(() => resolveRunProfile('browser')).toThrow('Run profile is not active: browser');
  });

  test('maps existing runtime paths without creating agent identities', () => {
    expect(runProfileForPurpose('work')).toBe('default');
    expect(runProfileForPurpose('verify')).toBe('verify');
    expect(runProfileForIsolatedSkill(true)).toBe('research');
    expect(runProfileForIsolatedSkill(false)).toBe('default');
    expect(runProfileForAnchor({
      type: 'conversation',
      agentId: 'built-in:tenon:assistant',
      conversationId: DEFAULT_DREAM_CHANNEL_ID,
    })).toBe('dream');
    expect(runProfileFromStartedRun(
      { purpose: 'verify' },
      { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId: 'general' },
    )).toBe('verify');
    expect(objectiveRoleForRun({ purpose: 'verify' }, 'parent-run')).toBe('verifier');
    expect(objectiveRoleForRun({}, 'parent-run')).toBe('worker');
    expect(objectiveRoleForRun({}, undefined)).toBe('controller');
  });

  test('normalizes legacy context modes into persisted run context policy', () => {
    expect(runContextPolicyFromContextMode('brief')).toBe('brief');
    expect(runContextPolicyFromContextMode('none')).toBe('none');
    expect(runContextPolicyFromContextMode('full')).toBe('full');
    expect(runContextPolicyFromContextMode('fork')).toBe('full');
    expect(runContextPolicyFromContextMode(undefined)).toBe('full');
  });
});
