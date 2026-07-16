import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedSkillGitHubClient, ManagedSkillGitHubDiscovery } from '../../src/main/managedSkillGitHub';
import { ManagedSkillService } from '../../src/main/managedSkillService';
import { ManagedSkillStore } from '../../src/main/managedSkillStore';
import { validateManagedSkillFiles, type ValidatedManagedSkill } from '../../src/main/managedSkillValidation';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

describe('managed skill service', () => {
  test('installs disabled, enables explicitly, discovers updates without activation, then applies and rolls back', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    let changes = 0;
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
      now: incrementingClock(),
      onChanged: () => { changes += 1; },
    });

    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    expect(discovery.resolvedCommit).toBe('a'.repeat(40));
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    expect(installed).toMatchObject({ status: 'installed-disabled', enabled: false });
    expect(await service.activeRuntimeRoots()).toEqual([]);

    const enabled = await service.setEnabled({
      skillId: installed.id,
      enabled: true,
      expectedActiveHash: installed.active.contentHash,
    });
    expect(enabled.status).toBe('enabled');
    expect((await service.activeRuntimeRoots())[0]).toMatchObject({
      id: installed.id,
      contentHash: installed.active.contentHash,
    });
    await service.assertInvocable(installed.id, installed.active.contentHash);

    github.version = 2;
    const [updateAvailable] = await service.checkUpdates(installed.id);
    expect(updateAvailable?.status).toBe('update-available');
    expect(updateAvailable?.active.contentHash).toBe(installed.active.contentHash);

    const preview = await service.previewUpdate({
      skillId: installed.id,
      expectedActiveHash: installed.active.contentHash,
    });
    expect(preview.candidate.commit).toBe('b'.repeat(40));
    expect(preview.candidate.contentHash).not.toBe(installed.active.contentHash);
    expect(preview.changedPaths).toContain('SKILL.md');

    const updated = await service.applyUpdate({
      skillId: installed.id,
      previewId: preview.id,
      expectedActiveHash: installed.active.contentHash,
      expectedCandidateHash: preview.candidate.contentHash,
    });
    expect(updated.active.contentHash).toBe(preview.candidate.contentHash);
    expect(updated.active.installedAt).toBeGreaterThan(preview.candidate.installedAt);
    expect(updated.previous?.contentHash).toBe(installed.active.contentHash);

    const rolledBack = await service.rollback({
      skillId: installed.id,
      expectedActiveHash: updated.active.contentHash,
      expectedPreviousHash: installed.active.contentHash,
    });
    expect(rolledBack.active.contentHash).toBe(installed.active.contentHash);
    expect(rolledBack.diagnostic).toContain('Rolled back');
    expect(changes).toBeGreaterThanOrEqual(4);
  });

  test('keeps installed bytes usable offline and preserves the active version after update failure', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    await service.setEnabled({ skillId: installed.id, enabled: true, expectedActiveHash: installed.active.contentHash });

    github.offline = true;
    expect((await service.list())[0]?.active.contentHash).toBe(installed.active.contentHash);
    await service.assertInvocable(installed.id, installed.active.contentHash);
    const [checked] = await service.checkUpdates(installed.id);
    expect(checked?.status).toBe('failed');
    expect(checked?.active.contentHash).toBe(installed.active.contentHash);
  });

  test('does not project a stale update check onto a reinstalled same-name skill', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
      now: incrementingClock(),
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });

    let releaseUpdateCheck: () => void = () => undefined;
    let markUpdateCheckStarted: () => void = () => undefined;
    github.updateCheckGate = new Promise<void>((resolve) => { releaseUpdateCheck = resolve; });
    const updateCheckStarted = new Promise<void>((resolve) => { markUpdateCheckStarted = resolve; });
    github.onUpdateCheckStarted = markUpdateCheckStarted;
    github.version = 2;
    const staleCheck = service.checkUpdates(installed.id);
    await updateCheckStarted;

    await service.uninstall({ skillId: installed.id, expectedActiveHash: installed.active.contentHash });
    github.version = 3;
    const rediscovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const reinstalled = await service.install({
      discoveryId: rediscovery.id,
      candidateId: rediscovery.candidates[0]!.id,
      expectedCommit: rediscovery.resolvedCommit,
    });
    releaseUpdateCheck();

    const [afterStaleCheck] = await staleCheck;
    expect(afterStaleCheck?.active).toMatchObject({
      commit: reinstalled.active.commit,
      contentHash: reinstalled.active.contentHash,
    });
    expect(afterStaleCheck?.updateCommit).toBeUndefined();
    expect(afterStaleCheck?.diagnostic).toBeUndefined();
  });

  test('keeps bytes installed but suppresses a version after Tenon leaves its compatibility range', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const github = new FakeGitHub();
    const original = new ManagedSkillService({
      appVersion: '0.1.0',
      store,
      github: github as unknown as ManagedSkillGitHubClient,
    });
    const discovery = await original.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await original.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    await original.setEnabled({ skillId: installed.id, enabled: true, expectedActiveHash: installed.active.contentHash });

    const upgraded = new ManagedSkillService({
      appVersion: '0.2.0',
      store,
      github: github as unknown as ManagedSkillGitHubClient,
    });
    const [incompatible] = await upgraded.list();
    expect(incompatible).toMatchObject({
      status: 'failed',
      enabled: true,
      compatibility: { status: 'incompatible', appVersion: '0.2.0' },
    });
    expect(incompatible?.diagnostic).toContain('requires Tenon');
    expect(await upgraded.activeRuntimeRoots()).toEqual([]);
    await expect(upgraded.assertInvocable(installed.id, installed.active.contentHash))
      .rejects.toThrow('not compatible with this Tenon version');
  });

  test('restores an active same-hash version when post-flip registry refresh fails', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    github.sameContentUpdate = true;
    let rejectRefresh = false;
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
      onChanged: () => {
        if (rejectRefresh) throw new Error('registry refresh failed');
      },
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    const enabled = await service.setEnabled({
      skillId: installed.id,
      enabled: true,
      expectedActiveHash: installed.active.contentHash,
    });
    github.version = 2;
    const preview = await service.previewUpdate({
      skillId: enabled.id,
      expectedActiveHash: enabled.active.contentHash,
    });
    expect(preview.candidate.contentHash).toBe(enabled.active.contentHash);

    rejectRefresh = true;
    await expect(service.applyUpdate({
      skillId: enabled.id,
      previewId: preview.id,
      expectedActiveHash: enabled.active.contentHash,
      expectedCandidateHash: preview.candidate.contentHash,
    })).rejects.toThrow('registry refresh failed');
    rejectRefresh = false;

    const [restored] = await service.list();
    expect(restored?.active).toMatchObject({
      commit: 'a'.repeat(40),
      contentHash: enabled.active.contentHash,
    });
    await service.assertInvocable(enabled.id, enabled.active.contentHash);
  });

  test('rejects an update preview created before a same-hash reinstall', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
      now: incrementingClock(),
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    github.version = 2;
    const stalePreview = await service.previewUpdate({
      skillId: installed.id,
      expectedActiveHash: installed.active.contentHash,
    });

    await service.uninstall({ skillId: installed.id, expectedActiveHash: installed.active.contentHash });
    github.version = 1;
    const rediscovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const reinstalled = await service.install({
      discoveryId: rediscovery.id,
      candidateId: rediscovery.candidates[0]!.id,
      expectedCommit: rediscovery.resolvedCommit,
    });
    expect(reinstalled.active.contentHash).toBe(installed.active.contentHash);

    await expect(service.applyUpdate({
      skillId: reinstalled.id,
      previewId: stalePreview.id,
      expectedActiveHash: reinstalled.active.contentHash,
      expectedCandidateHash: stalePreview.candidate.contentHash,
    })).rejects.toThrow('changed after this update preview');
    expect((await service.list())[0]?.active.commit).toBe('a'.repeat(40));
  });

  test('retains rollback bytes across a same-hash commit followed by a changed-hash update', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    github.sameContentUpdate = true;
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    await service.setEnabled({ skillId: installed.id, enabled: true, expectedActiveHash: installed.active.contentHash });

    github.version = 2;
    const sameHashPreview = await service.previewUpdate({
      skillId: installed.id,
      expectedActiveHash: installed.active.contentHash,
    });
    const sameHash = await service.applyUpdate({
      skillId: installed.id,
      previewId: sameHashPreview.id,
      expectedActiveHash: installed.active.contentHash,
      expectedCandidateHash: sameHashPreview.candidate.contentHash,
    });
    expect(sameHash.active).toMatchObject({ commit: 'b'.repeat(40), contentHash: installed.active.contentHash });

    github.sameContentUpdate = false;
    github.version = 3;
    const changedPreview = await service.previewUpdate({
      skillId: sameHash.id,
      expectedActiveHash: sameHash.active.contentHash,
    });
    const changed = await service.applyUpdate({
      skillId: sameHash.id,
      previewId: changedPreview.id,
      expectedActiveHash: sameHash.active.contentHash,
      expectedCandidateHash: changedPreview.candidate.contentHash,
    });
    expect(changed.previous?.contentHash).toBe(installed.active.contentHash);

    const rolledBack = await service.rollback({
      skillId: changed.id,
      expectedActiveHash: changed.active.contentHash,
      expectedPreviousHash: installed.active.contentHash,
    });
    expect(rolledBack.active).toMatchObject({ commit: 'b'.repeat(40), contentHash: installed.active.contentHash });
  });

  test('does not silently delete a locally modified retained previous version', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const github = new FakeGitHub();
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store,
      github: github as unknown as ManagedSkillGitHubClient,
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    await service.setEnabled({ skillId: installed.id, enabled: true, expectedActiveHash: installed.active.contentHash });
    github.version = 2;
    const firstPreview = await service.previewUpdate({ skillId: installed.id, expectedActiveHash: installed.active.contentHash });
    const firstUpdate = await service.applyUpdate({
      skillId: installed.id,
      previewId: firstPreview.id,
      expectedActiveHash: installed.active.contentHash,
      expectedCandidateHash: firstPreview.candidate.contentHash,
    });
    const previousFile = path.join(store.contentPath(installed.id, installed.active.contentHash), 'SKILL.md');
    if (process.platform !== 'win32') await chmod(previousFile, 0o600);
    await writeFile(previousFile, 'locally modified previous\n', 'utf8');

    github.version = 3;
    const secondPreview = await service.previewUpdate({ skillId: firstUpdate.id, expectedActiveHash: firstUpdate.active.contentHash });
    await expect(service.applyUpdate({
      skillId: firstUpdate.id,
      previewId: secondPreview.id,
      expectedActiveHash: firstUpdate.active.contentHash,
      expectedCandidateHash: secondPreview.candidate.contentHash,
    })).rejects.toThrow('will not be removed automatically');

    const [preserved] = await service.list();
    expect(preserved?.active.contentHash).toBe(firstUpdate.active.contentHash);
    expect(await readFile(previousFile, 'utf8')).toBe('locally modified previous\n');
  });

  test('fails duplicate names with the conflicting source and path', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
      findNameConflict: async () => ({ source: 'project', location: '/workspace/.agents/skills/demo-skill/SKILL.md' }),
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });

    await expect(service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    })).rejects.toThrow('conflicts with a project skill at /workspace/.agents/skills/demo-skill/SKILL.md');
    expect(await service.list()).toEqual([]);
  });

  test('blocks invocation when a project skill takes the name after enable', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    let conflict: { source: 'project'; location: string } | null = null;
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
      findNameConflict: async () => conflict,
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    await service.setEnabled({ skillId: installed.id, enabled: true, expectedActiveHash: installed.active.contentHash });

    conflict = { source: 'project', location: '/workspace/.agents/skills/demo-skill/SKILL.md' };
    await expect(service.assertInvocable(installed.id, installed.active.contentHash))
      .rejects.toThrow('conflicts with a project skill');
    expect((await service.list())[0]).toMatchObject({ status: 'failed', enabled: true });
  });

  test('keeps a modified diagnostic authoritative when a name conflict also appears', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const github = new FakeGitHub();
    let conflict = false;
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store,
      github: github as unknown as ManagedSkillGitHubClient,
      findNameConflict: async () => conflict
        ? { source: 'project', location: '/workspace/.agents/skills/demo-skill/SKILL.md' }
        : null,
    });
    const discovery = await service.discover({ sourceUrl: 'https://github.com/public/repo' });
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });
    const skillFile = path.join(store.contentPath(installed.id, installed.active.contentHash), 'SKILL.md');
    if (process.platform !== 'win32') await chmod(skillFile, 0o600);
    await writeFile(skillFile, 'locally modified\n', 'utf8');
    conflict = true;

    const [modified] = await service.list();
    expect(modified).toMatchObject({ status: 'modified' });
    expect(modified?.diagnostic).toContain('modified locally');
    expect(modified?.diagnostic).not.toContain('suppressed');
  });

  test('caches the last valid catalog and falls back to it when refresh validation fails', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const github = new FakeGitHub();
    github.catalog = catalogFixture();
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store,
      github: github as unknown as ManagedSkillGitHubClient,
      now: () => 42_000,
    });

    const fresh = await service.loadCatalog();
    expect(fresh).toMatchObject({
      status: 'fresh',
      refreshedAt: 42_000,
      entries: [{ id: 'demo-skill', name: 'demo-skill' }],
    });

    github.catalog = {
      schemaVersion: 1,
      entries: [
        catalogFixture().entries[0],
        { ...catalogFixture().entries[0], id: 'duplicate-id' },
      ],
    };
    const restarted = new ManagedSkillService({
      appVersion: '0.1.0',
      store,
      github: github as unknown as ManagedSkillGitHubClient,
    });
    const cached = await restarted.loadCatalog();
    expect(cached).toMatchObject({
      status: 'cached',
      refreshedAt: 42_000,
      entries: [{ id: 'demo-skill' }],
    });
    expect(cached.error).toContain('duplicate');
  });

  test('installs a catalog discovery as recommended and reports it installed', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    github.catalog = catalogFixture();
    github.additionalCandidates = [{
      view: {
        id: 'nested-candidate',
        name: 'nested-skill',
        description: 'Nested skill that is not the catalog recommendation.',
        subdirectory: 'skills/demo-skill/nested',
        compatibility: { status: 'unknown', appVersion: '0.1.0' },
        scripts: [],
      },
      repositoryTree: [],
    }];
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
    });
    expect((await service.loadCatalog()).status).toBe('fresh');

    const discovery = await service.discover({ catalogId: 'demo-skill' });
    expect(discovery.recommended).toBe(true);
    expect(discovery.selectionRequired).toBe(false);
    expect(discovery.candidates.map((candidate) => candidate.name)).toEqual(['demo-skill']);
    const installed = await service.install({
      discoveryId: discovery.id,
      candidateId: discovery.candidates[0]!.id,
      expectedCommit: discovery.resolvedCommit,
    });

    expect(installed.recommended).toBe(true);
    github.version = 2;
    expect((await service.previewUpdate({
      skillId: installed.id,
      expectedActiveHash: installed.active.contentHash,
    })).candidate.commit).toBe('b'.repeat(40));
    expect((await service.loadCatalog()).entries[0]?.installedSkillId).toBe(installed.id);
  });

  test('rejects catalog metadata that no longer matches the skill at its exact path', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    github.catalog = {
      ...catalogFixture(),
      entries: [{ ...catalogFixture().entries[0], name: 'different-skill' }],
    };
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
    });
    expect((await service.loadCatalog()).status).toBe('fresh');

    await expect(service.discover({ catalogId: 'demo-skill' }))
      .rejects.toThrow('no longer resolves to skill "different-skill"');
  });

  test('returns unavailable for an invalid catalog when no valid cache exists', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    github.catalog = {
      schemaVersion: 1,
      entries: [{ ...catalogFixture().entries[0], compatibilityRange: 'not semver' }],
    };
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
    });

    const catalog = await service.loadCatalog();
    expect(catalog.status).toBe('unavailable');
    expect(catalog.entries).toEqual([]);
    expect(catalog.error).toContain('compatibilityRange');
  });

  test('accepts the repository catalog as the six optional Linlab recommendations', async () => {
    const root = await temporaryRoot();
    const github = new FakeGitHub();
    github.catalog = JSON.parse(await readFile(
      path.resolve(import.meta.dir, '..', '..', 'catalog', 'managed-skills-v1.json'),
      'utf8',
    ));
    const service = new ManagedSkillService({
      appVersion: '0.1.0',
      store: new ManagedSkillStore(root),
      github: github as unknown as ManagedSkillGitHubClient,
    });

    const catalog = await service.loadCatalog();
    expect(catalog.status).toBe('fresh');
    expect(catalog.entries.map((entry) => entry.name)).toEqual([
      'data-analysis',
      'document',
      'feed-processing',
      'pdf',
      'presentation',
      'spreadsheet',
    ]);
  });
});

class FakeGitHub {
  version = 1;
  offline = false;
  sameContentUpdate = false;
  updateCheckGate: Promise<void> | null = null;
  onUpdateCheckStarted: (() => void) | null = null;
  additionalCandidates: ManagedSkillGitHubDiscovery['candidates'] = [];
  catalog: unknown = null;
  private readonly versions = new Map<number, ValidatedManagedSkill>([
    [1, fixture('Version one instructions.')],
    [2, fixture('Version two instructions.')],
    [3, fixture('Version three instructions.')],
  ]);

  async discover(): Promise<ManagedSkillGitHubDiscovery> {
    if (this.offline) throw new Error('offline');
    const commit = this.version === 1
      ? 'a'.repeat(40)
      : this.version === 2
        ? 'b'.repeat(40)
        : 'c'.repeat(40);
    const skill = this.versions.get(this.version)!;
    return {
      origin: {
        owner: 'public',
        repo: 'repo',
        repository: 'https://github.com/public/repo',
        subdirectory: 'skills/demo-skill',
        trackingRef: 'main',
        commit,
      },
      candidates: [{
        view: {
          id: 'candidate',
          name: skill.name,
          description: skill.description,
          subdirectory: 'skills/demo-skill',
          compatibility: skill.compatibility,
          scripts: [],
        },
        repositoryTree: [],
      }, ...this.additionalCandidates],
    };
  }

  async downloadCandidate(input: { origin: { commit: string } }): Promise<ValidatedManagedSkill> {
    if (this.offline) throw new Error('offline');
    if (input.origin.commit === 'a'.repeat(40)) return this.versions.get(1)!;
    if (input.origin.commit === 'b'.repeat(40)) {
      return this.sameContentUpdate ? this.versions.get(1)! : this.versions.get(2)!;
    }
    return this.versions.get(3)!;
  }

  async resolveTrackingCommit(): Promise<string> {
    if (this.offline) throw new Error('offline');
    const version = this.version;
    this.onUpdateCheckStarted?.();
    await this.updateCheckGate;
    return version === 1
      ? 'a'.repeat(40)
      : version === 2
        ? 'b'.repeat(40)
        : 'c'.repeat(40);
  }

  async fetchJsonFromRaw(): Promise<unknown> {
    if (this.catalog === null) throw new Error('catalog unavailable');
    return this.catalog;
  }
}

function catalogFixture() {
  return {
    schemaVersion: 1,
    entries: [{
      id: 'demo-skill',
      name: 'demo-skill',
      description: 'Recommended managed skill fixture.',
      repository: 'https://github.com/public/repo',
      subdirectory: 'skills/demo-skill',
      trackingRef: 'main',
      compatibilityRange: '>=0.1.0 <1.0.0',
    }],
  } as const;
}

function fixture(body: string): ValidatedManagedSkill {
  return validateManagedSkillFiles({
    files: [{
      relativePath: 'SKILL.md',
      bytes: new TextEncoder().encode([
        '---',
      'name: demo-skill',
      'description: Managed service fixture.',
      'metadata:',
      '  tenon:',
      '    version: ">=0.1.0 <0.2.0"',
      '---',
        body,
      ].join('\n')),
    }],
    selectedDirectoryName: 'demo-skill',
    appVersion: '0.1.0',
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-managed-service-'));
  roots.push(root);
  return root;
}

function incrementingClock(): () => number {
  let value = 1_000;
  return () => value += 1;
}

async function makeWritable(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isDirectory()) {
    await chmod(target, 0o600);
    return;
  }
  await chmod(target, 0o700);
  for (const child of await readdir(target)) await makeWritable(path.join(target, child));
}
