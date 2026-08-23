import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Change, ChangeSet, NodeDraft, Operation, TargetRef } from '../../src/outline/contract';
import {
  OutlineRuntimeWorkspace,
  applyOutlineDiff,
  diffOutlineChangeSet,
} from '../../src/outline/runtime';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('outline ChangeSet capability coverage', () => {
  test('preserves rich content, capture provenance, fields, definitions, and references', async () => {
    const workspace = await makeWorkspace();
    const definitions = await settle(workspace, [
      { op: 'ensure', resource: 'definition', definitionType: 'tag', name: 'Runtime tag', bind: 'tag' },
      { op: 'ensure', resource: 'definition', definitionType: 'field', name: 'Runtime field', fieldType: 'plain', bind: 'field' },
    ]);
    const tagId = definitions.diff.bindings.tag![0]!;
    const fieldId = definitions.diff.bindings.field![0]!;
    await settle(workspace, [
      {
        op: 'update',
        targets: oneId(tagId),
        changes: [{ kind: 'definition', definitionType: 'tag', patch: { showCheckbox: true } }],
      },
      {
        op: 'update',
        targets: oneId(fieldId),
        changes: [{ kind: 'definition', definitionType: 'field', patch: { nullable: true } }],
      },
    ]);

    const seeds = await settle(workspace, [{
      op: 'create',
      parents: oneAlias('today'),
      nodes: [draft('Reference A'), draft('Reference B')],
      bind: 'seeds',
    }]);
    const [referenceA, referenceB] = seeds.diff.bindings.seeds!;
    const capture = captureMetadata();
    const rich = await settle(workspace, [{
      op: 'create',
      parents: oneAlias('today'),
      nodes: [draft('Rich captured node', {
        content: {
          text: 'Rich captured node',
          marks: [{ start: 0, end: 4, type: 'bold' }],
          inlineRefs: [{ offset: 4, target: { kind: 'node', nodeId: referenceA! } }],
        },
        description: 'Captured description',
        checkbox: true,
        done: true,
        tags: [tagId],
        fields: [{ fieldDefId: fieldId, values: [draft('Field value')] }],
        metadata: { capture },
        children: [draft('const value = 1', { type: 'codeBlock', codeLanguage: 'typescript' })],
      })],
      bind: 'rich',
    }]);
    const richId = rich.diff.bindings.rich![0]!;
    const richNode = workspace.documentState().nodes[richId]!;
    expect(richNode.capture).toEqual(capture);
    expect(richNode.content.marks).toEqual([{ start: 0, end: 4, type: 'bold' }]);
    expect(richNode.content.inlineRefs).toEqual([{ offset: 4, target: { kind: 'node', nodeId: referenceA } }]);
    expect(richNode.tags).toContain(tagId);
    expect(richNode.completedAt).toBeGreaterThan(0);
    expect(workspace.documentState().nodes[richNode.children.at(-1)!]?.type).toBe('codeBlock');
    expect(Object.values(workspace.documentState().nodes)).toContainEqual(
      expect.objectContaining({ type: 'fieldEntry', parentId: richId, fieldDefId: fieldId }),
    );

    const reference = await settle(workspace, [{
      op: 'create',
      parents: oneId(richId),
      nodes: [draft('', { type: 'reference', referenceTargetId: referenceA })],
      bind: 'reference',
    }]);
    const referenceId = reference.diff.bindings.reference![0]!;
    await settle(workspace, [{
      op: 'update',
      targets: oneId(referenceId),
      changes: [{ kind: 'reference', action: 'retarget', target: oneId(referenceB!) }],
    }]);
    expect(workspace.documentState().nodes[referenceId]?.targetId).toBe(referenceB);
    const inlined = await settle(workspace, [{
      op: 'update',
      targets: oneId(referenceId),
      changes: [{ kind: 'reference', action: 'inline', target: oneId(referenceB!) }],
    }]);
    const inlineId = inlined.diff.affected.find((entry) => entry.effect === 'create')!.id;
    expect(workspace.documentState().nodes[referenceId]).toBeUndefined();
    expect(workspace.documentState().nodes[inlineId]?.type).toBeUndefined();
    const restored = await settle(workspace, [{
      op: 'update',
      targets: oneId(inlineId),
      changes: [{ kind: 'reference', action: 'restore', target: oneId(referenceB!) }],
    }]);
    const restoredReferenceId = restored.diff.affected.find((entry) => entry.effect === 'create')!.id;
    expect(workspace.documentState().nodes[restoredReferenceId]).toMatchObject({ type: 'reference', targetId: referenceB });

    await settle(workspace, [{
      op: 'update',
      targets: oneId(richId),
      changes: [{ kind: 'field', action: 'define', name: 'Temporary field', fieldType: 'plain' }],
    }]);
    const stateWithTemporary = workspace.documentState();
    const temporaryDefinition = Object.values(stateWithTemporary.nodes)
      .find((node) => node.type === 'fieldDef' && node.content.text === 'Temporary field')!;
    const temporaryEntry = Object.values(stateWithTemporary.nodes)
      .find((node) => node.type === 'fieldEntry' && node.parentId === richId && node.fieldDefId === temporaryDefinition.id)!;
    const replacement = await settle(workspace, [{
      op: 'ensure', resource: 'definition', definitionType: 'field', name: 'Replacement field', fieldType: 'plain', bind: 'replacement',
    }]);
    const replacementId = replacement.diff.bindings.replacement![0]!;
    await settle(workspace, [{
      op: 'update',
      targets: oneId(richId),
      changes: [{
        kind: 'field',
        action: 'reuse',
        sourceField: oneId(temporaryDefinition.id),
        field: oneId(replacementId),
      }],
    }]);
    expect(workspace.documentState().nodes[temporaryEntry.id]?.fieldDefId).toBe(replacementId);
    expect(workspace.documentState().nodes[temporaryDefinition.id]).toBeUndefined();
  });

  test('executes view, search, template, and definition-merge behavior through one public union', async () => {
    const workspace = await makeWorkspace();
    const definitions = await settle(workspace, [
      { op: 'ensure', resource: 'definition', definitionType: 'tag', name: 'Template tag', bind: 'templateTag' },
      { op: 'ensure', resource: 'definition', definitionType: 'tag', name: 'Merge source', bind: 'mergeSource' },
      { op: 'ensure', resource: 'definition', definitionType: 'tag', name: 'Merge target', bind: 'mergeTarget' },
    ]);
    const templateTagId = definitions.diff.bindings.templateTag![0]!;
    const mergeSourceId = definitions.diff.bindings.mergeSource![0]!;
    const mergeTargetId = definitions.diff.bindings.mergeTarget![0]!;
    const tagged = await settle(workspace, [{
      op: 'create',
      parents: oneAlias('today'),
      nodes: [draft('Tagged before template', { tags: [templateTagId] })],
      bind: 'tagged',
    }]);
    const taggedId = tagged.diff.bindings.tagged![0]!;
    const template = await settle(workspace, [{
      op: 'create',
      parents: oneId(templateTagId),
      nodes: [draft('Template child')],
      bind: 'template',
    }]);
    const templateId = template.diff.bindings.template![0]!;
    await settle(workspace, [{ op: 'template', action: 'apply', tag: oneId(templateTagId) }]);
    expect(Object.values(workspace.documentState().nodes)).toContainEqual(
      expect.objectContaining({ parentId: taggedId, templateId, content: expect.objectContaining({ text: 'Template child' }) }),
    );

    await settle(workspace, [{
      op: 'update', targets: oneId(taggedId), changes: [{ kind: 'tag', action: 'add', tag: oneId(mergeSourceId) }],
    }]);
    const merged = await settle(workspace, [{ op: 'merge', sources: oneId(mergeSourceId), target: oneId(mergeTargetId) }], true);
    expect(merged.diff.destructive).toContainEqual(expect.objectContaining({ kind: 'merge' }));
    expect(workspace.documentState().nodes[mergeSourceId]).toBeUndefined();
    expect(workspace.documentState().nodes[taggedId]?.tags).toContain(mergeTargetId);

    const todayId = workspace.projection().todayId;
    await settle(workspace, [{
      op: 'update',
      targets: oneId(todayId),
      changes: [
        { kind: 'view', property: 'mode', action: 'set', value: 'table' },
        { kind: 'view', property: 'toolbar', action: 'set', value: true },
        { kind: 'view', property: 'group', action: 'set', value: 'sys:tags' },
        { kind: 'view', property: 'sort', action: 'add', value: { field: 'sys:updatedAt', direction: 'desc' } },
        { kind: 'view', property: 'filter', action: 'add', value: { field: 'sys:done', operator: 'is', values: ['true'], valueLogic: 'any' } },
        { kind: 'view', property: 'display-field', action: 'add', value: { field: 'sys:name' } },
      ],
    }]);
    const viewState = workspace.documentState();
    const view = Object.values(viewState.nodes).find((node) => node.type === 'viewDef' && node.parentId === todayId)!;
    expect(view).toMatchObject({ viewMode: 'table', toolbarVisible: true, groupField: 'sys:tags' });
    expect(view.children.map((id) => viewState.nodes[id]?.type)).toEqual(expect.arrayContaining(['sortRule', 'filterRule', 'displayField']));

    const search = await settle(workspace, [{
      op: 'create',
      parents: oneAlias('today'),
      nodes: [draft('Runtime search', {
        type: 'search',
        metadata: { query: { kind: 'rule', op: 'STRING_MATCH', text: 'Tagged' } },
      })],
      bind: 'search',
    }]);
    const searchId = search.diff.bindings.search![0]!;
    await settle(workspace, [{
      op: 'update',
      targets: oneId(searchId),
      changes: [{
        kind: 'search',
        action: 'set',
        value: { title: 'Renamed search', query: { kind: 'rule', op: 'STRING_MATCH', text: 'template' } },
      }],
    }]);
    expect(workspace.documentState().nodes[searchId]).toMatchObject({ type: 'search', content: { text: 'Renamed search' } });
  });
});

async function settle(
  workspace: OutlineRuntimeWorkspace,
  operations: readonly Change[],
  acknowledgeDestructive = false,
): Promise<{ diff: Awaited<ReturnType<typeof diffOutlineChangeSet>>; operation: Operation }> {
  const changeSet: ChangeSet = { protocolVersion: 1, kind: 'outline.changeset', operations: [...operations] };
  const diff = await diffOutlineChangeSet(workspace, changeSet);
  let operation: Operation;
  try {
    operation = await applyOutlineDiff(workspace, diff, { origin: 'external-client' }, acknowledgeDestructive);
  } catch (error) {
    throw new Error(`Failed to settle test ChangeSet: ${JSON.stringify(operations)}`, { cause: error });
  }
  return { diff, operation };
}

function oneAlias(alias: 'today'): TargetRef {
  return { target: { selector: { by: 'alias', alias }, cardinality: 'one' } };
}

function oneId(id: string): TargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function draft(text: string, patch: Partial<NodeDraft> = {}): NodeDraft {
  return { content: { text, marks: [], inlineRefs: [] }, children: [], ...patch };
}

function captureMetadata() {
  return {
    schemaVersion: 1,
    captureId: 'capture:runtime-test',
    createdBy: 'import',
    capturedAt: '2026-08-24T00:00:00.000Z',
    origin: 'test',
    providerId: 'generic-webpage',
    app: { name: 'Outline Runtime test' },
    source: {
      kind: 'article',
      title: 'Runtime source',
      original: { kind: 'remote-url', url: 'https://example.com', preview: 'web-preview' },
      providerId: 'generic-webpage',
    },
    status: 'saved',
    intent: 'capture',
    warnings: [],
  };
}

async function makeWorkspace(): Promise<OutlineRuntimeWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-capabilities-'));
  roots.push(root);
  return OutlineRuntimeWorkspace.open(root, { instanceId: `runtime:${crypto.randomUUID()}` });
}
