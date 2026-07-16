import { describe, expect, test } from 'bun:test';
import type { AgentCapabilitySettingsView } from '../../src/renderer/api/types';
import {
  capabilitySettingsRemovalPatch,
  rebaseCapabilityDraft,
} from '../../src/renderer/ui/agent/agentCapabilitySettings';

function settings(folders: string[], blocks: string[]): AgentCapabilitySettingsView {
  return { folders, blocks, diagnostics: [] };
}

describe('agent capability settings draft', () => {
  test('saves only explicit removals from the loaded base', () => {
    const base = settings(['/project/a', '/project/b'], ['Action(git.publish_remote)', 'Command(npm publish)']);
    const draft = settings(['/project/b'], ['Action(git.publish_remote)']);

    expect(capabilitySettingsRemovalPatch(base, draft)).toEqual({
      revokeFolders: ['/project/a'],
      removeBlocks: ['Command(npm publish)'],
    });
  });

  test('rebases pending removals over concurrent grants without dropping them', () => {
    const base = settings(['/project/a'], ['Action(git.publish_remote)']);
    const draft = settings([], []);
    const current = settings(
      ['/project/a', '/project/concurrent', '/project/picked'],
      ['Action(git.publish_remote)', 'Command(npm publish)'],
    );

    expect(rebaseCapabilityDraft(base, draft, current)).toEqual(settings(
      ['/project/concurrent', '/project/picked'],
      ['Command(npm publish)'],
    ));
  });

  test('uses the current server state directly when there are no pending removals', () => {
    const base = settings(['/project/a'], []);
    const current = settings(['/project/a', '/project/picked'], []);

    expect(rebaseCapabilityDraft(base, base, current)).toBe(current);
  });
});
