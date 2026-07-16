import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManagedSkillStore, storedVersionFromValidated } from '../../src/main/managedSkillStore';
import { validateManagedSkillFiles } from '../../src/main/managedSkillValidation';

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

describe('managed skill store', () => {
  test('promotes validated bytes into a content-addressed immutable version', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const skill = fixture('Stored v1');
    const version = storedVersionFromValidated('a'.repeat(40), 100, skill);

    const installedPath = await store.installValidatedContent(skill.name, skill);
    expect(installedPath).toBe(store.contentPath(skill.name, skill.contentHash));
    expect(await readFile(path.join(installedPath, 'SKILL.md'), 'utf8')).toContain('Stored v1');
    if (process.platform !== 'win32') {
      expect((await lstat(path.join(installedPath, 'SKILL.md'))).mode & 0o333).toBe(0);
    }
    expect(await store.verifyVersion(skill.name, version)).toEqual({ ok: true });

    await store.updateIndex((index) => ({
      ...index,
      skills: [{
        id: skill.name,
        name: skill.name,
        origin: {
          owner: 'owner',
          repo: 'repo',
          repository: 'https://github.com/owner/repo',
          subdirectory: 'skills/stored-skill',
          trackingRef: 'main',
        },
        recommended: false,
        enabled: false,
        active: version,
      }],
    }));
    expect((await store.readIndex()).skills[0]?.active.contentHash).toBe(skill.contentHash);
  });

  test('detects local byte changes and never treats them as the pinned version', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const skill = fixture('Original bytes');
    const version = storedVersionFromValidated('b'.repeat(40), 200, skill);
    const installedPath = await store.installValidatedContent(skill.name, skill);
    const skillFile = path.join(installedPath, 'SKILL.md');

    if (process.platform !== 'win32') await chmod(skillFile, 0o600);
    await writeFile(skillFile, 'locally modified\n', 'utf8');

    const integrity = await store.verifyVersion(skill.name, version);
    expect(integrity.ok).toBe(false);
    expect(integrity.reason).toContain('changed');
  });

  test('reuses an existing clean content hash without overwriting its bytes', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const skill = fixture('Same bytes');

    const first = await store.installValidatedContent(skill.name, skill);
    const second = await store.installValidatedContent(skill.name, skill);

    expect(second).toBe(first);
    expect(await readFile(path.join(second, 'SKILL.md'), 'utf8')).toContain('Same bytes');
  });

  test('never follows a locally inserted skill-container symlink outside the managed root', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const skill = fixture('Symlink-safe bytes');
    const outside = path.join(root, 'ordinary-user-skill');
    const victim = path.join(outside, 'SKILL.md');
    await store.initialize();
    await mkdir(outside, { recursive: true });
    await writeFile(victim, 'ordinary user bytes\n', 'utf8');
    await symlink(outside, path.join(store.contentRoot, skill.name), 'dir');

    await expect(store.installValidatedContent(skill.name, skill)).rejects.toThrow('not a normal directory');
    expect(await readFile(victim, 'utf8')).toBe('ordinary user bytes\n');

    await store.removeSkill(skill.name);
    expect(await readFile(victim, 'utf8')).toBe('ordinary user bytes\n');
  });

  test('initialization removes orphan versions while retaining indexed active and previous content', async () => {
    const root = await temporaryRoot();
    const store = new ManagedSkillStore(root);
    const activeSkill = fixture('Active bytes');
    const previousSkill = fixture('Previous bytes');
    const orphanSkill = fixture('Orphan bytes');
    const active = storedVersionFromValidated('a'.repeat(40), 100, activeSkill);
    const previous = storedVersionFromValidated('b'.repeat(40), 90, previousSkill);
    await store.installValidatedContent(activeSkill.name, activeSkill);
    await store.installValidatedContent(previousSkill.name, previousSkill);
    await store.installValidatedContent(orphanSkill.name, orphanSkill);
    await store.replaceIndex({
      schemaVersion: 1,
      skills: [{
        id: activeSkill.name,
        name: activeSkill.name,
        origin: {
          owner: 'owner',
          repo: 'repo',
          repository: 'https://github.com/owner/repo',
          subdirectory: 'skills/stored-skill',
          trackingRef: 'main',
        },
        recommended: false,
        enabled: true,
        active,
        previous,
      }],
    });

    await store.initialize();

    expect(await store.verifyVersion(activeSkill.name, active)).toEqual({ ok: true });
    expect(await store.verifyVersion(previousSkill.name, previous)).toEqual({ ok: true });
    expect(await store.verifyVersion(orphanSkill.name, storedVersionFromValidated('c'.repeat(40), 110, orphanSkill)))
      .toMatchObject({ ok: false });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-managed-store-'));
  roots.push(root);
  return root;
}

function fixture(body: string) {
  return validateManagedSkillFiles({
    files: [{
      relativePath: 'SKILL.md',
      bytes: encoder.encode([
        '---',
        'name: stored-skill',
        'description: Stored managed skill fixture.',
        '---',
        body,
      ].join('\n')),
    }],
    selectedDirectoryName: 'stored-skill',
    appVersion: '0.1.0',
  });
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
