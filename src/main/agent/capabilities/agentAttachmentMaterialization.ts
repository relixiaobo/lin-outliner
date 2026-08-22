import { randomUUID } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  ThreadFileSource,
  ThreadImageArtifactReference,
  ThreadResourceReference,
} from '../../../core/agent/protocol';

export const AGENT_ATTACHMENT_DIR = 'agent-attachments';
export const AGENT_SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ManagedAttachmentObservation {
  resolvePath(ref: ThreadResourceReference): Promise<string | null>;
  resolveArtifactPath(artifact: ThreadImageArtifactReference): Promise<string | null>;
  dispose(): Promise<void>;
}

export function createManagedAttachmentObservation(
  scratchRoot: string,
  copyResource: (
    ref: ThreadResourceReference,
    targetDirectory: string,
  ) => Promise<string | null>,
  options: { readonly stableWorkspaceKey?: string } = {},
): ManagedAttachmentObservation {
  let disposed = false;
  let workspacePromise: Promise<string> | null = null;
  const resources = new Map<string, Promise<string | null>>();

  const workspace = (): Promise<string> => {
    if (workspacePromise) return workspacePromise;
    workspacePromise = (async () => {
      const root = path.join(path.resolve(scratchRoot), AGENT_ATTACHMENT_DIR);
      await mkdir(root, { recursive: true });
      const target = options.stableWorkspaceKey
        ? path.join(root, `provider-${safeWorkspaceKey(options.stableWorkspaceKey)}`)
        : path.join(root, randomUUID());
      if (options.stableWorkspaceKey) await rm(target, { recursive: true, force: true });
      await mkdir(target);
      return target;
    })();
    return workspacePromise;
  };

  return {
    resolvePath(ref) {
      if (disposed) throw new Error('Managed attachment observation is closed.');
      const key = `${ref.id}\0${ref.fileName}`;
      const existing = resources.get(key);
      if (existing) return existing;
      const pending = (async () => {
        const targetDirectory = path.join(
          await workspace(),
          options.stableWorkspaceKey ? ref.id : randomUUID(),
        );
        await mkdir(targetDirectory, { recursive: true });
        const copied = await copyResource(ref, targetDirectory);
        if (!copied) await rm(targetDirectory, { recursive: true, force: true });
        return copied ? realpath(copied) : null;
      })();
      resources.set(key, pending);
      return pending;
    },
    resolveArtifactPath(artifact) {
      if (disposed) throw new Error('Managed attachment observation is closed.');
      const key = `artifact:${artifact.id}`;
      const existing = resources.get(key);
      if (existing) return existing;
      const pending = (async () => {
        const targetDirectory = path.join(await workspace(), 'image-artifacts', artifact.id);
        await mkdir(targetDirectory, { recursive: true });
        const targetPath = path.join(targetDirectory, artifactMaterializedFileName(artifact));
        const copiedOriginal = artifact.original
          ? await copyArtifactSource(artifact.original, targetDirectory, targetPath, copyResource)
          : null;
        if (copiedOriginal) return realpath(copiedOriginal);
        const copiedObservation = await copyArtifactSource(
          { kind: 'threadPayload', ref: artifact.observation },
          targetDirectory,
          targetPath,
          copyResource,
        );
        if (!copiedObservation) await rm(targetDirectory, { recursive: true, force: true });
        return copiedObservation ? realpath(copiedObservation) : null;
      })();
      resources.set(key, pending);
      return pending;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled(resources.values());
      const target = await workspacePromise?.catch(() => null);
      if (target) await rm(target, { recursive: true, force: true });
      resources.clear();
    },
  };
}

async function copyArtifactSource(
  source: ThreadFileSource,
  targetDirectory: string,
  targetPath: string,
  copyResource: (ref: ThreadResourceReference, targetDirectory: string) => Promise<string | null>,
): Promise<string | null> {
  if (source.kind === 'localFile') {
    const sourcePath = await realpath(source.path).catch(() => null);
    if (!sourcePath) return null;
    const sourceStat = await lstat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) return null;
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    return targetPath;
  }
  const copied = await copyResource(source.ref, targetDirectory);
  if (!copied) return null;
  if (copied !== targetPath) await rename(copied, targetPath);
  return targetPath;
}

function artifactMaterializedFileName(artifact: ThreadImageArtifactReference): string {
  void artifact;
  return 'image';
}

function safeWorkspaceKey(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 160);
  if (!safe) throw new Error('Managed attachment observation workspace key is empty.');
  return safe;
}

// Bound the whole scratch root by age. Scratch is app-owned ephemeral data (attachment
// observations, image-artifact materializations, legacy web-fetch files, live bash logs,
// and PDF page images); none of it is durable, so anything untouched past the TTL is
// removed. Pruning entries within each scratch subdirectory keeps actively-written areas
// intact while still reclaiming stale files. Best-effort; called once at startup.
export async function pruneAgentScratch(
  scratchRoot: string,
  now = Date.now(),
  ttlMs = AGENT_SCRATCH_TTL_MS,
): Promise<void> {
  const root = path.resolve(scratchRoot);
  let subdirs: string[];
  try {
    subdirs = await readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(subdirs.map((entry) => pruneDirEntriesByTtl(path.join(root, entry), now, ttlMs)));
}

async function pruneDirEntriesByTtl(dir: string, now: number, ttlMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry);
    try {
      const entryStat = await lstat(entryPath);
      if (now - entryStat.mtimeMs <= ttlMs) return;
      await rm(entryPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup should never block attachment handling.
    }
  }));
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function canonicalPathPreservingSuffix(inputPath: string): string {
  const requested = path.resolve(inputPath);
  let existing = requested;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const canonicalExisting = realpathSync.native(existing);
    const suffix = path.relative(existing, requested);
    return suffix ? path.resolve(canonicalExisting, suffix) : canonicalExisting;
  } catch {
    return requested;
  }
}

export async function canonicalPathPreservingSuffixAsync(inputPath: string): Promise<string> {
  const requested = path.resolve(inputPath);
  let existing = requested;
  while (true) {
    try {
      const canonicalExisting = await realpath(existing);
      const suffix = path.relative(existing, requested);
      return suffix ? path.resolve(canonicalExisting, suffix) : canonicalExisting;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return requested;
      existing = parent;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
