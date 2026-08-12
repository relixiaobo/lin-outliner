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

export interface SettleAgentWorktreeOptions {
  /** The ledger already contains the durable clean-removal intent. */
  readonly cleanupStarted?: boolean;
  /** Persists that intent after the worktree is proven clean and before removal. */
  readonly beforeCleanRemoval?: () => void | Promise<void>;
}

export interface AgentWorktreeSandboxPaths {
  readonly writablePaths: readonly string[];
  readonly protectedGitObjectStores: readonly string[];
}

export class AgentWorktree {
  private readonly managedRoot: string;

  constructor(
    userDataPath: string,
    private readonly now: () => number = Date.now,
    private readonly onWorktreeCreated?: (path: string) => void | Promise<void>,
  ) {
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
      // Resume can recreate an auto-removed worktree and crash before the new
      // metadata reaches the ledger. The deterministic managed path/branch and
      // Git registration provide the same recovery proof as an initial prepare
      // that stopped before its execution row was inserted.
      return this.recoverUnrecorded(repository, expectedPath, expectedBranch);
    }

    await mkdir(dirname(expectedPath), { recursive: true });
    const baseCommit = await gitOutput(['-C', repository.checkoutRoot, 'rev-parse', 'HEAD']);
    await git([
      '-C', repository.sourceCwd,
      'worktree', 'add', '-b', expectedBranch, expectedPath, baseCommit,
    ]);
    try {
      await this.onWorktreeCreated?.(expectedPath);
      const metadata = await this.metadataFor(
        repository,
        expectedPath,
        expectedBranch,
        baseCommit,
      );
      return { cwd: expectedPath, worktree: metadata };
    } catch (error) {
      await this.rollbackIncompletePrepare(repository.sourceCwd, expectedPath, expectedBranch);
      throw error;
    }
  }

  async settle(
    metadata: AgentWorktreeMetadata,
    options: SettleAgentWorktreeOptions = {},
  ): Promise<SettledAgentWorktree> {
    if (!metadata.managed) throw new Error('Agent may clean up only host-managed worktrees');
    if (metadata.removedAt !== null) return { worktree: metadata, retained: false };
    const repository = await resolveRepository(metadata.sourceCwd);
    await this.assertCleanupIdentity(metadata, repository);
    const worktreeExists = await pathExists(metadata.path);
    if (!worktreeExists && !options.cleanupStarted) {
      throw new Error(`Retained Agent worktree is missing: ${metadata.path}`);
    }
    if (worktreeExists) {
      const prepared = await this.resumePrepared(metadata, repository, metadata.path, metadata.branch);
      const [status, head] = await Promise.all([
        gitOutput(['-C', prepared.cwd, 'status', '--porcelain', '--untracked-files=all']),
        gitOutput(['-C', prepared.cwd, 'rev-parse', 'HEAD']),
      ]);
      if (status.length > 0 || head !== metadata.baseCommit) {
        // Removal can fail after its durable intent is recorded, then an
        // external process can modify the still-present worktree. Preserve that
        // data as retained work; the caller clears the stale cleanup marker.
        return { worktree: metadata, retained: true };
      }
      if (!options.cleanupStarted) await options.beforeCleanRemoval?.();
      await git(['-C', metadata.sourceCwd, 'worktree', 'remove', metadata.path]);
    } else {
      await this.pruneMissingRegistration(metadata);
    }

    const branchHead = await localBranchHead(metadata.sourceCwd, metadata.branch);
    if (branchHead !== null) {
      if (branchHead !== metadata.baseCommit) {
        throw new Error(`Agent worktree branch changed after clean removal began: ${metadata.branch}`);
      }
      await git(['-C', metadata.sourceCwd, 'branch', '-D', metadata.branch]);
    }
    return {
      worktree: Object.freeze({ ...metadata, removedAt: this.now() }),
      retained: false,
    };
  }

  sandboxPaths(metadata: AgentWorktreeMetadata): AgentWorktreeSandboxPaths {
    if (metadata.removedAt !== null) return { writablePaths: [], protectedGitObjectStores: [] };
    const branchRef = join(metadata.gitCommonDir, 'refs', 'heads', metadata.branch);
    const branchLog = join(metadata.gitCommonDir, 'logs', 'refs', 'heads', metadata.branch);
    return Object.freeze({
      writablePaths: Object.freeze([
        metadata.path,
        metadata.gitWorktreeDir,
        branchRef,
        `${branchRef}.lock`,
        branchLog,
        `${branchLog}.lock`,
      ]),
      protectedGitObjectStores: Object.freeze([join(metadata.gitCommonDir, 'objects')]),
    });
  }

  private async rollbackIncompletePrepare(
    sourceCwd: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    const cleanupFailures: unknown[] = [];
    if (await pathExists(worktreePath)) {
      await git(['-C', sourceCwd, 'worktree', 'remove', '--force', worktreePath])
        .catch((error) => cleanupFailures.push(error));
    } else {
      await git(['-C', sourceCwd, 'worktree', 'prune', '--expire', 'now'])
        .catch((error) => cleanupFailures.push(error));
    }
    if (await localBranchHead(sourceCwd, branch) !== null) {
      await git(['-C', sourceCwd, 'branch', '-D', branch])
        .catch((error) => cleanupFailures.push(error));
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, `Failed to clean incomplete Agent worktree: ${worktreePath}`);
    }
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

  private async assertCleanupIdentity(
    metadata: AgentWorktreeMetadata,
    repository: ResolvedRepository,
  ): Promise<void> {
    await mkdir(this.managedRoot, { recursive: true });
    const managedRoot = await realpath(this.managedRoot);
    assertContained(managedRoot, resolve(metadata.path));
    if (await directoryRealpath(metadata.sourceCwd) !== repository.sourceCwd) {
      throw new Error(`Agent worktree source changed before cleanup: ${metadata.path}`);
    }
    const commonDir = await directoryRealpath(await gitOutput([
      '-C', repository.sourceCwd, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]));
    if (commonDir !== metadata.gitCommonDir) {
      throw new Error(`Managed Agent worktree Git metadata changed before cleanup: ${metadata.path}`);
    }
    assertContained(join(commonDir, 'worktrees'), resolve(metadata.gitWorktreeDir));
    await gitOutput(['-C', repository.sourceCwd, 'cat-file', '-e', `${metadata.baseCommit}^{commit}`]);
  }

  private async pruneMissingRegistration(metadata: AgentWorktreeMetadata): Promise<void> {
    const registered = await registeredWorktreePaths(metadata.sourceCwd);
    if (!registered.has(resolve(metadata.path))) return;
    await git(['-C', metadata.sourceCwd, 'worktree', 'prune', '--expire', 'now']);
    if ((await registeredWorktreePaths(metadata.sourceCwd)).has(resolve(metadata.path))) {
      throw new Error(`Missing Agent worktree remains registered: ${metadata.path}`);
    }
  }

  private async recoverUnrecorded(
    repository: ResolvedRepository,
    expectedPath: string,
    expectedBranch: string,
  ): Promise<PreparedAgentWorktree> {
    const worktreePath = await directoryRealpath(expectedPath);
    await assertRegisteredWorktree(repository.sourceCwd, worktreePath, expectedBranch);
    // The recovered worktree may have changed after the host stopped. Use the
    // checkout that requested it as the conservative baseline; adopting the
    // worktree's current HEAD would misclassify an unknown commit as clean and
    // allow settlement to delete its only branch reference.
    const baseCommit = await gitOutput(['-C', repository.checkoutRoot, 'rev-parse', 'HEAD']);
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

async function localBranchHead(sourceCwd: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const refs = await gitOutput([
    '-C', sourceCwd, 'for-each-ref', '--format=%(objectname)', ref,
  ]);
  return refs.length === 0 ? null : refs.split('\n')[0] ?? null;
}

async function registeredWorktreePaths(sourceCwd: string): Promise<ReadonlySet<string>> {
  const output = await gitOutput(['-C', sourceCwd, 'worktree', 'list', '--porcelain']);
  return new Set(output.split('\n').flatMap((line) => (
    line.startsWith('worktree ') ? [resolve(line.slice('worktree '.length))] : []
  )));
}
