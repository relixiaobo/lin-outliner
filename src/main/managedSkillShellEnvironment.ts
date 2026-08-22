import type {
  AgentShellOutputRoot,
  AgentShellProcessEnvironment,
} from './agent/capabilities/agentLocalTools';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ManagedSkillShellEnvironmentContributor {
  skillId: string;
  processEnvironment: (threadId: string, turnId: string) => Promise<AgentShellProcessEnvironment>;
}

export interface ManagedSkillShellEnvironmentRegistryOptions {
  activeSkillIds: () => Promise<ReadonlySet<string>>;
  contributors: readonly ManagedSkillShellEnvironmentContributor[];
  outputRootBoundary: string;
  onError?: (message: string, error: unknown) => void;
}

interface CachedTurnEnvironment {
  threadId: string;
  promise: Promise<AgentShellProcessEnvironment>;
}

/**
 * Composes host environment only for managed Skills active in this Turn.
 * Contributor failures are isolated so an optional integration cannot disable Bash.
 */
export class ManagedSkillShellEnvironmentRegistry {
  private readonly activeSkillIds: () => Promise<ReadonlySet<string>>;
  private readonly contributors: readonly ManagedSkillShellEnvironmentContributor[];
  private readonly outputRootBoundary: string;
  private readonly onError: (message: string, error: unknown) => void;
  private readonly turnEnvironments = new Map<string, CachedTurnEnvironment>();

  constructor(options: ManagedSkillShellEnvironmentRegistryOptions) {
    this.activeSkillIds = options.activeSkillIds;
    this.contributors = options.contributors;
    this.outputRootBoundary = path.resolve(options.outputRootBoundary);
    this.onError = options.onError ?? ((message, error) => console.warn(message, error));
  }

  processEnvironment(threadId: string, turnId: string): Promise<AgentShellProcessEnvironment> {
    const cached = this.turnEnvironments.get(turnId);
    if (cached?.threadId === threadId) return cached.promise;
    if (cached) {
      this.onError('[managed-skills] one Turn identity was observed in multiple Threads; rebuilding shell environment', {
        turnId,
      });
    }
    const promise = this.buildEnvironment(threadId, turnId);
    this.turnEnvironments.set(turnId, { threadId, promise });
    return promise;
  }

  clearTurn(turnId: string): void {
    this.turnEnvironments.delete(turnId);
  }

  invalidate(): void {
    this.turnEnvironments.clear();
  }

  private async buildEnvironment(threadId: string, turnId: string): Promise<AgentShellProcessEnvironment> {
    let activeSkillIds: ReadonlySet<string>;
    try {
      activeSkillIds = await this.activeSkillIds();
    } catch (error) {
      this.onError('[managed-skills] active Skill lookup failed; continuing without managed shell environment', error);
      return {};
    }

    const contributions = await Promise.all(this.contributors
      .filter((contributor) => activeSkillIds.has(contributor.skillId))
      .map(async (contributor) => {
        try {
          return {
            contributor,
            environment: await contributor.processEnvironment(threadId, turnId),
          };
        } catch (error) {
          this.onError(
            `[managed-skills] ${contributor.skillId} shell environment failed; continuing without that contribution`,
            error,
          );
          return null;
        }
      }));

    const env: NodeJS.ProcessEnv = {};
    const leadingToolPathSegments: string[] = [];
    const declaredOutputRoots: AgentShellOutputRoot[] = [];
    const outputRootIds = new Set<string>();
    const outputRootPaths = new Set<string>();
    for (const contribution of contributions) {
      if (!contribution) continue;
      const entries = Object.entries(contribution.environment.env ?? {});
      const conflictingKey = entries.find(([key, value]) => env[key] !== undefined && env[key] !== value)?.[0];
      if (conflictingKey) {
        this.onError(
          `[managed-skills] ${contribution.contributor.skillId} shell environment conflicts on ${conflictingKey}; contribution omitted`,
          new Error('Managed Skill shell environment conflict'),
        );
        continue;
      }
      let roots: AgentShellOutputRoot[];
      try {
        roots = await validateDeclaredOutputRoots(
          contribution.contributor.skillId,
          contribution.environment.declaredOutputRoots ?? [],
          this.outputRootBoundary,
        );
        if (roots.some((root) => outputRootIds.has(root.id) || outputRootPaths.has(root.path))) {
          throw new Error('Managed Skill output-root identity conflicts with another active contribution.');
        }
      } catch (error) {
        this.onError(
          `[managed-skills] ${contribution.contributor.skillId} declared an invalid output root; contribution omitted`,
          error,
        );
        continue;
      }
      Object.assign(env, contribution.environment.env);
      leadingToolPathSegments.push(...(contribution.environment.leadingToolPathSegments ?? []));
      declaredOutputRoots.push(...roots);
      for (const root of roots) {
        outputRootIds.add(root.id);
        outputRootPaths.add(root.path);
      }
    }

    return {
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(leadingToolPathSegments.length > 0 ? { leadingToolPathSegments } : {}),
      ...(declaredOutputRoots.length > 0 ? { declaredOutputRoots } : {}),
    };
  }
}

async function validateDeclaredOutputRoots(
  skillId: string,
  roots: readonly AgentShellOutputRoot[],
  outputRootBoundary: string,
): Promise<AgentShellOutputRoot[]> {
  if (roots.length === 0) return [];
  const [boundaryEntry, canonicalBoundary] = await Promise.all([
    lstat(outputRootBoundary),
    realpath(outputRootBoundary),
  ]);
  if (!boundaryEntry.isDirectory() || boundaryEntry.isSymbolicLink()) {
    throw new Error('Managed Skill output-root boundary is not a physical directory.');
  }
  const result: AgentShellOutputRoot[] = [];
  const localIds = new Set<string>();
  const localPaths = new Set<string>();
  for (const root of roots) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(root.id)) {
      throw new Error(`Invalid managed Skill output-root id: ${root.id}`);
    }
    if (root.skillId !== skillId || !root.label.trim() || !path.isAbsolute(root.path)) {
      throw new Error(`Invalid managed Skill output-root declaration: ${root.id}`);
    }
    const declaredPath = path.resolve(root.path);
    const [entry, canonicalPath] = await Promise.all([lstat(declaredPath), realpath(declaredPath)]);
    if (!entry.isDirectory() || entry.isSymbolicLink() || canonicalPath !== declaredPath) {
      throw new Error(`Managed Skill output root is not a canonical physical directory: ${declaredPath}`);
    }
    const relativeToBoundary = path.relative(canonicalBoundary, canonicalPath);
    if (
      relativeToBoundary === ''
      || relativeToBoundary === '..'
      || relativeToBoundary.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeToBoundary)
    ) {
      throw new Error(`Managed Skill output root escapes Agent scratch: ${declaredPath}`);
    }
    if (localIds.has(root.id) || localPaths.has(canonicalPath)) {
      throw new Error(`Duplicate managed Skill output root: ${root.id}`);
    }
    localIds.add(root.id);
    localPaths.add(canonicalPath);
    result.push({ ...root, path: canonicalPath, label: root.label.trim() });
  }
  return result;
}
