import { describe, expect, test } from 'bun:test';
import {
  resolveReferenceSelectionAction,
  resolveContentRowBackspaceAtStartIntent,
  resolveContentRowUpdateAction,
  resolveEditorTriggerText,
  resolveTrailingRowArrowDownIntent,
  resolveTrailingRowArrowUpIntent,
  resolveTrailingRowBackspaceIntent,
  resolveTrailingRowEnterIntent,
  resolveTrailingRowEscapeIntent,
  resolveTrailingRowUpdateAction,
  resolveTriggerForceCreateIntent,
} from '../../src/renderer/ui/interactions/rowInteractions';
import { resolveRowPointerSelectAction } from '../../src/renderer/ui/interactions/rowPointerSelection';
import { clampMenuIndex, nextMenuIndex } from '../../src/renderer/ui/interactions/menuNavigation';
import { resolveFieldOptions, resolveSelectedOptionId } from '../../src/renderer/ui/interactions/fieldOptions';
import { parseOutlinerPaste, parsePlainTextOutlinerPaste } from '../../src/renderer/ui/interactions/pasteParser';
import { buildReferenceCandidates } from '../../src/renderer/ui/interactions/referenceCandidates';
import { getTreeReferenceBlockReason } from '../../src/renderer/ui/interactions/referenceRules';
import { resolveSelectedReferenceShortcut } from '../../src/renderer/ui/interactions/selectedReferenceShortcuts';
import { filterSlashCommands } from '../../src/renderer/ui/interactions/slashCommands';
import {
  clampTagSelectorIndex,
  tagSelectorItemLabel,
  tagSelectorItems,
} from '../../src/renderer/ui/interactions/tagSelector';
import { isImeComposingEvent } from '../../src/renderer/ui/interactions/imeKeyboard';
import {
  commonTagIdsForTargets,
  resolveActiveNodeSelection,
} from '../../src/renderer/ui/interactions/contextMenuSelection';
import { resolveSelectionKeyboardAction } from '../../src/renderer/ui/interactions/selectionKeyboard';
import {
  expandIndentTargets,
  indentTargetParentId,
  previousVisibleRowId,
} from '../../src/renderer/ui/interactions/outlinerStructure';
import {
  buildOutlinerRows,
  hiddenFieldKey,
  NAME_FIELD,
  shouldShowTrailingInput,
} from '../../src/renderer/ui/outliner/row-model';
import { concatRichText } from '../../src/renderer/ui/editor/richTextCodec';

describe('row interaction resolvers', () => {
  const makeNode = (id: string, text: string, overrides: Record<string, unknown> = {}) => ({
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    showCheckbox: false,
    doneStateEnabled: false,
    autocollectOptions: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
    ...overrides,
  });

  test('builds view rows with hidden field reveal placeholders', () => {
    const parent = makeNode('parent', 'Parent', { children: ['field'] });
    const fieldDef = makeNode('field-def', 'Status', { type: 'fieldDef', hideField: 'always' });
    const field = makeNode('field', '', { type: 'fieldEntry', parentId: 'parent', fieldDefId: 'field-def' });
    const byId = new Map<string, any>([
      ['parent', parent],
      ['field-def', fieldDef],
      ['field', field],
    ]);

    expect(buildOutlinerRows(parent as any, byId)).toEqual([
      { id: 'hidden:parent:field', type: 'hiddenField', fieldId: 'field', label: 'Status' },
    ]);
    expect(buildOutlinerRows(parent as any, byId, {
      expandedHiddenFields: new Set([hiddenFieldKey('parent', 'field')]),
    })).toEqual([{ id: 'field', type: 'field' }]);
  });

  test('keeps panel fields in the normal body row model', () => {
    const parent = makeNode('parent', 'Parent', {
      children: ['status', 'beta', 'alpha', 'hidden'],
      filterField: NAME_FIELD,
      filterOp: 'any',
      filterValues: ['Alpha'],
      sortField: NAME_FIELD,
      sortDirection: 'asc',
    });
    const statusDef = makeNode('status-def', 'Status', { type: 'fieldDef' });
    const hiddenDef = makeNode('hidden-def', 'Archive', { type: 'fieldDef', hideField: 'always' });
    const byId = new Map<string, any>([
      ['parent', parent],
      ['status-def', statusDef],
      ['hidden-def', hiddenDef],
      ['status', makeNode('status', '', { type: 'fieldEntry', parentId: 'parent', fieldDefId: 'status-def' })],
      ['hidden', makeNode('hidden', '', { type: 'fieldEntry', parentId: 'parent', fieldDefId: 'hidden-def' })],
      ['alpha', makeNode('alpha', 'Alpha', { parentId: 'parent' })],
      ['beta', makeNode('beta', 'Beta', { parentId: 'parent' })],
    ]);

    expect(buildOutlinerRows(parent as any, byId)).toEqual([
      { id: 'alpha', type: 'content' },
      { id: 'hidden:parent:hidden', type: 'hiddenField', fieldId: 'hidden', label: 'Archive' },
    ]);
    expect(buildOutlinerRows(parent as any, byId, {
      expandedHiddenFields: new Set([hiddenFieldKey('parent', 'hidden')]),
    })).toEqual([{ id: 'alpha', type: 'content' }]);
  });

  test('applies sort, filter, and group view settings to row models', () => {
    const parent = makeNode('parent', 'Parent', {
      children: ['b', 'a', 'c'],
      sortField: NAME_FIELD,
      sortDirection: 'asc',
      filterField: NAME_FIELD,
      filterOp: 'any',
      filterValues: ['a', 'g'],
      groupField: NAME_FIELD,
    });
    const byId = new Map<string, any>([
      ['parent', parent],
      ['a', makeNode('a', 'Alpha', { parentId: 'parent' })],
      ['b', makeNode('b', 'Beta', { parentId: 'parent' })],
      ['c', makeNode('c', 'Gamma', { parentId: 'parent' })],
    ]);

    expect(buildOutlinerRows(parent as any, byId)).toEqual([
      { id: 'group:parent:__name:Alpha', type: 'group', label: 'Alpha' },
      { id: 'a', type: 'content' },
      { id: 'group:parent:__name:Beta', type: 'group', label: 'Beta' },
      { id: 'b', type: 'content' },
      { id: 'group:parent:__name:Gamma', type: 'group', label: 'Gamma' },
      { id: 'c', type: 'content' },
    ]);
  });

  test('trailing input ignores non-node rows when deciding placement', () => {
    expect(shouldShowTrailingInput([
      { id: 'group:a', type: 'group', label: 'A' },
      { id: 'hidden:p:f', type: 'hiddenField', fieldId: 'f', label: 'Field' },
    ])).toBe(true);
    expect(shouldShowTrailingInput([
      { id: 'field', type: 'field' },
      { id: 'group:a', type: 'group', label: 'A' },
    ])).toBe(true);
    expect(shouldShowTrailingInput([
      { id: 'content', type: 'content' },
      { id: 'hidden:p:f', type: 'hiddenField', fieldId: 'f', label: 'Field' },
    ])).toBe(false);
  });

  test('maps trailing input trigger characters to node actions', () => {
    expect(resolveTrailingRowUpdateAction({ text: '>' })).toEqual({ type: 'create_field' });
    expect(resolveTrailingRowUpdateAction({ text: '#' })).toEqual({
      type: 'create_trigger_node',
      trigger: '#',
      matchText: '#',
      textOffset: 1,
    });
    expect(resolveTrailingRowUpdateAction({ text: 'hello@' })).toEqual({
      type: 'create_trigger_node',
      trigger: '@',
      matchText: 'hello@',
      textOffset: 6,
    });
    expect(resolveTrailingRowUpdateAction({ text: '/' })).toEqual({
      type: 'create_trigger_node',
      trigger: '/',
      matchText: '/',
      textOffset: 1,
    });
  });

  test('keeps trailing navigation decisions explicit', () => {
    expect(resolveTrailingRowEnterIntent({ hasText: false })).toBe('create_empty');
    expect(resolveTrailingRowEnterIntent({ hasText: true })).toBe('create_content_and_continue');
    expect(resolveTrailingRowEnterIntent({ hasText: true, optionsOpen: true, optionCount: 2 })).toBe('options_confirm');
    expect(resolveTrailingRowBackspaceIntent({
      isEditorEmpty: false,
      depthShifted: true,
      parentChildCount: 0,
      hasLastVisibleTarget: false,
    })).toBe('allow_default');
    expect(resolveTrailingRowBackspaceIntent({
      isEditorEmpty: true,
      depthShifted: true,
      parentChildCount: 0,
      hasLastVisibleTarget: false,
    })).toBe('reset_depth_shift');
    expect(resolveTrailingRowBackspaceIntent({
      isEditorEmpty: true,
      depthShifted: false,
      parentChildCount: 0,
      hasLastVisibleTarget: false,
    })).toBe('collapse_parent');
    expect(resolveTrailingRowBackspaceIntent({
      isEditorEmpty: true,
      depthShifted: false,
      parentChildCount: 2,
      hasLastVisibleTarget: true,
    })).toBe('focus_last_visible');
    expect(resolveTrailingRowArrowUpIntent({
      hasLastVisibleTarget: true,
      hasNavigateOut: false,
    })).toBe('focus_last_visible');
    expect(resolveTrailingRowArrowDownIntent({
      hasNavigateOut: true,
    })).toBe('navigate_out_down');
    expect(resolveTrailingRowEscapeIntent(false)).toBe('blur_editor');
  });

  test('keeps plain pointer clicks out of block selection mode', () => {
    expect(resolveRowPointerSelectAction({
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      allowSingle: false,
    })).toBeNull();
    expect(resolveRowPointerSelectAction({
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      allowSingle: false,
    })).toBe('toggle');
    expect(resolveRowPointerSelectAction({
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      allowSingle: false,
    })).toBe('range');
  });

  test('maps # to batch tag application in selection mode', () => {
    expect(resolveSelectionKeyboardAction({
      key: '#',
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      isComposing: false,
    } as KeyboardEvent)).toBe('batch_apply_tag');
  });

  test('resolves batch context actions from top-level selected rows', () => {
    const parent = makeNode('parent', 'Parent');
    const child = makeNode('child', 'Child', { parentId: 'parent' });
    const target = makeNode('target', 'Target', { tags: ['tag-a', 'tag-b'] });
    const ref = makeNode('ref', 'Ref', { type: 'reference', targetId: 'target' });
    const refAgain = makeNode('ref-again', 'Ref again', { type: 'reference', targetId: 'target' });
    const byId = new Map<string, any>([
      ['parent', parent],
      ['child', child],
      ['target', target],
      ['ref', ref],
      ['ref-again', refAgain],
    ]);

    const selection = resolveActiveNodeSelection({
      nodeId: 'parent',
      targetId: 'parent',
      selectedIds: new Set(['parent', 'child', 'ref', 'ref-again']),
      byId,
    });

    expect(selection.nodeIds).toEqual(['parent', 'ref', 'ref-again']);
    expect(selection.targetIds).toEqual(['parent', 'target']);
    expect(selection.labelPrefix).toBe('3 nodes: ');
  });

  test('uses common existing tags for batch tag picker filtering', () => {
    const byId = new Map<string, any>([
      ['first', makeNode('first', 'First', { tags: ['tag-a', 'tag-b'] })],
      ['second', makeNode('second', 'Second', { tags: ['tag-b', 'tag-c'] })],
    ]);

    expect(commonTagIdsForTargets(['first', 'second'], byId)).toEqual(['tag-b']);
  });

  test('pre-expands target parents before indenting nodes', () => {
    const root = {
      id: 'root',
      children: ['first', 'second', 'third'],
    };
    const first = {
      id: 'first',
      parentId: 'root',
      children: [],
    };
    const second = {
      id: 'second',
      parentId: 'root',
      children: [],
    };
    const third = {
      id: 'third',
      parentId: 'root',
      children: [],
    };
    const byId = new Map<string, any>([
      [root.id, root],
      [first.id, first],
      [second.id, second],
      [third.id, third],
    ]);

    expect(indentTargetParentId('first', byId)).toBeNull();
    expect(indentTargetParentId('second', byId)).toBe('first');
    expect([...expandIndentTargets(new Set(['already']), ['second', 'third'], byId)].sort()).toEqual([
      'already',
      'first',
      'second',
    ]);
  });

  test('uses visible row order when merging with backspace at row start', () => {
    expect(previousVisibleRowId(['parent', 'child', 'sibling'], 'child')).toBe('parent');
    expect(previousVisibleRowId(['parent', 'child', 'sibling'], 'parent')).toBeNull();
    expect(previousVisibleRowId(['parent', 'child', 'sibling'], 'missing')).toBeNull();
  });

  test('detects editor tag and reference triggers at the cursor', () => {
    expect(resolveEditorTriggerText({ text: 'hello #ta', cursorOffset: 9 })).toEqual({
      kind: '#',
      query: 'ta',
      from: 6,
      to: 9,
    });
    expect(resolveEditorTriggerText({ text: 'see @node', cursorOffset: 9 })).toEqual({
      kind: '@',
      query: 'node',
      from: 4,
      to: 9,
    });
  });

  test('does not treat CSS hex colors as tag triggers', () => {
    expect(resolveEditorTriggerText({ text: 'color #fff', cursorOffset: 10 })).toBeNull();
    expect(resolveEditorTriggerText({ text: 'color #112233', cursorOffset: 13 })).toBeNull();
    expect(resolveEditorTriggerText({ text: 'hello #task', cursorOffset: 11 })).toMatchObject({
      kind: '#',
      query: 'task',
    });
  });

  test('opens slash commands only when the current node is otherwise empty', () => {
    expect(resolveEditorTriggerText({ text: '/', cursorOffset: 1 })).toEqual({
      kind: '/',
      query: '',
      from: 0,
      to: 1,
    });
    expect(resolveEditorTriggerText({ text: 'hello /', cursorOffset: 7 })).toBeNull();
  });

  test('fires content field creation only for a bare field trigger', () => {
    expect(resolveContentRowUpdateAction({
      text: '>',
      inlineRefCount: 0,
      enableFieldTrigger: true,
    })).toEqual({ type: 'create_field' });
    expect(resolveContentRowUpdateAction({
      text: '>field',
      inlineRefCount: 0,
      enableFieldTrigger: true,
    })).toEqual({ type: 'none' });
    expect(resolveContentRowUpdateAction({
      text: '>',
      inlineRefCount: 1,
      enableFieldTrigger: true,
    })).toEqual({ type: 'none' });
  });

  test('protects empty parent rows from destructive backspace', () => {
    expect(resolveContentRowBackspaceAtStartIntent({
      isEmpty: false,
      hasChildren: true,
    })).toBe('merge_with_previous');
    expect(resolveContentRowBackspaceAtStartIntent({
      isEmpty: true,
      hasChildren: false,
    })).toBe('delete_empty');
    expect(resolveContentRowBackspaceAtStartIntent({
      isEmpty: true,
      hasChildren: true,
    })).toBe('block_delete_parent');
  });

  test('splits reference selection between tree and inline reference modes', () => {
    expect(resolveReferenceSelectionAction({
      text: '@node',
      inlineRefCount: 0,
      triggerFrom: 0,
      triggerTo: 5,
      canCreateTreeReference: true,
    })).toBe('tree_reference');

    expect(resolveReferenceSelectionAction({
      text: 'see @node',
      inlineRefCount: 0,
      triggerFrom: 4,
      triggerTo: 9,
      canCreateTreeReference: true,
    })).toBe('inline_reference');

    expect(resolveReferenceSelectionAction({
      text: '@node',
      inlineRefCount: 1,
      triggerFrom: 0,
      triggerTo: 5,
      canCreateTreeReference: true,
    })).toBe('inline_reference');
  });

  test('matches nodex force-create behavior for active trigger menus', () => {
    expect(resolveTriggerForceCreateIntent({ triggerKind: '#', query: 'tag' })).toBe('hashtag_create');
    expect(resolveTriggerForceCreateIntent({ triggerKind: '@', query: 'node' })).toBe('reference_create');
    expect(resolveTriggerForceCreateIntent({ triggerKind: '/', query: 'ref' })).toBe('noop');
    expect(resolveTriggerForceCreateIntent({ triggerKind: '#', query: '' })).toBe('noop');
  });

  test('clamps trigger menu keyboard navigation instead of looping', () => {
    expect(clampMenuIndex(-1, 3)).toBe(0);
    expect(clampMenuIndex(4, 3)).toBe(2);
    expect(nextMenuIndex(2, 3, 'down')).toBe(2);
    expect(nextMenuIndex(0, 3, 'up')).toBe(0);
  });

  test('filters slash commands through a reusable command model', () => {
    expect(filterSlashCommands('').map((command) => command.id)).toEqual([
      'field',
      'reference',
      'heading',
      'checkbox',
      'command_palette',
    ]);
    expect(filterSlashCommands('ref').map((command) => command.id)).toEqual(['reference']);
    expect(filterSlashCommands('>')[0]?.id).toBe('field');
  });

  test('filters tag selector items like nodex', () => {
    const makeTag = (id: string, text: string) => ({
      id,
      type: 'tagDef',
      children: [],
      content: { text, marks: [], inlineRefs: [] },
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      showCheckbox: false,
      doneStateEnabled: false,
      autocollectOptions: false,
      autoCollected: false,
      toolbarVisible: false,
      filterValues: [],
    });
    const nodes = [
      makeTag('tag-project', 'project'),
      makeTag('tag-person', 'person'),
    ];
    const index = {
      projection: {
        workspaceId: 'root',
        rootId: 'root',
        dailyNotesId: 'daily',
        schemaId: 'schema',
        searchesId: 'searches',
        trashId: 'trash',
        settingsId: 'settings',
        todayId: 'today',
        nodes,
      },
      byId: new Map(nodes.map((node) => [node.id, node])),
    };

    expect(tagSelectorItems({
      query: '',
      index: index as any,
      existingTagIds: ['tag-project'],
    }).map((item) => item.type === 'existing' ? item.tag.id : item.name)).toEqual(['tag-person']);
    expect(tagSelectorItems({
      query: 'pro',
      index: index as any,
      existingTagIds: ['tag-project'],
    }).map((item) => item.type === 'existing' ? item.tag.id : `create:${item.name}`)).toEqual(['create:pro']);
    expect(clampTagSelectorIndex(2, 2)).toBe(1);
    expect(clampTagSelectorIndex(-1, 2)).toBe(0);
  });

  test('keeps hash marker out of tag selector text labels', () => {
    const tag = makeNode('tag-person', 'person', { type: 'tagDef' });
    expect(tagSelectorItemLabel({ type: 'existing', tag: tag as any })).toBe('person');
    expect(tagSelectorItemLabel({ type: 'create', name: 'project' })).toBe('Create project');
  });

  test('parses indented multiline paste into an outliner tree', () => {
    expect(parsePlainTextOutlinerPaste('Parent\n  Child\n    Grandchild\nSibling')).toEqual([
      {
        text: 'Parent',
        children: [
          {
            text: 'Child',
            children: [
              { text: 'Grandchild', children: [] },
            ],
          },
        ],
      },
      { text: 'Sibling', children: [] },
    ]);
  });

  test('strips common bullet markers while preserving hierarchy', () => {
    expect(parsePlainTextOutlinerPaste('- A\n  - B\n\t• C')).toEqual([
      {
        text: 'A',
        children: [
          { text: 'B', children: [] },
          { text: 'C', children: [] },
        ],
      },
    ]);
  });

  test('converts pasted markdown text into rich node trees', () => {
    expect(parseOutlinerPaste('# Title\n  - **Bold** and `code`')).toEqual([
      {
        content: {
          text: 'Title',
          marks: [{ start: 0, end: 5, type: 'headingMark' }],
          inlineRefs: [],
        },
        children: [
          {
            content: {
              text: 'Bold and code',
              marks: [
                { start: 0, end: 4, type: 'bold' },
                { start: 9, end: 13, type: 'code' },
              ],
              inlineRefs: [],
            },
            children: [],
          },
        ],
      },
    ]);
  });

  test('concatenates rich text slices while preserving shifted marks and inline references', () => {
    expect(concatRichText(
      {
        text: 'Hello ',
        marks: [{ start: 0, end: 5, type: 'bold' }],
        inlineRefs: [],
      },
      {
        text: 'world',
        marks: [{ start: 0, end: 5, type: 'code' }],
        inlineRefs: [{ offset: 0, targetNodeId: 'target', displayName: 'World' }],
      },
    )).toEqual({
      text: 'Hello world',
      marks: [
        { start: 0, end: 5, type: 'bold' },
        { start: 6, end: 11, type: 'code' },
      ],
      inlineRefs: [{ offset: 6, targetNodeId: 'target', displayName: 'World' }],
    });
  });

  test('resolves selected inline reference shortcut actions', () => {
    const keyboard = (key: string, init: Partial<KeyboardEvent> = {}) => (
      ({ key, ...init } as KeyboardEvent)
    );
    expect(resolveSelectedReferenceShortcut(keyboard('Backspace'))).toBe('delete');
    expect(resolveSelectedReferenceShortcut(keyboard('Delete'))).toBe('delete');
    expect(resolveSelectedReferenceShortcut(keyboard('ArrowRight'))).toBe('convert_arrow_right');
    expect(resolveSelectedReferenceShortcut(keyboard('x'))).toBe('convert_printable');
    expect(resolveSelectedReferenceShortcut(keyboard('x', { metaKey: true }))).toBeNull();
    expect(resolveSelectedReferenceShortcut(keyboard('Escape'))).toBe('escape');
  });

  test('ignores shortcut resolvers during IME composition', () => {
    expect(isImeComposingEvent({ key: 'Process' })).toBe(true);
    expect(isImeComposingEvent({ keyCode: 229 })).toBe(true);
    expect(resolveSelectionKeyboardAction({
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      keyCode: 229,
    } as KeyboardEvent)).toBeNull();
    expect(resolveSelectedReferenceShortcut({
      key: 'x',
      keyCode: 229,
    } as KeyboardEvent)).toBeNull();
  });

  test('resolves option nodes from field definitions and selected reference values', () => {
    const field = {
      id: 'field_status',
      type: 'fieldDef',
      children: ['opt_done'],
      content: { text: 'Status', marks: [], inlineRefs: [] },
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      showCheckbox: false,
      doneStateEnabled: false,
      fieldType: 'options',
      autocollectOptions: true,
      autoCollected: false,
      toolbarVisible: false,
      filterValues: [],
    } as const;
    const option = {
      id: 'opt_done',
      parentId: 'field_status',
      children: [],
      content: { text: 'Done', marks: [], inlineRefs: [] },
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      showCheckbox: false,
      doneStateEnabled: false,
      autocollectOptions: false,
      autoCollected: true,
      toolbarVisible: false,
      filterValues: [],
    } as const;
    const value = {
      ...option,
      id: 'value',
      type: 'reference',
      targetId: 'opt_done',
    } as const;
    const byId = new Map<string, any>([
      [field.id, field],
      [option.id, option],
      [value.id, value],
    ]);
    const options = resolveFieldOptions(field as any, byId);
    expect(options).toEqual([{ id: 'opt_done', label: 'Done', autoCollected: true }]);
    expect(resolveSelectedOptionId(value as any, options)).toBe('opt_done');
  });

  test('blocks tree reference candidates that would create display cycles', () => {
    const parent = {
      id: 'parent',
      children: ['child'],
      content: { text: 'Parent', marks: [], inlineRefs: [] },
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      showCheckbox: false,
      doneStateEnabled: false,
      autocollectOptions: false,
      autoCollected: false,
      toolbarVisible: false,
      filterValues: [],
    };
    const child = {
      ...parent,
      id: 'child',
      parentId: 'parent',
      children: [],
      content: { text: 'Child', marks: [], inlineRefs: [] },
    };
    const byId = new Map<string, any>([
      [parent.id, parent],
      [child.id, child],
    ]);
    expect(getTreeReferenceBlockReason({
      parentId: 'child',
      targetId: 'parent',
      byId,
    })).toBe('would_create_display_cycle');
  });

  test('reference candidates include date shortcuts and create option', () => {
    const projection = {
      workspaceId: 'root',
      rootId: 'root',
      dailyNotesId: 'daily',
      schemaId: 'schema',
      searchesId: 'searches',
      trashId: 'trash',
      settingsId: 'settings',
      todayId: 'today',
      nodes: [],
    };
    const candidates = buildReferenceCandidates({
      index: { projection, byId: new Map() },
      currentNodeId: 'current',
      query: 'tod',
    });
    expect(candidates[0]?.type).toBe('date');
    expect(candidates.at(-1)).toEqual({ type: 'create', label: 'tod' });
  });
});
