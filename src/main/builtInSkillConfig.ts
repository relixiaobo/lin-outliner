import path from 'node:path';

export const BUILT_IN_SKILL_RESOURCE_DIR_NAME = 'built-in-skills';
export const BUILT_IN_SKILL_SOURCE_DIR = 'src/main/builtInSkills';
export const GENERATED_BUILT_IN_SKILL_RESOURCE_DIR = 'build/generated/built-in-skills';
export const LINLAB_SKILLS_ROOT_ENV = 'LINLAB_SKILLS_ROOT';

export const ENABLED_LINLAB_BUILT_IN_SKILLS = ['data-analysis', 'document', 'pdf', 'presentation', 'spreadsheet'] as const;

export interface LinlabSkillsRootOptions {
  linlabSkillsRoot?: string;
  env?: Record<string, string | undefined>;
  repoRoot?: string;
  moduleDir?: string;
  localBuiltInRoot?: string;
}

export function resolveLinlabSkillsRoot(options: LinlabSkillsRootOptions = {}): string {
  const envRoot = options.env ? options.env[LINLAB_SKILLS_ROOT_ENV] : process.env[LINLAB_SKILLS_ROOT_ENV];
  const configuredRoot = options.linlabSkillsRoot ?? envRoot;
  if (configuredRoot?.trim()) {
    return path.resolve(configuredRoot);
  }

  const repoRoot = inferRepoRoot(options);
  return path.join(resolveSiblingCheckoutParent(repoRoot), 'linlab-skills');
}

function inferRepoRoot(options: LinlabSkillsRootOptions): string {
  if (options.repoRoot) {
    return path.resolve(options.repoRoot);
  }
  if (options.localBuiltInRoot) {
    return path.resolve(options.localBuiltInRoot, '../../..');
  }
  if (options.moduleDir) {
    return path.resolve(options.moduleDir, '../..');
  }
  throw new Error(`Cannot resolve linlab skills root without ${LINLAB_SKILLS_ROOT_ENV}, repoRoot, moduleDir, or localBuiltInRoot.`);
}

function resolveSiblingCheckoutParent(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  const worktreeMarker = `${path.sep}tmp${path.sep}worktrees${path.sep}`;
  const worktreeIndex = resolved.lastIndexOf(worktreeMarker);
  if (worktreeIndex > 0) {
    return path.dirname(resolved.slice(0, worktreeIndex));
  }
  return path.dirname(resolved);
}
