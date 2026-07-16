import { existsSync, realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  PRIVATE_JSON_FILE_OPTIONS,
  readJsonOrDefault,
  updateJsonFile,
} from './jsonFileStore';

export type FolderCapabilityAccess = 'read' | 'write';
export type FolderCapabilityOrigin = 'workdir' | 'attachment' | 'output' | 'skill' | 'user' | 'system';

export interface FolderCapabilityRoot {
  access: FolderCapabilityAccess;
  origin: FolderCapabilityOrigin;
  root: string;
}

export interface FolderCapabilityWriteDeny {
  path: string;
  recursive: boolean;
}

export interface FolderCapabilityProtectedRoot {
  root: string;
  readExceptions: readonly string[];
  writeExceptions: readonly string[];
}

export interface FolderCapabilitySnapshot {
  roots: readonly FolderCapabilityRoot[];
  readRoots: readonly string[];
  writeRoots: readonly string[];
  deniedWrites: readonly FolderCapabilityWriteDeny[];
  protectedRoots: readonly FolderCapabilityProtectedRoot[];
}

export interface FolderCapabilityDocument {
  folders: string[];
  blocks: string[];
}

export interface FolderCapabilityContext {
  workspaceRoot: string;
  scratchRoot?: string;
  activeSkillReadRoots?: readonly string[];
  deniedWrites?: readonly FolderCapabilityWriteDeny[];
  protectedRoots?: readonly string[];
  includeSystemRoots?: boolean;
}

type FolderRevocationListener = (folder: string) => void | Promise<void>;
type FolderGrantListener = (folders: readonly string[]) => void | Promise<void>;

const EMPTY_DOCUMENT: FolderCapabilityDocument = { folders: [], blocks: [] };

export class FolderCapabilityService {
  private readonly revocationListeners = new Set<FolderRevocationListener>();
  private readonly grantListeners = new Set<FolderGrantListener>();

  constructor(private readonly filePath: string) {}

  async read(): Promise<FolderCapabilityDocument> {
    const raw = await readJsonOrDefault(this.filePath, EMPTY_DOCUMENT);
    return normalizeDocument(raw);
  }

  async write(input: unknown): Promise<FolderCapabilityDocument> {
    const desired = await canonicalDocument(input);
    let previous = EMPTY_DOCUMENT;
    const persisted = await updateJsonFile(
      this.filePath,
      EMPTY_DOCUMENT,
      normalizeDocument,
      (current) => {
        previous = current;
        return desired;
      },
      PRIVATE_JSON_FILE_OPTIONS,
    );
    await this.publishRevokedFolders(previous, persisted);
    await this.publishGrantedFolders(previous, persisted);
    return persisted;
  }

  async grant(folderInput: string): Promise<FolderCapabilityDocument> {
    const folder = await canonicalExistingDirectory(folderInput);
    let previous = EMPTY_DOCUMENT;
    const next = await updateJsonFile(
      this.filePath,
      EMPTY_DOCUMENT,
      normalizeDocument,
      async (current) => {
        previous = current;
        return canonicalDocument({
          folders: [...current.folders, folder],
          blocks: current.blocks,
        });
      },
      PRIVATE_JSON_FILE_OPTIONS,
    );
    await this.publishGrantedFolders(previous, next);
    return next;
  }

  async grantMany(folderInputs: readonly string[]): Promise<FolderCapabilityDocument> {
    const folders = await Promise.all(folderInputs.map(canonicalExistingDirectory));
    let previous = EMPTY_DOCUMENT;
    const next = await updateJsonFile(
      this.filePath,
      EMPTY_DOCUMENT,
      normalizeDocument,
      async (current) => {
        previous = current;
        return canonicalDocument({
          folders: [...current.folders, ...folders],
          blocks: current.blocks,
        });
      },
      PRIVATE_JSON_FILE_OPTIONS,
    );
    await this.publishGrantedFolders(previous, next);
    return next;
  }

  async revoke(folderInput: string): Promise<FolderCapabilityDocument> {
    const requested = canonicalPathPreservingSuffix(folderInput);
    let previous = EMPTY_DOCUMENT;
    let folder = requested;
    const next = await updateJsonFile(
      this.filePath,
      EMPTY_DOCUMENT,
      normalizeDocument,
      (current) => {
        previous = current;
        folder = current.folders.find((candidate) => samePath(candidate, requested)) ?? requested;
        return {
          folders: current.folders.filter((candidate) => !samePath(candidate, folder)),
          blocks: current.blocks,
        };
      },
      PRIVATE_JSON_FILE_OPTIONS,
    );
    if (next.folders.length !== previous.folders.length) {
      await Promise.allSettled([...this.revocationListeners].map((listener) => listener(folder)));
    }
    return next;
  }

  async replaceBlocks(blocks: readonly string[]): Promise<FolderCapabilityDocument> {
    return updateJsonFile(
      this.filePath,
      EMPTY_DOCUMENT,
      normalizeDocument,
      (current) => ({ folders: current.folders, blocks: normalizedStrings(blocks) }),
      PRIVATE_JSON_FILE_OPTIONS,
    );
  }

  async appendBlock(ruleValue: string): Promise<FolderCapabilityDocument> {
    const normalized = ruleValue.trim();
    if (!normalized) return this.read();
    return updateJsonFile(
      this.filePath,
      EMPTY_DOCUMENT,
      normalizeDocument,
      (current) => ({
        folders: current.folders,
        blocks: current.blocks.includes(normalized) ? current.blocks : [...current.blocks, normalized],
      }),
      PRIVATE_JSON_FILE_OPTIONS,
    );
  }

  async removeBlock(ruleValue: string): Promise<FolderCapabilityDocument> {
    const normalized = ruleValue.trim();
    return updateJsonFile(
      this.filePath,
      EMPTY_DOCUMENT,
      normalizeDocument,
      (current) => ({
        folders: current.folders,
        blocks: current.blocks.filter((candidate) => candidate !== normalized),
      }),
      PRIVATE_JSON_FILE_OPTIONS,
    );
  }

  onRevoked(listener: FolderRevocationListener): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  onGranted(listener: FolderGrantListener): () => void {
    this.grantListeners.add(listener);
    return () => this.grantListeners.delete(listener);
  }

  async snapshot(context: FolderCapabilityContext): Promise<FolderCapabilitySnapshot> {
    const document = await this.read();
    return createFolderCapabilitySnapshot(context, document.folders);
  }

  private async publishGrantedFolders(
    previous: FolderCapabilityDocument,
    next: FolderCapabilityDocument,
  ): Promise<void> {
    const added = next.folders.filter((folder) => !previous.folders.some((existing) => samePath(existing, folder)));
    if (added.length === 0) return;
    await Promise.allSettled([...this.grantListeners].map((listener) => listener(added)));
  }

  private async publishRevokedFolders(
    previous: FolderCapabilityDocument,
    next: FolderCapabilityDocument,
  ): Promise<void> {
    const removed = previous.folders.filter((folder) => !next.folders.some((existing) => samePath(existing, folder)));
    for (const folder of removed) {
      await Promise.allSettled([...this.revocationListeners].map((listener) => listener(folder)));
    }
  }
}

export function createFolderCapabilitySnapshot(
  context: FolderCapabilityContext,
  userFolders: readonly string[],
): FolderCapabilitySnapshot {
  const workspaceRoot = canonicalPathPreservingSuffix(context.workspaceRoot);
  const roots: FolderCapabilityRoot[] = [{ access: 'write', origin: 'workdir', root: workspaceRoot }];
  const scratchRoot = context.scratchRoot?.trim()
    ? canonicalPathPreservingSuffix(context.scratchRoot)
    : undefined;
  if (scratchRoot) {
    roots.push({ access: 'read', origin: 'attachment', root: scratchRoot });
    for (const child of ['agent-tool-outputs', 'data-cleanup', 'generated-images']) {
      roots.push({ access: 'write', origin: 'output', root: path.join(scratchRoot, child) });
    }
  }
  for (const root of context.activeSkillReadRoots ?? []) {
    roots.push({ access: 'read', origin: 'skill', root: canonicalPathPreservingSuffix(root) });
  }
  for (const root of userFolders) {
    roots.push({ access: 'write', origin: 'user', root: canonicalPathPreservingSuffix(root) });
  }
  if (context.includeSystemRoots) {
    for (const root of systemReadRoots()) {
      roots.push({ access: 'read', origin: 'system', root });
    }
    for (const root of systemWriteRoots()) {
      roots.push({ access: 'write', origin: 'system', root });
    }
  }
  const protectedRoots = (context.protectedRoots ?? []).map((rootInput) => {
    const root = canonicalPathPreservingSuffix(rootInput);
    return {
      root,
      readExceptions: compactPaths([
        workspaceRoot,
        ...(scratchRoot ? [scratchRoot] : []),
      ].filter((candidate) => isPathInside(root, candidate))),
      writeExceptions: compactPaths([
        workspaceRoot,
        ...(scratchRoot
          ? ['agent-tool-outputs', 'data-cleanup', 'generated-images'].map((child) => path.join(scratchRoot, child))
          : []),
      ].filter((candidate) => isPathInside(root, candidate))),
    };
  });
  return snapshotFromRoots(compactCapabilityRoots(roots), context.deniedWrites, protectedRoots);
}

export function snapshotFromRoots(
  roots: readonly FolderCapabilityRoot[],
  deniedWrites: readonly FolderCapabilityWriteDeny[] = [],
  protectedRoots: readonly FolderCapabilityProtectedRoot[] = [],
): FolderCapabilitySnapshot {
  const compacted = compactCapabilityRoots(roots);
  const writeRoots = compactPaths(compacted.filter((entry) => entry.access === 'write').map((entry) => entry.root));
  const readRoots = compactPaths([
    ...writeRoots,
    ...compacted.filter((entry) => entry.access === 'read').map((entry) => entry.root),
  ]);
  return {
    roots: compacted,
    readRoots,
    writeRoots,
    deniedWrites: compactWriteDenies(deniedWrites),
    protectedRoots: compactProtectedRoots(protectedRoots),
  };
}

export function protectedRootForPath(
  snapshot: Pick<FolderCapabilitySnapshot, 'protectedRoots'>,
  targetPath: string,
  access: FolderCapabilityAccess,
): string | null {
  const target = canonicalPathPreservingSuffix(targetPath);
  for (const protection of snapshot.protectedRoots) {
    if (!isPathInside(protection.root, target)) continue;
    const exceptions = access === 'write' ? protection.writeExceptions : protection.readExceptions;
    if (!exceptions.some((root) => isPathInside(root, target))) return protection.root;
  }
  return null;
}

export function missingFolderCapabilities(
  requestedFolders: readonly string[],
  snapshot: Pick<FolderCapabilitySnapshot, 'readRoots'>,
): string[] {
  return compactPaths(requestedFolders
    .map((folder) => canonicalPathPreservingSuffix(folder))
    .filter((folder) => !snapshot.readRoots.some((root) => isPathInside(root, folder))));
}

export function normalizeRequiredFolders(input: unknown, cwd: string): string[] {
  if (!Array.isArray(input)) return [];
  return compactPaths(input.flatMap((value) => {
    if (typeof value !== 'string' || !value.trim()) return [];
    const resolved = resolveInputPath(value, cwd);
    const folder = nearestExistingDirectorySync(resolved);
    return folder ? [folder] : [];
  }));
}

export function capabilityFolderForTarget(inputPath: string, cwd: string): string | null {
  const resolved = resolveInputPath(inputPath, cwd);
  const folder = nearestExistingDirectorySync(resolved);
  return folder;
}

export function canonicalPathPreservingSuffix(inputPath: string): string {
  const requested = path.resolve(expandHome(inputPath));
  const existing = nearestExistingPathSync(requested);
  try {
    const canonicalExisting = realpathSync.native(existing);
    const suffix = path.relative(existing, requested);
    return suffix ? path.resolve(canonicalExisting, suffix) : canonicalExisting;
  } catch {
    return requested;
  }
}

export function isPathInside(rootInput: string, candidateInput: string): boolean {
  const root = path.resolve(rootInput);
  const candidate = path.resolve(candidateInput);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function canonicalExistingDirectory(inputPath: string): Promise<string> {
  const canonical = await realpath(path.resolve(expandHome(inputPath)));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`Folder capability requires a directory: ${inputPath}`);
  return canonical;
}

function normalizeDocument(input: unknown): FolderCapabilityDocument {
  if (!isRecord(input)) return { ...EMPTY_DOCUMENT };
  return {
    folders: compactPaths(normalizedStrings(input.folders).map((folder) => path.resolve(expandHome(folder)))),
    blocks: normalizedStrings(input.blocks),
  };
}

async function canonicalDocument(input: unknown): Promise<FolderCapabilityDocument> {
  const normalized = normalizeDocument(input);
  const folders: string[] = [];
  for (const candidate of normalized.folders) {
    try {
      folders.push(await canonicalExistingDirectory(candidate));
    } catch {
      // Settings only retain capabilities that still name real directories.
    }
  }
  return { folders: compactPaths(folders), blocks: normalized.blocks };
}

function compactCapabilityRoots(roots: readonly FolderCapabilityRoot[]): FolderCapabilityRoot[] {
  const result: FolderCapabilityRoot[] = [];
  for (const entry of roots) {
    const root = canonicalPathPreservingSuffix(entry.root);
    const existing = result.find((candidate) => samePath(candidate.root, root) && candidate.access === entry.access);
    if (existing) continue;
    if (result.some((candidate) => candidate.access === 'write' && isPathInside(candidate.root, root))) continue;
    if (entry.access === 'write') {
      for (let index = result.length - 1; index >= 0; index -= 1) {
        if (isPathInside(root, result[index]!.root)) result.splice(index, 1);
      }
    } else if (result.some((candidate) => candidate.access === 'read' && isPathInside(candidate.root, root))) {
      continue;
    }
    result.push({ ...entry, root });
  }
  return result;
}

function compactPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const candidate of paths.map((value) => path.resolve(value)).sort((left, right) => left.length - right.length)) {
    if (result.some((root) => isPathInside(root, candidate))) continue;
    result.push(candidate);
  }
  return result;
}

function compactWriteDenies(values: readonly FolderCapabilityWriteDeny[]): FolderCapabilityWriteDeny[] {
  const result: FolderCapabilityWriteDeny[] = [];
  for (const value of values) {
    const candidate = { path: canonicalPathPreservingSuffix(value.path), recursive: value.recursive === true };
    if (result.some((entry) => entry.recursive && isPathInside(entry.path, candidate.path))) continue;
    if (result.some((entry) => entry.path === candidate.path && entry.recursive === candidate.recursive)) continue;
    result.push(candidate);
  }
  return result;
}

function compactProtectedRoots(values: readonly FolderCapabilityProtectedRoot[]): FolderCapabilityProtectedRoot[] {
  const result: FolderCapabilityProtectedRoot[] = [];
  for (const value of values) {
    const root = canonicalPathPreservingSuffix(value.root);
    if (result.some((entry) => isPathInside(entry.root, root))) continue;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (isPathInside(root, result[index]!.root)) result.splice(index, 1);
    }
    result.push({
      root,
      readExceptions: compactPaths(value.readExceptions
        .map(canonicalPathPreservingSuffix)
        .filter((candidate) => isPathInside(root, candidate))),
      writeExceptions: compactPaths(value.writeExceptions
        .map(canonicalPathPreservingSuffix)
        .filter((candidate) => isPathInside(root, candidate))),
    });
  }
  return result;
}

function nearestExistingDirectorySync(inputPath: string): string | null {
  const existing = nearestExistingPathSync(inputPath);
  try {
    const canonical = realpathSync.native(existing);
    const info = statSync(canonical);
    return info.isDirectory() ? canonical : path.dirname(canonical);
  } catch {
    return null;
  }
}

function nearestExistingPathSync(inputPath: string): string {
  let current = path.resolve(inputPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function systemReadRoots(): string[] {
  const roots = process.platform === 'darwin'
    ? ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/opt/homebrew', '/usr/local']
    : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/usr/local'];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) roots.push(resourcesPath);
  return roots.filter(existsSync).map(canonicalPathPreservingSuffix);
}

function systemWriteRoots(): string[] {
  const roots = [tmpdir()];
  for (const relative of [
    'Library/Caches',
    '.cache',
    '.npm',
    '.bun/install/cache',
    'Library/pnpm',
  ]) {
    const candidate = path.join(homedir(), relative);
    if (existsSync(candidate)) roots.push(candidate);
  }
  return roots.map(canonicalPathPreservingSuffix);
}

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((candidate) => (
    typeof candidate === 'string' && candidate.trim() ? [candidate.trim()] : []
  )))];
}

function resolveInputPath(inputPath: string, cwd: string): string {
  const expanded = expandHome(inputPath.trim());
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded));
}

function expandHome(inputPath: string): string {
  if (inputPath === '~' || inputPath === '$HOME' || inputPath === '${HOME}') return homedir();
  if (inputPath.startsWith('~/')) return path.join(homedir(), inputPath.slice(2));
  if (inputPath.startsWith('$HOME/')) return path.join(homedir(), inputPath.slice(6));
  if (inputPath.startsWith('${HOME}/')) return path.join(homedir(), inputPath.slice(8));
  return inputPath;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
