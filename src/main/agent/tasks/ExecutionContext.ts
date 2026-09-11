import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  decodeTaskExecutionContext,
  type ExecutionAddress,
  type ExecutionPolicy,
  type ExecutionScope,
  type TaskExecutionContext,
} from '../../../core/agent/executionContext';

const run = promisify(execFile);

export class ExecutionAdmissionError extends Error {
  constructor(readonly code: 'invalid_cwd' | 'invalid_target' | 'isolation_unavailable', message: string) {
    super(message);
    this.name = 'ExecutionAdmissionError';
  }
}

export async function resolveExecutionAddress(input: {
  readonly defaultCwd: string;
  readonly projectDefault?: import('../../../core/agent/project').ProjectExecutionDefault;
  readonly cwd?: string;
  readonly targets?: readonly string[];
  readonly followFinalSymlink?: boolean;
  readonly targetKind?: 'entry' | 'directory';
}): Promise<ExecutionAddress> {
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim() || input.cwd.includes('\0'))) {
    throw new ExecutionAdmissionError('invalid_cwd', 'cwd must be a non-empty directory path.');
  }
  let cwd: string;
  try {
    if (input.projectDefault?.path && !path.isAbsolute(input.cwd ?? '')
      && await realpath(input.projectDefault.path) !== input.projectDefault.path) throw new Error('Saved Project primary folder was redirected');
    cwd = await realpath(path.resolve(input.defaultCwd, input.cwd ?? '.'));
    if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new ExecutionAdmissionError('invalid_cwd', `Execution directory is unavailable: ${input.cwd ?? input.defaultCwd}`);
  }
  const targets = await Promise.all((input.targets ?? []).map(async (target) => {
    if (typeof target !== 'string' || !target.trim() || target.includes('\0')) {
      throw new ExecutionAdmissionError('invalid_target', 'File target must be a non-empty path.');
    }
    const resolved = path.resolve(cwd, target);
    return input.followFinalSymlink === false
      ? path.join(await canonicalPotentialPath(path.dirname(resolved)), path.basename(resolved))
      : canonicalPotentialPath(resolved);
  }));
  const directories = targets.length === 0 ? [cwd]
    : input.targetKind === 'directory' ? targets : targets.map((target) => path.dirname(target));
  const scopes = await Promise.all([...new Set(directories)].sort().map(resolveExecutionScope));
  return {
    ...(input.projectDefault ? { projectDefault: input.projectDefault } : {}),
    requestedCwd: input.cwd ?? null,
    cwd,
    targets: [...new Set(targets)].sort(),
    targetMode: input.followFinalSymlink === false ? 'entry' : 'follow',
    coverage: input.targets === undefined ? 'cwd-only' : 'known-targets',
    scopes: scopes.sort((a, b) => a.directory.localeCompare(b.directory)),
  };
}

export function pendingExecutionContext(address: ExecutionAddress, policy: ExecutionPolicy): TaskExecutionContext {
  const snapshot = {
    seriesId: randomUUID(),
    capturedAt: Date.now(),
    generation: 0,
    predecessorRef: null,
    discovery: 'pending' as const,
    degradation: 'Repository instruction discovery has not completed.',
    facts: address.scopes.map((scope) => ({
      source: 'host:execution-discovery',
      kind: 'discovery' as const,
      authority: 'host' as const,
      purpose: 'observation' as const,
      scope: scope.directory,
      version: 'pending:0',
      text: 'Repository instructions have not been inspected. Read applicable instructions before relying on project guidance.',
      invalidated: false,
    })),
  };
  return validateExecutionContext({
    addressRef: executionDigest(address), policyRef: executionDigest(policy), snapshotRef: executionDigest(snapshot),
    address, policy, snapshot,
  });
}

export function validateExecutionContext(value: unknown): TaskExecutionContext {
  const context = decodeTaskExecutionContext(value);
  for (const key of ['address', 'policy', 'snapshot'] as const) {
    if (context[`${key}Ref`] !== executionDigest(context[key])) throw new Error(`Execution ${key} digest mismatch`);
  }
  return freeze(context);
}

export async function revalidateExecutionContext(value: TaskExecutionContext): Promise<TaskExecutionContext> {
  const context = validateExecutionContext(value);
  try {
    if (await realpath(context.address.cwd) !== context.address.cwd || !(await stat(context.address.cwd)).isDirectory()) {
      throw new Error('Not the captured directory');
    }
  } catch {
    throw new ExecutionAdmissionError('invalid_cwd', 'The captured execution directory is unavailable or redirected.');
  }
  for (const target of context.address.targets) {
    const canonical = context.address.targetMode === 'entry'
      ? path.join(await canonicalPotentialPath(path.dirname(target)), path.basename(target))
      : await canonicalPotentialPath(target);
    if (canonical !== target) throw new ExecutionAdmissionError('invalid_target', `The captured file target was redirected: ${target}`);
  }
  for (const scope of context.address.scopes) {
    if (await canonicalPotentialPath(scope.directory) !== scope.directory
      || JSON.stringify(await resolveExecutionScope(scope.directory)) !== JSON.stringify(scope)) {
      throw new ExecutionAdmissionError('invalid_target', `The captured execution scope changed: ${scope.directory}`);
    }
  }
  return context;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function executionDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function canonicalPotentialPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink is not a creatable missing entry at this address.
    const entry = await lstat(target).catch(() => null);
    if (entry?.isSymbolicLink()) throw new ExecutionAdmissionError('invalid_target', `Dangling symlink: ${target}`);
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonicalPotentialPath(parent), path.basename(target));
  }
}

async function resolveExecutionScope(directory: string): Promise<ExecutionScope> {
  let existing = directory;
  while (!(await stat(existing).catch(() => null))?.isDirectory()) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new ExecutionAdmissionError('invalid_target', `No existing parent: ${directory}`);
    existing = parent;
  }
  let cursor = existing;
  while (true) {
    const marker = await lstat(path.join(cursor, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (marker) {
      const git = async (argument: string) => (await run('git', ['-C', existing, 'rev-parse', argument], {
        timeout: 2_000, maxBuffer: 64 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })).stdout.trim();
      const worktree = await realpath(await git('--show-toplevel'));
      const gitDirectory = await realpath(await git('--absolute-git-dir'));
      return { key: `git:${gitDirectory}`, directory, worktree, gitDirectory };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return { key: `directory:${directory}`, directory, worktree: null, gitDirectory: null };
    cursor = parent;
  }
}
