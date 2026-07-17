import { describe, expect, test } from 'bun:test';
import type { AgentCapabilitySettingsView } from '../../src/renderer/api/types';
import { capabilitySettingsRemovalPatch } from '../../src/renderer/ui/agent/agentCapabilitySettings';

function settings(blocks: string[]): AgentCapabilitySettingsView {
  return { blocks, diagnostics: [] };
}

describe('agent capability settings draft', () => {
  test('saves only explicit block removals from the loaded base', () => {
    const base = settings(['Action(git.publish_remote)', 'Command(npm publish)']);
    const draft = settings(['Action(git.publish_remote)']);

    expect(capabilitySettingsRemovalPatch(base, draft)).toEqual({
      removeBlocks: ['Command(npm publish)'],
    });
  });

  test('does not turn draft-only additions into a removal patch', () => {
    expect(capabilitySettingsRemovalPatch(
      settings(['Action(git.publish_remote)']),
      settings(['Action(git.publish_remote)', 'Command(git push origin main)']),
    )).toEqual({ removeBlocks: [] });
  });
});
