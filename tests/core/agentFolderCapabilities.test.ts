import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FolderCapabilityService,
  capabilityFolderForTarget,
  createFolderCapabilitySnapshot,
  missingFolderCapabilities,
  normalizeRequiredFolders,
  protectedRootForPath,
} from '../../src/main/agentFolderCapabilities';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('folder capability service', () => {
  test('canonicalizes, deduplicates, and persists folder capabilities privately', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-capability-'));
    const nested = path.join(root, 'nested');
    const storePath = path.join(root, 'state', 'agent-capabilities.json');
    roots.push(root);
    await mkdir(nested);
    const service = new FolderCapabilityService(storePath);

    await service.grantMany([nested, root, nested]);
    await service.appendBlock('Action(git.publish_remote)');
    const canonicalRoot = await realpath(root);

    expect(await service.read()).toEqual({
      folders: [canonicalRoot],
      blocks: ['Action(git.publish_remote)'],
    });
    if (process.platform !== 'win32') {
      expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('publishes revocation only after the persistent root is removed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-revoke-'));
    const granted = path.join(root, 'granted');
    roots.push(root);
    await mkdir(granted);
    const service = new FolderCapabilityService(path.join(root, 'permissions.json'));
    const revoked: string[] = [];
    service.onRevoked((folder) => { revoked.push(folder); });
    await service.grant(granted);
    const canonicalGranted = await realpath(granted);

    const next = await service.revoke(granted);

    expect(next.folders).toEqual([]);
    expect(revoked).toEqual([canonicalGranted]);
    expect(service.currentRevocationGeneration()).toBe(1);
    expect(await service.readState()).toEqual({
      document: { folders: [], blocks: [] },
      revocationGeneration: 1,
    });
  });

  test('publishes revocations when Settings applies a removal patch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-folder-capability-settings-'));
    roots.push(root);
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const store = path.join(root, 'permissions.json');
    const service = new FolderCapabilityService(store);
    await service.grantMany([first, second]);

    const revoked: Array<{ folder: string; persisted: string[] }> = [];
    service.onRevoked(async (folder) => {
      revoked.push({ folder, persisted: (await service.read()).folders });
    });

    await service.applyRemovalPatch({ folders: [first] });

    expect(revoked).toEqual([{ folder: await realpath(first), persisted: [await realpath(second)] }]);
    expect(service.currentRevocationGeneration()).toBe(1);
  });

  test('publishes only newly persistent folder capabilities', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-grant-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    roots.push(root);
    await mkdir(first);
    await mkdir(second);
    const service = new FolderCapabilityService(path.join(root, 'permissions.json'));
    const grants: string[][] = [];
    service.onGranted((folders) => { grants.push([...folders]); });

    await service.grant(first);
    await service.grant(first);
    await service.grantMany([first, second]);

    expect(grants).toEqual([
      [await realpath(first)],
      [await realpath(second)],
    ]);
  });

  test('publishes concurrent grants exactly once from their serialized states', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-concurrent-grant-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    roots.push(root);
    await mkdir(first);
    await mkdir(second);
    const service = new FolderCapabilityService(path.join(root, 'permissions.json'));
    const grants: string[] = [];
    service.onGranted((folders) => { grants.push(...folders); });

    await Promise.all([service.grant(first), service.grant(second)]);

    expect(grants.sort()).toEqual([await realpath(first), await realpath(second)].sort());
  });

  test('does not turn a later grant into an implicit revocation of a missing root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-grant-preserves-missing-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    roots.push(root);
    await mkdir(first);
    await mkdir(second);
    const canonicalFirst = await realpath(first);
    const canonicalSecond = await realpath(second);
    const service = new FolderCapabilityService(path.join(root, 'permissions.json'));
    await service.grant(first);
    await rm(first, { recursive: true });

    await service.grant(second);

    expect((await service.read()).folders.sort()).toEqual([canonicalFirst, canonicalSecond].sort());
    expect(service.currentRevocationGeneration()).toBe(0);
  });

  test('derives the nearest existing folder and preflights missing capabilities', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-preflight-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    roots.push(root);
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, 'source.json'), '{}');
    const canonicalWorkspace = await realpath(workspace);
    const canonicalOutside = await realpath(outside);
    const snapshot = createFolderCapabilitySnapshot({ workspaceRoot: workspace }, []);

    expect(capabilityFolderForTarget(path.join(outside, 'source.json'), workspace)).toBe(canonicalOutside);
    expect(normalizeRequiredFolders([outside, outside], workspace)).toEqual([canonicalOutside]);
    expect(missingFolderCapabilities([outside], snapshot)).toEqual([canonicalOutside]);
    expect(missingFolderCapabilities([canonicalWorkspace], snapshot)).toEqual([]);
  });

  test('keeps attachments read-only while cleanup and output roots are writable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-snapshot-'));
    const workspace = path.join(root, 'workspace');
    const scratch = path.join(root, 'scratch');
    roots.push(root);
    await mkdir(workspace);
    await mkdir(scratch);
    const canonicalScratch = await realpath(scratch);
    const snapshot = createFolderCapabilitySnapshot({ workspaceRoot: workspace, scratchRoot: scratch }, []);

    expect(snapshot.readRoots).toContain(canonicalScratch);
    expect(snapshot.writeRoots).not.toContain(canonicalScratch);
    expect(snapshot.writeRoots).toContain(path.join(canonicalScratch, 'data-cleanup'));
    expect(snapshot.writeRoots).toContain(path.join(canonicalScratch, 'agent-tool-outputs'));
  });

  test('keeps the control plane private inside a broader user capability', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-protected-'));
    const control = path.join(root, 'control');
    const workspace = path.join(control, 'agent-workdir');
    const scratch = path.join(control, 'agent-scratch');
    roots.push(root);
    await mkdir(workspace, { recursive: true });
    await mkdir(scratch);
    const canonicalControl = await realpath(control);
    const filesystemRoot = path.parse(root).root;
    const snapshot = createFolderCapabilitySnapshot({
      workspaceRoot: workspace,
      scratchRoot: scratch,
      protectedRoots: [control],
    }, [filesystemRoot]);

    expect(protectedRootForPath(snapshot, path.join(control, 'agent-secrets.json'), 'read')).toBe(canonicalControl);
    expect(protectedRootForPath(snapshot, path.join(control, 'workspace.json'), 'write')).toBe(canonicalControl);
    expect(protectedRootForPath(snapshot, path.join(workspace, 'source.ts'), 'read')).toBeNull();
    expect(protectedRootForPath(snapshot, path.join(workspace, 'source.ts'), 'write')).toBeNull();
    expect(protectedRootForPath(snapshot, path.join(scratch, 'attachment.pdf'), 'read')).toBeNull();
    expect(protectedRootForPath(snapshot, path.join(scratch, 'attachment.pdf'), 'write')).toBe(canonicalControl);
    expect(protectedRootForPath(snapshot, path.join(scratch, 'data-cleanup', 'pack.json'), 'write')).toBeNull();
  });

  test('persists the filesystem root as an explicit capability', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-folder-root-grant-'));
    roots.push(root);
    const filesystemRoot = path.parse(root).root;
    const service = new FolderCapabilityService(path.join(root, 'permissions.json'));

    expect((await service.grant(filesystemRoot)).folders).toEqual([filesystemRoot]);
    expect(normalizeRequiredFolders([filesystemRoot], root)).toEqual([filesystemRoot]);
    expect(capabilityFolderForTarget(path.join(filesystemRoot, 'missing-root-child'), root)).toBe(filesystemRoot);
  });
});
