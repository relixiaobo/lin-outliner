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
  createSelectionIndex,
  diffOutlineChangeSet,
  projectOutline,
  resolveSelector,
} from '../../src/outline/runtime';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('outline ChangeSet kernel', () => {
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
        parents: oneAlias('today'),
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
        parents: oneAlias('today'),
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
    const first = await OutlineRuntimeWorkspace.open(root, { instanceId: 'runtime:first' });
    const diff = await diffKeyed(first, createTodayChangeSet('Applied after restart'));

    const restarted = await OutlineRuntimeWorkspace.open(root, { instanceId: 'runtime:second' });
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
        parents: oneAlias('today'),
        nodes: [draft('Unkeyed apply')],
      }],
    });

    await expect(applyOutlineDiff(workspace, diff, { origin: 'external-client' })).rejects.toMatchObject({
      outlineError: { code: 'invalid_input', message: expect.stringContaining('idempotency key') },
    });
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
        { op: 'create', parents: { binding: 'later' }, nodes: [draft('Invalid')] },
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
        { op: 'create', parents: oneAlias('today'), nodes: [draft('Projection owner')], bind: 'owner' },
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
        parents: { binding: `date${index}` },
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
        { op: 'create', parents: oneAlias('today'), nodes: [draft('Must roll back')], bind: 'created' },
        { op: 'move', targets: { binding: 'created' }, destination: { binding: 'created' } },
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

function createTodayChangeSet(text: string): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [{ op: 'create', parents: oneAlias('today'), nodes: [draft(text)], bind: 'created' }],
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
  return OutlineRuntimeWorkspace.open(await makeRoot(), { instanceId: `runtime:${crypto.randomUUID()}` });
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-kernel-'));
  roots.push(root);
  return root;
}
