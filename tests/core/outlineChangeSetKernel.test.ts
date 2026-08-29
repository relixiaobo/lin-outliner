import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Value } from 'typebox/value';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import { DiffSchema, type ChangeSet, type NodeDraft, type Projection } from '../../src/outline/contract/schemas';
import {
  OutlineRuntimeWorkspace,
  applyOutlineDiff,
  commitOutlineChangeSet,
  commitOutlineChangeSetAccepted,
  createSelectionIndex,
  diffOutlineChangeSet,
  projectOutline,
  resolveSelector,
} from '../../src/outline/runtime';
import { formatAssetSourceUri } from '../../src/core/source';
import { sourceEntryNodeId } from '../../src/core/types';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('outline ChangeSet kernel', () => {
  const documentChildIds = (workspace: OutlineRuntimeWorkspace, parentId: string) => (
    workspace.documentState().nodes[parentId]?.children.filter((id) => id !== sourceEntryNodeId(parentId))
  );

  test('commits a non-destructive ChangeSet directly without reviewed Diff preview', async () => {
    const workspace = await makeWorkspace();
    const beforeRevision = workspace.revision();
    const changeSet: ChangeSet = {
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'test:direct-commit',
      operations: [{
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [draft('Direct commit row')],
      }],
    };

    const operation = await commitOutlineChangeSet(workspace, changeSet, { origin: 'desktop' });

    expect(operation.kind).toBe('outline.operation');
    if (operation.kind !== 'outline.operation') throw new Error('Expected direct commit to produce an Operation.');
    expect(operation.origin).toBe('desktop');
    expect(operation.revisionBefore).toBe(beforeRevision);
    expect(operation.revisionAfter).toBe(beforeRevision + 1);
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Direct commit row')).toBe(true);
    expect(await commitOutlineChangeSet(workspace, changeSet, { origin: 'desktop' })).toEqual(operation);
  });

  test('keeps accepted desktop commits off the full Core Projection path', async () => {
    const workspace = await makeWorkspace();
    const liveCore = (workspace as unknown as { core: { projection: () => unknown } }).core;
    const originalProjection = liveCore.projection;
    const projectionCallStacks: string[] = [];
    liveCore.projection = () => {
      projectionCallStacks.push(new Error('Unexpected full Core Projection').stack ?? 'missing stack');
      return originalProjection.call(liveCore);
    };
    try {
      const accepted = await commitOutlineChangeSetAccepted(workspace, {
        ...createTodayChangeSet('Projection-free accepted row'),
        idempotencyKey: 'test:projection-free-accepted',
      }, { origin: 'desktop' });

      expect(accepted.update).toMatchObject({ kind: 'delta', revision: 1 });
      const runtimeProjectionCalls = projectionCallStacks.filter((stack) => !stack.includes('verifyCaches'));
      expect(runtimeProjectionCalls).toEqual([]);
      expect(projectionCallStacks).toHaveLength(process.env.LIN_VERIFY_CACHE === '1' ? 1 : 0);
    } finally {
      liveCore.projection = originalProjection;
    }
  });

  test('converts a newly bound desktop draft into a field in the same accepted ChangeSet', async () => {
    const workspace = await makeWorkspace();
    const fieldEntryId = `node:${crypto.randomUUID()}`;

    const accepted = await commitOutlineChangeSetAccepted(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'test:accepted-inline-field-binding',
      operations: [
        {
          op: 'create',
          placement: { kind: 'last', parent: oneAlias('today') },
          nodes: [draft('', { id: fieldEntryId })],
          bind: 'field-entry',
        },
        {
          op: 'update',
          targets: { binding: 'field-entry' },
          changes: [{ kind: 'field', action: 'convert', name: '', fieldType: 'plain' }],
        },
      ],
    }, { origin: 'desktop' });

    expect(accepted.diff.bindings['field-entry']).toEqual([fieldEntryId]);
    expect(accepted.update.changedNodes.find((node) => node.id === fieldEntryId)).toMatchObject({
      id: fieldEntryId,
      type: 'fieldEntry',
      parentId: workspace.projection().todayId,
    });
    const entry = workspace.documentState().nodes[fieldEntryId];
    expect(entry).toMatchObject({ id: fieldEntryId, type: 'fieldEntry' });
    expect(entry?.type === 'fieldEntry' && workspace.documentState().nodes[entry.fieldDefId]).toMatchObject({
      type: 'fieldDef',
      content: { text: '' },
    });
  });

  test('replays the exact accepted desktop receipt after compaction and Runtime restart', async () => {
    const root = await makeRoot();
    const firstRuntime = await openWorkspace(root, {
      instanceId: 'runtime:accepted-receipt-first',
      storeOptions: { compactionRecords: 1 },
    });
    const changeSet: ChangeSet = {
      ...createTodayChangeSet('Accepted receipt row'),
      idempotencyKey: 'test:accepted-receipt-restart',
    };

    const first = await commitOutlineChangeSetAccepted(firstRuntime, changeSet, { origin: 'desktop' });
    const sameRuntimeRetry = await commitOutlineChangeSetAccepted(firstRuntime, changeSet, { origin: 'desktop' });

    expect(sameRuntimeRetry).toEqual(first);
    expect(first.diff.bindings.created).toHaveLength(1);
    await firstRuntime.drainDurability(first.update.revision);
    expect(await firstRuntime.store.operations()).toHaveLength(1);
    await firstRuntime.maintain({ compactIfNeeded: true });
    firstRuntime.close();

    const restarted = await openWorkspace(root, { instanceId: 'runtime:accepted-receipt-second' });
    const restartRetry = await commitOutlineChangeSetAccepted(restarted, changeSet, { origin: 'desktop' });

    expect(restartRetry).toEqual(first);
    expect(restartRetry.diff.bindings).toEqual(first.diff.bindings);
    expect(restarted.projection().nodes.filter((node) => node.content.text === 'Accepted receipt row')).toHaveLength(1);
    expect(await restarted.store.operations()).toHaveLength(1);
  });

  test('normalizes a direct commit inside the mutation queue before executing', async () => {
    const workspace = await makeWorkspace();
    const revision = workspace.revision();
    const createAtRevision = (text: string, idempotencyKey: string): ChangeSet => ({
      protocolVersion: 1,
      kind: 'outline.changeset',
      base: { revision },
      idempotencyKey,
      operations: [{
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [draft(text)],
      }],
    });

    const results = await Promise.allSettled([
      commitOutlineChangeSet(workspace, createAtRevision('Queued direct commit A', 'test:queued-direct-a'), { origin: 'desktop' }),
      commitOutlineChangeSet(workspace, createAtRevision('Queued direct commit B', 'test:queued-direct-b'), { origin: 'desktop' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { outlineError: { code: 'stale_revision' } },
    });
    expect(workspace.revision()).toBe(revision + 1);
  });

  test('rejects destructive ChangeSets on the direct commit path', async () => {
    const workspace = await makeWorkspace();
    const targetId = await createExisting(workspace, 'Reviewed replacement target');
    const destructive: ChangeSet[] = [
      {
        protocolVersion: 1,
        kind: 'outline.changeset',
        idempotencyKey: 'test:direct-replace',
        operations: [{
          op: 'update',
          targets: oneId(targetId),
          changes: [{
            kind: 'text-patch',
            field: 'content',
            patch: { ops: [{ type: 'replace_all', content: { text: 'replacement', marks: [], inlineRefs: [] } }] },
            review: { destructive: 'replace' },
          }],
        }],
      },
      {
        protocolVersion: 1,
        kind: 'outline.changeset',
        idempotencyKey: 'test:direct-purge',
        operations: [{ op: 'lifecycle', action: 'purge', targets: oneId(targetId) }],
      },
      {
        protocolVersion: 1,
        kind: 'outline.changeset',
        idempotencyKey: 'test:direct-merge',
        operations: [{ op: 'merge', sources: oneId(targetId), target: oneAlias('today') }],
      },
    ];

    for (const changeSet of destructive) {
      await expect(commitOutlineChangeSet(workspace, changeSet, { origin: 'desktop' })).rejects.toMatchObject({
        outlineError: { code: 'confirmation_required' },
      });
    }
  });

  test('commits empty field placeholders through the public ChangeSet schema', async () => {
    const workspace = await makeWorkspace();
    const ownerId = await createExisting(workspace, 'Placeholder owner');
    const nestedEntryId = `node:${crypto.randomUUID()}`;

    await commitOutlineChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'test:empty-field-placeholder',
      operations: [
        {
          op: 'update',
          targets: oneId(ownerId),
          changes: [{ kind: 'field', action: 'define', name: '', fieldType: 'plain' }],
        },
        { op: 'ensure', resource: 'definition', definitionType: 'field', name: 'Outer', fieldType: 'plain', bind: 'outer' },
        {
          op: 'update',
          targets: oneId(ownerId),
          changes: [{
            kind: 'field-slot',
            field: { binding: 'outer' },
            mutation: { action: 'append-field', name: '', fieldType: 'plain', id: nestedEntryId },
          }],
        },
      ],
    }, { origin: 'desktop' });

    const state = workspace.documentState();
    const directEntry = Object.values(state.nodes).find((node) => (
      node.type === 'fieldEntry'
      && node.parentId === ownerId
      && node.id !== nestedEntryId
      && state.nodes[node.fieldDefId]?.content.text === ''
    ));
    expect(directEntry).toBeDefined();
    const nestedEntry = state.nodes[nestedEntryId];
    expect(nestedEntry?.type).toBe('fieldEntry');
    if (nestedEntry?.type !== 'fieldEntry') throw new Error('Expected nested placeholder field entry.');
    expect(state.nodes[nestedEntry.fieldDefId]?.content.text).toBe('');
  });

  test('preserves pasted metadata when appending field value NodeDraft trees', async () => {
    const workspace = await makeWorkspace();
    const ownerId = await createExisting(workspace, 'Field value metadata owner');
    const valueId = `node:${crypto.randomUUID()}`;

    await commitOutlineChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'test:field-value-paste-metadata',
      operations: [
        { op: 'ensure', resource: 'definition', definitionType: 'field', name: 'Slot', fieldType: 'plain', bind: 'slot' },
        {
          op: 'update',
          targets: oneId(ownerId),
          changes: [{
            kind: 'field-slot',
            field: { binding: 'slot' },
            mutation: {
              action: 'append-nodes',
              id: valueId,
              nodes: [draft('Task #Work', {
                metadata: {
                  pasteTags: ['Work'],
                  pasteFields: [{ name: 'Status', value: 'Open' }],
                },
                children: [draft('Child #Next', { metadata: { pasteTags: ['Next'] } })],
              })],
            },
          }],
        },
      ],
    }, { origin: 'desktop' });

    const state = workspace.documentState();
    const workTagId = Object.values(state.nodes).find((node) => node.type === 'tagDef' && node.content.text === 'Work')?.id;
    const statusFieldId = Object.values(state.nodes).find((node) => node.type === 'fieldDef' && node.content.text === 'Status')?.id;
    const value = state.nodes[valueId];
    expect(workTagId).toBeDefined();
    expect(statusFieldId).toBeDefined();
    expect(value?.tags).toContain(workTagId);
    const statusEntry = value?.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'fieldEntry' && node.fieldDefId === statusFieldId);
    expect(statusEntry?.children.map((childId) => state.nodes[childId]?.content.text)).toEqual(['Open']);
  });

  test('previews without mutation and applies the exact fixed-ID result as one Operation', async () => {
    const workspace = await makeWorkspace();
    const beforeRevision = workspace.revision();
    const changeSet: ChangeSet = {
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'test:preview-apply-replay',
      source: { kind: 'cli', label: 'kernel test' },
      operations: [{
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [draft('Created through ChangeSet', {
          children: [draft('Nested child')],
        })],
        bind: 'created',
      }],
      return: [{
        kind: 'outline',
        targets: { binding: 'created' },
        depth: 2,
        include: ['children', 'description'],
      }],
    };

    const conflictingDiff = await diffKeyed(workspace, {
      ...changeSet,
      operations: [{
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [draft('Different payload under the same key')],
      }],
    });
    const diff = await diffKeyed(workspace, changeSet);
    expect(Value.Check(DiffSchema, diff)).toBe(true);
    expect(workspace.revision()).toBe(beforeRevision);
    expect(await workspace.store.operations()).toEqual([]);
    expect(diff.bindings.created).toHaveLength(1);
    expect(diff.bindings.created?.[0]).toMatch(/^node:[0-9a-f-]{36}$/);
    expect(diff.affected.some((entry) => entry.id === diff.bindings.created?.[0] && entry.effect === 'create')).toBe(true);

    const operation = await applyOutlineDiff(workspace, diff, { origin: 'local-user' });
    expect(operation.revisionBefore).toBe(beforeRevision);
    expect(operation.revisionAfter).toBe(beforeRevision + 1);
    expect(operation.affectedNodeIds).toEqual(diff.affected.map((entry) => entry.id));
    expect(operation.result?.[0]?.nodes).toHaveLength(2);
    expect(await applyOutlineDiff(workspace, diff, { origin: 'local-user' })).toEqual(operation);
    await expect(applyOutlineDiff(workspace, conflictingDiff, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'idempotency_conflict' },
    });
    expect(workspace.documentState().nodes[diff.bindings.created![0]!]?.content.text).toBe('Created through ChangeSet');
    expect(await workspace.store.operations()).toHaveLength(1);
  });

  test('keeps a Diff self-contained across Runtime restart', async () => {
    const root = await makeRoot();
    const first = await openWorkspace(root, { instanceId: 'runtime:first' });
    const diff = await diffKeyed(first, createTodayChangeSet('Applied after restart'));

    const restarted = await openWorkspace(root, { instanceId: 'runtime:second' });
    const operation = await applyOutlineDiff(restarted, diff, { origin: 'external-client' });

    expect(operation.origin).toBe('external-client');
    expect(restarted.documentState().nodes[diff.bindings.created![0]!]?.content.text).toBe('Applied after restart');
  });

  test('rejects an unkeyed Diff before mutation admission', async () => {
    const workspace = await makeWorkspace();
    const diff = await diffOutlineChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [draft('Unkeyed apply')],
      }],
    });

    await expect(applyOutlineDiff(workspace, diff, { origin: 'external-client' })).rejects.toMatchObject({
      outlineError: { code: 'invalid_input', message: expect.stringContaining('idempotency key') },
    });
    expect(await workspace.store.operations()).toEqual([]);
  });

  test('reports focused schema paths for invalid Node IDs, field types, and capture provenance', async () => {
    const workspace = await makeWorkspace();
    const invalidCases = [
      {
        value: {
          protocolVersion: 1,
          kind: 'outline.changeset',
          operations: [{
            op: 'create',
            placement: { kind: 'last', parent: oneAlias('today') },
            nodes: [{ ...draft('Invalid ID'), id: 'node:not-canonical' }],
          }],
        },
        path: '/operations/0/nodes/0/id',
        secret: 'node:not-canonical',
      },
      {
        value: {
          protocolVersion: 1,
          kind: 'outline.changeset',
          operations: [{
            op: 'ensure',
            resource: 'definition',
            definitionType: 'field',
            id: 'field:invalid',
            name: 'Invalid field',
            fieldType: 'currency',
            bind: 'field',
          }],
        },
        path: '/operations/0/fieldType',
        secret: 'currency',
      },
      {
        value: {
          protocolVersion: 1,
          kind: 'outline.changeset',
          operations: [{
            op: 'create',
            placement: { kind: 'last', parent: oneAlias('today') },
            nodes: [{
              ...draft('Invalid capture'),
              metadata: { capture: captureProvenance('not-a-timestamp') },
            }],
          }],
        },
        path: '/operations/0/nodes/0/metadata/capture/capturedAt',
        secret: 'not-a-timestamp',
      },
    ] as const;

    for (const invalidCase of invalidCases) {
      try {
        await diffKeyed(workspace, invalidCase.value as unknown as ChangeSet);
        throw new Error('Expected invalid ChangeSet admission to fail.');
      } catch (error) {
        expect(error).toMatchObject({
          outlineError: {
            code: 'invalid_input',
            details: {
              validation: {
                issues: expect.arrayContaining([expect.objectContaining({ path: invalidCase.path })]),
              },
            },
          },
        });
        expect(JSON.stringify(error)).not.toContain(invalidCase.secret);
      }
    }
    expect(await workspace.store.operations()).toEqual([]);
  });

  test('rejects stale Diff and targeted digest changes without writing', async () => {
    const workspace = await makeWorkspace();
    const targetId = await createExisting(workspace, 'Target');
    const diff = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'update',
        targets: oneId(targetId),
        changes: [{ kind: 'description', value: 'Reviewed' }],
      }],
    });
    await workspace.mutate(updateRequest(targetId, 'Concurrent'));
    const operationsBefore = (await workspace.store.operations()).length;

    await expect(applyOutlineDiff(workspace, diff, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'stale_revision' },
    });
    expect(workspace.documentState().nodes[targetId]?.description).toBe('Concurrent');
    expect(await workspace.store.operations()).toHaveLength(operationsBefore);

    const source = await makeWorkspace();
    const destination = await makeWorkspace();
    const sharedId = 'node:00000000-0000-4000-8000-000000000031';
    const createShared = (text: string, idempotencyKey: string): ChangeSet => ({
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey,
      operations: [{
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [draft(text, { id: sharedId })],
      }],
    });
    await commitOutlineChangeSet(source, createShared('Source target', 'test:digest-source'), { origin: 'desktop' });
    await commitOutlineChangeSet(destination, createShared('Different target', 'test:digest-destination'), { origin: 'desktop' });
    expect(destination.revision()).toBe(source.revision());

    const crossWorkspaceDiff = await diffKeyed(source, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'update',
        targets: oneId(sharedId),
        changes: [{ kind: 'description', value: 'Reviewed source state' }],
      }],
    });
    const destinationOperations = await destination.store.operations();
    await expect(applyOutlineDiff(destination, crossWorkspaceDiff, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'precondition_failed' },
    });
    expect(destination.documentState().nodes[sharedId]).toMatchObject({
      content: { text: 'Different target' },
    });
    expect(destination.documentState().nodes[sharedId]).not.toHaveProperty('description');
    expect(await destination.store.operations()).toEqual(destinationOperations);
  });

  test('rejects ambiguous mutation selectors and forward binding references before preview writes', async () => {
    const workspace = await makeWorkspace();
    await createExisting(workspace, 'Repeated token alpha');
    await createExisting(workspace, 'Repeated token beta');
    const ambiguous: ChangeSet = {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'update',
        targets: {
          target: {
            selector: { by: 'query', query: { kind: 'rule', op: 'STRING_MATCH', text: 'Repeated token' }, limit: 10 },
            cardinality: 'one',
          },
        },
        changes: [{ kind: 'done', value: true }],
      }],
    };
    await expect(diffKeyed(workspace, ambiguous)).rejects.toMatchObject({
      outlineError: { code: 'ambiguous_selector' },
    });

    const forward: ChangeSet = {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [
        { op: 'create', placement: { kind: 'last', parent: { binding: 'later' } }, nodes: [draft('Invalid')] },
        { op: 'resolve', target: oneAliasTarget('today'), bind: 'later' },
      ],
    };
    await expect(diffKeyed(workspace, forward)).rejects.toMatchObject({
      outlineError: { code: 'invalid_input', message: expect.stringContaining('forward-references') },
    });
  });

  test('applies query selector filtering and document ordering before limit', async () => {
    const workspace = await makeWorkspace();
    const earlierId = await createExisting(workspace, 'Needle in an earlier document row with more words');
    await createExisting(workspace, 'Needle');
    const scopedParentId = `node:${crypto.randomUUID()}`;
    const scopedChildId = `node:${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Scoped query fixture'),
      execute: (core) => {
        core.createNode(core.projection().todayId, null, 'Scoped query parent', scopedParentId);
        core.createNode(scopedParentId, null, 'Needle inside the requested subtree', scopedChildId);
      },
    });
    const index = createSelectionIndex(workspace.projection());
    const query = { kind: 'rule' as const, op: 'STRING_MATCH' as const, text: 'Needle' };

    expect(resolveSelector(index, {
      by: 'query',
      query,
      order: 'document',
      limit: 1,
    })).toEqual([earlierId]);
    expect(resolveSelector(index, {
      by: 'query',
      query,
      within: { by: 'id', id: scopedParentId },
      order: 'document',
      limit: 1,
    })).toEqual([scopedChildId]);
  });

  test('resolves exact ID lists and executes Saved Searches from live state', async () => {
    const workspace = await makeWorkspace();
    const firstId = await createExisting(workspace, 'Live module first');
    const secondId = await createExisting(workspace, 'Exact second');
    const searchId = `node:${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create live Saved Search'),
      execute: (core) => {
        core.createSearchNode(core.projection().searchesId, null, {
          title: 'Live modules',
          query: { kind: 'rule', op: 'STRING_MATCH', text: 'Live module' },
        }, undefined, searchId);
      },
    });
    const laterId = await createExisting(workspace, 'Live module added after materialization');
    const state = workspace.documentState();
    expect(state.nodes[searchId]!.children
      .map((childId) => state.nodes[childId])
      .filter((node) => node?.type === 'reference')
      .map((node) => node.targetId)).not.toContain(laterId);

    const index = createSelectionIndex(workspace.projection());
    expect(resolveSelector(index, { by: 'ids', ids: [secondId, firstId] })).toEqual([secondId, firstId]);
    expect(() => resolveSelector(index, { by: 'ids', ids: [firstId, 'node:missing'] }))
      .toThrow('exact Node IDs');
    expect(resolveSelector(index, { by: 'search', id: searchId, limit: 10 }))
      .toEqual(expect.arrayContaining([firstId, laterId]));
  });

  test('executes transient and Saved Search media queries from Runtime AssetRecord metadata after restart', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const lease = await workspace.assets.ingestBytes(
      new TextEncoder().encode('audio fixture'),
      'runtime-audio.mp3',
      'audio/mpeg',
    );
    const ownerId = `node:${crypto.randomUUID()}`;
    await commitOutlineChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [
        {
          op: 'create',
          placement: { kind: 'last', parent: oneAlias('today') },
          nodes: [draft('Runtime audio Source', { id: ownerId })],
          bind: 'audio',
        },
        {
          op: 'update',
          targets: { binding: 'audio' },
          changes: [{ kind: 'source', action: 'add', sourceText: formatAssetSourceUri(lease.assetId) }],
        },
      ],
    }, { origin: 'external-client' });
    const searchId = `node:${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create managed-media Saved Search'),
      execute: (core) => {
        core.createSearchNode(core.projection().searchesId, null, {
          title: 'Runtime audio',
          query: { kind: 'rule', op: 'HAS_AUDIO' },
        }, undefined, searchId);
      },
    });

    const mediaSelector = { by: 'query' as const, query: { kind: 'rule' as const, op: 'HAS_AUDIO' as const }, limit: 10 };
    expect(resolveSelector(workspace.selectionIndex(), mediaSelector)).toEqual([ownerId]);
    expect(resolveSelector(workspace.selectionIndex(), { by: 'search', id: searchId, limit: 10 })).toEqual([ownerId]);
    await workspace.drainDurability();
    workspace.close();

    const restarted = await openWorkspace(root);
    expect(resolveSelector(restarted.selectionIndex(), mediaSelector)).toEqual([ownerId]);
    expect(resolveSelector(restarted.selectionIndex(), { by: 'search', id: searchId, limit: 10 })).toEqual([ownerId]);
    restarted.close();
  });

  test('returns a Node and its backlinks in separately bounded Projection pages', async () => {
    const workspace = await makeWorkspace();
    const targetId = await createExisting(workspace, 'Backlink target');
    const sourceId = await createExisting(workspace, 'Backlink source');
    const secondSourceId = await createExisting(workspace, 'Second backlink source');
    await workspace.mutate({
      ...createRequest('Create inline backlinks'),
      execute: (core) => {
        for (const id of [sourceId, secondSourceId]) {
          core.applyNodeTextPatch(id, {
            ops: [{
              type: 'replace_all',
              content: {
                text: 'Backlink source',
                marks: [],
                inlineRefs: [{
                  offset: 0,
                  target: { kind: 'node', nodeId: targetId },
                  displayName: 'Backlink target',
                }],
              },
            }],
          });
        }
      },
    });

    const projection: Projection = {
      kind: 'node',
      targets: oneId(targetId),
      include: ['references', 'backlinks'],
      page: { limit: 1 },
    };
    const first = projectOutline(workspace.forkCore(), projection);
    const second = projectOutline(workspace.forkCore(), {
      ...projection,
      page: { limit: 1, cursor: first.cursor },
    });

    expect(first.nodes).toContainEqual(expect.objectContaining({ id: targetId }));
    expect(first.backlinks).toHaveLength(1);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBeDefined();
    expect(second.nodes).toEqual([]);
    expect(second.backlinks).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
    const pagedBacklinks = [...(first.backlinks ?? []), ...(second.backlinks ?? [])];
    expect(new Set(pagedBacklinks.map((entry) => entry.sourceId))).toEqual(new Set([sourceId, secondSourceId]));
    expect(pagedBacklinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId, sourceId, kind: 'inline' }),
      expect.objectContaining({ targetId, sourceId: secondSourceId, kind: 'inline' }),
    ]));

    const backlinksOnlyFirst = projectOutline(workspace.forkCore(), {
      kind: 'backlinks', targets: oneId(targetId), page: { limit: 1 },
    });
    const backlinksOnlySecond = projectOutline(workspace.forkCore(), {
      kind: 'backlinks', targets: oneId(targetId),
      page: { limit: 1, cursor: backlinksOnlyFirst.cursor },
    });
    expect(backlinksOnlyFirst.nodes).toEqual([]);
    expect(backlinksOnlyFirst.backlinks).toHaveLength(1);
    expect(backlinksOnlyFirst.truncated).toBe(true);
    expect(backlinksOnlySecond.nodes).toEqual([]);
    expect(backlinksOnlySecond.backlinks).toHaveLength(1);
    expect(backlinksOnlySecond.truncated).toBeUndefined();
  });

  test('builds backlinks once for a bounded page across many selected targets', async () => {
    const workspace = await makeWorkspace();
    const targetIds = Array.from({ length: 250 }, () => `node:${crypto.randomUUID()}`);
    await workspace.mutate({
      ...createRequest('Create many backlink targets'),
      execute: (core) => {
        const parentId = core.projection().todayId;
        for (const [index, targetId] of targetIds.entries()) {
          core.createNode(parentId, null, `Backlink target ${index}`, targetId);
        }
      },
    });
    const core = workspace.forkCore();
    const originalBacklinks = core.backlinks.bind(core);
    let perTargetScans = 0;
    core.backlinks = (targetId) => {
      perTargetScans += 1;
      return originalBacklinks(targetId);
    };

    const result = projectOutline(core, {
      kind: 'backlinks',
      targets: {
        target: {
          selector: { by: 'ids', ids: targetIds },
          cardinality: 'many',
          max: targetIds.length,
        },
      },
      page: { limit: 1 },
    });

    expect(result.nodes).toEqual([]);
    expect(result.backlinks).toEqual([]);
    expect(perTargetScans).toBe(0);
  });

  test('moves an ordered target block before and after same-parent siblings atomically', async () => {
    const workspace = await makeWorkspace();
    const ids = {
      parent: `node:${crypto.randomUUID()}`,
      a: `node:${crypto.randomUUID()}`,
      b: `node:${crypto.randomUUID()}`,
      c: `node:${crypto.randomUUID()}`,
      d: `node:${crypto.randomUUID()}`,
    };
    await workspace.mutate({
      ...createRequest('Create move fixture'),
      execute: (core) => {
        core.createNode(core.projection().todayId, null, 'Move parent', ids.parent);
        for (const [id, text] of [[ids.a, 'A'], [ids.b, 'B'], [ids.c, 'C'], [ids.d, 'D']] as const) {
          core.createNode(ids.parent, null, text, id);
        }
      },
    });
    const original = [ids.a, ids.b, ids.c, ids.d];
    const many = (nodeIds: string[]) => ({
      target: { selector: { by: 'ids' as const, ids: nodeIds }, cardinality: 'many' as const, max: nodeIds.length },
    });

    const after = await applyOutlineDiff(workspace, await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'move', targets: many([ids.a, ids.b]), placement: { kind: 'after', sibling: oneId(ids.c) } }],
    }), { origin: 'local-user' });
    expect(documentChildIds(workspace, ids.parent)).toEqual([ids.c, ids.a, ids.b, ids.d]);
    await workspace.revert(after.operationId, { origin: 'local-user' });
    expect(documentChildIds(workspace, ids.parent)).toEqual(original);

    const before = await applyOutlineDiff(workspace, await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'move', targets: many([ids.c, ids.d]), placement: { kind: 'before', sibling: oneId(ids.a) } }],
    }), { origin: 'local-user' });
    expect(documentChildIds(workspace, ids.parent)).toEqual([ids.c, ids.d, ids.a, ids.b]);
    await workspace.revert(before.operationId, { origin: 'local-user' });
    expect(documentChildIds(workspace, ids.parent)).toEqual(original);
  });

  test('honors includeTrash during transient query execution', async () => {
    const workspace = await makeWorkspace();
    const nodeId = await createExisting(workspace, 'Searchable trashed row');
    await workspace.mutate({
      ...createRequest('Trash search fixture'),
      execute: (core) => { core.trashNode(nodeId); },
    });
    const index = createSelectionIndex(workspace.projection());
    const query = { kind: 'rule' as const, op: 'STRING_MATCH' as const, text: 'Searchable trashed row' };

    expect(resolveSelector(index, { by: 'query', query, limit: 10 })).not.toContain(nodeId);
    expect(resolveSelector(index, { by: 'query', query, includeTrash: true, limit: 10 })).toContain(nodeId);
  });

  test('treats ordinary rich-text replacement patches as non-destructive editor sync', async () => {
    const workspace = await makeWorkspace();
    const nodeId = await createExisting(workspace, 'Draft before sync');
    const richText = {
      text: 'Draft after sync',
      marks: [{ start: 0, end: 5, type: 'bold' as const }],
      inlineRefs: [],
    };
    const contentDiff = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'update',
        targets: oneId(nodeId),
        changes: [{
          kind: 'text-patch',
          field: 'content',
          patch: { ops: [{ type: 'replace_all', content: richText }] },
        }],
      }],
    });
    expect(contentDiff.destructive).toEqual([]);

    await applyOutlineDiff(workspace, contentDiff, { origin: 'local-user' });
    expect(workspace.documentState().nodes[nodeId]?.content).toEqual(richText);

    const descriptionDiff = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'update',
        targets: oneId(nodeId),
        changes: [{ kind: 'text-patch', field: 'description', from: 0, to: 0, value: 'Plain description sync' }],
      }],
    });
    expect(descriptionDiff.destructive).toEqual([]);

    await applyOutlineDiff(workspace, descriptionDiff, { origin: 'local-user' });
    expect(workspace.documentState().nodes[nodeId]?.description).toBe('Plain description sync');
  });

  test('requires acknowledgement only for explicitly reviewed text replacement patches', async () => {
    const workspace = await makeWorkspace();
    const nodeId = await createExisting(workspace, 'Reviewed before replace');
    const diff = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{
        op: 'update',
        targets: oneId(nodeId),
        changes: [{
          kind: 'text-patch',
          field: 'content',
          patch: { ops: [{ type: 'replace_all', content: { text: 'Reviewed after replace', marks: [], inlineRefs: [] } }] },
          review: { destructive: 'replace' },
        }],
      }],
    });
    expect(diff.destructive).toEqual([{ kind: 'replace', targetCount: 1 }]);

    await expect(applyOutlineDiff(workspace, diff, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'confirmation_required' },
    });
    expect(workspace.documentState().nodes[nodeId]?.content.text).toBe('Reviewed before replace');

    await applyOutlineDiff(workspace, diff, { origin: 'local-user' }, true);
    expect(workspace.documentState().nodes[nodeId]?.content.text).toBe('Reviewed after replace');
  });

  test('requires Diff-bound acknowledgement for purge and preserves exact recovery', async () => {
    const workspace = await makeWorkspace();
    const targetId = await createExisting(workspace, 'Purge me');
    await applyOutlineDiff(workspace, await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'lifecycle', action: 'trash', targets: oneId(targetId) }],
    }), { origin: 'local-user' });
    const purgeDiff = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'lifecycle', action: 'purge', targets: oneId(targetId) }],
    });
    expect(purgeDiff.destructive).toEqual([expect.objectContaining({ kind: 'purge' })]);

    await expect(applyOutlineDiff(workspace, purgeDiff, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'confirmation_required' },
    });
    expect(workspace.documentState().nodes[targetId]).toBeDefined();
    const purged = await applyOutlineDiff(workspace, purgeDiff, { origin: 'local-user' }, true);
    expect(workspace.documentState().nodes[targetId]).toBeUndefined();
    await workspace.revert(purged.operationId, { origin: 'local-user' });
    expect(workspace.documentState().nodes[targetId]?.content.text).toBe('Purge me');
  });

  test('paginates a Projection at one bound revision and rejects a stale cursor', async () => {
    const workspace = await makeWorkspace();
    for (let index = 0; index < 3; index += 1) await createExisting(workspace, `Page ${index}`);
    const projection: Projection = {
      kind: 'outline',
      targets: oneAlias('today'),
      depth: 1,
      include: ['children'],
      page: { limit: 2 },
    };
    const first = projectOutline(workspace.forkCore(), projection);
    expect(first.nodes).toHaveLength(2);
    expect(first.truncated).toBe(true);
    const second = projectOutline(workspace.forkCore(), {
      ...projection,
      page: { limit: 2, cursor: first.cursor },
    });
    expect(second.nodes.length).toBeGreaterThan(0);

    await createExisting(workspace, 'Invalidates cursor');
    expect(() => projectOutline(workspace.forkCore(), {
      ...projection,
      page: { limit: 2, cursor: first.cursor },
    })).toThrow('Projection cursor does not match');
  });

  test('redacts and preserves field view and trash metadata through include controls', async () => {
    const workspace = await makeWorkspace();
    const setup = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [
        {
          op: 'create',
          resource: 'definition',
          definitionType: 'field',
          name: 'Projection field',
          config: { fieldType: 'plain' },
          bind: 'field',
        },
        { op: 'create', placement: { kind: 'last', parent: oneAlias('today') }, nodes: [draft('Projection owner')], bind: 'owner' },
        {
          op: 'update',
          targets: { binding: 'owner' },
          changes: [{ kind: 'field', action: 'set', field: { binding: 'field' }, value: 'Projected value' }],
        },
        {
          op: 'update',
          targets: { binding: 'owner' },
          changes: [{
            kind: 'view',
            property: 'configuration',
            action: 'set',
            view: {
              mode: 'table',
              group: { binding: 'field' },
              replace: {
                sort: [{ field: 'sys:updatedAt', direction: 'desc' }],
                display: [{ field: 'sys:name' }, { field: { binding: 'field' } }],
              },
            },
          }],
        },
      ],
    });
    await applyOutlineDiff(workspace, setup, { origin: 'external-client' });
    const ownerId = setup.bindings.owner![0]!;
    const fieldId = setup.bindings.field![0]!;
    const request: Projection = {
      kind: 'outline',
      targets: oneId(ownerId),
      depth: 3,
      include: ['children'],
      page: { limit: 100 },
    };
    const redacted = projectOutline(workspace.forkCore(), request).nodes as Array<Record<string, unknown>>;
    const expanded = projectOutline(workspace.forkCore(), {
      ...request,
      include: ['children', 'fields', 'view'],
    }).nodes as Array<Record<string, unknown>>;
    const redactedField = redacted.find((node) => node.type === 'fieldEntry')!;
    const expandedField = expanded.find((node) => node.type === 'fieldEntry')!;
    const redactedView = redacted.find((node) => node.type === 'viewDef')!;
    const expandedView = expanded.find((node) => node.type === 'viewDef')!;
    const redactedSort = redacted.find((node) => node.type === 'sortRule')!;
    const expandedSort = expanded.find((node) => node.type === 'sortRule')!;
    expect(redactedField.fieldDefId).toBeUndefined();
    expect(expandedField.fieldDefId).toBe(fieldId);
    expect(redactedView.viewMode).toBeUndefined();
    expect(redactedView.groupField).toBeUndefined();
    expect(expandedView).toMatchObject({ viewMode: 'table', groupField: fieldId });
    expect(redactedSort.sortField).toBeUndefined();
    expect(expandedSort).toMatchObject({ sortField: 'sys:updatedAt', sortDirection: 'desc' });

    const trashed = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ op: 'lifecycle', action: 'trash', targets: oneId(ownerId) }],
    });
    await applyOutlineDiff(workspace, trashed, { origin: 'external-client' });
    const trashRequest: Projection = { kind: 'node', targets: oneId(ownerId), page: { limit: 1 } };
    expect((projectOutline(workspace.forkCore(), trashRequest).nodes[0] as Record<string, unknown>)
      .trashedFromParentId).toBeUndefined();
    expect((projectOutline(workspace.forkCore(), { ...trashRequest, include: ['trash'] }).nodes[0] as Record<string, unknown>)
      .trashedFromParentId).toBe(workspace.projection().todayId);
  });

  test('composes 100 date ensures and dependent creates into one Diff and one Operation', async () => {
    const workspace = await makeWorkspace();
    const operations: ChangeSet['operations'][number][] = [];
    const start = new Date(2028, 0, 1);
    for (let index = 0; index < 100; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const localDate = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ].join('-');
      operations.push({ op: 'ensure', resource: 'date', date: localDate, bind: `date${index}` });
      operations.push({
        op: 'create',
        placement: { kind: 'last', parent: { binding: `date${index}` } },
        nodes: [draft(`Imported ${localDate}`)],
      });
    }
    const changeSet: ChangeSet = { protocolVersion: 1, kind: 'outline.changeset', operations };
    const diff = await diffKeyed(workspace, changeSet);
    expect(Object.keys(diff.bindings).filter((name) => name.startsWith('date'))).toHaveLength(100);
    expect(workspace.revision()).toBe(0);

    const operation = await applyOutlineDiff(workspace, diff, { origin: 'external-client' });
    expect(operation.revisionAfter).toBe(1);
    expect(await workspace.store.operations()).toHaveLength(1);
    expect(workspace.projection().nodes.filter((node) => node.content.text.startsWith('Imported 2028-')).length).toBe(100);
  });

  test('yields a large import while preserving one searchable and undoable Operation', async () => {
    const workspace = await makeWorkspace();
    const children = Array.from({ length: 600 }, (_, index) => draft(`Cooperative import needle ${index}`));
    let eventLoopProgressed = false;
    const timer = setTimeout(() => { eventLoopProgressed = true; }, 0);
    const settlement = await commitOutlineChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      idempotencyKey: 'test:cooperative-import',
      source: { kind: 'import', label: 'Cooperative import fixture' },
      operations: [{
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [draft('Cooperative import root', { children })],
        bind: 'imported',
      }],
    }, { origin: 'external-client' });
    clearTimeout(timer);

    expect(settlement.kind).toBe('outline.operation');
    if (settlement.kind !== 'outline.operation') throw new Error('Expected import Operation.');
    expect(eventLoopProgressed).toBe(true);
    expect(settlement.revisionBefore).toBe(0);
    expect(settlement.revisionAfter).toBe(1);
    expect(await workspace.store.operations()).toHaveLength(1);
    const lastImportedId = workspace.projection().nodes.find((node) => (
      node.content.text === 'Cooperative import needle 599'
    ))!.id;
    expect(workspace.searchText('cooperative import needle 599', 50).map((hit) => hit.nodeId))
      .toContain(lastImportedId);

    const undo = await workspace.undo({
      origin: 'local-user',
      selectionOrigin: 'external-client',
      expectOperationId: settlement.operationId,
    });
    expect(undo.revertsOperationId).toBe(settlement.operationId);
    expect(workspace.searchText('cooperative import needle 599', 10)).toEqual([]);
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Cooperative import root')).toBe(false);
  }, 15_000);

  test('settles thousands of leaf mutations with one bounded Operation summary', async () => {
    const workspace = await makeWorkspace();
    const targetId = await createExisting(workspace, 'Bulk update target');
    const operations: ChangeSet['operations'][number][] = Array.from({ length: 2_050 }, (_, index) => ({
      op: 'update',
      targets: oneId(targetId),
      changes: [{ kind: 'description', value: `Bulk value ${index}` }],
    }));
    const diff = await diffKeyed(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations,
    });

    const operation = await applyOutlineDiff(workspace, diff, { origin: 'external-client' });

    expect(operation.summary).toBe('Applied 2050 ChangeSet operations: update x2050.');
    expect(operation.affectedNodeCount).toBe(1);
    expect(operation.recovery.state).toBe('available');
    expect(workspace.documentState().nodes[targetId]?.description).toBe('Bulk value 2049');
    expect(await workspace.store.operations()).toHaveLength(2);
  }, 15_000);

  test('rolls back every earlier change when a late operation fails', async () => {
    const workspace = await makeWorkspace();
    const before = workspace.documentState();
    const operationsBefore = await workspace.store.operations();
    const changeSet: ChangeSet = {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [
        { op: 'create', placement: { kind: 'last', parent: oneAlias('today') }, nodes: [draft('Must roll back')], bind: 'created' },
        { op: 'move', targets: { binding: 'created' }, placement: { kind: 'last', parent: { binding: 'created' } } },
      ],
    };

    await expect(diffKeyed(workspace, changeSet)).rejects.toMatchObject({
      outlineError: { code: 'precondition_failed', message: expect.stringContaining('operation 1') },
    });
    expect(workspace.documentState()).toEqual(before);
    expect(await workspace.store.operations()).toEqual(operationsBefore);
  });
});

function draft(text: string, patch: Partial<NodeDraft> = {}): NodeDraft {
  return {
    content: { text, marks: [], inlineRefs: [] },
    children: [],
    ...patch,
  };
}

function captureProvenance(capturedAt: string) {
  return {
    schemaVersion: 1 as const,
    captureId: 'capture:invalid-schema-fixture',
    createdBy: 'agent' as const,
    capturedAt,
    origin: 'test' as const,
    providerId: 'generic-webpage' as const,
    app: { name: 'Schema fixture' },
    source: {
      kind: 'webpage' as const,
      title: 'Schema fixture',
      original: {
        kind: 'remote-url' as const,
        url: 'https://example.com/schema-fixture',
        preview: 'web-preview' as const,
      },
      providerId: 'generic-webpage' as const,
    },
    status: 'saved' as const,
    intent: 'capture' as const,
    warnings: [],
  };
}

function createTodayChangeSet(text: string): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [{ op: 'create', placement: { kind: 'last', parent: oneAlias('today') }, nodes: [draft(text)], bind: 'created' }],
  };
}

function diffKeyed(workspace: OutlineRuntimeWorkspace, changeSet: ChangeSet) {
  return diffOutlineChangeSet(workspace, {
    ...changeSet,
    idempotencyKey: changeSet.idempotencyKey ?? `test:${crypto.randomUUID()}`,
  });
}

function oneAlias(alias: 'today') {
  return { target: oneAliasTarget(alias) } as const;
}

function oneAliasTarget(alias: 'today') {
  return { selector: { by: 'alias' as const, alias }, cardinality: 'one' as const };
}

function oneId(id: string) {
  return { target: { selector: { by: 'id' as const, id }, cardinality: 'one' as const } };
}

function createRequest(text: string) {
  const payload = { kind: 'create', text };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Created ${text}.`,
    execute: (core: Parameters<Parameters<OutlineRuntimeWorkspace['mutate']>[0]['execute']>[0]) => {
      const id = `node:${crypto.randomUUID()}`;
      core.createNode(core.projection().todayId, null, text, id);
      return undefined;
    },
  };
}

async function createExisting(workspace: OutlineRuntimeWorkspace, text: string): Promise<string> {
  const before = new Set(Object.keys(workspace.documentState().nodes));
  await workspace.mutate(createRequest(text));
  return Object.values(workspace.documentState().nodes)
    .find((node) => !before.has(node.id) && node.content.text === text)!.id;
}

function updateRequest(nodeId: string, description: string) {
  const payload = { kind: 'update', nodeId, description };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Updated ${nodeId}.`,
    execute: (core: Parameters<Parameters<OutlineRuntimeWorkspace['mutate']>[0]['execute']>[0]) => {
      core.updateNodeDescription(nodeId, description);
    },
  };
}

async function makeWorkspace(): Promise<OutlineRuntimeWorkspace> {
  return openWorkspace(await makeRoot(), { instanceId: `runtime:${crypto.randomUUID()}` });
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-kernel-'));
  roots.push(root);
  return root;
}
type WorkspaceOpenOptions = NonNullable<Parameters<typeof OutlineRuntimeWorkspace.open>[1]>;

function openWorkspace(
  root: string,
  options: WorkspaceOpenOptions = {},
): Promise<OutlineRuntimeWorkspace> {
  return OutlineRuntimeWorkspace.open(root, {
    ...options,
    contentRoot: options.contentRoot ?? path.join(root, 'content'),
  });
}
