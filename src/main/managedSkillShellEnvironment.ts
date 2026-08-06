import type { AgentShellProcessEnvironment } from './agent/capabilities/agentLocalTools';

export interface ManagedSkillShellEnvironmentContributor {
  skillId: string;
  processEnvironment: (threadId: string, turnId: string) => Promise<AgentShellProcessEnvironment>;
}

export interface ManagedSkillShellEnvironmentRegistryOptions {
  activeSkillIds: () => Promise<ReadonlySet<string>>;
  contributors: readonly ManagedSkillShellEnvironmentContributor[];
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
  private readonly onError: (message: string, error: unknown) => void;
  private readonly turnEnvironments = new Map<string, CachedTurnEnvironment>();

  constructor(options: ManagedSkillShellEnvironmentRegistryOptions) {
    this.activeSkillIds = options.activeSkillIds;
    this.contributors = options.contributors;
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
      Object.assign(env, contribution.environment.env);
      leadingToolPathSegments.push(...(contribution.environment.leadingToolPathSegments ?? []));
    }

    return {
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(leadingToolPathSegments.length > 0 ? { leadingToolPathSegments } : {}),
    };
  }
}
