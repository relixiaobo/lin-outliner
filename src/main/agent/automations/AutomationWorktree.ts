import { execFile } from 'node:child_process';
import { mkdir, open, opendir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AutomationRun, AutomationWorktreeMetadata } from '../../../core/agent/automation';

const execFileAsync = promisify(execFile);

export interface AutomationWorkspace {
  readonly cwd: string;
  readonly worktree: AutomationWorktreeMetadata | null;
}

export class AutomationWorktree {
  private readonly managedRoot: string;
  private readonly snapshotRoot: string;

  constructor(userDataPath: string) {
    this.managedRoot = join(userDataPath, 'agent', 'automation-worktrees');
    this.snapshotRoot = join(userDataPath, 'agent', 'automation-worktree-snapshots');
  }

  async prepare(run: AutomationRun): Promise<AutomationWorkspace> {
    const binding = run.snapshot.projectBinding;
    if (!binding) return { cwd: '', worktree: null };
    const cwd = await directoryRealpath(binding.cwd);
    if (cwd !== binding.cwd) {
      throw new Error(`Automation project path changed before dispatch: ${binding.cwd}`);
    }
    if (binding.executionMode === 'local') return { cwd, worktree: null };

    const sourceCwd = await directoryRealpath(await gitOutput(['-C', cwd, 'rev-parse', '--show-toplevel']));
    if (sourceCwd !== binding.cwd) {
      throw new Error(`Automation Git root changed before dispatch: ${binding.cwd}`);
    }
    await mkdir(this.managedRoot, { recursive: true });
    const managedRoot = await realpath(this.managedRoot);
    const worktreePath = resolve(managedRoot, run.automationId, run.id);
    assertContained(managedRoot, worktreePath);
    if (run.worktree) {
      return this.resumePrepared(run.worktree, sourceCwd, worktreePath);
    }

    await mkdir(resolve(worktreePath, '..'), { recursive: true });
    let baseCommit: string;
    try {
      await stat(worktreePath);
      const existingSource = await gitOutput(['-C', worktreePath, 'rev-parse', '--show-toplevel']);
      if (resolve(existingSource) !== worktreePath) {
        throw new Error(`Managed Automation worktree has unexpected root: ${worktreePath}`);
      }
      await assertRegisteredDetachedWorktree(sourceCwd, worktreePath);
      baseCommit = await gitOutput(['-C', worktreePath, 'rev-parse', 'HEAD']);
      await gitOutput(['-C', sourceCwd, 'cat-file', '-e', `${baseCommit}^{commit}`]);
    } catch (error) {
      if (!isMissing(error)) throw error;
      baseCommit = await gitOutput(['-C', sourceCwd, 'rev-parse', 'HEAD']);
      await git(['-C', sourceCwd, 'worktree', 'add', '--detach', worktreePath, baseCommit]);
      await assertRegisteredDetachedWorktree(sourceCwd, worktreePath);
    }
    return {
      cwd: worktreePath,
      worktree: Object.freeze({
        sourceCwd,
        path: worktreePath,
        baseCommit,
        snapshotPath: null,
        removedAt: null,
        managed: true,
      }),
    };
  }

  private async resumePrepared(
    metadata: AutomationWorktreeMetadata,
    sourceCwd: string,
    expectedPath: string,
  ): Promise<AutomationWorkspace> {
    if (metadata.removedAt !== null || metadata.snapshotPath !== null) {
      throw new Error(`Pending Automation worktree is already in cleanup: ${metadata.path}`);
    }
    if (await directoryRealpath(metadata.sourceCwd) !== sourceCwd) {
      throw new Error(`Automation worktree source changed before dispatch: ${metadata.path}`);
    }
    const worktreePath = await directoryRealpath(metadata.path);
    if (worktreePath !== expectedPath) {
      throw new Error(`Managed Automation worktree has unexpected path: ${metadata.path}`);
    }
    const existingRoot = await directoryRealpath(await gitOutput([
      '-C', worktreePath, 'rev-parse', '--show-toplevel',
    ]));
    if (existingRoot !== worktreePath) {
      throw new Error(`Managed Automation worktree has unexpected root: ${worktreePath}`);
    }
    await assertRegisteredDetachedWorktree(sourceCwd, worktreePath);
    await gitOutput(['-C', sourceCwd, 'cat-file', '-e', `${metadata.baseCommit}^{commit}`]);
    const existingHead = await gitOutput(['-C', worktreePath, 'rev-parse', 'HEAD']);
    if (existingHead !== metadata.baseCommit) {
      throw new Error(`Managed Automation worktree base changed before dispatch: ${worktreePath}`);
    }
    return { cwd: worktreePath, worktree: metadata };
  }

  async snapshotAndRemove(
    metadata: AutomationWorktreeMetadata,
    onSnapshot?: (metadata: AutomationWorktreeMetadata) => void | Promise<void>,
  ): Promise<AutomationWorktreeMetadata> {
    if (!metadata.managed) throw new Error('Automation may clean up only host-managed worktrees');
    if (metadata.removedAt !== null) return metadata;
    const path = resolve(metadata.path);
    const managedRoot = await directoryRealpath(this.managedRoot);
    assertContained(managedRoot, path);
    let prepared = metadata;
    if (!prepared.snapshotPath) {
      const sourceCwd = await directoryRealpath(metadata.sourceCwd);
      await assertRegisteredDetachedWorktree(sourceCwd, path);
      await gitOutput(['-C', sourceCwd, 'cat-file', '-e', `${metadata.baseCommit}^{commit}`]);
      await mkdir(this.snapshotRoot, { recursive: true });
      const snapshotRoot = await realpath(this.snapshotRoot);
      const snapshotPath = resolve(snapshotRoot, `${path.split(sep).at(-1)}.patch`);
      assertContained(snapshotRoot, snapshotPath);
      const patch = await recoverablePatch(path, metadata.baseCommit);
      await durableWrite(snapshotPath, patch);
      prepared = Object.freeze({ ...metadata, snapshotPath });
      await onSnapshot?.(prepared);
    } else {
      await assertSnapshotExists(this.snapshotRoot, prepared.snapshotPath);
    }
    const pathExists = await stat(path).then(() => true, (error) => {
      if (isMissing(error)) return false;
      throw error;
    });
    if (pathExists) {
      const sourceCwd = await directoryRealpath(prepared.sourceCwd);
      await assertRegisteredDetachedWorktree(sourceCwd, path);
      await gitOutput(['-C', sourceCwd, 'cat-file', '-e', `${prepared.baseCommit}^{commit}`]);
      await refreshSnapshot(path, prepared.baseCommit, prepared.snapshotPath!);
      await git(['-C', sourceCwd, 'worktree', 'remove', '--force', path]);
    }
    return Object.freeze({ ...prepared, removedAt: Date.now() });
  }
}

async function recoverablePatch(worktreePath: string, baseCommit: string): Promise<string> {
  await assertNoIgnoredContent(worktreePath);
  await assertNoEmbeddedRepositories(worktreePath);
  await git(['-C', worktreePath, 'add', '--intent-to-add', '.']);
  return gitRawOutput([
    '-C', worktreePath, 'diff', '--binary', '--no-ext-diff', baseCommit,
  ]);
}

async function refreshSnapshot(worktreePath: string, baseCommit: string, snapshotPath: string): Promise<void> {
  const patch = await recoverablePatch(worktreePath, baseCommit);
  const previous = await readFile(snapshotPath, 'utf8');
  if (patch !== previous) await durableWrite(snapshotPath, patch);
}

async function assertNoIgnoredContent(worktreePath: string): Promise<void> {
  const output = await gitRawOutput([
    '-C', worktreePath, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ]);
  const ignored = output.split('\0').filter(Boolean);
  if (ignored.length === 0) return;
  const sample = ignored.slice(0, 3).join(', ');
  throw new Error(`Automation worktree contains ignored content that is not recoverable from its patch: ${sample}`);
}

async function assertNoEmbeddedRepositories(worktreePath: string): Promise<void> {
  const directories = [worktreePath];
  while (directories.length > 0) {
    const directoryPath = directories.pop()!;
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      const entryPath = join(directoryPath, entry.name);
      if (directoryPath === worktreePath && entry.name === '.git') continue;
      if (entry.name === '.git') {
        throw new Error(`Automation worktree contains an embedded repository that is not recoverable from its patch: ${entryPath}`);
      }
      if (entry.isDirectory()) directories.push(entryPath);
    }
  }
}

async function directoryRealpath(path: string): Promise<string> {
  const resolved = await realpath(path);
  const value = await stat(resolved);
  if (!value.isDirectory()) throw new Error(`Automation project is not a directory: ${path}`);
  return resolved;
}

async function git(args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { maxBuffer: 8 * 1024 * 1024 });
}

async function gitOutput(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function gitRawOutput(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function durableWrite(path: string, value: string): Promise<void> {
  const file = await open(path, 'w', 0o600);
  try {
    await file.writeFile(value, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function assertSnapshotExists(root: string, path: string): Promise<void> {
  const snapshotRoot = await directoryRealpath(root);
  const snapshotPath = await realpath(path);
  assertContained(snapshotRoot, snapshotPath);
  const value = await stat(snapshotPath);
  if (!value.isFile()) throw new Error(`Automation worktree snapshot is not a file: ${path}`);
}

async function assertRegisteredDetachedWorktree(sourceCwd: string, worktreePath: string): Promise<void> {
  const list = await gitRawOutput([
    '-C', sourceCwd, '-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain', '-z',
  ]);
  const entry = list.split('\0\0').find((candidate) => (
    candidate.split('\0').some((field) => field === `worktree ${worktreePath}`)
  ));
  if (!entry) throw new Error(`Automation worktree is not registered to its source repository: ${worktreePath}`);
  const detached = entry.split('\0').some((field) => field === 'detached');
  if (!detached) {
    throw new Error(`Automation worktree must remain detached from user branches: ${worktreePath}`);
  }
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Automation managed path escapes its root: ${target}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
