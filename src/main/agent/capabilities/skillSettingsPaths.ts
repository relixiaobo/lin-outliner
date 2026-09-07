import type {
  AgentSkillSettingsView,
  AgentSkillSettingsInput,
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
  input: AgentSkillSettingsInput,
  stored: AgentSkillSettingsView,
  root: string,
): AgentSkillSettingsInput {
  const byExpanded = new Map(stored.sourceBindings.map((binding) => (
    [expandSkillDirectory(binding.path, root), binding.path]
  )));
  const preserve = (directory: string) => byExpanded.get(expandSkillDirectory(directory, root)) ?? directory;
  if (input.sourceBindings) {
    return {
      ...input,
      sourceBindings: input.sourceBindings.map((binding) => ({
        ...binding,
        path: preserve(binding.path),
      })),
    };
  }
  return input;
}
