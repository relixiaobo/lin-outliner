import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  assertContained,
  assertRegisteredWorktree,
  directoryRealpath,
  git,
  gitOutput,
  isMissing,
} from '../automations/AutomationWorktree';

export interface AgentWorktreeMetadata {
  readonly sourceCwd: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly gitCommonDir: string;
  readonly gitWorktreeDir: string;
  readonly managed: true;
  readonly removedAt: number | null;
}

export interface PreparedAgentWorktree {
  readonly cwd: string;
  readonly worktree: AgentWorktreeMetadata;
}

export interface SettledAgentWorktree {
  readonly worktree: AgentWorktreeMetadata;
  readonly retained: boolean;
}

export class AgentWorktree {
  private readonly managedRoot: string;

  constructor(userDataPath: string, private readonly now: () => number = Date.now) {
    this.managedRoot = join(userDataPath, 'agent', 'subagent-worktrees');
  }

  async prepare(input: {
    readonly agentId: string;
    readonly cwd: string;
    readonly worktree?: AgentWorktreeMetadata | null;
  }): Promise<PreparedAgentWorktree> {
    const repository = await resolveRepository(input.cwd);
    await mkdir(this.managedRoot, { recursive: true });
    const managedRoot = await realpath(this.managedRoot);
    const identity = worktreeIdentity(input.agentId);
    const expectedPath = resolve(managedRoot, identity);
    assertContained(managedRoot, expectedPath);
    const expectedBranch = `tenon-agent-${identity}`;

    if (input.worktree?.removedAt === null) {
      return this.resumePrepared(input.worktree, repository, expectedPath, expectedBranch);
    }
    if (await pathExists(expectedPath)) {
      if (input.worktree) {
        throw new Error(`Removed Agent worktree still exists: ${expectedPath}`);
      }
      return this.recoverUnrecorded(repository, expectedPath, expectedBranch);
    }

    await mkdir(dirname(expectedPath), { recursive: true });
    const baseCommit = await gitOutput(['-C', repository.checkoutRoot, 'rev-parse', 'HEAD']);
    await git([
      '-C', repository.sourceCwd,
      'worktree', 'add', '-b', expectedBranch, expectedPath, baseCommit,
    ]);
    const metadata = await this.metadataFor(
      repository,
      expectedPath,
      expectedBranch,
      baseCommit,
    );
    return { cwd: expectedPath, worktree: metadata };
  }

  async settle(metadata: AgentWorktreeMetadata): Promise<SettledAgentWorktree> {
    const repository = await resolveRepository(metadata.sourceCwd);
    const prepared = await this.resumePrepared(metadata, repository, metadata.path, metadata.branch);
    const [status, head] = await Promise.all([
      gitOutput(['-C', prepared.cwd, 'status', '--porcelain', '--untracked-files=all']),
      gitOutput(['-C', prepared.cwd, 'rev-parse', 'HEAD']),
    ]);
    if (status.length > 0 || head !== metadata.baseCommit) {
      return { worktree: metadata, retained: true };
    }

    await git(['-C', metadata.sourceCwd, 'worktree', 'remove', metadata.path]);
    await git(['-C', metadata.sourceCwd, 'branch', '-D', metadata.branch]);
    return {
      worktree: Object.freeze({ ...metadata, removedAt: this.now() }),
      retained: false,
    };
  }

  sandboxWritePaths(metadata: AgentWorktreeMetadata): readonly string[] {
    if (metadata.removedAt !== null) return [];
    const branchRef = join(metadata.gitCommonDir, 'refs', 'heads', metadata.branch);
    const branchLog = join(metadata.gitCommonDir, 'logs', 'refs', 'heads', metadata.branch);
    return Object.freeze([
      metadata.path,
      metadata.gitWorktreeDir,
      join(metadata.gitCommonDir, 'objects'),
      branchRef,
      `${branchRef}.lock`,
      branchLog,
      `${branchLog}.lock`,
    ]);
  }

  private async resumePrepared(
    metadata: AgentWorktreeMetadata,
    repository: ResolvedRepository,
    expectedPath: string,
    expectedBranch: string,
  ): Promise<PreparedAgentWorktree> {
    if (!metadata.managed) throw new Error('Agent may resume only a host-managed worktree');
    if (metadata.removedAt !== null) throw new Error(`Agent worktree was already removed: ${metadata.path}`);
    if (await directoryRealpath(metadata.sourceCwd) !== repository.sourceCwd) {
      throw new Error(`Agent worktree source changed before resume: ${metadata.path}`);
    }
    const worktreePath = await directoryRealpath(metadata.path);
    if (worktreePath !== expectedPath || metadata.branch !== expectedBranch) {
      throw new Error(`Managed Agent worktree identity changed before resume: ${metadata.path}`);
    }
    await assertRegisteredWorktree(repository.sourceCwd, worktreePath, expectedBranch);
    await gitOutput(['-C', repository.sourceCwd, 'cat-file', '-e', `${metadata.baseCommit}^{commit}`]);
    const commonDir = await directoryRealpath(await gitOutput([
      '-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]));
    const worktreeGitDir = await directoryRealpath(await gitOutput([
      '-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir',
    ]));
    if (commonDir !== metadata.gitCommonDir || worktreeGitDir !== metadata.gitWorktreeDir) {
      throw new Error(`Managed Agent worktree Git metadata changed before resume: ${metadata.path}`);
    }
    assertContained(join(commonDir, 'worktrees'), worktreeGitDir);
    return { cwd: worktreePath, worktree: metadata };
  }

  private async recoverUnrecorded(
    repository: ResolvedRepository,
    expectedPath: string,
    expectedBranch: string,
  ): Promise<PreparedAgentWorktree> {
    const worktreePath = await directoryRealpath(expectedPath);
    await assertRegisteredWorktree(repository.sourceCwd, worktreePath, expectedBranch);
    const baseCommit = await gitOutput(['-C', worktreePath, 'rev-parse', 'HEAD']);
    const metadata = await this.metadataFor(
      repository,
      worktreePath,
      expectedBranch,
      baseCommit,
    );
    return { cwd: worktreePath, worktree: metadata };
  }

  private async metadataFor(
    repository: ResolvedRepository,
    worktreePath: string,
    branch: string,
    baseCommit: string,
  ): Promise<AgentWorktreeMetadata> {
    await assertRegisteredWorktree(repository.sourceCwd, worktreePath, branch);
    const gitCommonDir = await directoryRealpath(await gitOutput([
      '-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]));
    const gitWorktreeDir = await directoryRealpath(await gitOutput([
      '-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir',
    ]));
    assertContained(join(gitCommonDir, 'worktrees'), gitWorktreeDir);
    return Object.freeze({
      sourceCwd: repository.sourceCwd,
      path: worktreePath,
      branch,
      baseCommit,
      gitCommonDir,
      gitWorktreeDir,
      managed: true,
      removedAt: null,
    });
  }
}

interface ResolvedRepository {
  readonly checkoutRoot: string;
  readonly sourceCwd: string;
}

async function resolveRepository(cwd: string): Promise<ResolvedRepository> {
  const canonicalCwd = await directoryRealpath(cwd);
  const checkoutRoot = await directoryRealpath(await gitOutput([
    '-C', canonicalCwd, 'rev-parse', '--show-toplevel',
  ]));
  const gitCommonDir = await directoryRealpath(await gitOutput([
    '-C', checkoutRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]));
  const sourceCwd = await directoryRealpath(dirname(gitCommonDir));
  return { checkoutRoot, sourceCwd };
}

function worktreeIdentity(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, 20);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (error) => {
    if (isMissing(error)) return false;
    throw error;
  });
}
