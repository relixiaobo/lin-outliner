import { describe, expect, test } from 'bun:test';
import {
  inferFieldTypeFromValues,
  resolveFieldWriteTarget,
  validateFieldValuesForType,
  type FieldResolutionNode,
} from '../../src/core/fieldResolution';
import { DONE_FIELD } from '../../src/core/systemFields';
import { SCHEMA_ID, plainText } from '../../src/core/types';

function node(
  id: string,
  text: string,
  overrides: Partial<FieldResolutionNode> = {},
): FieldResolutionNode {
  return {
    id,
    children: [],
    tags: [],
    content: plainText(text),
    ...overrides,
  };
}

describe('field value type resolution', () => {
  test('node references remain values under a plain field', () => {
    const references = [
      { text: 'Alpha', targetId: 'alpha' },
      { text: 'Beta', targetId: 'beta' },
    ];

    expect(inferFieldTypeFromValues(references)).toBe('plain');
    expect(validateFieldValuesForType('Related', 'plain', references)).toEqual({ ok: true });
  });

  test('plain fields accept mixed text and node-reference values', () => {
    const values = [
      { text: 'Context' },
      { text: 'Alpha', targetId: 'alpha' },
    ];

    expect(inferFieldTypeFromValues(values)).toBe('plain');
    expect(validateFieldValuesForType('Notes', 'plain', values)).toEqual({ ok: true });
  });

  test('scalar field types still reject node-reference values', () => {
    const result = validateFieldValuesForType('Score', 'number', [{ text: 'Alpha', targetId: 'alpha' }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.instructions).toContain('plain field');
  });

  test('non-node inline references force plain inference and fail typed validation', () => {
    const values = [{ text: '', hasInlineRefs: true }];

    expect(inferFieldTypeFromValues(values)).toBe('plain');
    expect(validateFieldValuesForType('Attachment', 'plain', values)).toEqual({ ok: true });
    for (const fieldType of ['number', 'options', 'options_from_supertag'] as const) {
      const result = validateFieldValuesForType('Attachment', fieldType, values);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('inline reference values');
    }
  });
});

describe('field definition identity resolution', () => {
  test('routes a projected Done slot through the mutable system field path', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Task', { tags: ['task-tag'] })],
      ['task-tag', node('task-tag', 'task', { type: 'tagDef', children: ['done-template'] })],
      ['done-template', node('done-template', '', {
        type: 'fieldEntry',
        parentId: 'task-tag',
        fieldDefId: DONE_FIELD,
      })],
    ]);

    expect(resolveFieldWriteTarget(byId, 'owner', 'Done', [{ text: 'true' }])).toEqual({
      ok: true,
      target: { kind: 'systemDone', fieldDefId: DONE_FIELD },
    });
  });

  test('prefers the unique definition from the most specific owner tag layer', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', { tags: ['issue-tag'] })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['base-status-def', node('base-status-def', ' status ', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-tag', node('issue-tag', 'issue', {
        type: 'tagDef',
        children: ['issue-status-entry', 'issue-extends'],
      })],
      ['issue-status-entry', node('issue-status-entry', '', {
        type: 'fieldEntry',
        parentId: 'issue-tag',
        fieldDefId: 'issue-status-def',
      })],
      ['issue-extends', node('issue-extends', 'extends', {
        type: 'defConfig',
        parentId: 'issue-tag',
        configKey: 'extends',
        children: ['issue-extends-value'],
      })],
      ['issue-extends-value', node('issue-extends-value', '', {
        type: 'reference',
        parentId: 'issue-extends',
        targetId: 'base-tag',
      })],
      ['base-tag', node('base-tag', 'record', {
        type: 'tagDef',
        children: ['base-status-entry'],
      })],
      ['base-status-entry', node('base-status-entry', '', {
        type: 'fieldEntry',
        parentId: 'base-tag',
        fieldDefId: 'base-status-def',
      })],
    ]);

    expect(resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }])).toEqual({
      ok: true,
      target: {
        kind: 'existingFieldDef',
        fieldDefId: 'issue-status-def',
        fieldType: 'plain',
      },
    });
  });

  test('prefers a projected tag definition over a same-name own entry', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', {
        children: ['own-status'],
        tags: ['issue-tag'],
      })],
      ['own-status-def', node('own-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['own-status', node('own-status', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'own-status-def',
      })],
      ['issue-tag', node('issue-tag', 'issue', {
        type: 'tagDef',
        children: ['issue-status-template'],
      })],
      ['issue-status-template', node('issue-status-template', '', {
        type: 'fieldEntry',
        parentId: 'issue-tag',
        fieldDefId: 'issue-status-def',
      })],
    ]);

    expect(resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }])).toEqual({
      ok: true,
      target: {
        kind: 'existingFieldDef',
        fieldDefId: 'issue-status-def',
        fieldType: 'plain',
      },
    });
  });

  test('keeps same-layer tag definitions ambiguous', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', { tags: ['project-tag', 'issue-tag'] })],
      ['project-status-def', node('project-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['project-tag', node('project-tag', 'project', { type: 'tagDef', children: ['project-status-entry'] })],
      ['project-status-entry', node('project-status-entry', '', {
        type: 'fieldEntry',
        parentId: 'project-tag',
        fieldDefId: 'project-status-def',
      })],
      ['issue-tag', node('issue-tag', 'issue', { type: 'tagDef', children: ['issue-status-entry'] })],
      ['issue-status-entry', node('issue-status-entry', '', {
        type: 'fieldEntry',
        parentId: 'issue-tag',
        fieldDefId: 'issue-status-def',
      })],
    ]);

    const result = resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('duplicate_field_definitions');
      expect(result.nodeIds).toEqual(['project-status-def', 'issue-status-def']);
    }
  });

  test('keeps schema definitions ambiguous when the owner has no tag data', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', { tags: undefined })],
      ['project-status-def', node('project-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
    ]);

    const result = resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('duplicate_field_definitions');
      expect(result.nodeIds).toEqual(['project-status-def', 'issue-status-def']);
    }
  });

  test('treats one definition reused by multiple owner tags as one candidate', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', { tags: ['project-tag', 'issue-tag'] })],
      ['shared-status-def', node('shared-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['unused-status-def', node('unused-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['project-tag', node('project-tag', 'project', { type: 'tagDef', children: ['project-status-entry'] })],
      ['project-status-entry', node('project-status-entry', '', {
        type: 'fieldEntry',
        parentId: 'project-tag',
        fieldDefId: 'shared-status-def',
      })],
      ['issue-tag', node('issue-tag', 'issue', { type: 'tagDef', children: ['issue-status-entry'] })],
      ['issue-status-entry', node('issue-status-entry', '', {
        type: 'fieldEntry',
        parentId: 'issue-tag',
        fieldDefId: 'shared-status-def',
      })],
    ]);

    expect(resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }])).toEqual({
      ok: true,
      target: {
        kind: 'existingFieldDef',
        fieldDefId: 'shared-status-def',
        fieldType: 'plain',
      },
    });
  });

  test('prefers the unique owner entry from the most specific tag layer', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', {
        children: ['base-status', 'issue-status'],
        tags: ['issue-tag'],
      })],
      ['base-status-def', node('base-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['base-status', node('base-status', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'base-status-def',
      })],
      ['issue-status', node('issue-status', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'issue-status-def',
      })],
      ['issue-tag', node('issue-tag', 'issue', {
        type: 'tagDef',
        children: ['issue-status-template', 'issue-extends'],
      })],
      ['issue-status-template', node('issue-status-template', '', {
        type: 'fieldEntry',
        parentId: 'issue-tag',
        fieldDefId: 'issue-status-def',
      })],
      ['issue-extends', node('issue-extends', 'extends', {
        type: 'defConfig',
        parentId: 'issue-tag',
        configKey: 'extends',
        children: ['issue-extends-value'],
      })],
      ['issue-extends-value', node('issue-extends-value', '', {
        type: 'reference',
        parentId: 'issue-extends',
        targetId: 'base-tag',
      })],
      ['base-tag', node('base-tag', 'record', {
        type: 'tagDef',
        children: ['base-status-template'],
      })],
      ['base-status-template', node('base-status-template', '', {
        type: 'fieldEntry',
        parentId: 'base-tag',
        fieldDefId: 'base-status-def',
      })],
    ]);

    expect(resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }])).toEqual({
      ok: true,
      target: {
        kind: 'existingEntry',
        fieldEntryId: 'issue-status',
        fieldDefId: 'issue-status-def',
        fieldType: 'plain',
      },
    });
  });

  test('requires entry-id disambiguation when same-layer owner entries coexist', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', {
        children: ['project-status', 'issue-status'],
        tags: ['project-tag', 'issue-tag'],
      })],
      ['project-status-def', node('project-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['project-tag', node('project-tag', 'project', { type: 'tagDef', children: ['project-status-template'] })],
      ['project-status-template', node('project-status-template', '', {
        type: 'fieldEntry',
        parentId: 'project-tag',
        fieldDefId: 'project-status-def',
      })],
      ['issue-tag', node('issue-tag', 'issue', { type: 'tagDef', children: ['issue-status-template'] })],
      ['issue-status-template', node('issue-status-template', '', {
        type: 'fieldEntry',
        parentId: 'issue-tag',
        fieldDefId: 'issue-status-def',
      })],
      ['project-status', node('project-status', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'project-status-def',
      })],
      ['issue-status', node('issue-status', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'issue-status-def',
      })],
    ]);

    const result = resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('duplicate_field_entries');
      expect(result.instructions).toContain('entry id');
      expect(result.instructions).toContain('rename');
      expect(result.nodeIds).toEqual(['project-status', 'issue-status']);
    }
  });

  test('keeps duplicate owner entries for the preferred definition ambiguous', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', {
        children: ['issue-status-a', 'issue-status-b', 'base-status'],
        tags: ['issue-tag'],
      })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['base-status-def', node('base-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-a', node('issue-status-a', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'issue-status-def',
      })],
      ['issue-status-b', node('issue-status-b', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'issue-status-def',
      })],
      ['base-status', node('base-status', '', {
        type: 'fieldEntry',
        parentId: 'owner',
        fieldDefId: 'base-status-def',
      })],
      ['issue-tag', node('issue-tag', 'issue', {
        type: 'tagDef',
        children: ['issue-status-template', 'issue-extends'],
      })],
      ['issue-status-template', node('issue-status-template', '', {
        type: 'fieldEntry',
        parentId: 'issue-tag',
        fieldDefId: 'issue-status-def',
      })],
      ['issue-extends', node('issue-extends', 'extends', {
        type: 'defConfig',
        parentId: 'issue-tag',
        configKey: 'extends',
        children: ['issue-extends-value'],
      })],
      ['issue-extends-value', node('issue-extends-value', '', {
        type: 'reference',
        parentId: 'issue-extends',
        targetId: 'base-tag',
      })],
      ['base-tag', node('base-tag', 'record', {
        type: 'tagDef',
        children: ['base-status-template'],
      })],
      ['base-status-template', node('base-status-template', '', {
        type: 'fieldEntry',
        parentId: 'base-tag',
        fieldDefId: 'base-status-def',
      })],
    ]);

    const result = resolveFieldWriteTarget(byId, 'owner', 'Status', [{ text: 'Open' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('duplicate_field_entries');
      expect(result.nodeIds).toEqual(['issue-status-a', 'issue-status-b', 'base-status']);
    }
  });
});
