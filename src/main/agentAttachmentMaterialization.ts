import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { formatFileReferenceMarker, splitFileReferenceMarkers } from '../core/referenceMarkup';
import { safeAttachmentFileName } from '../core/agentAttachmentPaths';

export const AGENT_ATTACHMENT_DIR = 'agent-attachments';

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
  const sourcePath = path.resolve(inputPath);
  if (isPathInside(root, sourcePath)) return sourcePath;

  const sourceStat = await stat(sourcePath);
  const attachmentDir = path.join(root, 'tmp', AGENT_ATTACHMENT_DIR);
  await mkdir(attachmentDir, { recursive: true });
  const targetPath = path.join(attachmentDir, `${randomUUID()}-${safeAttachmentFileName(label || path.basename(sourcePath))}`);
  if (sourceStat.isDirectory()) {
    await symlink(sourcePath, targetPath, 'dir');
    return targetPath;
  }
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

export async function materializeFileReferenceMarkersInText(
  localRoot: string,
  text: string,
  options: { onError?: 'preserve' | 'throw' } = {},
): Promise<string> {
  if (!text.includes('[[file:')) return text;
  const cache = new Map<string, Promise<string>>();
  return rewriteFileReferenceMarkersInText(localRoot, text, cache, options);
}

export async function materializeFileReferenceMarkersInValue<T>(
  localRoot: string,
  value: T,
  options: { onError?: 'preserve' | 'throw' } = {},
): Promise<T> {
  const cache = new Map<string, Promise<string>>();
  return rewriteFileReferenceMarkersInValue(localRoot, value, cache, options) as Promise<T>;
}

async function rewriteFileReferenceMarkersInValue(
  localRoot: string,
  value: unknown,
  cache: Map<string, Promise<string>>,
  options: { onError?: 'preserve' | 'throw' },
): Promise<unknown> {
  if (typeof value === 'string') return rewriteFileReferenceMarkersInText(localRoot, value, cache, options);
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => rewriteFileReferenceMarkersInValue(localRoot, item, cache, options)));
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = await rewriteFileReferenceMarkersInValue(localRoot, item, cache, options);
  }
  return out;
}

async function rewriteFileReferenceMarkersInText(
  localRoot: string,
  text: string,
  cache: Map<string, Promise<string>>,
  options: { onError?: 'preserve' | 'throw' },
): Promise<string> {
  if (!text.includes('[[file:')) return text;
  const segments = splitFileReferenceMarkers(text);
  if (!segments.some((segment) => segment.type === 'file')) return text;
  const parts = await Promise.all(segments.map(async (segment) => {
    if (segment.type === 'text') return segment.text;
    const nextPath = await materializedMarkerPath(localRoot, segment.path, segment.label || segment.ref, cache, options);
    if (!nextPath || nextPath === segment.path) return segment.raw;
    return formatFileReferenceMarker(segment.label || segment.ref, nextPath, segment.entryKind);
  }));
  return parts.join('');
}

async function materializedMarkerPath(
  localRoot: string,
  filePath: string,
  label: string,
  cache: Map<string, Promise<string>>,
  options: { onError?: 'preserve' | 'throw' },
): Promise<string | null> {
  const cacheKey = path.resolve(filePath);
  let promise = cache.get(cacheKey);
  if (!promise) {
    promise = materializeAgentLocalPath(localRoot, filePath, label);
    cache.set(cacheKey, promise);
  }
  try {
    return await promise;
  } catch (error) {
    if (options.onError === 'throw') throw error;
    return null;
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
