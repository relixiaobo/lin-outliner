/**
 * The task-path segment an isolated Skill child is addressed by.
 *
 * `skill_<slug>_<12 hex>`: the slug folds the Skill's name to the task-path
 * charset, and the suffix exists so two runs of one Skill get distinct session
 * addresses. Neither is a name — a row that renders the segment renders twelve
 * characters no reader can use — so the renderer strips it back to the Skill.
 *
 * Built and parsed in one place because the two sides live in different
 * processes: a main-side change to the slug charset or the identity length
 * would otherwise silently stop the renderer from matching, and every
 * isolated-Skill row would regress to showing the raw address with no test
 * failing on either side.
 */

export const ISOLATED_SKILL_TASK_PREFIX = 'skill';
export const ISOLATED_SKILL_IDENTITY_LENGTH = 12;

const SLUG_SEPARATOR = '_';
const DISALLOWED_SLUG_CHARS = /[^a-z0-9_]+/g;
const EDGE_SEPARATORS = /^_+|_+$/g;
const ISOLATED_SKILL_TASK_NAME = new RegExp(
  `^${ISOLATED_SKILL_TASK_PREFIX}${SLUG_SEPARATOR}(.+)${SLUG_SEPARATOR}[0-9a-f]{${ISOLATED_SKILL_IDENTITY_LENGTH}}$`,
);

/** The uniqueness half of the address, derived from a UUIDv7 by the caller. */
export function isolatedSkillIdentity(uuid: string): string {
  return uuid.replaceAll('-', '').slice(-ISOLATED_SKILL_IDENTITY_LENGTH);
}

/** The task-path segment for one run of `skillName`. */
export function isolatedSkillTaskName(skillName: string, identity: string): string {
  const slug = skillName
    .toLowerCase()
    .replace(DISALLOWED_SLUG_CHARS, SLUG_SEPARATOR)
    .replace(EDGE_SEPARATORS, '')
    || ISOLATED_SKILL_TASK_PREFIX;
  return `${ISOLATED_SKILL_TASK_PREFIX}${SLUG_SEPARATOR}${slug}${SLUG_SEPARATOR}${identity}`;
}

/**
 * The Skill slug inside an isolated-Skill task name, or null if the segment is
 * not one.
 *
 * Shape alone is NOT proof of the delegation form: a collaboration `task_name`
 * is model-chosen under `^[a-z][a-z0-9_]*$` and could coincide with this shape.
 * Callers that can consult the child Thread's `source` must prefer it; this is
 * the evidence of last resort, for a child whose record no longer exists.
 */
export function isolatedSkillNameFromTaskName(taskName: string): string | null {
  return taskName.match(ISOLATED_SKILL_TASK_NAME)?.[1] ?? null;
}
