import type {
  AgentRuntimeSettings,
  AgentRuntimeSettingsInput,
} from '../../../core/types';
import { expandSkillDirectory } from './agentSkills';

/**
 * Keep the user's spelling for source directories that were not changed.
 *
 * The renderer receives canonical absolute paths so it can compare them with
 * loaded Skill roots. When it sends the complete binding list back, matching
 * those paths to the stored values preserves relative and home-relative forms.
 */
export function preserveStoredSkillDirectoryForms(
  input: AgentRuntimeSettingsInput,
  stored: AgentRuntimeSettings,
  root: string,
): AgentRuntimeSettingsInput {
  const byExpanded = new Map(stored.additionalSkillDirectories.map((directory) => (
    [expandSkillDirectory(directory, root), directory]
  )));
  const preserve = (directory: string) => byExpanded.get(expandSkillDirectory(directory, root)) ?? directory;
  if (input.additionalSkillSourceBindings) {
    return {
      ...input,
      additionalSkillSourceBindings: input.additionalSkillSourceBindings.map((binding) => ({
        ...binding,
        path: preserve(binding.path),
      })),
    };
  }
  if (!input.additionalSkillDirectories) return input;
  return {
    ...input,
    additionalSkillDirectories: input.additionalSkillDirectories.map(preserve),
  };
}
