import { describe, expect, test } from 'bun:test';
import {
  NodeFieldSlotCache,
  fieldSlotValueSource,
  fieldSlotId,
  nodeFieldSlots,
  parseFieldSlotId,
  type FieldSlotNode,
} from '../../src/core/fieldSlots';
import type { NodeId } from '../../src/core/types';

function source(...nodes: FieldSlotNode[]): ReadonlyMap<NodeId, FieldSlotNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function node(
  id: NodeId,
  input: Partial<FieldSlotNode> = {},
): FieldSlotNode {
  return {
    id,
    children: [],
    tags: [],
    ...input,
  };
}

describe('nodeFieldSlots', () => {
  test('projects tag fields before own fields in tag, ancestor, and template order', () => {
    const nodes = source(
      node('owner', { children: ['own-entry'], tags: ['project', 'contact'] }),
      node('project', { type: 'tagDef', children: ['project-extends', 'project-status', 'project-due'] }),
      node('project-extends', { type: 'defConfig', parentId: 'project', configKey: 'extends', children: ['project-extends-ref'] }),
      node('project-extends-ref', { type: 'reference', parentId: 'project-extends', targetId: 'base' }),
      node('base', { type: 'tagDef', children: ['base-owner'] }),
      node('contact', { type: 'tagDef', children: ['contact-email'] }),
      node('project-status', { type: 'fieldEntry', parentId: 'project', fieldDefId: 'status-def' }),
      node('project-due', { type: 'fieldEntry', parentId: 'project', fieldDefId: 'due-def' }),
      node('base-owner', { type: 'fieldEntry', parentId: 'base', fieldDefId: 'owner-def' }),
      node('contact-email', { type: 'fieldEntry', parentId: 'contact', fieldDefId: 'email-def' }),
      node('own-entry', { type: 'fieldEntry', parentId: 'owner', fieldDefId: 'notes-def' }),
      node('status-def', { type: 'fieldDef' }),
      node('due-def', { type: 'fieldDef' }),
      node('owner-def', { type: 'fieldDef' }),
      node('email-def', { type: 'fieldDef' }),
      node('notes-def', { type: 'fieldDef' }),
    );

    expect(nodeFieldSlots(nodes, 'owner')).toEqual([
      {
        id: fieldSlotId('owner', 'owner-def'),
        fieldDefId: 'owner-def',
        source: 'tag',
        sourceTagId: 'base',
        templateEntryId: 'base-owner',
      },
      {
        id: fieldSlotId('owner', 'status-def'),
        fieldDefId: 'status-def',
        source: 'tag',
        sourceTagId: 'project',
        templateEntryId: 'project-status',
      },
      {
        id: fieldSlotId('owner', 'due-def'),
        fieldDefId: 'due-def',
        source: 'tag',
        sourceTagId: 'project',
        templateEntryId: 'project-due',
      },
      {
        id: fieldSlotId('owner', 'email-def'),
        fieldDefId: 'email-def',
        source: 'tag',
        sourceTagId: 'contact',
        templateEntryId: 'contact-email',
      },
      {
        id: 'own-entry',
        fieldDefId: 'notes-def',
        source: 'own',
        entryId: 'own-entry',
      },
    ]);
  });

  test('fills a projected slot with the first stored entry and leaves concurrent duplicates as own fields', () => {
    const nodes = source(
      node('owner', { children: ['first', 'duplicate', 'other'], tags: ['tag'] }),
      node('tag', { type: 'tagDef', children: ['template-entry'] }),
      node('template-entry', { type: 'fieldEntry', parentId: 'tag', fieldDefId: 'status-def' }),
      node('first', { type: 'fieldEntry', parentId: 'owner', fieldDefId: 'status-def' }),
      node('duplicate', { type: 'fieldEntry', parentId: 'owner', fieldDefId: 'status-def' }),
      node('other', { type: 'fieldEntry', parentId: 'owner', fieldDefId: 'other-def' }),
      node('status-def', { type: 'fieldDef' }),
      node('other-def', { type: 'fieldDef' }),
    );

    expect(nodeFieldSlots(nodes, 'owner')).toEqual([
      {
        id: fieldSlotId('owner', 'status-def'),
        fieldDefId: 'status-def',
        source: 'tag',
        sourceTagId: 'tag',
        templateEntryId: 'template-entry',
        entryId: 'first',
      },
      {
        id: 'duplicate',
        fieldDefId: 'status-def',
        source: 'own',
        entryId: 'duplicate',
      },
      {
        id: 'other',
        fieldDefId: 'other-def',
        source: 'own',
        entryId: 'other',
      },
    ]);
  });

  test('keeps distinct same-name definitions as distinct projected slots', () => {
    const nodes = source(
      node('owner', { tags: ['tag-a', 'tag-b'] }),
      node('tag-a', { type: 'tagDef', children: ['status-a-template'] }),
      node('tag-b', { type: 'tagDef', children: ['status-b-template'] }),
      node('status-a-template', { type: 'fieldEntry', parentId: 'tag-a', fieldDefId: 'status-a' }),
      node('status-b-template', { type: 'fieldEntry', parentId: 'tag-b', fieldDefId: 'status-b' }),
      node('status-a', { type: 'fieldDef' }),
      node('status-b', { type: 'fieldDef' }),
    );

    expect(nodeFieldSlots(nodes, 'owner').map((slot) => slot.fieldDefId)).toEqual([
      'status-a',
      'status-b',
    ]);
  });

  test('reads static template values as inherited defaults until a stored entry exists', () => {
    const nodes = source(
      node('owner', { tags: ['tag'] }),
      node('tag', { type: 'tagDef', children: ['template-entry'] }),
      node('template-entry', {
        type: 'fieldEntry',
        parentId: 'tag',
        fieldDefId: 'status-def',
        children: ['template-value'],
      }),
      node('template-value', { parentId: 'template-entry' }),
      node('status-def', { type: 'fieldDef' }),
    );
    const slot = nodeFieldSlots(nodes, 'owner')[0]!;

    expect(fieldSlotValueSource(nodes, slot)).toEqual({
      entryId: 'template-entry',
      inherited: true,
    });

    const storedNodes = new Map(nodes);
    storedNodes.set('owner', node('owner', { children: ['stored-entry'], tags: ['tag'] }));
    storedNodes.set('stored-entry', node('stored-entry', {
      type: 'fieldEntry',
      parentId: 'owner',
      fieldDefId: 'status-def',
      children: ['stored-value'],
    }));
    storedNodes.set('stored-value', node('stored-value', { parentId: 'stored-entry' }));

    expect(fieldSlotValueSource(storedNodes, nodeFieldSlots(storedNodes, 'owner')[0]!)).toEqual({
      entryId: 'stored-entry',
      inherited: false,
    });
  });

  test('does not inherit a static default from an auto-initialized field', () => {
    const nodes = source(
      node('owner', { tags: ['tag'] }),
      node('tag', { type: 'tagDef', children: ['template-entry'] }),
      node('template-entry', {
        type: 'fieldEntry',
        parentId: 'tag',
        fieldDefId: 'date-def',
        children: ['template-value'],
      }),
      node('template-value', { parentId: 'template-entry' }),
      node('date-def', { type: 'fieldDef', children: ['auto-init'] }),
      node('auto-init', {
        type: 'defConfig',
        parentId: 'date-def',
        configKey: 'autoInitialize',
        children: ['auto-init-ref'],
      }),
      node('auto-init-ref', {
        type: 'reference',
        parentId: 'auto-init',
        targetId: 'current-date-option',
      }),
      node('current-date-option', {
        type: 'systemOption',
        content: { text: 'current_date' },
      }),
    );

    expect(fieldSlotValueSource(nodes, nodeFieldSlots(nodes, 'owner')[0]!)).toBeUndefined();

    const invalidStrategyNodes = new Map(nodes);
    invalidStrategyNodes.set('current-date-option', node('current-date-option', {
      type: 'systemOption',
      content: { text: 'not_a_strategy' },
    }));
    expect(fieldSlotValueSource(
      invalidStrategyNodes,
      nodeFieldSlots(invalidStrategyNodes, 'owner')[0]!,
    )).toEqual({ entryId: 'template-entry', inherited: true });

    const danglingStrategyNodes = new Map(nodes);
    danglingStrategyNodes.delete('current-date-option');
    expect(fieldSlotValueSource(
      danglingStrategyNodes,
      nodeFieldSlots(danglingStrategyNodes, 'owner')[0]!,
    )).toEqual({ entryId: 'template-entry', inherited: true });
  });

  test('round-trips encoded virtual row ids', () => {
    const id = fieldSlotId('owner:with/slash', 'field:def/value');
    expect(parseFieldSlotId(id)).toEqual({
      ownerId: 'owner:with/slash',
      fieldDefId: 'field:def/value',
    });
    expect(parseFieldSlotId('slot:missing-field')).toBeNull();
    expect(parseFieldSlotId('ordinary-node')).toBeNull();
  });

  test('reuses cached slots until the owner, a direct child, or schema epoch changes', () => {
    const owner = node('owner', { children: ['own-entry'], tags: ['tag'] });
    const nodes = source(
      owner,
      node('own-entry', { type: 'fieldEntry', parentId: 'owner', fieldDefId: 'notes-def' }),
      node('tag', { type: 'tagDef', children: ['template-entry'] }),
      node('template-entry', { type: 'fieldEntry', parentId: 'tag', fieldDefId: 'status-def' }),
      node('status-def', { type: 'fieldDef' }),
      node('notes-def', { type: 'fieldDef' }),
      node('renamed-def', { type: 'fieldDef' }),
    );
    const cache = new NodeFieldSlotCache();

    const first = cache.read(nodes, 'owner', 1, 1);
    expect(cache.read(nodes, 'owner', 1, 1)).toBe(first);
    expect(cache.read(nodes, 'owner', 2, 1)).not.toBe(first);
    const afterSchemaChange = cache.read(nodes, 'owner', 2, 1);
    expect(cache.read(nodes, 'owner', 2, 2)).not.toBe(afterSchemaChange);

    const relinkedNodes = new Map(nodes);
    relinkedNodes.set('own-entry', {
      ...nodes.get('own-entry')!,
      fieldDefId: 'renamed-def',
    });
    expect(cache.read(relinkedNodes, 'owner', 2, 2).map((slot) => slot.fieldDefId)).toEqual([
      'status-def',
      'renamed-def',
    ]);

    const nextNodes = new Map(nodes);
    nextNodes.set('owner', { ...owner, tags: [] });
    expect(cache.read(nextNodes, 'owner', 2, 2).map((slot) => slot.fieldDefId)).toEqual(['notes-def']);
  });
});
