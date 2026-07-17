import { createHash, randomUUID } from 'node:crypto';
import { validRange } from 'semver';
import type {
  ManagedSkillCatalogEntryView,
  ManagedSkillCatalogView,
  ManagedSkillCompatibilityView,
  ManagedSkillDiscoveryView,
  ManagedSkillErrorCode,
  ManagedSkillErrorView,
  ManagedSkillUpdatePreviewView,
  ManagedSkillVersionView,
  ManagedSkillView,
} from '../core/types';
import {
  ManagedSkillGitHubClient,
  ManagedSkillNetworkError,
  validateGitHubTrackingRef,
  type ManagedSkillGitHubDiscovery,
} from './managedSkillGitHub';
import {
  ManagedSkillStore,
  storedVersionFromValidated,
  type ManagedSkillIndex,
  type ManagedSkillRecord,
  type ManagedSkillStoredVersion,
} from './managedSkillStore';
import {
  MANAGED_SKILL_LIMITS,
  ManagedSkillValidationError,
  resolveManagedSkillCompatibility,
  type ManagedSkillFile,
  type ValidatedManagedSkill,
} from './managedSkillValidation';

export const MANAGED_SKILL_CATALOG_URL = 'https://raw.githubusercontent.com/relixiaobo/lin-outliner/main/catalog/managed-skills-v1.json';
const CATALOG_SCHEMA_VERSION = 1;
const MAX_CATALOG_ENTRIES = 256;
const SESSION_TTL_MS = 30 * 60 * 1_000;
const MAX_SESSIONS = 8;
const MAX_CHANGED_PATHS = 200;
const MAX_DIFF_LINES = 240;
const MAX_DIFF_CHARS = 24_000;

export class ManagedSkillServiceError extends Error {
  constructor(
    readonly code: ManagedSkillErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ManagedSkillServiceError';
  }
}

export function managedSkillErrorView(error: unknown): ManagedSkillErrorView {
  if (
    error instanceof ManagedSkillServiceError
    || error instanceof ManagedSkillNetworkError
    || error instanceof ManagedSkillValidationError
  ) {
    const detail = normalizedErrorDetail(error.detail);
    return { code: error.code, ...(detail ? { detail } : {}) };
  }
  return { code: 'unexpected_error' };
}

export interface ManagedSkillNameConflict {
  source: 'built-in' | 'managed' | 'user' | 'project';
  location: string;
}

export interface ManagedSkillRuntimeRoot {
  id: string;
  name: string;
  rootDir: string;
  contentHash: string;
}

export interface ManagedSkillServiceOptions {
  appVersion: string;
  store: ManagedSkillStore;
  github?: ManagedSkillGitHubClient;
  now?: () => number;
  onChanged?: () => Promise<void> | void;
  findNameConflict?: (name: string, excludingManagedSkillId?: string) => Promise<ManagedSkillNameConflict | null>;
}

interface CatalogDocument {
  schemaVersion: 1;
  entries: CatalogEntry[];
}

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  repository: string;
  subdirectory: string;
  trackingRef: string;
  compatibilityRange?: string;
}

interface CatalogCache {
  schemaVersion: 1;
  refreshedAt: number;
  catalog: CatalogDocument;
}

interface DiscoverySession {
  id: string;
  createdAt: number;
  discovery: ManagedSkillGitHubDiscovery;
  recommended: boolean;
  catalogId?: string;
  catalogCompatibilityRange?: string;
}

interface UpdatePreviewSession {
  id: string;
  createdAt: number;
  skillId: string;
  expectedActiveHash: string;
  expectedRecord: ManagedSkillRecord;
  validated: ValidatedManagedSkill;
  view: ManagedSkillUpdatePreviewView;
}

export class ManagedSkillService {
  private readonly github: ManagedSkillGitHubClient;
  private readonly now: () => number;
  private readonly ready: Promise<void>;
  private readonly discoverySessions = new Map<string, DiscoverySession>();
  private readonly updatePreviews = new Map<string, UpdatePreviewSession>();
  private lastCatalog: CatalogDocument | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ManagedSkillServiceOptions) {
    this.github = options.github ?? new ManagedSkillGitHubClient();
    this.now = options.now ?? Date.now;
    this.ready = options.store.initialize();
  }

  get contentRoot(): string {
    return this.options.store.contentRoot;
  }

  async loadCatalog(): Promise<ManagedSkillCatalogView> {
    await this.ready;
    let refreshError: ManagedSkillErrorView | undefined;
    try {
      const remote = parseCatalogDocument(await this.github.fetchJsonFromRaw(MANAGED_SKILL_CATALOG_URL, MANAGED_SKILL_LIMITS.catalogBytes));
      const refreshedAt = this.now();
      this.lastCatalog = remote;
      await this.options.store.writeCatalogCache({ schemaVersion: CATALOG_SCHEMA_VERSION, refreshedAt, catalog: remote } satisfies CatalogCache);
      return this.catalogView(remote, 'fresh', refreshedAt);
    } catch (error) {
      refreshError = managedSkillErrorView(error);
    }

    try {
      const cache = parseCatalogCache(await this.options.store.readCatalogCache());
      this.lastCatalog = cache.catalog;
      return this.catalogView(cache.catalog, 'cached', cache.refreshedAt, refreshError);
    } catch {
      this.lastCatalog = null;
      return { status: 'unavailable', entries: [], ...(refreshError ? { error: refreshError } : {}) };
    }
  }

  async discover(input: { sourceUrl?: string; catalogId?: string }): Promise<ManagedSkillDiscoveryView> {
    await this.ready;
    this.pruneSessions();
    let sourceUrl: string;
    let trackingRef: string | undefined;
    let subdirectory: string | undefined;
    let catalogCompatibilityRange: string | undefined;
    let catalogId: string | undefined;
    let catalogSkillName: string | undefined;
    if (input.catalogId?.trim()) {
      const entry = await this.catalogEntry(input.catalogId.trim());
      sourceUrl = entry.repository;
      trackingRef = entry.trackingRef;
      subdirectory = entry.subdirectory;
      catalogCompatibilityRange = entry.compatibilityRange;
      catalogId = entry.id;
      catalogSkillName = entry.name;
    } else if (input.sourceUrl?.trim()) {
      sourceUrl = input.sourceUrl.trim();
    } else {
      throw new ManagedSkillServiceError('missing_source', 'Enter a public GitHub repository or choose a catalog skill.');
    }

    let discovery = await this.github.discover({
      sourceUrl,
      appVersion: this.options.appVersion,
      trackingRef,
      subdirectory,
      catalogCompatibilityRange,
    });
    if (catalogId && catalogSkillName !== undefined && subdirectory !== undefined) {
      const candidate = discovery.candidates.find((entry) => entry.view.subdirectory === subdirectory);
      if (!candidate || candidate.view.name !== catalogSkillName) {
        throw new ManagedSkillServiceError(
          'catalog_entry_mismatch',
          `Catalog entry ${catalogId} no longer resolves to skill "${catalogSkillName}" at ${subdirectory}.`,
          `${catalogId} @ ${subdirectory}`,
        );
      }
      discovery = { ...discovery, candidates: [candidate] };
    }
    const id = randomUUID();
    const session: DiscoverySession = {
      id,
      createdAt: this.now(),
      discovery,
      recommended: Boolean(catalogId),
      ...(catalogId ? { catalogId } : {}),
      ...(catalogCompatibilityRange ? { catalogCompatibilityRange } : {}),
    };
    this.discoverySessions.set(id, session);
    this.trimSessions(this.discoverySessions);
    return discoveryView(session);
  }

  async install(input: {
    discoveryId: string;
    candidateId: string;
    expectedCommit: string;
  }): Promise<ManagedSkillView> {
    await this.ready;
    const session = this.discoverySession(input.discoveryId);
    if (session.discovery.origin.commit !== input.expectedCommit) {
      throw new ManagedSkillServiceError('stale_discovery', 'The resolved GitHub commit changed. Discover the skill again before installing.');
    }
    const candidate = session.discovery.candidates.find((entry) => entry.view.id === input.candidateId);
    if (!candidate) throw new ManagedSkillServiceError('candidate_not_found', 'Select one of the discovered skill folders.');
    const validated = await this.github.downloadCandidate({
      origin: session.discovery.origin,
      candidate,
      appVersion: this.options.appVersion,
      catalogCompatibilityRange: session.catalogCompatibilityRange,
    });
    if (validated.name !== candidate.view.name) {
      throw new ManagedSkillServiceError(
        'candidate_changed',
        'The selected skill identity changed while downloading. Discover it again.',
        `${candidate.view.name} -> ${validated.name}`,
      );
    }

    return this.withMutation(async () => {
      const before = await this.options.store.readIndex();
      await this.assertNameAvailable(before, validated.name);
      const installedAt = this.now();
      const active = storedVersionFromValidated(session.discovery.origin.commit, installedAt, validated);
      await this.options.store.installValidatedContent(validated.name, validated);
      const record: ManagedSkillRecord = {
        id: validated.name,
        name: validated.name,
        origin: {
          owner: session.discovery.origin.owner,
          repo: session.discovery.origin.repo,
          repository: session.discovery.origin.repository,
          subdirectory: candidate.view.subdirectory,
          trackingRef: session.discovery.origin.trackingRef,
        },
        recommended: session.recommended,
        ...(session.catalogId ? { catalogId: session.catalogId } : {}),
        ...(session.catalogCompatibilityRange ? { catalogCompatibilityRange: session.catalogCompatibilityRange } : {}),
        enabled: false,
        active,
      };
      try {
        await this.options.store.updateIndex((index) => ({ ...index, skills: [...index.skills, record] }));
        await this.options.onChanged?.();
      } catch (error) {
        const restored = await this.restoreIndex(before);
        if (restored && !indexReferencesVersion(before, record.id, active.contentHash)) {
          await this.options.store.removeVersion(record.id, active.contentHash).catch(() => undefined);
        }
        throw error;
      }
      this.discoverySessions.delete(session.id);
      return managedSkillView(record, this.options.appVersion);
    });
  }

  async list(): Promise<ManagedSkillView[]> {
    await this.ready;
    const integrityChecked = await this.refreshIntegrityDiagnostics();
    const index = await this.refreshNameConflictDiagnostics(integrityChecked);
    return index.skills
      .map((record) => managedSkillView(record, this.options.appVersion))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async activeRuntimeRoots(): Promise<ManagedSkillRuntimeRoot[]> {
    await this.ready;
    const index = await this.refreshIntegrityDiagnostics('detached');
    return index.skills.flatMap((record): ManagedSkillRuntimeRoot[] => {
      if (
        !record.enabled
        || record.diagnostic?.code === 'modified'
        || record.diagnostic?.code === 'name_conflict'
        || currentCompatibility(record.active, this.options.appVersion).error
      ) return [];
      return [{
        id: record.id,
        name: record.name,
        rootDir: this.options.store.contentPath(record.id, record.active.contentHash),
        contentHash: record.active.contentHash,
      }];
    });
  }

  async assertInvocable(skillId: string, expectedContentHash: string): Promise<void> {
    await this.ready;
    const index = await this.options.store.readIndex();
    const record = requireRecord(index, skillId);
    if (!record.enabled) throw new ManagedSkillServiceError('skill_disabled', `Managed skill ${record.name} is disabled.`);
    if (record.active.contentHash !== expectedContentHash) {
      throw new ManagedSkillServiceError('stale_skill_version', `Managed skill ${record.name} changed versions. Invoke it again.`);
    }
    if (record.diagnostic?.code === 'modified') throw new ManagedSkillServiceError('skill_modified', record.diagnostic.message, record.name);
    if (record.diagnostic?.code === 'name_conflict') throw new ManagedSkillServiceError('duplicate_skill_name', record.diagnostic.message, record.name);
    this.assertVersionCompatible(record.name, record.active);
    await this.assertExternalNameAvailable(record.name, record.id);
    const integrity = await this.options.store.verifyVersion(record.id, record.active);
    if (!integrity.ok) {
      await this.markModified(record.id, record.active.contentHash, integrity.reason);
      throw new ManagedSkillServiceError(
        'skill_modified',
        `Managed skill ${record.name} was modified locally and has been disabled for invocation.`,
        record.name,
      );
    }
  }

  async checkUpdates(skillId?: string): Promise<ManagedSkillView[]> {
    await this.ready;
    const index = await this.options.store.readIndex();
    const targets = skillId ? [requireRecord(index, skillId)] : index.skills;
    for (const target of targets) {
      try {
        const commit = await this.github.resolveTrackingCommit({
          owner: target.origin.owner,
          repo: target.origin.repo,
          trackingRef: target.origin.trackingRef,
        });
        await this.withMutation(async () => {
          await this.options.store.updateIndex((current) => ({
            ...current,
            skills: current.skills.map((record) => sameManagedRecordSnapshot(record, target) ? {
              ...record,
              ...(commit !== record.active.commit ? { updateCommit: commit } : {}),
              ...(commit === record.active.commit ? { updateCommit: undefined } : {}),
              lastCheckedAt: this.now(),
              ...(record.diagnostic?.code === 'update_failed' ? { diagnostic: undefined } : {}),
            } : record),
          }));
        });
      } catch (error) {
        await this.recordUpdateFailure(target, error, 'Update check failed');
      }
    }
    return this.list();
  }

  async previewUpdate(input: { skillId: string; expectedActiveHash: string }): Promise<ManagedSkillUpdatePreviewView> {
    await this.ready;
    this.pruneSessions();
    const index = await this.options.store.readIndex();
    const record = requireRecord(index, input.skillId);
    this.assertExpectedActive(record, input.expectedActiveHash);
    await this.assertRecordClean(record);
    try {
      const discovery = await this.github.discover({
        sourceUrl: record.origin.repository,
        appVersion: this.options.appVersion,
        trackingRef: record.origin.trackingRef,
        subdirectory: record.origin.subdirectory,
        catalogCompatibilityRange: await this.compatibilityRangeForRecord(record),
      });
      if (discovery.origin.commit === record.active.commit) {
        throw new ManagedSkillServiceError('no_update', `${record.name} is already at the tracked commit.`, record.name);
      }
      const candidate = discovery.candidates.find((entry) => entry.view.subdirectory === record.origin.subdirectory);
      if (!candidate) {
        throw new ManagedSkillServiceError(
          'skill_moved',
          'The tracked skill folder no longer contains its root SKILL.md.',
          record.origin.subdirectory,
        );
      }
      const validated = await this.github.downloadCandidate({
        origin: discovery.origin,
        candidate,
        appVersion: this.options.appVersion,
        catalogCompatibilityRange: await this.compatibilityRangeForRecord(record),
      });
      if (validated.name !== record.name) {
        throw new ManagedSkillServiceError(
          'skill_renamed',
          `The update declares skill name "${validated.name}" instead of "${record.name}".`,
          `${record.name} -> ${validated.name}`,
        );
      }
      await this.assertExternalNameAvailable(record.name, record.id);
      const storedVersion = storedVersionFromValidated(discovery.origin.commit, this.now(), validated);
      const currentFiles = await this.options.store.readVersionFiles(record.id, record.active);
      const latest = requireRecord(await this.options.store.readIndex(), record.id);
      if (!sameManagedRecordSnapshot(latest, record)) {
        throw new ManagedSkillServiceError('stale_skill_version', `Managed skill ${record.name} changed while the update was being previewed.`);
      }
      const comparison = compareFiles(currentFiles, validated.files);
      const id = randomUUID();
      const view: ManagedSkillUpdatePreviewView = {
        id,
        skillId: record.id,
        repository: record.origin.repository,
        subdirectory: record.origin.subdirectory,
        recommended: record.recommended,
        current: versionView(record.active),
        candidate: versionView(storedVersion),
        compatibility: validated.compatibility,
        scripts: [...validated.scripts],
        changedPaths: comparison.changedPaths,
        skillDiff: comparison.skillDiff,
        diffTruncated: comparison.diffTruncated,
      };
      this.updatePreviews.set(id, {
        id,
        createdAt: this.now(),
        skillId: record.id,
        expectedActiveHash: record.active.contentHash,
        expectedRecord: record,
        validated,
        view,
      });
      this.trimSessions(this.updatePreviews);
      return view;
    } catch (error) {
      if (!(error instanceof ManagedSkillServiceError && error.code === 'no_update')) {
        await this.recordUpdateFailure(record, error, 'Update preview failed');
      }
      throw error;
    }
  }

  async applyUpdate(input: {
    skillId: string;
    previewId: string;
    expectedActiveHash: string;
    expectedCandidateHash: string;
  }): Promise<ManagedSkillView> {
    await this.ready;
    const preview = this.updatePreview(input.previewId);
    if (
      preview.skillId !== input.skillId
      || preview.expectedActiveHash !== input.expectedActiveHash
      || preview.validated.contentHash !== input.expectedCandidateHash
    ) {
      throw new ManagedSkillServiceError('stale_update_preview', 'The update preview no longer matches the requested versions.');
    }
    return this.withMutation(async () => {
      const before = await this.options.store.readIndex();
      const record = requireRecord(before, input.skillId);
      this.assertExpectedActive(record, input.expectedActiveHash);
      if (!sameManagedRecordSnapshot(record, preview.expectedRecord)) {
        throw new ManagedSkillServiceError('stale_update_preview', 'The installed skill changed after this update preview was created.');
      }
      await this.assertRecordClean(record);
      await this.assertExternalNameAvailable(record.name, record.id);
      const previousWillBeDiscarded = record.previous
        && record.previous.contentHash !== preview.validated.contentHash
        && record.previous.contentHash !== record.active.contentHash;
      if (previousWillBeDiscarded) {
        const previousIntegrity = await this.options.store.verifyVersion(record.id, record.previous!);
        if (!previousIntegrity.ok) {
          throw new ManagedSkillServiceError(
            'previous_version_modified',
            `The retained previous version of ${record.name} was modified locally and will not be removed automatically. Uninstall and reinstall the skill to continue.`,
            record.name,
          );
        }
      }
      await this.options.store.installValidatedContent(record.id, preview.validated);
      const appliedVersion = storedVersionFromValidated(
        preview.view.candidate.commit,
        this.now(),
        preview.validated,
      );
      const nextRecord: ManagedSkillRecord = {
        ...record,
        active: appliedVersion,
        previous: record.active,
        updateCommit: undefined,
        diagnostic: undefined,
      };
      try {
        await this.options.store.updateIndex((current) => ({
          ...current,
          skills: current.skills.map((candidate) => candidate.id === record.id ? nextRecord : candidate),
        }));
        await this.options.onChanged?.();
      } catch (error) {
        const restored = await this.restoreIndex(before);
        if (restored && !indexReferencesVersion(before, record.id, appliedVersion.contentHash)) {
          await this.options.store.removeVersion(record.id, appliedVersion.contentHash).catch(() => undefined);
        }
        throw error;
      }
      if (
        record.previous
        && record.previous.contentHash !== nextRecord.active.contentHash
        && record.previous.contentHash !== nextRecord.previous?.contentHash
      ) {
        await this.options.store.removeVersion(record.id, record.previous.contentHash).catch(() => undefined);
      }
      this.updatePreviews.delete(preview.id);
      return managedSkillView(nextRecord, this.options.appVersion);
    });
  }

  async setEnabled(input: { skillId: string; enabled: boolean; expectedActiveHash: string }): Promise<ManagedSkillView> {
    await this.ready;
    return this.withMutation(async () => {
      const before = await this.options.store.readIndex();
      const record = requireRecord(before, input.skillId);
      this.assertExpectedActive(record, input.expectedActiveHash);
      if (input.enabled) {
        this.assertVersionCompatible(record.name, record.active);
        await this.assertRecordClean(record);
        await this.assertExternalNameAvailable(record.name, record.id);
      }
      const nextRecord = { ...record, enabled: input.enabled };
      try {
        await this.options.store.updateIndex((current) => ({
          ...current,
          skills: current.skills.map((candidate) => candidate.id === record.id ? nextRecord : candidate),
        }));
        await this.options.onChanged?.();
      } catch (error) {
        await this.restoreIndex(before);
        throw error;
      }
      return managedSkillView(nextRecord, this.options.appVersion);
    });
  }

  async rollback(input: {
    skillId: string;
    expectedActiveHash: string;
    expectedPreviousHash: string;
  }): Promise<ManagedSkillView> {
    await this.ready;
    return this.withMutation(async () => {
      const before = await this.options.store.readIndex();
      const record = requireRecord(before, input.skillId);
      this.assertExpectedActive(record, input.expectedActiveHash);
      if (!record.previous || record.previous.contentHash !== input.expectedPreviousHash) {
        throw new ManagedSkillServiceError('previous_version_missing', 'The previous managed skill version is no longer available.');
      }
      this.assertVersionCompatible(record.name, record.previous);
      await this.assertRecordClean(record);
      const previousIntegrity = await this.options.store.verifyVersion(record.id, record.previous);
      if (!previousIntegrity.ok) {
        throw new ManagedSkillServiceError(
          'previous_version_modified',
          previousIntegrity.reason ?? 'The previous version failed integrity validation.',
          record.name,
        );
      }
      await this.assertExternalNameAvailable(record.name, record.id);
      const nextRecord: ManagedSkillRecord = {
        ...record,
        active: record.previous,
        previous: record.active,
        updateCommit: record.active.commit,
        diagnostic: {
          code: 'rolled_back',
          message: `Rolled back from ${record.active.commit.slice(0, 12)}.`,
          errorCode: 'rolled_back',
          detail: record.active.commit.slice(0, 12),
          at: this.now(),
        },
      };
      try {
        await this.options.store.updateIndex((current) => ({
          ...current,
          skills: current.skills.map((candidate) => candidate.id === record.id ? nextRecord : candidate),
        }));
        await this.options.onChanged?.();
      } catch (error) {
        await this.restoreIndex(before);
        throw error;
      }
      return managedSkillView(nextRecord, this.options.appVersion);
    });
  }

  async uninstall(input: { skillId: string; expectedActiveHash: string }): Promise<ManagedSkillView[]> {
    await this.ready;
    return this.withMutation(async () => {
      const before = await this.options.store.readIndex();
      const record = requireRecord(before, input.skillId);
      this.assertExpectedActive(record, input.expectedActiveHash);
      const next = { ...before, skills: before.skills.filter((candidate) => candidate.id !== record.id) };
      try {
        await this.options.store.replaceIndex(next);
        await this.options.onChanged?.();
      } catch (error) {
        await this.restoreIndex(before);
        throw error;
      }
      await this.options.store.removeSkill(record.id).catch(() => undefined);
      return next.skills.map((record) => managedSkillView(record, this.options.appVersion));
    });
  }

  private async refreshIntegrityDiagnostics(
    notification: 'await' | 'detached' = 'await',
  ): Promise<ManagedSkillIndex> {
    const index = await this.options.store.readIndex();
    const modified = new Map<string, { contentHash: string; reason: string }>();
    for (const record of index.skills) {
      if (record.diagnostic?.code === 'modified') continue;
      const integrity = await this.options.store.verifyVersion(record.id, record.active);
      if (!integrity.ok) {
        modified.set(record.id, {
          contentHash: record.active.contentHash,
          reason: integrity.reason ?? 'Managed skill content changed locally.',
        });
      }
    }
    if (modified.size === 0) return index;
    const next = await this.options.store.updateIndex((current) => ({
      ...current,
      skills: current.skills.map((record) => {
        const failure = modified.get(record.id);
        return failure && failure.contentHash === record.active.contentHash ? {
          ...record,
          diagnostic: {
            code: 'modified' as const,
            message: `Managed skill ${record.name} was modified locally. Uninstall and reinstall it before invoking or updating. ${failure.reason}`.trim(),
            at: this.now(),
          },
        } : record;
      }),
    }));
    if (notification === 'await') {
      await this.options.onChanged?.();
    } else if (this.options.onChanged) {
      void Promise.resolve().then(() => this.options.onChanged?.()).catch(() => undefined);
    }
    return next;
  }

  private async refreshNameConflictDiagnostics(index: ManagedSkillIndex): Promise<ManagedSkillIndex> {
    if (!this.options.findNameConflict) return index;
    const conflicts = new Map<string, ManagedSkillNameConflict>();
    for (const record of index.skills) {
      if (record.diagnostic?.code === 'modified') continue;
      const conflict = await this.options.findNameConflict(record.name, record.id);
      if (conflict) conflicts.set(record.id, conflict);
    }
    const changed = index.skills.some((record) => {
      if (record.diagnostic?.code === 'modified') return false;
      const conflict = conflicts.get(record.id);
      if (!conflict) return record.diagnostic?.code === 'name_conflict';
      return record.diagnostic?.code !== 'name_conflict'
        || record.diagnostic.message !== nameConflictDiagnostic(record, conflict);
    });
    if (!changed) return index;
    const next = await this.options.store.updateIndex((current) => ({
      ...current,
      skills: current.skills.map((record) => {
        if (record.diagnostic?.code === 'modified') return record;
        const conflict = conflicts.get(record.id);
        if (conflict) return {
          ...record,
          diagnostic: {
            code: 'name_conflict' as const,
            message: nameConflictDiagnostic(record, conflict),
            at: this.now(),
          },
        };
        if (record.diagnostic?.code !== 'name_conflict') return record;
        const { diagnostic: _removed, ...restored } = record;
        return restored;
      }),
    }));
    await this.options.onChanged?.();
    return next;
  }

  private async markModified(skillId: string, expectedContentHash: string, reason?: string): Promise<void> {
    await this.options.store.updateIndex((index) => ({
      ...index,
      skills: index.skills.map((record) => record.id === skillId && record.active.contentHash === expectedContentHash ? {
        ...record,
        diagnostic: {
          code: 'modified' as const,
          message: `Managed skill ${record.name} was modified locally. Uninstall and reinstall it before invoking or updating. ${reason ?? ''}`.trim(),
          at: this.now(),
        },
      } : record),
    }));
    await this.options.onChanged?.();
  }

  private async assertRecordClean(record: ManagedSkillRecord): Promise<void> {
    if (record.diagnostic?.code === 'modified') throw new ManagedSkillServiceError('skill_modified', record.diagnostic.message, record.name);
    const integrity = await this.options.store.verifyVersion(record.id, record.active);
    if (!integrity.ok) {
      await this.markModified(record.id, record.active.contentHash, integrity.reason);
      throw new ManagedSkillServiceError(
        'skill_modified',
        `Managed skill ${record.name} was modified locally. Uninstall and reinstall it before continuing.`,
        record.name,
      );
    }
  }

  private async assertNameAvailable(index: ManagedSkillIndex, name: string): Promise<void> {
    const managed = index.skills.find((record) => record.name === name);
    if (managed) {
      const location = managed.origin.subdirectory
        ? `${managed.origin.repository}/${managed.origin.subdirectory}`
        : managed.origin.repository;
      throw new ManagedSkillServiceError(
        'duplicate_skill_name',
        `A managed skill named "${name}" is already installed from ${location}.`,
        `${name} @ ${location}`,
      );
    }
    await this.assertExternalNameAvailable(name);
  }

  private async assertExternalNameAvailable(name: string, excludingManagedSkillId?: string): Promise<void> {
    const conflict = await this.options.findNameConflict?.(name, excludingManagedSkillId);
    if (conflict) {
      throw new ManagedSkillServiceError(
        'duplicate_skill_name',
        `Skill name "${name}" conflicts with a ${conflict.source} skill at ${conflict.location}.`,
        `${name} @ ${conflict.source}:${conflict.location}`,
      );
    }
  }

  private assertExpectedActive(record: ManagedSkillRecord, expectedHash: string): void {
    if (record.active.contentHash !== expectedHash) {
      throw new ManagedSkillServiceError('stale_skill_version', `Managed skill ${record.name} changed since this view loaded.`);
    }
  }

  private assertVersionCompatible(name: string, version: ManagedSkillStoredVersion): void {
    const compatibility = currentCompatibility(version, this.options.appVersion);
    if (compatibility.error) {
      throw new ManagedSkillServiceError(
        'incompatible_tenon',
        `Managed skill ${name} is not compatible with this Tenon version. ${compatibility.error}`,
        compatibility.view.declaredRange,
      );
    }
  }

  private async recordUpdateFailure(expected: ManagedSkillRecord, error: unknown, prefix: string): Promise<void> {
    const view = managedSkillErrorView(error);
    const message = `${prefix}: ${errorMessage(error)}`;
    await this.withMutation(async () => {
      await this.options.store.updateIndex((index) => ({
        ...index,
        skills: index.skills.map((record) => sameManagedRecordSnapshot(record, expected)
          && record.diagnostic?.code !== 'modified'
          && record.diagnostic?.code !== 'name_conflict' ? {
          ...record,
          diagnostic: {
            code: 'update_failed' as const,
            message,
            errorCode: view.code,
            ...(view.detail ? { detail: view.detail } : {}),
            at: this.now(),
          },
        } : record),
      }));
    });
  }

  private async compatibilityRangeForRecord(record: ManagedSkillRecord): Promise<string | undefined> {
    return record.catalogCompatibilityRange;
  }

  private async restoreIndex(index: ManagedSkillIndex): Promise<boolean> {
    try {
      await this.options.store.replaceIndex(index);
      await this.options.onChanged?.();
      return true;
    } catch {
      // Preserve the operation failure; persisted state is re-read before every invocation.
      return false;
    }
  }

  private async catalogEntry(id: string): Promise<CatalogEntry> {
    let catalog = this.lastCatalog;
    if (!catalog) {
      try {
        catalog = parseCatalogCache(await this.options.store.readCatalogCache()).catalog;
        this.lastCatalog = catalog;
      } catch {
        const loaded = await this.loadCatalog();
        if (loaded.status === 'unavailable' || !this.lastCatalog) {
          throw new ManagedSkillServiceError('catalog_unavailable', 'The Linlab Catalog is unavailable.');
        }
        catalog = this.lastCatalog;
      }
    }
    const entry = catalog.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new ManagedSkillServiceError('catalog_entry_not_found', `Catalog skill "${id}" is unavailable.`, id);
    return entry;
  }

  private async catalogView(
    catalog: CatalogDocument,
    status: 'fresh' | 'cached',
    refreshedAt: number,
    error?: ManagedSkillErrorView,
  ): Promise<ManagedSkillCatalogView> {
    const installed = await this.options.store.readIndex();
    return {
      status,
      refreshedAt,
      ...(error ? { error } : {}),
      entries: catalog.entries.map((entry): ManagedSkillCatalogEntryView => ({
        ...entry,
        ...(installed.skills.find((skill) => skill.catalogId === entry.id)?.id
          ? { installedSkillId: installed.skills.find((skill) => skill.catalogId === entry.id)?.id }
          : {}),
      })),
    };
  }

  private discoverySession(id: string): DiscoverySession {
    this.pruneSessions();
    const session = this.discoverySessions.get(id);
    if (!session) throw new ManagedSkillServiceError('discovery_expired', 'GitHub discovery expired. Resolve the repository again.');
    return session;
  }

  private updatePreview(id: string): UpdatePreviewSession {
    this.pruneSessions();
    const preview = this.updatePreviews.get(id);
    if (!preview) throw new ManagedSkillServiceError('update_preview_expired', 'The update preview expired. Preview the update again.');
    return preview;
  }

  private pruneSessions(): void {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, session] of this.discoverySessions) if (session.createdAt < cutoff) this.discoverySessions.delete(id);
    for (const [id, session] of this.updatePreviews) if (session.createdAt < cutoff) this.updatePreviews.delete(id);
  }

  private trimSessions<T extends { createdAt: number }>(sessions: Map<string, T>): void {
    while (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
      if (!oldest) return;
      sessions.delete(oldest[0]);
    }
  }

  private withMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task, task);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function discoveryView(session: DiscoverySession): ManagedSkillDiscoveryView {
  return {
    id: session.id,
    repository: session.discovery.origin.repository,
    trackingRef: session.discovery.origin.trackingRef,
    resolvedCommit: session.discovery.origin.commit,
    recommended: session.recommended,
    selectionRequired: session.discovery.candidates.length > 1,
    candidates: session.discovery.candidates.map((candidate) => candidate.view),
  };
}

function managedSkillView(record: ManagedSkillRecord, appVersion: string): ManagedSkillView {
  const compatibility = currentCompatibility(record.active, appVersion);
  const diagnostic = managedSkillDiagnosticView(record, compatibility);
  const status = record.diagnostic?.code === 'modified'
    ? 'modified'
    : record.diagnostic?.code === 'update_failed' || record.diagnostic?.code === 'name_conflict' || compatibility.error
      ? 'failed'
      : record.updateCommit
        ? 'update-available'
        : record.enabled
          ? 'enabled'
          : 'installed-disabled';
  return {
    id: record.id,
    name: record.name,
    description: record.active.description,
    repository: record.origin.repository,
    subdirectory: record.origin.subdirectory,
    trackingRef: record.origin.trackingRef,
    recommended: record.recommended,
    enabled: record.enabled,
    status,
    compatibility: compatibility.view,
    active: versionView(record.active, appVersion),
    ...(record.previous ? { previous: versionView(record.previous, appVersion) } : {}),
    ...(record.updateCommit ? { updateCommit: record.updateCommit } : {}),
    scripts: [...record.active.scripts],
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function managedSkillDiagnosticView(
  record: ManagedSkillRecord,
  compatibility: ReturnType<typeof currentCompatibility>,
): ManagedSkillErrorView | undefined {
  if (record.diagnostic?.code === 'modified') return { code: 'skill_modified', detail: record.name };
  if (record.diagnostic?.code === 'name_conflict') return { code: 'duplicate_skill_name', detail: record.name };
  if (record.diagnostic?.code === 'update_failed') {
    return {
      code: record.diagnostic.errorCode ?? 'update_failed',
      ...(record.diagnostic.detail ? { detail: record.diagnostic.detail } : {}),
    };
  }
  if (record.diagnostic?.code === 'rolled_back') {
    return {
      code: 'rolled_back',
      ...(record.diagnostic.detail ? { detail: record.diagnostic.detail } : {}),
    };
  }
  if (compatibility.error) {
    return {
      code: 'incompatible_tenon',
      ...(compatibility.view.declaredRange ? { detail: compatibility.view.declaredRange } : {}),
    };
  }
  return undefined;
}

function versionView(version: ManagedSkillStoredVersion, appVersion = version.compatibility.appVersion): ManagedSkillVersionView {
  return {
    commit: version.commit,
    contentHash: version.contentHash,
    installedAt: version.installedAt,
    fileCount: version.fileCount,
    totalBytes: version.totalBytes,
    compatibility: currentCompatibility(version, appVersion).view,
    scripts: [...version.scripts],
    ...(version.version ? { version: version.version } : {}),
  };
}

function currentCompatibility(
  version: ManagedSkillStoredVersion,
  appVersion: string,
): { view: ManagedSkillCompatibilityView; error?: string } {
  const ranges = version.compatibility.declaredRanges ?? [];
  try {
    return {
      view: resolveManagedSkillCompatibility({
        appVersion,
        catalogRange: ranges[0],
        skillRange: ranges[1],
      }),
    };
  } catch (error) {
    return {
      view: {
        status: 'incompatible',
        appVersion,
        ...(version.compatibility.declaredRange ? { declaredRange: version.compatibility.declaredRange } : {}),
        ...(ranges.length > 0 ? { declaredRanges: [...ranges] } : {}),
      },
      error: errorMessage(error),
    };
  }
}

function requireRecord(index: ManagedSkillIndex, skillId: string): ManagedSkillRecord {
  const record = index.skills.find((candidate) => candidate.id === skillId);
  if (!record) throw new ManagedSkillServiceError('managed_skill_not_found', `Managed skill "${skillId}" is not installed.`, skillId);
  return record;
}

function indexReferencesVersion(index: ManagedSkillIndex, skillId: string, contentHash: string): boolean {
  const record = index.skills.find((candidate) => candidate.id === skillId);
  return record?.active.contentHash === contentHash || record?.previous?.contentHash === contentHash;
}

function sameManagedRecordSnapshot(current: ManagedSkillRecord, expected: ManagedSkillRecord): boolean {
  return current.id === expected.id
    && current.active.commit === expected.active.commit
    && current.active.contentHash === expected.active.contentHash
    && current.active.installedAt === expected.active.installedAt
    && current.origin.repository === expected.origin.repository
    && current.origin.subdirectory === expected.origin.subdirectory
    && current.origin.trackingRef === expected.origin.trackingRef;
}

function nameConflictDiagnostic(record: ManagedSkillRecord, conflict: ManagedSkillNameConflict): string {
  return `Managed skill ${record.name} is suppressed by a ${conflict.source} skill at ${conflict.location}.`;
}

function parseCatalogDocument(value: unknown): CatalogDocument {
  if (!isRecord(value) || value.schemaVersion !== CATALOG_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    throw new ManagedSkillServiceError('invalid_catalog', 'Linlab Catalog has an unsupported schema.');
  }
  if (value.entries.length > MAX_CATALOG_ENTRIES) {
    throw new ManagedSkillServiceError('invalid_catalog', `Linlab Catalog exceeds the ${MAX_CATALOG_ENTRIES}-entry limit.`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const entries = value.entries.map((entry): CatalogEntry => {
    if (!isRecord(entry)) throw new ManagedSkillServiceError('invalid_catalog', 'Linlab Catalog contains an invalid entry.');
    const compatibilityRange = catalogCompatibilityRange(entry.compatibilityRange);
    const parsed: CatalogEntry = {
      id: catalogString(entry.id, 'id'),
      name: catalogString(entry.name, 'name'),
      description: catalogString(entry.description, 'description'),
      repository: catalogRepository(entry.repository),
      subdirectory: catalogPath(entry.subdirectory),
      trackingRef: catalogTrackingRef(entry.trackingRef),
      ...(compatibilityRange ? { compatibilityRange } : {}),
    };
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.id) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.name)) {
      throw new ManagedSkillServiceError('invalid_catalog', `Catalog entry ${parsed.id} has an invalid id or skill name.`);
    }
    if (ids.has(parsed.id) || names.has(parsed.name)) throw new ManagedSkillServiceError('invalid_catalog', `Catalog contains duplicate entry ${parsed.id}.`);
    ids.add(parsed.id);
    names.add(parsed.name);
    return parsed;
  });
  return { schemaVersion: CATALOG_SCHEMA_VERSION, entries };
}

function parseCatalogCache(value: unknown): CatalogCache {
  if (
    !isRecord(value)
    || value.schemaVersion !== CATALOG_SCHEMA_VERSION
    || typeof value.refreshedAt !== 'number'
    || !Number.isSafeInteger(value.refreshedAt)
    || value.refreshedAt < 0
  ) {
    throw new ManagedSkillServiceError('invalid_catalog_cache', 'No valid cached Linlab Catalog is available.');
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    refreshedAt: value.refreshedAt,
    catalog: parseCatalogDocument(value.catalog),
  };
}

function catalogString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) {
    throw new ManagedSkillServiceError('invalid_catalog', `Catalog field ${field} is invalid.`);
  }
  return value.trim();
}

function catalogRepository(value: unknown): string {
  const repository = catalogString(value, 'repository');
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new ManagedSkillServiceError('invalid_catalog', `Catalog repository is invalid: ${repository}`);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash || url.username || url.password || url.port) {
    throw new ManagedSkillServiceError('invalid_catalog', `Catalog repository must be a public github.com HTTPS URL: ${repository}`);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) throw new ManagedSkillServiceError('invalid_catalog', `Catalog repository must identify exactly one GitHub repository: ${repository}`);
  return `https://github.com/${segments[0]}/${segments[1]?.replace(/\.git$/i, '')}`;
}

function catalogPath(value: unknown): string {
  const result = catalogString(value, 'subdirectory').replace(/^\/+|\/+$/g, '');
  if (!result || result.includes('\\') || result.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ManagedSkillServiceError('invalid_catalog', `Catalog subdirectory is invalid: ${result}`);
  }
  return result;
}

function catalogTrackingRef(value: unknown): string {
  const ref = catalogString(value, 'trackingRef');
  try {
    return validateGitHubTrackingRef(ref);
  } catch {
    throw new ManagedSkillServiceError('invalid_catalog', `Catalog trackingRef is invalid: ${ref}`);
  }
}

function catalogCompatibilityRange(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const range = catalogString(value, 'compatibilityRange');
  if (!validRange(range)) {
    throw new ManagedSkillServiceError('invalid_catalog', `Catalog compatibilityRange is invalid: ${range}`);
  }
  return range;
}

function compareFiles(
  currentFiles: readonly ManagedSkillFile[],
  candidateFiles: readonly ManagedSkillFile[],
): { changedPaths: string[]; skillDiff: string; diffTruncated: boolean } {
  const current = new Map(currentFiles.map((file) => [file.relativePath, hashBytes(file.bytes)]));
  const candidate = new Map(candidateFiles.map((file) => [file.relativePath, hashBytes(file.bytes)]));
  const allPaths = [...new Set([...current.keys(), ...candidate.keys()])].sort();
  const changed = allPaths.filter((filePath) => current.get(filePath) !== candidate.get(filePath));
  const changedPaths = changed.slice(0, MAX_CHANGED_PATHS);
  if (changed.length > MAX_CHANGED_PATHS) changedPaths.push(`... ${changed.length - MAX_CHANGED_PATHS} more paths`);
  const oldSkill = currentFiles.find((file) => file.relativePath === 'SKILL.md');
  const newSkill = candidateFiles.find((file) => file.relativePath === 'SKILL.md');
  const diff = boundedLineDiff(
    oldSkill ? Buffer.from(oldSkill.bytes).toString('utf8') : '',
    newSkill ? Buffer.from(newSkill.bytes).toString('utf8') : '',
  );
  return { changedPaths, skillDiff: diff.text, diffTruncated: diff.truncated || changed.length > MAX_CHANGED_PATHS };
}

function boundedLineDiff(before: string, after: string): { text: string; truncated: boolean } {
  if (before === after) return { text: 'SKILL.md is unchanged.', truncated: false };
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + 3);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + 3);
  const lines = [
    `@@ -${contextStart + 1},${beforeEnd - contextStart} +${contextStart + 1},${afterEnd - contextStart} @@`,
    ...beforeLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, beforeLines.length - suffix).map((line) => `-${line}`),
    ...afterLines.slice(prefix, afterLines.length - suffix).map((line) => `+${line}`),
    ...afterLines.slice(afterLines.length - suffix, afterEnd).map((line) => ` ${line}`),
  ];
  let text = lines.slice(0, MAX_DIFF_LINES).join('\n');
  const truncated = lines.length > MAX_DIFF_LINES || text.length > MAX_DIFF_CHARS;
  if (text.length > MAX_DIFF_CHARS) text = text.slice(0, MAX_DIFF_CHARS);
  if (truncated) text = `${text}\n... diff truncated`;
  return { text, truncated };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedErrorDetail(detail: string | undefined): string | undefined {
  const normalized = detail?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
