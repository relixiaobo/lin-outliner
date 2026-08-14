import { describe, expect, test } from 'bun:test';
import {
  inferFieldTypeFromValues,
  resolveFieldWriteTarget,
  validateFieldValuesForType,
  type FieldResolutionNode,
} from '../../src/core/fieldResolution';
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

  test('keeps schema definitions ambiguous when owner tags reach none of them', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', { tags: ['unrelated-tag'] })],
      ['project-status-def', node('project-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['unrelated-tag', node('unrelated-tag', 'note', { type: 'tagDef' })],
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

  test('requires entry-id disambiguation when same-name entries coexist on the owner', () => {
    const byId = new Map<string, FieldResolutionNode>([
      ['owner', node('owner', 'Record', { children: ['project-status', 'issue-status'] })],
      ['project-status-def', node('project-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
      ['issue-status-def', node('issue-status-def', 'Status', { type: 'fieldDef', parentId: SCHEMA_ID })],
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
});
