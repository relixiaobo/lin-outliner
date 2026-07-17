import type {
  AgentCapabilitySettingsPatchInput,
  AgentCapabilitySettingsView,
} from '../../api/types';

export function capabilitySettingsRemovalPatch(
  base: AgentCapabilitySettingsView,
  draft: AgentCapabilitySettingsView,
): AgentCapabilitySettingsPatchInput {
  return {
    removeBlocks: base.blocks.filter((block) => !draft.blocks.includes(block)),
  };
}
