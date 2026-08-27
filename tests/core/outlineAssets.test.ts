import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContentStore } from '../../src/content';
import {
  AssetLeaseSchema,
  AssetMetadataSchema,
  AssetRecordSchema,
  canonicalSha256,
  type ChangeSet,
  type NodeDraft,
} from '../../src/outline/contract';
import {
  applyOutlineDiff,
  diffOutlineChangeSet,
  OutlineAssetStore,
  OutlineRuntimeWorkspace,
  WorkspaceTransactionLog,
} from '../../src/outline/runtime';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('Outline Runtime assets', () => {
  test('keeps exact revision and retention coordinates out of public asset schemas', () => {
    const publicSchemas = JSON.stringify([AssetMetadataSchema, AssetLeaseSchema, AssetRecordSchema]);
    expect(publicSchemas).not.toContain('sha256');
    expect(publicSchemas).not.toContain('digest');
    expect(publicSchemas).not.toContain('anchorId');
  });

  test('deduplicates exact revisions while keeping logical records and leases distinct', async () => {
    const workspace = await makeWorkspace();
    const bytes = pngBytes(32, 24);
    const first = await workspace.assets.ingestBytes(bytes, 'first.png');
    const second = await workspace.assets.ingestBytes(bytes, 'second.png');

    expect(first.assetId).not.toBe(second.assetId);
    expect(first.leaseId).not.toBe(second.leaseId);
    expect(first.metadata).not.toHaveProperty('sha256');
    const firstStored = await workspace.store.storedAssetRecord(first.assetId);
    const secondStored = await workspace.store.storedAssetRecord(second.assetId);
    expect(firstStored?.exactRevision.anchorId).not.toBe(secondStored?.exactRevision.anchorId);
    expect(await workspace.assets.measureExactRevisionBytes([
      { namespace: 'outline', recordKey: first.assetId, reference: firstStored!.exactRevision },
      { namespace: 'outline', recordKey: second.assetId, reference: secondStored!.exactRevision },
    ])).toBe(bytes.byteLength);
    expect(JSON.stringify([firstStored, secondStored])).not.toContain('digest');
    expect(await readFile(workspace.store.transactionLogPath, 'utf8')).not.toContain('"digest"');
    expect(await contentRevisionFiles(workspace.assets.content.revisionsRoot)).toHaveLength(1);

    const restarted = await OutlineRuntimeWorkspace.open(workspace.store.workspaceRoot(), {
      contentRoot: workspace.assets.content.root,
    });
    expect(await restarted.assets.show(first.assetId)).toMatchObject({
      assetId: first.assetId,
      metadata: { imageWidth: 32, imageHeight: 24 },
    });
  });

  test('charges one physical revision to recovery only after its last live logical record is removed', async () => {
    const workspace = await makeWorkspace();
    const bytes = Buffer.alloc(32 * 1024, 7);
    const firstLease = await workspace.assets.ingestBytes(bytes, 'first.bin');
    const secondLease = await workspace.assets.ingestBytes(bytes, 'second.bin');
    const firstCreate = await applyChangeSet(workspace, createAttachmentChangeSet(firstLease.leaseId));
    const secondCreate = await applyChangeSet(workspace, createAttachmentChangeSet(secondLease.leaseId));
    const firstNodeId = firstCreate.affectedNodeIds.find((id) => (
      workspace.documentState().nodes[id]?.assetId === firstLease.assetId
    ));
    const secondNodeId = secondCreate.affectedNodeIds.find((id) => (
      workspace.documentState().nodes[id]?.assetId === secondLease.assetId
    ));
    expect(firstNodeId).toBeDefined();
    expect(secondNodeId).toBeDefined();

    await trashAndPurge(workspace, firstNodeId!);
    const firstLogicalRecoveryBytes = await transactionRecoveryBytes(workspace.store.transactionLogPath);
    expect((await workspace.status()).recovery.retainedBytes).toBe(firstLogicalRecoveryBytes);

    await trashAndPurge(workspace, secondNodeId!);
    const allLogicalRecoveryBytes = await transactionRecoveryBytes(workspace.store.transactionLogPath);
    expect((await workspace.status()).recovery.retainedBytes).toBe(allLogicalRecoveryBytes + bytes.byteLength);
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
    const stored = await workspace.store.storedAssetRecord(corruptLease.assetId);
    expect(stored).toBeDefined();
    const blobPath = await workspace.assets.content.verifiedPath(
      stored!.exactRevision,
      'outline',
      corruptLease.assetId,
    );
    await writeFile(blobPath, Buffer.from('wrong bytes'));
    const publicError = await rejectedError(workspace.assets.show(corruptLease.assetId));
    expect(publicError).toMatchObject({ outlineError: { code: 'recovery_inconsistent' } });
    const publicErrorJson = JSON.stringify(publicError);
    expect(publicErrorJson).not.toContain(stored!.exactRevision.anchorId);
    expect(publicErrorJson).not.toContain(blobPath);
    expect(publicErrorJson).not.toMatch(/[a-f0-9]{64}/u);
    const quarantined = await readdir(workspace.assets.content.quarantineRoot);
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(workspace.assets.content.quarantineRoot, quarantined[0]!))).toEqual(Buffer.from('wrong bytes'));
  });

  test('releases an anchor leaked before AssetRecord commit without collecting a committed record', async () => {
    let injected = true;
    const workspace = await makeWorkspace({
      assetStoreOptions: {
        hooks: {
          afterAnchorCreated: () => {
            if (!injected) return;
            injected = false;
            throw new Error('injected crash after anchor creation');
          },
        },
      },
    });

    await expect(workspace.assets.ingestBytes(Buffer.from('uncommitted'), 'uncommitted.txt'))
      .rejects.toThrow('injected crash after anchor creation');
    const [leaked] = await workspace.assets.content.anchors('outline');
    expect(leaked).toBeDefined();
    expect(await workspace.store.assetRecords()).toEqual([]);

    expect(await workspace.assets.reconcileAnchors()).toEqual([leaked!.anchorId]);
    expect(await workspace.assets.content.collectGarbage()).toEqual({
      revisionCount: 1,
      byteLength: leaked!.byteLength,
    });
  });

  test('keeps a committed AssetRecord when stage acknowledgement is lost after fsync', async () => {
    let failNextFsync = false;
    const workspace = await makeWorkspace({
      storeOptions: {
        fsync: async (handle) => {
          await handle.sync();
          if (!failNextFsync) return;
          failNextFsync = false;
          throw new Error('injected lost asset-stage acknowledgement');
        },
      },
    });
    failNextFsync = true;

    const lease = await workspace.assets.ingestBytes(Buffer.from('durably staged'), 'durable.txt');
    const stored = await workspace.store.storedAssetRecord(lease.assetId);
    expect(stored).toBeDefined();
    expect((await workspace.assets.content.anchors('outline')).map((entry) => entry.anchorId))
      .toEqual([stored!.exactRevision.anchorId]);
    expect((await workspace.assets.readVerified(lease.assetId)).bytes).toEqual(Buffer.from('durably staged'));
  });

  test('serializes reconciliation behind in-flight anchor and AssetRecord settlement', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const workspace = await makeWorkspace({
      assetStoreOptions: {
        hooks: {
          afterAnchorCreated: async () => {
            enter();
            await gate;
          },
        },
      },
    });

    const ingesting = workspace.assets.ingestBytes(Buffer.from('in flight'), 'in-flight.txt');
    await entered;
    const [anchor] = await workspace.assets.content.anchors('outline');
    expect(anchor).toBeDefined();
    let reconciliationSettled = false;
    const reconciling = workspace.assets.reconcileAnchors().finally(() => {
      reconciliationSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconciliationSettled).toBe(false);

    release();
    const lease = await ingesting;
    expect(await reconciling).toEqual([]);
    expect(await workspace.assets.show(lease.assetId)).toMatchObject({ assetId: lease.assetId });
    expect((await workspace.assets.content.anchors('outline')).map((entry) => entry.anchorId))
      .toEqual([anchor!.anchorId]);
  });

  test('reconciles only orphan anchors after a complete successful Runtime enumeration', async () => {
    const workspace = await makeWorkspace();
    const lease = await workspace.assets.ingestBytes(Buffer.from('shared revision'), 'shared.txt');
    const stored = await workspace.store.storedAssetRecord(lease.assetId);
    expect(stored).toBeDefined();
    const orphan = await workspace.assets.content.cloneAnchor(
      stored!.exactRevision.anchorId,
      'outline',
      'asset:orphan',
    );

    expect(await workspace.assets.reconcileAnchors()).toEqual([orphan.anchorId]);
    expect((await workspace.assets.content.anchors('outline')).map((entry) => entry.anchorId))
      .toEqual([stored!.exactRevision.anchorId]);
    expect((await workspace.assets.readVerified(lease.assetId)).bytes).toEqual(Buffer.from('shared revision'));
  });

  test('releases no orphan when a committed AssetRecord anchor coordinate mismatches ContentStore', async () => {
    const workspace = await makeWorkspace();
    const lease = await workspace.assets.ingestBytes(Buffer.from('committed revision'), 'committed.txt');
    const stored = await workspace.store.storedAssetRecord(lease.assetId);
    expect(stored).toBeDefined();
    const orphan = await workspace.assets.content.cloneAnchor(
      stored!.exactRevision.anchorId,
      'outline',
      'asset:orphan',
    );
    const database = new Database(workspace.assets.content.databasePath);
    database.query('UPDATE retention_anchors SET record_key = ? WHERE anchor_id = ?')
      .run('asset:wrong-coordinate', stored!.exactRevision.anchorId);
    database.close();

    await expect(workspace.assets.reconcileAnchors()).rejects.toMatchObject({
      outlineError: { code: 'recovery_inconsistent' },
    });
    expect((await workspace.assets.content.anchors('outline')).map((entry) => entry.anchorId).sort())
      .toEqual([stored!.exactRevision.anchorId, orphan.anchorId].sort());
  });

  test('releases no Outline anchor when the Runtime enumeration is inconsistent', async () => {
    const workspace = await makeWorkspace();
    const lease = await workspace.assets.ingestBytes(Buffer.from('keep both anchors'), 'keep.txt');
    const stored = await workspace.store.storedAssetRecord(lease.assetId);
    expect(stored).toBeDefined();
    const orphan = await workspace.assets.content.cloneAnchor(
      stored!.exactRevision.anchorId,
      'outline',
      'asset:orphan',
    );
    const transactionLogPath = workspace.store.transactionLogPath;
    const contentRoot = workspace.assets.content.root;
    const workspaceRoot = workspace.store.workspaceRoot();
    workspace.close();
    await appendFile(transactionLogPath, '{"invalid":"complete-record"}\n');

    const transactions = new WorkspaceTransactionLog(workspaceRoot);
    expect((await transactions.load()).inconsistent).toBeDefined();
    const content = await ContentStore.open(contentRoot);
    const assets = new OutlineAssetStore(content, transactions);
    await expect(assets.reconcileAnchors()).rejects.toMatchObject({
      outlineError: { code: 'recovery_inconsistent' },
    });
    expect((await content.anchors('outline')).map((entry) => entry.anchorId).sort())
      .toEqual([stored!.exactRevision.anchorId, orphan.anchorId].sort());
    assets.close();
  });

  test('degrades only invalid AssetRecord metadata while retaining shared exact bytes', async () => {
    const workspace = await makeWorkspace();
    const bytes = Buffer.from('one exact revision, two logical records');
    const healthyLease = await workspace.assets.ingestBytes(bytes, 'healthy.txt');
    const degradedLease = await workspace.assets.ingestBytes(bytes, 'degraded.txt');
    const healthyStored = await workspace.store.storedAssetRecord(healthyLease.assetId);
    const degradedStored = await workspace.store.storedAssetRecord(degradedLease.assetId);
    expect(healthyStored?.exactRevision.anchorId).not.toBe(degradedStored?.exactRevision.anchorId);
    expect(await workspace.assets.measureExactRevisionBytes([
      { namespace: 'outline', recordKey: healthyLease.assetId, reference: healthyStored!.exactRevision },
      { namespace: 'outline', recordKey: degradedLease.assetId, reference: degradedStored!.exactRevision },
    ])).toBe(bytes.byteLength);
    const transactionLogPath = workspace.store.transactionLogPath;
    const contentRoot = workspace.assets.content.root;
    const workspaceRoot = workspace.store.workspaceRoot();
    workspace.close();

    const lines = (await readFile(transactionLogPath, 'utf8')).trimEnd().split('\n');
    const finalRecord = JSON.parse(lines.at(-1)!) as Record<string, unknown> & {
      stage: { record: { metadata: { mimeType: string } } };
    };
    finalRecord.stage.record.metadata.mimeType = '';
    const { checksum: _checksum, ...body } = finalRecord;
    finalRecord.checksum = canonicalSha256(body);
    lines[lines.length - 1] = JSON.stringify(finalRecord);
    await writeFile(transactionLogPath, `${lines.join('\n')}\n`);

    const transactions = new WorkspaceTransactionLog(workspaceRoot);
    expect((await transactions.load()).inconsistent).toBeUndefined();
    expect(await transactions.verifiedStoredAssetRecords()).toHaveLength(2);
    const content = await ContentStore.open(contentRoot);
    const assets = new OutlineAssetStore(content, transactions, {
      now: () => new Date('2100-01-01T00:00:00.000Z'),
    });
    expect(await assets.reconcileAnchors()).toEqual([]);
    expect((await assets.readVerified(healthyLease.assetId)).bytes).toEqual(bytes);
    await expect(assets.show(degradedLease.assetId)).rejects.toMatchObject({
      outlineError: { code: 'recovery_inconsistent' },
    });
    expect(await readdir(content.quarantineRoot)).toEqual([]);
    expect(await content.anchors('outline')).toHaveLength(2);
    expect(await assets.collectGarbage([])).toEqual([]);
    expect((await assets.readVerified(healthyLease.assetId)).bytes).toEqual(bytes);
    assets.close();

    const compacting = await OutlineRuntimeWorkspace.open(workspaceRoot, {
      contentRoot,
      storeOptions: { compactionRecords: 1 },
    });
    await compacting.maintain({ compactIfNeeded: true });
    compacting.close();
    const compacted = await OutlineRuntimeWorkspace.open(workspaceRoot, { contentRoot });
    expect((await compacted.assets.readVerified(healthyLease.assetId)).bytes).toEqual(bytes);
    await expect(compacted.assets.show(degradedLease.assetId)).rejects.toMatchObject({
      outlineError: { code: 'recovery_inconsistent' },
    });
    expect(await compacted.assets.content.anchors('outline')).toHaveLength(2);
    compacted.close();
  });

  test('repairs crashes after AssetRecord removal and after anchor release in the required order', async () => {
    let nowMs = Date.parse('2032-01-01T00:00:00.000Z');
    let crashAfterRemoval = true;
    const workspace = await makeWorkspace({
      now: () => new Date(nowMs),
      assetStoreOptions: {
        leaseMs: 1_000,
        hooks: {
          afterAssetRecordsRemoved: (records) => {
            if (!crashAfterRemoval || records.length === 0) return;
            crashAfterRemoval = false;
            throw new Error('injected crash after AssetRecord removal');
          },
        },
      },
    });
    const lease = await workspace.assets.ingestBytes(Buffer.from('remove then release'), 'remove.txt');
    const stored = await workspace.store.storedAssetRecord(lease.assetId);
    expect(stored).toBeDefined();
    nowMs += 1_001;

    await expect(workspace.collectAssetGarbage()).rejects.toThrow('injected crash after AssetRecord removal');
    expect(await workspace.store.storedAssetRecord(lease.assetId)).toBeUndefined();
    expect((await workspace.assets.content.anchors('outline')).map((entry) => entry.anchorId))
      .toEqual([stored!.exactRevision.anchorId]);
    expect(await workspace.assets.reconcileAnchors()).toEqual([stored!.exactRevision.anchorId]);
    expect(await workspace.assets.content.collectGarbage()).toEqual({
      revisionCount: 1,
      byteLength: stored!.exactRevision.byteLength,
    });

    let crashAfterRelease = true;
    const second = await makeWorkspace({
      now: () => new Date(nowMs),
      assetStoreOptions: {
        leaseMs: 1_000,
        hooks: {
          afterAnchorsReleased: (records) => {
            if (!crashAfterRelease || records.length === 0) return;
            crashAfterRelease = false;
            throw new Error('injected crash after anchor release');
          },
        },
      },
    });
    const secondLease = await second.assets.ingestBytes(Buffer.from('release then collect'), 'release.txt');
    const secondStored = await second.store.storedAssetRecord(secondLease.assetId);
    expect(secondStored).toBeDefined();
    nowMs += 1_001;

    await expect(second.collectAssetGarbage()).rejects.toThrow('injected crash after anchor release');
    expect(await second.store.storedAssetRecord(secondLease.assetId)).toBeUndefined();
    expect(await second.assets.content.anchors('outline')).toEqual([]);
    expect(await contentRevisionFiles(second.assets.content.revisionsRoot)).toHaveLength(1);
    expect(await second.assets.content.collectGarbage()).toEqual({
      revisionCount: 1,
      byteLength: secondStored!.exactRevision.byteLength,
    });
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

async function trashAndPurge(workspace: OutlineRuntimeWorkspace, nodeId: string): Promise<void> {
  await applyChangeSet(workspace, {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [{ op: 'lifecycle', action: 'trash', targets: oneId(nodeId) }],
  });
  await applyChangeSet(workspace, {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [{ op: 'lifecycle', action: 'purge', targets: oneId(nodeId) }],
  }, true);
}

async function transactionRecoveryBytes(transactionLogPath: string): Promise<number> {
  return (await readFile(transactionLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind?: string; recovery?: { byteSize?: number } })
    .filter((record) => record.kind === 'outline.transaction')
    .reduce((total, record) => total + (record.recovery?.byteSize ?? 0), 0);
}

async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject.');
}

function oneAlias(alias: 'today') {
  return { target: { selector: { by: 'alias' as const, alias }, cardinality: 'one' as const } };
}

function oneId(id: string) {
  return { target: { selector: { by: 'id' as const, id }, cardinality: 'one' as const } };
}

async function makeWorkspace(options: Parameters<typeof OutlineRuntimeWorkspace.open>[1] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-assets-'));
  const contentRoot = `${root}-content`;
  roots.push(root, contentRoot);
  return OutlineRuntimeWorkspace.open(root, { ...options, contentRoot });
}

async function contentRevisionFiles(root: string): Promise<readonly string[]> {
  const prefixes = await readdir(root);
  const files = await Promise.all(prefixes.map(async (prefix) => (
    (await readdir(path.join(root, prefix))).map((entry) => `${prefix}/${entry}`)
  )));
  return files.flat().sort();
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
