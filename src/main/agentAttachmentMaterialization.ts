import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeAttachmentFileName } from '../core/agentAttachmentPaths';
import { MAX_MATERIALIZED_ATTACHMENT_BYTES } from '../core/agentAttachmentLimits';

export const AGENT_ATTACHMENT_DIR = 'agent-attachments';
export const AGENT_GENERATED_IMAGE_DIR = 'generated-images';
export const AGENT_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// The whole scratch root is bounded by the same age as attachments; nothing in it is durable.
export const AGENT_SCRATCH_TTL_MS = AGENT_ATTACHMENT_TTL_MS;

export interface PathBackedAttachment {
  name: string;
  path: string;
}

export async function materializePathBackedAttachment<T extends PathBackedAttachment>(
  localRoot: string,
  scratchRoot: string,
  attachment: T,
): Promise<T> {
  return {
    ...attachment,
    path: await materializeAgentLocalPath(localRoot, scratchRoot, attachment.path, attachment.name),
  };
}

// Sources already in the workdir or scratch are returned as-is. Other attachments are copied
// into app-owned scratch so the Run receives a stable local snapshot instead of depending on
// the lifetime of the original selection path.
export async function materializeAgentLocalPath(
  localRoot: string,
  scratchRoot: string,
  inputPath: string,
  label = 'attachment',
): Promise<string> {
  const root = path.resolve(localRoot);
  const rootRealPath = await realpath(root);
  const sourcePath = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath));
  const sourceRealPath = await realpath(sourcePath);
  // A source already in the workdir or app-owned scratch (for example, a staged attachment)
  // is returned as-is rather than copied again.
  const scratchRealPath = await safeRealPath(scratchRoot);
  if (isPathInside(rootRealPath, sourceRealPath)) return sourceRealPath;
  if (scratchRealPath && isPathInside(scratchRealPath, sourceRealPath)) return sourceRealPath;

  const sourceStat = await stat(sourceRealPath);
  if (sourceStat.isDirectory()) {
    throw new Error('Directory attachments outside the Run workdir cannot be materialized as stable snapshots.');
  }
  if (!sourceStat.isFile()) {
    throw new Error('Only regular file attachments can be materialized for agent access.');
  }
  if (sourceStat.size > MAX_MATERIALIZED_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is larger than ${formatBytes(MAX_MATERIALIZED_ATTACHMENT_BYTES)} and cannot be materialized for agent access.`);
  }

  await pruneOldAgentAttachments(scratchRoot);
  const attachmentDir = agentAttachmentDir(scratchRoot);
  await mkdir(attachmentDir, { recursive: true });
  const targetPath = path.join(attachmentDir, `${randomUUID()}-${safeAttachmentFileName(label || path.basename(sourceRealPath))}`);
  await copyFile(sourceRealPath, targetPath);
  return targetPath;
}

export function agentAttachmentDir(scratchRoot: string): string {
  return path.join(path.resolve(scratchRoot), AGENT_ATTACHMENT_DIR);
}

export async function pruneOldAgentAttachments(
  scratchRoot: string,
  now = Date.now(),
  ttlMs = AGENT_ATTACHMENT_TTL_MS,
): Promise<void> {
  await pruneDirEntriesByTtl(agentAttachmentDir(scratchRoot), now, ttlMs);
}

// Bound the whole scratch root by age. Scratch is app-owned ephemeral data (materialized
// attachments, web-fetch binaries, bash overflow logs, PDF page images); none of it is durable,
// so anything untouched past the TTL is removed. Pruning the entries WITHIN each scratch subdir
// (by per-entry mtime) rather than the subdirs themselves keeps actively-written areas intact
// while still reclaiming stale files. Best-effort; called once at startup.
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
  await Promise.all(subdirs.map((entry) => {
    if (entry === AGENT_GENERATED_IMAGE_DIR) return undefined;
    return pruneDirEntriesByTtl(path.join(root, entry), now, ttlMs);
  }));
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function safeRealPath(target: string): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(target));
    // A root that resolves to the filesystem root makes the whole disk "inside" it; treat it
    // as no root (mirrors localFileReferenceSecurity.trustedRootRealPath).
    if (path.parse(resolved).root === resolved) return null;
    return resolved;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
