import type { ManagedSkillView, SkillDefinition } from '../../api/types';

/**
 * How many Skills the library lists.
 *
 * Managed rows come from the managed index, not the loaded catalog: a Skill that
 * is installed but deactivated is absent from the catalog and still has a row. So
 * the catalog's own `managed` entries — the active subset — are dropped and the
 * index is counted instead, or every active managed Skill would count twice.
 *
 * Both the settings shell (which needs the number for the Agent pane's row while
 * the library is not mounted, and for the rail badge) and the library itself count
 * through here. Written out twice, the two surfaces could report different totals
 * for the same list with nothing to catch it.
 */
export function skillLibraryCount(
  allSkills: readonly SkillDefinition[],
  managedSkills: readonly ManagedSkillView[],
): number {
  return allSkills.filter((skill) => skill.source !== 'managed').length + managedSkills.length;
}
