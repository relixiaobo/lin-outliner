import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MANAGED_SKILL_ERROR_CODES,
  type ManagedSkillCompatibilityView,
  type ManagedSkillErrorCode,
} from '../core/types';
import {
  PRIVATE_JSON_FILE_OPTIONS,
  readJsonOrDefault,
  updateJsonFile,
  writeJsonFile,
} from './jsonFileStore';
import {
  MANAGED_SKILL_LIMITS,
  compareManagedSkillPaths,
  hashManagedSkillFiles,
  type ManagedSkillFile,
  type ValidatedManagedSkill,
} from './managedSkillValidation';

const INDEX_SCHEMA_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = process.platform === 'win32' ? undefined : 0o700;
const PRIVATE_FILE_MODE = process.platform === 'win32' ? undefined : 0o600;
const IMMUTABLE_DIRECTORY_MODE = process.platform === 'win32' ? undefined : 0o500;
const IMMUTABLE_FILE_MODE = process.platform === 'win32' ? undefined : 0o400;
const SAFE_SKILL_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_HASH = /^[0-9a-f]{64}$/;
const SAFE_COMMIT = /^[0-9a-f]{40}$/;

export interface ManagedSkillStoredVersion {
  commit: string;
  contentHash: string;
  installedAt: number;
  fileCount: number;
  totalBytes: number;
  description: string;
  compatibility: ManagedSkillCompatibilityView;
  scripts: string[];
  version?: string;
}

export interface ManagedSkillRecord {
  id: string;
  name: string;
  origin: {
    owner: string;
    repo: string;
    repository: string;
    subdirectory: string;
    trackingRef: string;
  };
  recommended: boolean;
  catalogId?: string;
  catalogCompatibilityRange?: string;
  enabled: boolean;
  active: ManagedSkillStoredVersion;
  previous?: ManagedSkillStoredVersion;
  updateCommit?: string;
  lastCheckedAt?: number;
  diagnostic?: {
    code: 'modified' | 'name_conflict' | 'update_failed' | 'rolled_back';
    message: string;
    errorCode?: ManagedSkillErrorCode;
    detail?: string;
    at: number;
  };
}

export interface ManagedSkillIndex {
  schemaVersion: 1;
  skills: ManagedSkillRecord[];
}

export interface ManagedSkillIntegrityResult {
  ok: boolean;
  reason?: string;
}

export class ManagedSkillStore {
  readonly controlRoot: string;
  readonly contentRoot: string;
  readonly indexPath: string;
  readonly catalogCachePath: string;
  private readonly stagingRoot: string;

  constructor(userDataRoot: string) {
    this.controlRoot = path.join(userDataRoot, 'managed-skills');
    this.contentRoot = path.join(userDataRoot, 'managed-skill-content');
    this.indexPath = path.join(this.controlRoot, 'index.json');
    this.catalogCachePath = path.join(this.controlRoot, 'catalog-cache.json');
    this.stagingRoot = path.join(this.controlRoot, 'staging');
  }

  async initialize(): Promise<void> {
    await ensureNormalDirectory(this.controlRoot, PRIVATE_DIRECTORY_MODE);
    await ensureNormalDirectory(this.contentRoot, PRIVATE_DIRECTORY_MODE);
    await ensureNormalDirectory(this.stagingRoot, PRIVATE_DIRECTORY_MODE);
    await this.pruneStaging();
    await this.pruneOrphanVersions();
  }

  async readIndex(): Promise<ManagedSkillIndex> {
    await ensureNormalDirectory(this.controlRoot, PRIVATE_DIRECTORY_MODE);
    return readJsonOrDefault(this.indexPath, emptyIndex(), parseManagedSkillIndex);
  }

  async replaceIndex(index: ManagedSkillIndex): Promise<void> {
    await ensureNormalDirectory(this.controlRoot, PRIVATE_DIRECTORY_MODE);
    await writeJsonFile(this.indexPath, parseManagedSkillIndex(index), PRIVATE_JSON_FILE_OPTIONS);
  }

  async updateIndex(mutator: (index: ManagedSkillIndex) => ManagedSkillIndex | void | Promise<ManagedSkillIndex | void>): Promise<ManagedSkillIndex> {
    await ensureNormalDirectory(this.controlRoot, PRIVATE_DIRECTORY_MODE);
    return updateJsonFile(
      this.indexPath,
      emptyIndex(),
      parseManagedSkillIndex,
      mutator,
      PRIVATE_JSON_FILE_OPTIONS,
    );
  }

  async readCatalogCache(): Promise<unknown | null> {
    await ensureNormalDirectory(this.controlRoot, PRIVATE_DIRECTORY_MODE);
    return readJsonOrDefault<unknown | null>(this.catalogCachePath, null);
  }

  async writeCatalogCache(value: unknown): Promise<void> {
    await ensureNormalDirectory(this.controlRoot, PRIVATE_DIRECTORY_MODE);
    await writeJsonFile(this.catalogCachePath, value, PRIVATE_JSON_FILE_OPTIONS);
  }

  contentPath(skillId: string, contentHash: string): string {
    assertSafeIdentity(skillId, contentHash);
    return path.join(this.contentRoot, skillId, contentHash);
  }

  async installValidatedContent(skillId: string, skill: ValidatedManagedSkill): Promise<string> {
    assertSafeIdentity(skillId, skill.contentHash);
    await ensureNormalDirectory(this.controlRoot, PRIVATE_DIRECTORY_MODE);
    await ensureNormalDirectory(this.stagingRoot, PRIVATE_DIRECTORY_MODE);
    await ensureNormalDirectory(this.contentRoot, PRIVATE_DIRECTORY_MODE);
    const stagingPath = path.join(this.stagingRoot, randomUUID());
    let promotedPath: string | null = null;
    await mkdir(stagingPath, { recursive: false, ...(PRIVATE_DIRECTORY_MODE === undefined ? {} : { mode: PRIVATE_DIRECTORY_MODE }) });
    try {
      for (const file of skill.files) {
        const destination = safeChildPath(stagingPath, file.relativePath);
        await mkdir(path.dirname(destination), { recursive: true, ...(PRIVATE_DIRECTORY_MODE === undefined ? {} : { mode: PRIVATE_DIRECTORY_MODE }) });
        await writeFile(destination, file.bytes, {
          flag: 'wx',
          ...(PRIVATE_FILE_MODE === undefined ? {} : { mode: PRIVATE_FILE_MODE }),
        });
      }
      const stagedFiles = await readManagedContentFiles(stagingPath);
      if (hashManagedSkillFiles(stagedFiles) !== skill.contentHash) {
        throw new Error('Managed skill staging integrity check failed.');
      }

      const destination = this.contentPath(skillId, skill.contentHash);
      await assertNormalDirectory(this.contentRoot);
      await ensureNormalDirectory(path.dirname(destination), PRIVATE_DIRECTORY_MODE);
      if (await pathExists(destination)) {
        const existing = await this.verifyVersion(skillId, {
          commit: '0'.repeat(40),
          contentHash: skill.contentHash,
          installedAt: 0,
          fileCount: skill.fileCount,
          totalBytes: skill.totalBytes,
          description: skill.description,
          compatibility: skill.compatibility,
          scripts: skill.scripts,
        });
        if (!existing.ok) throw new Error(`Managed content-address collision: ${existing.reason ?? skill.contentHash}`);
        await removeTree(stagingPath);
      } else {
        await rename(stagingPath, destination);
        promotedPath = destination;
        await makeTreeImmutable(destination);
      }
      return destination;
    } catch (error) {
      await removeTree(stagingPath).catch(() => undefined);
      if (promotedPath) await removeTree(promotedPath).catch(() => undefined);
      throw error;
    }
  }

  async verifyVersion(skillId: string, version: ManagedSkillStoredVersion): Promise<ManagedSkillIntegrityResult> {
    try {
      const files = await readManagedContentFiles(await this.safeVersionPath(skillId, version.contentHash));
      const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
      if (files.length !== version.fileCount) return { ok: false, reason: 'The managed skill file set changed.' };
      if (totalBytes !== version.totalBytes) return { ok: false, reason: 'The managed skill byte length changed.' };
      if (hashManagedSkillFiles(files) !== version.contentHash) return { ok: false, reason: 'The managed skill content hash changed.' };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async readVersionFiles(skillId: string, version: ManagedSkillStoredVersion): Promise<ManagedSkillFile[]> {
    const integrity = await this.verifyVersion(skillId, version);
    if (!integrity.ok) throw new Error(integrity.reason ?? 'Managed skill integrity check failed.');
    return readManagedContentFiles(await this.safeVersionPath(skillId, version.contentHash));
  }

  async removeVersion(skillId: string, contentHash: string): Promise<void> {
    await removeTree(await this.safeVersionPath(skillId, contentHash));
    const skillRoot = path.join(this.contentRoot, skillId);
    try {
      if ((await readdir(skillRoot)).length === 0) await rm(skillRoot, { recursive: false, force: true });
    } catch {
      // The root is already gone or still holds another retained version.
    }
  }

  async removeSkill(skillId: string): Promise<void> {
    if (!SAFE_SKILL_ID.test(skillId)) throw new Error(`Invalid managed skill id: ${skillId}`);
    await assertNormalDirectory(this.contentRoot);
    const skillRoot = path.join(this.contentRoot, skillId);
    const stat = await lstat(skillRoot).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      await rm(skillRoot, { recursive: false, force: true });
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Managed skill storage path is not a normal directory: ${skillRoot}`);
    await removeTree(skillRoot);
  }

  async pruneStaging(): Promise<void> {
    let entries;
    try {
      await assertNormalDirectory(this.controlRoot);
      await assertNormalDirectory(this.stagingRoot);
      entries = await readdir(this.stagingRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    await Promise.allSettled(entries.map((entry) => removeTree(path.join(this.stagingRoot, entry.name))));
  }

  async pruneOrphanVersions(): Promise<void> {
    const index = await this.readIndex();
    const retained = new Map<string, Set<string>>();
    for (const record of index.skills) {
      const hashes = new Set([record.active.contentHash]);
      if (record.previous) hashes.add(record.previous.contentHash);
      retained.set(record.id, hashes);
    }

    await assertNormalDirectory(this.contentRoot);
    const skillEntries = await readdir(this.contentRoot, { withFileTypes: true });
    for (const skillEntry of skillEntries) {
      const skillPath = path.join(this.contentRoot, skillEntry.name);
      const retainedHashes = retained.get(skillEntry.name);
      if (!skillEntry.isDirectory() || skillEntry.isSymbolicLink() || !retainedHashes) {
        await removeTree(skillPath);
        continue;
      }
      const versionEntries = await readdir(skillPath, { withFileTypes: true });
      for (const versionEntry of versionEntries) {
        if (
          !versionEntry.isDirectory()
          || versionEntry.isSymbolicLink()
          || !retainedHashes.has(versionEntry.name)
        ) {
          await removeTree(path.join(skillPath, versionEntry.name));
        }
      }
      if ((await readdir(skillPath)).length === 0) await rm(skillPath, { recursive: false, force: true });
    }
  }

  private async safeVersionPath(skillId: string, contentHash: string): Promise<string> {
    assertSafeIdentity(skillId, contentHash);
    await assertNormalDirectory(this.contentRoot);
    await assertNormalDirectory(path.join(this.contentRoot, skillId));
    return this.contentPath(skillId, contentHash);
  }
}

export function storedVersionFromValidated(
  commit: string,
  installedAt: number,
  skill: ValidatedManagedSkill,
): ManagedSkillStoredVersion {
  if (!SAFE_COMMIT.test(commit)) throw new Error(`Invalid managed skill commit: ${commit}`);
  return {
    commit,
    contentHash: skill.contentHash,
    installedAt,
    fileCount: skill.fileCount,
    totalBytes: skill.totalBytes,
    description: skill.description,
    compatibility: skill.compatibility,
    scripts: [...skill.scripts],
    ...(skill.version ? { version: skill.version } : {}),
  };
}

function emptyIndex(): ManagedSkillIndex {
  return { schemaVersion: INDEX_SCHEMA_VERSION, skills: [] };
}

function parseManagedSkillIndex(value: unknown): ManagedSkillIndex {
  if (!isRecord(value) || value.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(value.skills)) {
    throw new Error('Managed skill index has an unsupported or corrupt schema.');
  }
  const skills = value.skills.map(parseManagedSkillRecord);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const skill of skills) {
    if (ids.has(skill.id) || names.has(skill.name)) throw new Error(`Managed skill index contains duplicate skill "${skill.name}".`);
    ids.add(skill.id);
    names.add(skill.name);
  }
  return { schemaVersion: INDEX_SCHEMA_VERSION, skills };
}

function parseManagedSkillRecord(value: unknown): ManagedSkillRecord {
  if (!isRecord(value) || !isRecord(value.origin)) throw new Error('Managed skill index contains an invalid record.');
  const id = requiredString(value.id, 'id');
  const name = requiredString(value.name, 'name');
  if (!SAFE_SKILL_ID.test(id) || !SAFE_SKILL_ID.test(name)) throw new Error(`Managed skill index contains an invalid id or name: ${id}`);
  const origin = {
    owner: requiredString(value.origin.owner, 'origin.owner'),
    repo: requiredString(value.origin.repo, 'origin.repo'),
    repository: requiredString(value.origin.repository, 'origin.repository'),
    subdirectory: typeof value.origin.subdirectory === 'string' ? value.origin.subdirectory : '',
    trackingRef: requiredString(value.origin.trackingRef, 'origin.trackingRef'),
  };
  const diagnosticValue = value.diagnostic;
  const diagnosticErrorCode = isRecord(diagnosticValue) ? managedSkillErrorCode(diagnosticValue.errorCode) : undefined;
  const diagnosticDetail = isRecord(diagnosticValue) ? boundedOptionalString(diagnosticValue.detail) : undefined;
  const diagnostic: ManagedSkillRecord['diagnostic'] = isRecord(diagnosticValue)
    && (diagnosticValue.code === 'modified' || diagnosticValue.code === 'name_conflict' || diagnosticValue.code === 'update_failed' || diagnosticValue.code === 'rolled_back')
    ? {
        code: diagnosticValue.code,
        message: requiredString(diagnosticValue.message, 'diagnostic.message'),
        ...(diagnosticErrorCode ? { errorCode: diagnosticErrorCode } : {}),
        ...(diagnosticDetail ? { detail: diagnosticDetail } : {}),
        at: requiredNumber(diagnosticValue.at, 'diagnostic.at'),
      }
    : undefined;
  return {
    id,
    name,
    origin,
    recommended: value.recommended === true,
    ...(typeof value.catalogId === 'string' && value.catalogId ? { catalogId: value.catalogId } : {}),
    ...(typeof value.catalogCompatibilityRange === 'string' && value.catalogCompatibilityRange
      ? { catalogCompatibilityRange: value.catalogCompatibilityRange }
      : {}),
    enabled: value.enabled === true,
    active: parseStoredVersion(value.active),
    ...(value.previous === undefined ? {} : { previous: parseStoredVersion(value.previous) }),
    ...(typeof value.updateCommit === 'string' && SAFE_COMMIT.test(value.updateCommit) ? { updateCommit: value.updateCommit } : {}),
    ...(typeof value.lastCheckedAt === 'number' && Number.isFinite(value.lastCheckedAt) ? { lastCheckedAt: value.lastCheckedAt } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function parseStoredVersion(value: unknown): ManagedSkillStoredVersion {
  if (!isRecord(value) || !isRecord(value.compatibility)) throw new Error('Managed skill index contains an invalid version.');
  const commit = requiredString(value.commit, 'version.commit');
  const contentHash = requiredString(value.contentHash, 'version.contentHash');
  if (!SAFE_COMMIT.test(commit) || !SAFE_HASH.test(contentHash)) throw new Error('Managed skill index contains an invalid commit or content hash.');
  const compatibilityStatus = value.compatibility.status;
  if (compatibilityStatus !== 'compatible' && compatibilityStatus !== 'unknown') {
    throw new Error('Managed skill index contains an invalid compatibility status.');
  }
  const declaredRange = typeof value.compatibility.declaredRange === 'string'
    ? requiredString(value.compatibility.declaredRange, 'compatibility.declaredRange')
    : undefined;
  const declaredRanges = Array.isArray(value.compatibility.declaredRanges)
    ? value.compatibility.declaredRanges.map((entry) => requiredString(entry, 'compatibility.declaredRanges'))
    : undefined;
  if ((declaredRange === undefined) !== (declaredRanges === undefined) || (declaredRanges?.length ?? 0) > 2) {
    throw new Error('Managed skill index contains inconsistent compatibility ranges.');
  }
  return {
    commit,
    contentHash,
    installedAt: requiredNumber(value.installedAt, 'version.installedAt'),
    fileCount: requiredNumber(value.fileCount, 'version.fileCount'),
    totalBytes: requiredNumber(value.totalBytes, 'version.totalBytes'),
    description: requiredString(value.description, 'version.description'),
    compatibility: {
      status: compatibilityStatus,
      appVersion: requiredString(value.compatibility.appVersion, 'compatibility.appVersion'),
      ...(declaredRange ? { declaredRange } : {}),
      ...(declaredRanges ? { declaredRanges } : {}),
    },
    scripts: Array.isArray(value.scripts) ? value.scripts.map((entry) => requiredString(entry, 'version.scripts')) : [],
    ...(typeof value.version === 'string' && value.version ? { version: value.version } : {}),
  };
}

async function readManagedContentFiles(root: string): Promise<ManagedSkillFile[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Managed skill content root is not a normal directory.');
  const files: ManagedSkillFile[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = safeChildPath(root, relativePath);
      const entryStat = await lstat(absolutePath);
      if (entry.isSymbolicLink() || entryStat.isSymbolicLink()) throw new Error(`Managed skill content contains a symlink: ${relativePath}`);
      if (entry.isDirectory() && entryStat.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !entryStat.isFile()) throw new Error(`Managed skill content contains an unsupported entry: ${relativePath}`);
      if ((entryStat.mode & 0o111) !== 0) throw new Error(`Managed skill content became executable: ${relativePath}`);
      if (entryStat.size > MANAGED_SKILL_LIMITS.fileBytes) throw new Error(`Managed skill file exceeds its size limit: ${relativePath}`);
      files.push({ relativePath, bytes: await readFile(absolutePath) });
      if (files.length > MANAGED_SKILL_LIMITS.fileCount) throw new Error('Managed skill content exceeds its file-count limit.');
    }
  }

  await walk(root, '');
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (totalBytes > MANAGED_SKILL_LIMITS.totalBytes) throw new Error('Managed skill content exceeds its total-size limit.');
  return files.sort((left, right) => compareManagedSkillPaths(left.relativePath, right.relativePath));
}

async function makeTreeImmutable(root: string): Promise<void> {
  const directories: string[] = [root];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const stat = await lstat(target);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`Managed skill staging gained a symlink before promotion: ${target}`);
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        directories.push(target);
        await walk(target);
      } else if (entry.isFile() && stat.isFile() && IMMUTABLE_FILE_MODE !== undefined) {
        await chmod(target, IMMUTABLE_FILE_MODE);
      } else if (!entry.isFile() || !stat.isFile()) {
        throw new Error(`Managed skill staging gained an unsupported entry before promotion: ${target}`);
      }
    }
  }
  await walk(root);
  if (IMMUTABLE_DIRECTORY_MODE !== undefined) {
    for (const directory of directories.reverse()) await chmod(directory, IMMUTABLE_DIRECTORY_MODE);
  }
}

async function removeTree(target: string): Promise<void> {
  try {
    await makeTreeWritable(target);
  } catch (error) {
    if (isNotFoundError(error)) return;
  }
  await rm(target, { recursive: true, force: true });
}

async function makeTreeWritable(root: string): Promise<void> {
  if (process.platform === 'win32') return;
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    await makeTreeWritable(target).catch(() => undefined);
  }
}

async function ensureNormalDirectory(target: string, mode: number | undefined): Promise<void> {
  await mkdir(target, { recursive: true, ...(mode === undefined ? {} : { mode }) });
  await assertNormalDirectory(target);
  if (mode !== undefined) await chmod(target, mode);
}

async function assertNormalDirectory(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Managed skill storage path is not a normal directory: ${target}`);
  }
}

function safeChildPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\')) throw new Error(`Unsafe managed skill path: ${relativePath}`);
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe managed skill path: ${relativePath}`);
  return target;
}

function assertSafeIdentity(skillId: string, contentHash: string): void {
  if (!SAFE_SKILL_ID.test(skillId) || !SAFE_HASH.test(contentHash)) throw new Error('Invalid managed skill storage identity.');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Managed skill index field ${field} is invalid.`);
  return value;
}

function managedSkillErrorCode(value: unknown): ManagedSkillErrorCode | undefined {
  return typeof value === 'string' && (MANAGED_SKILL_ERROR_CODES as readonly string[]).includes(value)
    ? value as ManagedSkillErrorCode
    : undefined;
}

function boundedOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized || undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Managed skill index field ${field} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}
