import type {
  AgentCapabilitySettingsPatchInput,
  AgentCapabilitySettingsView,
} from '../../api/types';

export function capabilitySettingsRemovalPatch(
  base: AgentCapabilitySettingsView,
  draft: AgentCapabilitySettingsView,
): AgentCapabilitySettingsPatchInput {
  return {
    revokeFolders: base.folders.filter((folder) => !draft.folders.includes(folder)),
    removeBlocks: base.blocks.filter((block) => !draft.blocks.includes(block)),
  };
}

export function rebaseCapabilityDraft(
  base: AgentCapabilitySettingsView,
  draft: AgentCapabilitySettingsView,
  current: AgentCapabilitySettingsView,
): AgentCapabilitySettingsView {
  const patch = capabilitySettingsRemovalPatch(base, draft);
  if (patch.revokeFolders.length === 0 && patch.removeBlocks.length === 0) return current;
  return {
    ...current,
    folders: current.folders.filter((folder) => !patch.revokeFolders.includes(folder)),
    blocks: current.blocks.filter((block) => !patch.removeBlocks.includes(block)),
  };
}
