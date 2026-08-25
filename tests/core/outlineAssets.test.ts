import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChangeSet, NodeDraft } from '../../src/outline/contract';
import {
  applyOutlineDiff,
  diffOutlineChangeSet,
  OutlineRuntimeWorkspace,
} from '../../src/outline/runtime';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('Outline Runtime assets', () => {
  test('deduplicates immutable blobs while keeping logical records and leases distinct', async () => {
    const workspace = await makeWorkspace();
    const bytes = pngBytes(32, 24);
    const first = await workspace.assets.ingestBytes(bytes, 'first.png');
    const second = await workspace.assets.ingestBytes(bytes, 'second.png');

    expect(first.assetId).not.toBe(second.assetId);
    expect(first.leaseId).not.toBe(second.leaseId);
    expect(first.metadata.sha256).toBe(second.metadata.sha256);
    expect((await readdir(workspace.assets.blobDirectory)).filter((name) => name.endsWith('.blob'))).toHaveLength(1);

    const restarted = await OutlineRuntimeWorkspace.open(workspace.store.workspaceRoot());
    expect(await restarted.assets.show(first.assetId)).toMatchObject({
      assetId: first.assetId,
      metadata: { imageWidth: 32, imageHeight: 24 },
    });
  });

  test('stores PDF thumbnails as linked AssetRecords protected by the parent lease and live Node', async () => {
    let nowMs = Date.parse('2030-01-01T00:00:00.000Z');
    const thumbnailBytes = pngBytes(128, 96);
    const workspace = await makeWorkspace({
      now: () => new Date(nowMs),
      assetStoreOptions: {
        leaseMs: 1_000,
        renderPdfThumbnail: async () => thumbnailBytes,
      },
    });
    const lease = await workspace.assets.ingestBytes(Buffer.from('%PDF-1.4\n/Type /Page\n'), 'report.pdf');
    const thumbnailAssetId = lease.metadata.thumbnailAssetId;
    expect(thumbnailAssetId).toBeDefined();
    expect(await workspace.assets.show(thumbnailAssetId!)).toMatchObject({
      assetId: thumbnailAssetId,
      metadata: { mimeType: 'image/png', imageWidth: 128, imageHeight: 96 },
    });

    await applyChangeSet(workspace, createAttachmentChangeSet(lease.leaseId));
    nowMs += 1_001;

    expect(await workspace.collectAssetGarbage()).toEqual([]);
    expect((await workspace.assets.readVerified(thumbnailAssetId!)).bytes).toEqual(thumbnailBytes);
  });

  test('consumes a lease atomically and retains live and recovery-only bytes through purge and revert', async () => {
    const workspace = await makeWorkspace();
    const lease = await workspace.assets.ingestBytes(Buffer.from('attachment bytes'), 'note.txt');
    const createDiff = await diffOutlineChangeSet(workspace, createAttachmentChangeSet(lease.leaseId));
    const createdId = createDiff.bindings.created?.[0];
    expect(createdId).toBeDefined();
    expect(createDiff.affected).toContainEqual(expect.objectContaining({ id: createdId, effect: 'create' }));

    const created = await applyOutlineDiff(workspace, createDiff, { origin: 'local-user' });
    expect(created.affectedNodeIds).toContain(createdId!);
    expect(workspace.documentState().nodes[createdId!]).toMatchObject({
      type: 'attachment',
      assetId: lease.assetId,
    });
    await expect(workspace.assets.resolveLeases([lease.leaseId])).rejects.toMatchObject({
      outlineError: { code: 'precondition_failed' },
    });
    expect(await workspace.collectAssetGarbage()).toEqual([]);

    await applyChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'lifecycle', action: 'trash', targets: oneId(createdId!) }],
    });
    const purged = await applyChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'lifecycle', action: 'purge', targets: oneId(createdId!) }],
    }, true);
    expect(workspace.documentState().nodes[createdId!]).toBeUndefined();
    expect(await workspace.collectAssetGarbage()).toEqual([]);
    expect((await workspace.assets.readVerified(lease.assetId)).bytes).toEqual(Buffer.from('attachment bytes'));

    await workspace.revert(purged.operationId, { origin: 'local-user' });
    expect(workspace.documentState().nodes[createdId!]).toMatchObject({ assetId: lease.assetId });
    expect(await workspace.assets.show(lease.assetId)).toMatchObject({ assetId: lease.assetId });
  });

  test('keeps a staged lease after a stale Diff and collects it only after expiry', async () => {
    let nowMs = Date.parse('2030-01-01T00:00:00.000Z');
    const workspace = await makeWorkspace({
      now: () => new Date(nowMs),
      assetStoreOptions: { leaseMs: 1_000 },
    });
    const lease = await workspace.assets.ingestBytes(Buffer.from('retry me'), 'retry.txt');
    const stale = await diffOutlineChangeSet(workspace, createAttachmentChangeSet(lease.leaseId));
    await applyChangeSet(workspace, createPlainChangeSet('Concurrent edit'));

    await expect(applyOutlineDiff(workspace, stale, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'stale_revision' },
    });
    expect((await workspace.assets.resolveLeases([lease.leaseId])).get(lease.leaseId)?.assetId).toBe(lease.assetId);
    expect(await workspace.collectAssetGarbage()).toEqual([]);

    nowMs += 1_001;
    const collected = await workspace.collectAssetGarbage();
    expect(collected).toContain(lease.assetId);
    await expect(workspace.assets.show(lease.assetId)).rejects.toMatchObject({
      outlineError: { code: 'not_found' },
    });
  });

  test('expires recovery before collecting purge-only bytes and preserves diagnostic corruption evidence', async () => {
    let nowMs = Date.parse('2031-01-01T00:00:00.000Z');
    const workspace = await makeWorkspace({
      now: () => new Date(nowMs),
      storeOptions: { minimumRetentionDays: 1, minimumRetentionOperations: 0 },
    });
    const lease = await workspace.assets.ingestBytes(Buffer.from('eventually collect'), 'old.txt');
    const create = await applyChangeSet(workspace, createAttachmentChangeSet(lease.leaseId));
    const createdNodeId = create.affectedNodeIds.find((id) => workspace.documentState().nodes[id]?.type === 'attachment')!;
    await applyChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'lifecycle', action: 'trash', targets: oneId(createdNodeId) }],
    });
    const purge = await applyChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'lifecycle', action: 'purge', targets: oneId(createdNodeId) }],
    }, true);

    nowMs += 2 * 86_400_000;
    await workspace.store.prepareMutation();
    expect((await workspace.collectAssetGarbage())).toContain(lease.assetId);
    await expect(workspace.revert(purge.operationId, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'recovery_expired' },
    });

    const corruptLease = await workspace.assets.ingestBytes(Buffer.from('quarantine me'), 'bad.txt');
    const blobPath = path.join(workspace.assets.blobDirectory, `${corruptLease.metadata.sha256}.blob`);
    await writeFile(blobPath, Buffer.from('wrong bytes'));
    await expect(workspace.assets.show(corruptLease.assetId)).rejects.toMatchObject({
      outlineError: { code: 'recovery_inconsistent' },
    });
    const quarantined = await readdir(workspace.assets.quarantineDirectory);
    expect(quarantined.some((name) => name.startsWith(corruptLease.metadata.sha256))).toBe(true);
    expect(await readFile(path.join(workspace.assets.quarantineDirectory, quarantined[0]!))).toEqual(Buffer.from('wrong bytes'));
  });
});

function createAttachmentChangeSet(assetLeaseId: string): ChangeSet {
  const attachment: NodeDraft = {
    type: 'attachment',
    content: { text: 'note.txt', marks: [], inlineRefs: [] },
    assetLeaseId,
    children: [],
  };
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    idempotencyKey: `test:${crypto.randomUUID()}`,
    operations: [{ op: 'create', placement: { kind: 'last', parent: oneAlias('today') }, nodes: [attachment], bind: 'created' }],
  };
}

function createPlainChangeSet(text: string): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    idempotencyKey: `test:${crypto.randomUUID()}`,
    operations: [{
      op: 'create',
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [{ content: { text, marks: [], inlineRefs: [] }, children: [] }],
    }],
  };
}

async function applyChangeSet(
  workspace: OutlineRuntimeWorkspace,
  changeSet: ChangeSet,
  acknowledgeDestructive = false,
) {
  return applyOutlineDiff(
    workspace,
    await diffOutlineChangeSet(workspace, {
      ...changeSet,
      idempotencyKey: changeSet.idempotencyKey ?? `test:${crypto.randomUUID()}`,
    }),
    { origin: 'local-user' },
    acknowledgeDestructive,
  );
}

function oneAlias(alias: 'today') {
  return { target: { selector: { by: 'alias' as const, alias }, cardinality: 'one' as const } };
}

function oneId(id: string) {
  return { target: { selector: { by: 'id' as const, id }, cardinality: 'one' as const } };
}

async function makeWorkspace(options: Parameters<typeof OutlineRuntimeWorkspace.open>[1] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-assets-'));
  roots.push(root);
  return OutlineRuntimeWorkspace.open(root, options);
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
