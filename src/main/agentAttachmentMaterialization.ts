import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeAttachmentFileName } from '../core/agentAttachmentPaths';
import { MAX_MATERIALIZED_ATTACHMENT_BYTES } from '../core/agentAttachmentLimits';

export const AGENT_ATTACHMENT_DIR = 'agent-attachments';
export const AGENT_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PathBackedAttachment {
  name: string;
  path: string;
}

export async function materializePathBackedAttachment<T extends PathBackedAttachment>(
  localRoot: string,
  attachment: T,
): Promise<T> {
  return {
    ...attachment,
    path: await materializeAgentLocalPath(localRoot, attachment.path, attachment.name),
  };
}

export async function materializeAgentLocalPath(
  localRoot: string,
  inputPath: string,
  label = 'attachment',
): Promise<string> {
  const root = path.resolve(localRoot);
  const rootRealPath = await realpath(root);
  const sourcePath = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath));
  const sourceRealPath = await realpath(sourcePath);
  if (isPathInside(rootRealPath, sourceRealPath)) return sourceRealPath;

  const sourceStat = await stat(sourceRealPath);
  if (sourceStat.isDirectory()) {
    throw new Error('Directory attachments outside the allowed file area cannot be materialized safely.');
  }
  if (!sourceStat.isFile()) {
    throw new Error('Only regular file attachments can be materialized for agent access.');
  }
  if (sourceStat.size > MAX_MATERIALIZED_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is larger than ${formatBytes(MAX_MATERIALIZED_ATTACHMENT_BYTES)} and cannot be materialized for agent access.`);
  }

  await pruneOldAgentAttachments(root);
  const attachmentDir = agentAttachmentDir(root);
  await mkdir(attachmentDir, { recursive: true });
  const targetPath = path.join(attachmentDir, `${randomUUID()}-${safeAttachmentFileName(label || path.basename(sourceRealPath))}`);
  await copyFile(sourceRealPath, targetPath);
  return targetPath;
}

export function agentAttachmentDir(localRoot: string): string {
  return path.join(path.resolve(localRoot), 'tmp', AGENT_ATTACHMENT_DIR);
}

export async function pruneOldAgentAttachments(
  localRoot: string,
  now = Date.now(),
  ttlMs = AGENT_ATTACHMENT_TTL_MS,
): Promise<void> {
  const attachmentDir = agentAttachmentDir(localRoot);
  let entries: string[];
  try {
    entries = await readdir(attachmentDir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(attachmentDir, entry);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
