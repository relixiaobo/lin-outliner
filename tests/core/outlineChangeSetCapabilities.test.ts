import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MEMORY_TAG_DEFINITIONS } from '../../src/core/agent/memory';
import { projectFieldConfig } from '../../src/core/configProjection';
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
  test('protects deterministic Memory tags while permitting ordinary tag application', async () => {
    const workspace = await makeWorkspace();
    const ensured = await settle(workspace, MEMORY_TAG_DEFINITIONS.map((definition, index): Change => ({
      op: 'ensure',
      resource: 'definition',
      definitionType: 'tag',
      id: definition.tagId,
      name: definition.name,
      bind: `memoryTag${index + 1}`,
    })));
    for (const definition of MEMORY_TAG_DEFINITIONS) {
      expect(workspace.documentState().nodes[definition.tagId]).toMatchObject({
        id: definition.tagId,
        type: 'tagDef',
        parentId: workspace.projection().schemaId,
        locked: true,
        content: { text: definition.name },
      });
    }

    const ordinary = await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [draft('Ordinary tagged Node')],
      bind: 'ordinary',
    }]);
    const ordinaryId = ordinary.diff.bindings.ordinary![0]!;
    const memoryTagId = MEMORY_TAG_DEFINITIONS[0]!.tagId;
    await settle(workspace, [{
      op: 'update',
      targets: oneId(ordinaryId),
      changes: [{ kind: 'tag', action: 'add', tag: oneId(memoryTagId) }],
    }]);
    expect(workspace.documentState().nodes[ordinaryId]?.tags).toContain(memoryTagId);

    await expect(diffOutlineChangeSet(workspace, changeSet([{
      op: 'create',
      placement: { kind: 'last', parent: oneId(memoryTagId) },
      nodes: [draft('Forbidden definition child')],
    }]))).rejects.toMatchObject({ outlineError: { code: 'precondition_failed' } });
    await expect(workspace.revert(ensured.operation.operationId, {
      origin: 'external-client',
    })).rejects.toMatchObject({ outlineError: { code: 'precondition_failed' } });
    expect(workspace.documentState().nodes[memoryTagId]).toBeDefined();
  });

  test('keeps explicit definition IDs stable and rejects same-name ID conflicts without writing', async () => {
    const workspace = await makeWorkspace();
    const definition = {
      op: 'ensure' as const,
      resource: 'definition' as const,
      definitionType: 'field' as const,
      id: 'field:url',
      name: 'URL',
      fieldType: 'url',
      bind: 'urlField',
    };

    const created = await settle(workspace, [definition]);
    const repeated = await diffOutlineChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [definition],
    });
    expect(created.diff.bindings.urlField).toEqual(['field:url']);
    expect(repeated.bindings.urlField).toEqual(['field:url']);
    expect(workspace.documentState().nodes['field:url']).toMatchObject({
      id: 'field:url',
      type: 'fieldDef',
      content: { text: 'URL' },
    });
    expect(projectFieldConfig(
      new Map(Object.values(workspace.documentState().nodes).map((node) => [node.id, node])),
      workspace.documentState().nodes['field:url']!,
    )).toMatchObject({ fieldType: 'url' });
    expect(Object.values(workspace.documentState().nodes).some((node) => (
      node.type === 'fieldEntry' && node.fieldDefId === 'field:url'
    ))).toBe(false);

    const operationsBeforeConflict = await workspace.store.operations();
    await expect(diffOutlineChangeSet(workspace, {
      protocolVersion: 1,
      kind: 'outline.changeset',
      operations: [{ ...definition, id: 'field:other-url' }],
    })).rejects.toMatchObject({
      outlineError: { code: 'invalid_input', category: 'usage' },
    });
    expect(await workspace.store.operations()).toEqual(operationsBeforeConflict);
    expect(workspace.documentState().nodes['field:other-url']).toBeUndefined();
  });

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
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [draft('Reference A'), draft('Reference B')],
      bind: 'seeds',
    }]);
    const [referenceA, referenceB] = seeds.diff.bindings.seeds!;
    const capture = captureMetadata();
    const rich = await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [draft('Rich captured node', {
        content: {
          text: 'Rich captured node',
          marks: [
            { start: 0, end: 4, type: 'bold' },
            { start: 5, end: 13, type: 'link', attrs: { href: 'https://example.com/docs_(v1)' } },
          ],
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
    expect(richNode.content.marks).toEqual([
      { start: 0, end: 4, type: 'bold' },
      { start: 5, end: 13, type: 'link', attrs: { href: 'https://example.com/docs_(v1)' } },
    ]);
    expect(richNode.content.inlineRefs).toEqual([{ offset: 4, target: { kind: 'node', nodeId: referenceA } }]);
    expect(richNode.tags).toContain(tagId);
    expect(richNode.completedAt).toBeGreaterThan(0);
    expect(workspace.documentState().nodes[richNode.children.at(-1)!]?.type).toBe('codeBlock');
    expect(Object.values(workspace.documentState().nodes)).toContainEqual(
      expect.objectContaining({ type: 'fieldEntry', parentId: richId, fieldDefId: fieldId }),
    );

    const unchecked = await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [draft('Unchecked', { checkbox: true, done: false })],
      bind: 'unchecked',
    }]);
    expect(workspace.documentState().nodes[unchecked.diff.bindings.unchecked![0]!]).toMatchObject({
      content: { text: 'Unchecked' },
      completedAt: 0,
    });

    const reference = await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneId(richId) },
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
    const inlineId = 'node:00000000-0000-4000-8000-000000000011';
    const inlined = await settle(workspace, [{
      op: 'update',
      targets: oneId(referenceId),
      changes: [{
        kind: 'reference',
        action: 'inline',
        target: oneId(referenceB!),
        replacementId: inlineId,
      }],
    }]);
    expect(inlined.diff.affected).toContainEqual(expect.objectContaining({ id: inlineId, effect: 'create' }));
    expect(workspace.documentState().nodes[referenceId]).toBeUndefined();
    expect(workspace.documentState().nodes[inlineId]?.type).toBeUndefined();
    const restoredReferenceId = 'node:00000000-0000-4000-8000-000000000012';
    const restored = await settle(workspace, [{
      op: 'update',
      targets: oneId(inlineId),
      changes: [{
        kind: 'reference',
        action: 'restore',
        target: oneId(referenceB!),
        replacementId: restoredReferenceId,
      }],
    }]);
    expect(restored.diff.affected).toContainEqual(expect.objectContaining({
      id: restoredReferenceId,
      effect: 'create',
    }));
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
    await settle(workspace, [{
      op: 'update',
      targets: oneId(richId),
      changes: [{
        kind: 'field',
        action: 'reuse',
        sourceField: oneId(replacementId),
        field: oneId('sys:createdAt'),
      }],
    }]);
    expect(workspace.documentState().nodes[temporaryEntry.id]?.fieldDefId).toBe('sys:createdAt');
    expect(workspace.documentState().nodes[replacementId]).toBeUndefined();

    const inlineTrigger = (await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneId(richId) },
      nodes: [draft('>')],
      bind: 'inlineTrigger',
    }])).diff.bindings.inlineTrigger![0]!;
    await settle(workspace, [{
      op: 'update',
      targets: oneId(inlineTrigger),
      changes: [{ kind: 'field', action: 'convert', name: '', fieldType: 'plain' }],
    }]);
    expect(workspace.documentState().nodes[inlineTrigger]).toMatchObject({
      type: 'fieldEntry',
      content: { text: '' },
    });

    await settle(workspace, [{
      op: 'update',
      targets: oneId(richId),
      changes: [{
        kind: 'text-patch',
        field: 'content',
        patch: {
          ops: [
            { type: 'replace', from: 0, to: 4, content: { text: 'Deep', marks: [], inlineRefs: [] } },
            { type: 'add_mark', from: 0, to: 4, markType: 'italic' },
          ],
        },
      }],
    }]);
    expect(workspace.documentState().nodes[richId]?.content).toMatchObject({
      text: 'Deep captured node',
      marks: [
        expect.objectContaining({ start: 0, end: 4, type: 'italic' }),
        { start: 5, end: 13, type: 'link', attrs: { href: 'https://example.com/docs_(v1)' } },
      ],
    });

    await settle(workspace, [{
      op: 'update',
      targets: oneId(richId),
      changes: [{
        kind: 'field-slot',
        field: oneId(fieldId),
        mutation: {
          action: 'append-reference',
          target: oneId(referenceB!),
          id: 'node:00000000-0000-4000-8000-000000000001',
        },
      }],
    }]);
    expect(workspace.documentState().nodes['node:00000000-0000-4000-8000-000000000001']).toMatchObject({
      type: 'reference',
      targetId: referenceB,
    });
  });

  test('preserves field multiplicity, reference identity, omissions, template values, and one owner entry', async () => {
    const workspace = await makeWorkspace();
    const fieldId = 'field:runtime-values';
    const tagId = 'tag:runtime-values';
    const firstTargetId = 'node:00000000-0000-4000-8000-000000000021';
    const secondTargetId = 'node:00000000-0000-4000-8000-000000000022';
    await settle(workspace, [
      {
        op: 'ensure',
        resource: 'definition',
        definitionType: 'field',
        id: fieldId,
        name: 'Runtime values',
        fieldType: 'plain',
        bind: 'field',
      },
      {
        op: 'ensure',
        resource: 'definition',
        definitionType: 'tag',
        id: tagId,
        name: 'Runtime record',
        bind: 'tag',
      },
      {
        op: 'create',
        placement: { kind: 'last', parent: oneAlias('today') },
        nodes: [
          draft('First target', { id: firstTargetId }),
          draft('Second target', { id: secondTargetId }),
        ],
      },
    ]);
    await settle(workspace, [{
      op: 'update',
      targets: oneId(tagId),
      changes: [{ kind: 'field', action: 'attach', field: oneId(fieldId) }],
    }]);
    await settle(workspace, [{
      op: 'update',
      targets: oneId(tagId),
      changes: [{
        kind: 'field-slot',
        field: oneId(fieldId),
        mutation: { action: 'append-text', text: 'Template default' },
      }],
    }]);

    const sameReferenceLabel = (nodeId: string): NodeDraft => draft('', {
      content: {
        text: '',
        marks: [],
        inlineRefs: [{
          offset: 0,
          displayName: 'Same reference',
          target: { kind: 'node', nodeId },
        }],
      },
    });
    const sameLinkLabel = (href: string): NodeDraft => draft('docs', {
      content: {
        text: 'docs',
        marks: [{ start: 0, end: 4, type: 'link', attrs: { href } }],
        inlineRefs: [],
      },
    });
    const created = await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [draft('Record', {
        tags: [tagId],
        fields: [{
          fieldDefId: fieldId,
          values: [
            draft('Same value'),
            draft('Same value'),
            sameReferenceLabel(firstTargetId),
            sameReferenceLabel(secondTargetId),
            sameLinkLabel('https://a.test/docs_(v1)'),
            sameLinkLabel('https://b.test'),
          ],
        }],
        children: [draft('Ordinary child')],
      })],
      bind: 'owner',
    }]);
    const ownerId = created.diff.bindings.owner![0]!;
    const owner = workspace.documentState().nodes[ownerId]!;
    const fieldEntries = owner.children
      .map((childId) => workspace.documentState().nodes[childId])
      .filter((node) => node?.type === 'fieldEntry' && node.fieldDefId === fieldId);
    expect(fieldEntries).toHaveLength(1);
    const entryId = fieldEntries[0]!.id;
    expect(owner.children[0]).toBe(entryId);

    await settle(workspace, [{
      op: 'update',
      targets: oneId(ownerId),
      changes: [{
        kind: 'field-slot',
        field: oneId(fieldId),
        mutation: { action: 'append-text', text: 'Later value' },
      }],
    }]);
    await settle(workspace, [{
      op: 'update',
      targets: oneId(ownerId),
      changes: [{
        kind: 'text-patch',
        field: 'content',
        patch: {
          ops: [{
            type: 'replace',
            from: 0,
            to: 'Record'.length,
            content: { text: 'Record updated', marks: [], inlineRefs: [] },
          }],
        },
      }],
    }]);

    const finalState = workspace.documentState();
    const finalOwner = finalState.nodes[ownerId]!;
    const finalEntries = finalOwner.children.filter((childId) => (
      finalState.nodes[childId]?.type === 'fieldEntry'
      && finalState.nodes[childId]?.fieldDefId === fieldId
    ));
    expect(finalOwner.content.text).toBe('Record updated');
    expect(finalEntries).toEqual([entryId]);
    expect(finalState.nodes[entryId]!.children.map((valueId) => finalState.nodes[valueId]!.content)).toEqual([
      { text: 'Same value', marks: [], inlineRefs: [] },
      { text: 'Same value', marks: [], inlineRefs: [] },
      {
        text: '',
        marks: [],
        inlineRefs: [{
          offset: 0,
          displayName: 'Same reference',
          target: { kind: 'node', nodeId: firstTargetId },
        }],
      },
      {
        text: '',
        marks: [],
        inlineRefs: [{
          offset: 0,
          displayName: 'Same reference',
          target: { kind: 'node', nodeId: secondTargetId },
        }],
      },
      {
        text: 'docs',
        marks: [{ start: 0, end: 4, type: 'link', attrs: { href: 'https://a.test/docs_(v1)' } }],
        inlineRefs: [],
      },
      {
        text: 'docs',
        marks: [{ start: 0, end: 4, type: 'link', attrs: { href: 'https://b.test' } }],
        inlineRefs: [],
      },
      { text: 'Later value', marks: [], inlineRefs: [] },
    ]);
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
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [draft('Tagged before template', { tags: [templateTagId] })],
      bind: 'tagged',
    }]);
    const taggedId = tagged.diff.bindings.tagged![0]!;
    const template = await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneId(templateTagId) },
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
        { kind: 'view', property: 'mode', action: 'set', mode: 'table' },
        { kind: 'view', property: 'toolbar', action: 'set', visible: true },
        { kind: 'view', property: 'group', action: 'set', field: 'sys:tags' },
        { kind: 'view', property: 'sort', action: 'add', field: 'sys:updatedAt', direction: 'desc' },
        { kind: 'view', property: 'filter', action: 'add', field: 'sys:done', operator: 'is', values: ['true'], valueLogic: 'any' },
        { kind: 'view', property: 'display-field', action: 'add', field: 'sys:name' },
      ],
    }]);
    const viewState = workspace.documentState();
    const view = Object.values(viewState.nodes).find((node) => node.type === 'viewDef' && node.parentId === todayId)!;
    expect(view).toMatchObject({ viewMode: 'table', toolbarVisible: true, groupField: 'sys:tags' });
    expect(view.children.map((id) => viewState.nodes[id]?.type)).toEqual(expect.arrayContaining(['sortRule', 'filterRule', 'displayField']));

    const search = await settle(workspace, [{
      op: 'create',
      placement: { kind: 'last', parent: oneAlias('today') },
      nodes: [draft('Runtime search', {
        type: 'search',
        metadata: { query: { kind: 'rule', op: 'STRING_MATCH', text: 'Tagged' } },
        children: [draft('Unrelated search child')],
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
        title: 'Renamed search',
        query: { kind: 'rule', op: 'STRING_MATCH', text: 'template' },
      }],
    }]);
    const updatedSearch = workspace.documentState().nodes[searchId]!;
    expect(updatedSearch).toMatchObject({ type: 'search', content: { text: 'Renamed search' } });
    expect(updatedSearch.children.map((id) => workspace.documentState().nodes[id]?.content.text))
      .toContain('Unrelated search child');
  });

  test('registers reusable options and removes one field value through typed field instructions', async () => {
    const workspace = await makeWorkspace();
    const setup = await settle(workspace, [
      {
        op: 'ensure',
        resource: 'definition',
        definitionType: 'field',
        name: 'Status',
        fieldType: 'options',
        bind: 'field',
      },
      { op: 'create', placement: { kind: 'last', parent: oneAlias('today') }, nodes: [draft('Task')], bind: 'owner' },
    ]);
    const fieldId = setup.diff.bindings.field![0]!;
    const ownerId = setup.diff.bindings.owner![0]!;
    await settle(workspace, [{
      op: 'update',
      targets: oneId(fieldId),
      changes: [{ kind: 'field', action: 'register-option', name: 'In progress' }],
    }]);
    const optionId = workspace.documentState().nodes[fieldId]?.children.find((childId) => (
      workspace.documentState().nodes[childId]?.content.text === 'In progress'
    ));
    expect(optionId).toBeDefined();

    await settle(workspace, [{
      op: 'update',
      targets: oneId(ownerId),
      changes: [{
        kind: 'field-slot',
        field: oneId(fieldId),
        mutation: { action: 'select-option', option: oneId(optionId!) },
      }],
    }]);
    const entry = Object.values(workspace.documentState().nodes).find((node) => (
      node.type === 'fieldEntry' && node.parentId === ownerId && node.fieldDefId === fieldId
    ));
    const valueId = entry?.children[0];
    expect(workspace.documentState().nodes[valueId!]).toMatchObject({ type: 'reference', targetId: optionId });

    await settle(workspace, [{
      op: 'update',
      targets: oneId(ownerId),
      changes: [{
        kind: 'field-slot',
        field: oneId(fieldId),
        mutation: { action: 'remove-value', value: oneId(valueId!), entryId: entry!.id },
      }],
    }]);
    expect(workspace.documentState().nodes[valueId!]).toBeUndefined();
    expect(workspace.documentState().nodes[optionId!]?.content.text).toBe('In progress');
  });
});

async function settle(
  workspace: OutlineRuntimeWorkspace,
  operations: readonly Change[],
  acknowledgeDestructive = false,
): Promise<{ diff: Awaited<ReturnType<typeof diffOutlineChangeSet>>; operation: Operation }> {
  const changeSet: ChangeSet = {
    protocolVersion: 1,
    kind: 'outline.changeset',
    idempotencyKey: `test:${crypto.randomUUID()}`,
    operations: [...operations],
  };
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

function changeSet(operations: readonly Change[]): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    operations: [...operations],
  };
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
  return openWorkspace(root, { instanceId: `runtime:${crypto.randomUUID()}` });
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
