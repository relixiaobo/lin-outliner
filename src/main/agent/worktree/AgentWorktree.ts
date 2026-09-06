import { createHash } from 'node:crypto';
import { mkdir, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  assertContained,
  assertRegisteredWorktree,
  directoryRealpath,
  git,
  gitOutput,
  gitRawOutput,
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

export interface AgentWorktreeIntentInput {
  readonly agentId: string;
  readonly cwd: string;
  readonly previous: AgentWorktreeMetadata | null;
}

/** Complete read-only intent persisted before any managed Git state is created. */
export interface AgentWorktreeRecoveryIntent {
  readonly sourceCwd: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly gitCommonDir: string;
}

export interface AgentWorktreeRecoveryInput {
  readonly agentId: string;
  readonly intent: AgentWorktreeRecoveryIntent;
  readonly previous: AgentWorktreeMetadata | null;
}

export type AgentWorktreeRecoveryResult =
  | {
    readonly status: 'recovered';
    readonly prepared: PreparedAgentWorktree;
  }
  | {
    readonly status: 'absent';
    readonly intent: AgentWorktreeRecoveryIntent;
  }
  | {
    readonly status: 'residual';
    readonly intent: AgentWorktreeRecoveryIntent;
    readonly registrationPresent: boolean;
    readonly branchHead: string | null;
  };

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

export interface AgentWorktreeInspection {
  readonly changedFiles: readonly string[];
  readonly patch: string;
}

export class AgentWorktree {
  private readonly managedRoot: string;

  constructor(
    userDataPath: string,
    private readonly now: () => number = Date.now,
    private readonly onWorktreeCreated?: (path: string) => void | Promise<void>,
  ) {
    this.managedRoot = join(userDataPath, 'agent', 'delegation-worktrees');
  }

  /** Resolves repository identity and the exact base without mutating Git or disk. */
  async plan(input: AgentWorktreeIntentInput): Promise<AgentWorktreeRecoveryIntent> {
    const repository = await resolveRepository(input.cwd);
    return this.resolveRecoveryIntent(input, repository);
  }

  async prepare(input: {
    readonly agentId: string;
    readonly intent: AgentWorktreeRecoveryIntent;
    readonly worktree?: AgentWorktreeMetadata | null;
  }): Promise<PreparedAgentWorktree> {
    const repository = await resolveRepository(input.intent.sourceCwd);
    await this.assertRecoveryIntent(input.agentId, input.intent, repository);
    await mkdir(this.managedRoot, { recursive: true });
    const managedRoot = await realpath(this.managedRoot);
    const identity = worktreeIdentity(input.agentId);
    const expectedPath = resolve(managedRoot, identity);
    assertContained(managedRoot, expectedPath);
    const expectedBranch = `tenon-agent-${identity}`;
    if (expectedPath !== input.intent.path || expectedBranch !== input.intent.branch) {
      throw new Error(`Managed Agent worktree intent changed before prepare: ${input.intent.path}`);
    }

    if (input.worktree?.removedAt === null) {
      return this.resumePrepared(input.worktree, repository, expectedPath, expectedBranch);
    }
    if (input.worktree) {
      await this.assertRemovedResumeMetadata(
        input.worktree,
        repository,
        expectedPath,
        expectedBranch,
      );
    }
    if (await pathExists(expectedPath)) {
      // Resume can recreate an auto-removed worktree and crash before the new
      // metadata reaches the ledger. The deterministic managed path/branch and
      // Git registration provide the same recovery proof as an initial prepare
      // that stopped before its execution row was inserted.
      return this.recoverUnrecorded(
        repository,
        expectedPath,
        expectedBranch,
        input.intent.baseCommit,
      );
    }

    await mkdir(dirname(expectedPath), { recursive: true });
    const baseCommit = input.intent.baseCommit;
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

  /**
   * Recovers only an already-created deterministic Agent worktree. This method
   * never creates the managed root, a worktree, or a branch.
   */
  async recover(input: AgentWorktreeRecoveryInput): Promise<AgentWorktreeRecoveryResult> {
    const repository = await resolveRepository(input.intent.sourceCwd);
    await this.assertRecoveryIntent(input.agentId, input.intent, repository);
    if (input.previous) {
      await this.assertPreviousRecoveryMetadata(input.previous, input.intent, repository);
    }

    if (input.previous?.removedAt === null && await pathExists(input.intent.path)) {
      const prepared = await this.resumePrepared(
        input.previous,
        repository,
        input.intent.path,
        input.intent.branch,
      );
      await assertBranchCheckoutHead(repository.sourceCwd, prepared.cwd, input.intent.branch);
      return Object.freeze({ status: 'recovered', prepared });
    }
    return this.inspectRecoveryIntent(repository, input.intent);
  }

  /**
   * Removes only a pathless deterministic recovery residue. A changed branch
   * is retained and reported as an error so startup can preserve the durable
   * intent and retry after explicit resolution.
   */
  async cleanupResidual(
    input: AgentWorktreeRecoveryInput,
  ): Promise<AgentWorktreeRecoveryResult> {
    const repository = await resolveRepository(input.intent.sourceCwd);
    await this.assertRecoveryIntent(input.agentId, input.intent, repository);
    if (input.previous) {
      await this.assertPreviousRecoveryMetadata(input.previous, input.intent, repository);
    }
    let current = await this.inspectRecoveryIntent(repository, input.intent);
    if (current.status !== 'residual') return current;
    if (current.branchHead !== null && current.branchHead !== current.intent.baseCommit) {
      throw new Error(`Residual Agent worktree branch contains changes: ${current.intent.branch}`);
    }

    if (current.registrationPresent) {
      await git(['-C', current.intent.sourceCwd, 'worktree', 'prune', '--expire', 'now']);
      current = await this.inspectRecoveryIntent(repository, current.intent);
      if (current.status !== 'residual') return current;
      if (current.registrationPresent) {
        throw new Error(`Missing Agent worktree remains registered: ${current.intent.path}`);
      }
      if (current.branchHead !== null && current.branchHead !== current.intent.baseCommit) {
        throw new Error(`Residual Agent worktree branch contains changes: ${current.intent.branch}`);
      }
    }

    if (current.branchHead !== null) {
      await git(['-C', current.intent.sourceCwd, 'branch', '-D', current.intent.branch]);
    }
    return this.inspectRecoveryIntent(repository, current.intent);
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

  /** Discards all changes inside a managed worktree before removing it. */
  async discard(metadata: AgentWorktreeMetadata): Promise<SettledAgentWorktree> {
    if (!metadata.managed) throw new Error('Agent may discard only host-managed worktrees');
    await git(['-C', metadata.path, 'reset', '--hard', metadata.baseCommit]);
    await git(['-C', metadata.path, 'clean', '-fdx']);
    return this.settle(metadata);
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

  async inspect(metadata: AgentWorktreeMetadata): Promise<AgentWorktreeInspection> {
    if (!metadata.managed || metadata.removedAt !== null) {
      throw new Error('Agent worktree inspection requires an active Host-managed worktree');
    }
    const repository = await resolveRepository(metadata.sourceCwd);
    const prepared = await this.resumePrepared(metadata, repository, metadata.path, metadata.branch);
    await assertNoUnrecoverableContent(prepared.cwd);
    await git(['-C', prepared.cwd, 'add', '--intent-to-add', '.']);
    const [patch, names] = await Promise.all([
      gitRawOutput(['-C', prepared.cwd, 'diff', '--binary', '--no-ext-diff', metadata.baseCommit]),
      gitRawOutput(['-C', prepared.cwd, 'diff', '--name-only', '-z', metadata.baseCommit]),
    ]);
    return Object.freeze({
      changedFiles: Object.freeze(names.split('\0').filter(Boolean)),
      patch,
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

  private async assertRemovedResumeMetadata(
    metadata: AgentWorktreeMetadata,
    repository: ResolvedRepository,
    expectedPath: string,
    expectedBranch: string,
  ): Promise<void> {
    if (!metadata.managed) throw new Error('Agent may resume only a host-managed worktree');
    if (metadata.removedAt === null) throw new Error(`Agent worktree is still active: ${metadata.path}`);
    if (await directoryRealpath(metadata.sourceCwd) !== repository.sourceCwd) {
      throw new Error(`Agent worktree source changed before resume: ${metadata.path}`);
    }
    if (resolve(metadata.path) !== expectedPath || metadata.branch !== expectedBranch) {
      throw new Error(`Managed Agent worktree identity changed before resume: ${metadata.path}`);
    }
    const commonDir = await directoryRealpath(await gitOutput([
      '-C', repository.sourceCwd, 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]));
    if (commonDir !== metadata.gitCommonDir) {
      throw new Error(`Managed Agent worktree Git metadata changed before resume: ${metadata.path}`);
    }
    assertContained(join(commonDir, 'worktrees'), resolve(metadata.gitWorktreeDir));
    await gitOutput(['-C', repository.sourceCwd, 'cat-file', '-e', `${metadata.baseCommit}^{commit}`]);
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
    baseCommit: string,
  ): Promise<PreparedAgentWorktree> {
    const worktreePath = await directoryRealpath(expectedPath);
    await assertRegisteredWorktree(repository.sourceCwd, worktreePath, expectedBranch);
    await assertBranchCheckoutHead(repository.sourceCwd, worktreePath, expectedBranch);
    // Never adopt the recovered worktree's current HEAD: it may contain the only
    // reference to changes made after the host stopped. The durable intent is
    // the authority even if the source checkout has advanced since the crash.
    const metadata = await this.metadataFor(
      repository,
      worktreePath,
      expectedBranch,
      baseCommit,
    );
    return { cwd: worktreePath, worktree: metadata };
  }

  private async resolveRecoveryIntent(
    input: AgentWorktreeIntentInput,
    repository: ResolvedRepository,
  ): Promise<AgentWorktreeRecoveryIntent> {
    const managedRoot = await prospectiveDirectoryRealpath(this.managedRoot);
    const identity = worktreeIdentity(input.agentId);
    const path = resolve(managedRoot, identity);
    assertContained(managedRoot, path);
    const branch = `tenon-agent-${identity}`;
    const baseCommit = input.previous?.baseCommit
      ?? await gitOutput(['-C', repository.checkoutRoot, 'rev-parse', 'HEAD']);
    const intent = Object.freeze({
      sourceCwd: repository.sourceCwd,
      path,
      branch,
      baseCommit,
      gitCommonDir: repository.gitCommonDir,
    });
    if (input.previous) {
      await this.assertPreviousRecoveryMetadata(input.previous, intent, repository);
    }
    await gitOutput(['-C', repository.sourceCwd, 'cat-file', '-e', `${baseCommit}^{commit}`]);
    return intent;
  }

  private async assertPreviousRecoveryMetadata(
    previous: AgentWorktreeMetadata,
    intent: AgentWorktreeRecoveryIntent,
    repository: ResolvedRepository,
  ): Promise<void> {
    if (!previous.managed) throw new Error('Agent may recover only a host-managed worktree');
    if (await directoryRealpath(previous.sourceCwd) !== repository.sourceCwd) {
      throw new Error(`Agent worktree source changed before recovery: ${previous.path}`);
    }
    if (
      resolve(previous.path) !== intent.path
      || previous.branch !== intent.branch
      || previous.baseCommit !== intent.baseCommit
    ) {
      throw new Error(`Managed Agent worktree identity changed before recovery: ${previous.path}`);
    }
    if (previous.gitCommonDir !== repository.gitCommonDir) {
      throw new Error(`Managed Agent worktree Git metadata changed before recovery: ${previous.path}`);
    }
    assertContained(join(repository.gitCommonDir, 'worktrees'), resolve(previous.gitWorktreeDir));
  }

  private async assertRecoveryIntent(
    agentId: string,
    intent: AgentWorktreeRecoveryIntent,
    repository: ResolvedRepository,
  ): Promise<void> {
    const managedRoot = await prospectiveDirectoryRealpath(this.managedRoot);
    const identity = worktreeIdentity(agentId);
    const expectedPath = resolve(managedRoot, identity);
    assertContained(managedRoot, expectedPath);
    if (
      repository.sourceCwd !== intent.sourceCwd
      || repository.gitCommonDir !== intent.gitCommonDir
      || intent.path !== expectedPath
      || intent.branch !== `tenon-agent-${identity}`
    ) {
      throw new Error(`Managed Agent worktree intent is invalid: ${intent.path}`);
    }
    await gitOutput(['-C', repository.sourceCwd, 'cat-file', '-e', `${intent.baseCommit}^{commit}`]);
  }

  private async inspectRecoveryIntent(
    repository: ResolvedRepository,
    intent: AgentWorktreeRecoveryIntent,
  ): Promise<AgentWorktreeRecoveryResult> {
    if (await pathExists(intent.path)) {
      const prepared = await this.recoverUnrecorded(
        repository,
        intent.path,
        intent.branch,
        intent.baseCommit,
      );
      return Object.freeze({ status: 'recovered', prepared });
    }

    const registrationPresent = (await registeredWorktreePaths(intent.sourceCwd)).has(intent.path);
    if (registrationPresent) {
      await assertRegisteredWorktree(intent.sourceCwd, intent.path, intent.branch);
    }
    const branchHead = await localBranchHead(intent.sourceCwd, intent.branch);
    if (!registrationPresent && branchHead === null) {
      return Object.freeze({ status: 'absent', intent });
    }
    return Object.freeze({
      status: 'residual',
      intent,
      registrationPresent,
      branchHead,
    });
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

async function assertNoUnrecoverableContent(worktreePath: string): Promise<void> {
  const ignored = (await gitRawOutput([
    '-C', worktreePath, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ])).split('\0').filter(Boolean);
  if (ignored.length > 0) {
    throw new Error(`Agent worktree contains ignored content that cannot be represented in its patch: ${ignored.slice(0, 3).join(', ')}`);
  }

  const directories = [worktreePath];
  while (directories.length > 0) {
    const directoryPath = directories.pop()!;
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      const entryPath = join(directoryPath, entry.name);
      if (directoryPath === worktreePath && entry.name === '.git') continue;
      if (entry.name === '.git') {
        throw new Error(`Agent worktree contains an embedded repository that cannot be represented in its patch: ${entryPath}`);
      }
      if (entry.isDirectory()) directories.push(entryPath);
    }
  }
}

interface ResolvedRepository {
  readonly checkoutRoot: string;
  readonly sourceCwd: string;
  readonly gitCommonDir: string;
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
  return { checkoutRoot, sourceCwd, gitCommonDir };
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

async function prospectiveDirectoryRealpath(path: string): Promise<string> {
  let existing = resolve(path);
  const missingSegments: string[] = [];
  while (!await pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Cannot resolve Agent worktree root: ${path}`);
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  return resolve(await directoryRealpath(existing), ...missingSegments);
}

async function localBranchHead(sourceCwd: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const refs = await gitOutput([
    '-C', sourceCwd, 'for-each-ref', '--format=%(objectname)', ref,
  ]);
  return refs.length === 0 ? null : refs.split('\n')[0] ?? null;
}

async function assertBranchCheckoutHead(
  sourceCwd: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const [branchHead, checkoutHead] = await Promise.all([
    localBranchHead(sourceCwd, branch),
    gitOutput(['-C', worktreePath, 'rev-parse', 'HEAD']),
  ]);
  if (branchHead === null || branchHead !== checkoutHead) {
    throw new Error(`Managed Agent worktree branch changed before recovery: ${branch}`);
  }
}

async function registeredWorktreePaths(sourceCwd: string): Promise<ReadonlySet<string>> {
  const output = await gitOutput(['-C', sourceCwd, 'worktree', 'list', '--porcelain']);
  return new Set(output.split('\n').flatMap((line) => (
    line.startsWith('worktree ') ? [resolve(line.slice('worktree '.length))] : []
  )));
}
