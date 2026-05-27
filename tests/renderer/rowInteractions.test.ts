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
  matchesShortcutEvent,
  shortcutDefinitionsForScope,
} from '../../src/renderer/ui/interactions/shortcutRegistry';
import {
  expandIndentTargets,
  indentTargetParentId,
  previousVisibleRowId,
} from '../../src/renderer/ui/interactions/outlinerStructure';
import { resolveOutlinerDropMove } from '../../src/renderer/ui/interactions/dragDrop';
import {
  buildOutlinerRows,
  DONE_FIELD,
  hiddenFieldKey,
  NAME_FIELD,
  shouldShowTrailingInput,
} from '../../src/renderer/ui/outliner/row-model';
import { searchQueryOutlineText, searchQuerySummaryModel } from '../../src/renderer/ui/search/SearchQuerySummaryBar';
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
	      children: ['view', 'status', 'beta', 'alpha', 'hidden'],
	    });
	    const statusDef = makeNode('status-def', 'Status', { type: 'fieldDef' });
	    const hiddenDef = makeNode('hidden-def', 'Archive', { type: 'fieldDef', hideField: 'always' });
	    const byId = new Map<string, any>([
	      ['parent', parent],
	      ['view', makeNode('view', '', { type: 'viewDef', parentId: 'parent', children: ['filter', 'sort'] })],
	      ['filter', makeNode('filter', '', {
	        type: 'filterRule',
	        parentId: 'view',
	        filterField: NAME_FIELD,
	        filterOperator: 'contains',
	        filterValueLogic: 'any',
	        filterValues: ['Alpha'],
	      })],
	      ['sort', makeNode('sort', '', {
	        type: 'sortRule',
	        parentId: 'view',
	        sortField: NAME_FIELD,
	        sortDirection: 'asc',
	      })],
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

  test('hides search query condition nodes from normal outliner rows', () => {
    const parent = makeNode('search', 'Search', {
      type: 'search',
      children: ['query', 'result-ref'],
    });
    const byId = new Map<string, any>([
      ['search', parent],
      ['query', makeNode('query', 'AND', { type: 'queryCondition', parentId: 'search' })],
      ['result-ref', makeNode('result-ref', '', { type: 'reference', parentId: 'search', targetId: 'target' })],
    ]);

    expect(buildOutlinerRows(parent as any, byId)).toEqual([
      { id: 'result-ref', type: 'content' },
    ]);
  });

  test('summarizes search query conditions and materialized result count', () => {
    const search = makeNode('search', 'Open work', {
      type: 'search',
      children: ['group', 'result-ref'],
    });
    const byId = new Map<string, any>([
      ['search', search],
      ['group', makeNode('group', '', {
        type: 'queryCondition',
        parentId: 'search',
        queryLogic: 'AND',
        children: ['tag-rule', 'field-rule'],
      })],
      ['tag-rule', makeNode('tag-rule', '', {
        type: 'queryCondition',
        parentId: 'group',
        queryOp: 'HAS_TAG',
        queryTagDefId: 'tag-card',
      })],
      ['field-rule', makeNode('field-rule', '', {
        type: 'queryCondition',
        parentId: 'group',
        queryOp: 'FIELD_IS',
        queryFieldDefId: 'field-status',
        children: ['field-value'],
      })],
      ['field-value', makeNode('field-value', 'Backlog', { parentId: 'field-rule' })],
      ['tag-card', makeNode('tag-card', 'card', { type: 'tagDef' })],
      ['field-status', makeNode('field-status', 'Status', { type: 'fieldDef' })],
      ['result-ref', makeNode('result-ref', '', { type: 'reference', parentId: 'search', targetId: 'target' })],
      ['target', makeNode('target', 'Task', { parentId: 'workspace' })],
    ]);

	    expect(searchQuerySummaryModel({ byId, projection: {} } as any, 'search')).toEqual({
	      chips: [
	        { kind: 'tag', label: '#card' },
	        { kind: 'field', label: 'Status = Backlog' },
	      ],
	      resultCount: 1,
	    });
	    expect(searchQueryOutlineText({ byId, projection: {} } as any, 'search')).toBe([
	      '- AND',
	      '  - HAS_TAG',
	      '    - tag:: [[#card^tag-card]]',
	      '  - FIELD_IS',
	      '    - field:: [[Status^field-status]]',
	      '    - value:: Backlog',
	    ].join('\n'));
	  });

	  test('applies sort, filter, and group view settings to row models', () => {
	    const parent = makeNode('parent', 'Parent', {
	      children: ['view', 'b', 'a', 'c'],
	    });
	    const byId = new Map<string, any>([
	      ['parent', parent],
	      ['view', makeNode('view', '', {
	        type: 'viewDef',
	        parentId: 'parent',
	        children: ['sort', 'filter'],
	        groupField: NAME_FIELD,
	      })],
	      ['sort', makeNode('sort', '', {
	        type: 'sortRule',
	        parentId: 'view',
	        sortField: NAME_FIELD,
	        sortDirection: 'asc',
	      })],
	      ['filter', makeNode('filter', '', {
	        type: 'filterRule',
	        parentId: 'view',
	        filterField: NAME_FIELD,
	        filterOperator: 'contains',
	        filterValueLogic: 'any',
	        filterValues: ['a', 'g'],
	      })],
	      ['a', makeNode('a', 'Alpha', { parentId: 'parent' })],
	      ['b', makeNode('b', 'Beta', { parentId: 'parent' })],
	      ['c', makeNode('c', 'Gamma', { parentId: 'parent' })],
    ]);

	    expect(buildOutlinerRows(parent as any, byId)).toEqual([
	      { id: 'group:parent:sys:name:alpha', type: 'group', label: 'Alpha' },
	      { id: 'a', type: 'content' },
	      { id: 'group:parent:sys:name:beta', type: 'group', label: 'Beta' },
	      { id: 'b', type: 'content' },
	      { id: 'group:parent:sys:name:gamma', type: 'group', label: 'Gamma' },
	      { id: 'c', type: 'content' },
	    ]);
	  });

	  test('filters a custom date field by after using parsed dates, not string compare', () => {
	    const parent = makeNode('parent', 'Parent', { children: ['view', 'early', 'late'] });
	    const byId = new Map<string, any>([
	      ['parent', parent],
	      ['view', makeNode('view', '', {
	        type: 'viewDef',
	        parentId: 'parent',
	        children: ['filter'],
	      })],
	      ['filter', makeNode('filter', '', {
	        type: 'filterRule',
	        parentId: 'view',
	        filterField: 'date-def',
	        filterOperator: 'after',
	        filterValueLogic: 'any',
	        filterValues: ['2026-01-01'],
	      })],
	      ['date-def', makeNode('date-def', 'Due', { type: 'fieldDef', fieldType: 'date' })],
	      ['early', makeNode('early', 'Early', { parentId: 'parent', children: ['early-date'] })],
	      ['early-date', makeNode('early-date', '2025-06-01', { type: 'fieldEntry', parentId: 'early', fieldDefId: 'date-def' })],
	      ['late', makeNode('late', 'Late', { parentId: 'parent', children: ['late-date'] })],
	      ['late-date', makeNode('late-date', '2026-06-01', { type: 'fieldEntry', parentId: 'late', fieldDefId: 'date-def' })],
	    ]);

	    expect(buildOutlinerRows(parent as any, byId)).toEqual([
	      { id: 'late', type: 'content' },
	    ]);
	  });

	  test('groups a custom date field into one bucket per calendar day with readable labels', () => {
	    const fmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	    const parent = makeNode('parent', 'Parent', { children: ['view', 'a', 'b', 'c'] });
	    const byId = new Map<string, any>([
	      ['parent', parent],
	      ['view', makeNode('view', '', { type: 'viewDef', parentId: 'parent', children: [], groupField: 'date-def' })],
	      ['date-def', makeNode('date-def', 'Due', { type: 'fieldDef', fieldType: 'date' })],
	      ['a', makeNode('a', 'A', { parentId: 'parent', children: ['a-date'] })],
	      ['a-date', makeNode('a-date', '2026-06-01', { type: 'fieldEntry', parentId: 'a', fieldDefId: 'date-def' })],
	      ['b', makeNode('b', 'B', { parentId: 'parent', children: ['b-date'] })],
	      ['b-date', makeNode('b-date', '2026-06-01', { type: 'fieldEntry', parentId: 'b', fieldDefId: 'date-def' })],
	      ['c', makeNode('c', 'C', { parentId: 'parent', children: ['c-date'] })],
	      ['c-date', makeNode('c-date', '2026-06-02', { type: 'fieldEntry', parentId: 'c', fieldDefId: 'date-def' })],
	    ]);

	    expect(buildOutlinerRows(parent as any, byId)).toEqual([
	      { id: 'group:parent:date-def:2026-06-01', type: 'group', label: fmt.format(new Date(2026, 5, 1)) },
	      { id: 'a', type: 'content' },
	      { id: 'b', type: 'content' },
	      { id: 'group:parent:date-def:2026-06-02', type: 'group', label: fmt.format(new Date(2026, 5, 2)) },
	      { id: 'c', type: 'content' },
	    ]);
	  });

	  test('groups the done field into Done / Not done buckets', () => {
	    const parent = makeNode('parent', 'Parent', { children: ['view', 'done1', 'open1'] });
	    const byId = new Map<string, any>([
	      ['parent', parent],
	      ['view', makeNode('view', '', { type: 'viewDef', parentId: 'parent', children: [], groupField: DONE_FIELD })],
	      ['done1', makeNode('done1', 'Done one', { parentId: 'parent', completedAt: 1000 })],
	      ['open1', makeNode('open1', 'Open one', { parentId: 'parent' })],
	    ]);

	    expect(buildOutlinerRows(parent as any, byId)).toEqual([
	      { id: 'group:parent:sys:done:true', type: 'group', label: 'Done' },
	      { id: 'done1', type: 'content' },
	      { id: 'group:parent:sys:done:false', type: 'group', label: 'Not done' },
	      { id: 'open1', type: 'content' },
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
    ])).toBe(true);
    expect(shouldShowTrailingInput([
      { id: 'content', type: 'content' },
      { id: 'hidden:p:f', type: 'hiddenField', fieldId: 'f', label: 'Field' },
    ], { mode: 'fieldValue' })).toBe(false);
  });

  test('resolves row drag-drop moves across parents and expanded targets', () => {
    expect(resolveOutlinerDropMove({
      dragNodeId: 'drag',
      targetNodeId: 'target',
      targetParentId: 'parent-b',
      siblingIndex: 2,
      dropPosition: 'before',
      targetHasChildren: false,
      targetIsExpanded: false,
      currentParentId: 'parent-a',
      currentIndex: 0,
    })).toEqual({ parentId: 'parent-b', index: 2, expandTargetId: undefined });

    expect(resolveOutlinerDropMove({
      dragNodeId: 'drag',
      targetNodeId: 'target',
      targetParentId: 'parent-b',
      siblingIndex: 2,
      dropPosition: 'after',
      targetHasChildren: true,
      targetIsExpanded: true,
      currentParentId: 'parent-a',
      currentIndex: 0,
    })).toEqual({ parentId: 'target', index: 0, expandTargetId: undefined });

    expect(resolveOutlinerDropMove({
      dragNodeId: 'drag',
      targetNodeId: 'target',
      targetParentId: 'parent-b',
      siblingIndex: 2,
      dropPosition: 'inside',
      targetHasChildren: false,
      targetIsExpanded: false,
      currentParentId: 'parent-a',
      currentIndex: 0,
    })).toEqual({ parentId: 'target', index: 0, expandTargetId: 'target' });
  });

  test('adjusts same-parent drag-drop indexes after source removal', () => {
    expect(resolveOutlinerDropMove({
      dragNodeId: 'drag',
      targetNodeId: 'target',
      targetParentId: 'parent',
      siblingIndex: 3,
      dropPosition: 'after',
      targetHasChildren: false,
      targetIsExpanded: false,
      currentParentId: 'parent',
      currentIndex: 1,
    })).toEqual({ parentId: 'parent', index: 3, expandTargetId: undefined });
  });

  test('maps trailing input trigger characters to node actions', () => {
    expect(resolveTrailingRowUpdateAction({ text: '>' })).toEqual({ type: 'create_field' });
    expect(resolveTrailingRowUpdateAction({ text: '#' })).toEqual({
      type: 'open_trigger',
      trigger: '#',
      matchText: '#',
      textOffset: 1,
    });
    expect(resolveTrailingRowUpdateAction({ text: 'hello@' })).toEqual({
      type: 'open_trigger',
      trigger: '@',
      matchText: 'hello@',
      textOffset: 6,
    });
    expect(resolveTrailingRowUpdateAction({ text: '/' })).toEqual({
      type: 'open_trigger',
      trigger: '/',
      matchText: '/',
      textOffset: 1,
    });
    expect(resolveTrailingRowUpdateAction({ text: '#fff' })).toEqual({ type: 'none' });
    expect(resolveTrailingRowUpdateAction({ text: '#112233' })).toEqual({ type: 'none' });
    expect(resolveTrailingRowUpdateAction({ text: '#112233', isOptionsField: true })).toEqual({
      type: 'open_options',
      query: '#112233',
    });
  });

  test('keeps trailing navigation decisions explicit', () => {
    expect(resolveTrailingRowEnterIntent({ hasText: false })).toBe('create_empty');
    expect(resolveTrailingRowEnterIntent({ hasText: true })).toBe('create_content');
    expect(resolveTrailingRowEnterIntent({ hasText: true, continueOnText: true })).toBe('create_content_and_continue');
    expect(resolveTrailingRowEnterIntent({ hasText: true, continueOnText: false })).toBe('create_content');
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

  test('converts a bare ``` / ~~~ row into a code block', () => {
    expect(resolveContentRowUpdateAction({
      text: '```',
      inlineRefCount: 0,
      enableFieldTrigger: true,
      enableCodeFence: true,
    })).toEqual({ type: 'create_code_block' });
    expect(resolveContentRowUpdateAction({
      text: '~~~',
      inlineRefCount: 0,
      enableFieldTrigger: true,
      enableCodeFence: true,
    })).toEqual({ type: 'create_code_block' });
  });

  test('leaves partial / decorated fences and disabled rows untouched', () => {
    // Fewer than three backticks, or any trailing text, is not a fence trigger.
    expect(resolveContentRowUpdateAction({
      text: '``',
      inlineRefCount: 0,
      enableFieldTrigger: true,
      enableCodeFence: true,
    })).toEqual({ type: 'none' });
    expect(resolveContentRowUpdateAction({
      text: '```ts',
      inlineRefCount: 0,
      enableFieldTrigger: true,
      enableCodeFence: true,
    })).toEqual({ type: 'none' });
    // Inline refs in the row, or a row that cannot become a code block, opt out.
    expect(resolveContentRowUpdateAction({
      text: '```',
      inlineRefCount: 1,
      enableFieldTrigger: true,
      enableCodeFence: true,
    })).toEqual({ type: 'none' });
    expect(resolveContentRowUpdateAction({
      text: '```',
      inlineRefCount: 0,
      enableFieldTrigger: true,
      enableCodeFence: false,
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
      treeBlockReason: null,
      sourceIsReference: false,
    })).toBe('tree_reference');

    expect(resolveReferenceSelectionAction({
      text: 'see @node',
      inlineRefCount: 0,
      triggerFrom: 4,
      triggerTo: 9,
      treeBlockReason: null,
      sourceIsReference: false,
    })).toBe('inline_reference');

    expect(resolveReferenceSelectionAction({
      text: '@node',
      inlineRefCount: 1,
      triggerFrom: 0,
      triggerTo: 5,
      treeBlockReason: null,
      sourceIsReference: false,
    })).toBe('inline_reference');

    expect(resolveReferenceSelectionAction({
      text: '@node',
      inlineRefCount: 0,
      triggerFrom: 0,
      triggerTo: 5,
      treeBlockReason: 'already_in_parent',
      sourceIsReference: false,
    })).toBe('inline_reference');

    expect(resolveReferenceSelectionAction({
      text: '@node',
      inlineRefCount: 0,
      triggerFrom: 0,
      triggerTo: 5,
      treeBlockReason: 'would_create_display_cycle',
      sourceIsReference: false,
    })).toBe('blocked');

    expect(resolveReferenceSelectionAction({
      text: '@node',
      inlineRefCount: 0,
      triggerFrom: 0,
      triggerTo: 5,
      treeBlockReason: null,
      sourceIsReference: true,
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
      'code',
      'image',
      'command_palette',
    ]);
    expect(filterSlashCommands('ref').map((command) => command.id)).toEqual(['reference']);
    expect(filterSlashCommands('code').map((command) => command.id)).toEqual(['code']);
    expect(filterSlashCommands('image').map((command) => command.id)).toEqual(['image']);
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
        libraryId: 'root',
        dailyNotesId: 'daily',
        schemaId: 'schema',
        searchesId: 'searches',
        recentsId: 'recents',
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

  test('orders tag selector candidates by relevance before raw document order', () => {
    const nodes = [
      makeNode('tag-hex-recent', 'E4E4E7', { type: 'tagDef', updatedAt: 40 }),
      makeNode('tag-ui', 'ui', { type: 'tagDef', updatedAt: 10 }),
      makeNode('tag-design', 'design', { type: 'tagDef', updatedAt: 30 }),
      makeNode('tag-hex', '52525B', { type: 'tagDef', updatedAt: 20 }),
    ];
    const index = {
      projection: {
        workspaceId: 'root',
        rootId: 'root',
        libraryId: 'root',
        dailyNotesId: 'daily',
        schemaId: 'schema',
        searchesId: 'searches',
        recentsId: 'recents',
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
      existingTagIds: [],
    }).map((item) => item.type === 'existing' ? item.tag.content.text : `create:${item.name}`)).toEqual([
      'design',
      'ui',
      'E4E4E7',
      '52525B',
    ]);
    expect(tagSelectorItems({
      query: 'des',
      index: index as any,
      existingTagIds: [],
    }).map((item) => item.type === 'existing' ? item.tag.content.text : `create:${item.name}`)).toEqual([
      'design',
      'create:des',
    ]);
    expect(tagSelectorItems({
      query: 'design',
      index: index as any,
      existingTagIds: ['tag-design'],
    })).toEqual([]);
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
      ({
        key,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...init,
      } as KeyboardEvent)
    );
    expect(resolveSelectedReferenceShortcut(keyboard('Backspace'))).toBe('delete');
    expect(resolveSelectedReferenceShortcut(keyboard('Delete'))).toBe('delete');
    expect(resolveSelectedReferenceShortcut(keyboard('ArrowRight'))).toBe('convert_arrow_right');
    expect(resolveSelectedReferenceShortcut(keyboard('x'))).toBe('convert_printable');
    expect(resolveSelectedReferenceShortcut(keyboard('x', { metaKey: true }))).toBeNull();
    expect(resolveSelectedReferenceShortcut(keyboard('Escape'))).toBe('escape');
  });

  test('central shortcut registry maps editor and trailing commands', () => {
    const keyboard = (key: string, init: Partial<KeyboardEvent> = {}) => (
      ({
        key,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...init,
      } as KeyboardEvent)
    );
    expect(shortcutDefinitionsForScope('editor').map((shortcut) => shortcut.id)).toContain('editor.description');
    expect(matchesShortcutEvent(keyboard('z', { metaKey: true }), 'editor.undo')).toBe(true);
    expect(matchesShortcutEvent(keyboard('z', { metaKey: true, shiftKey: true }), 'editor.redo')).toBe(true);
    expect(matchesShortcutEvent(keyboard('y', { ctrlKey: true }), 'trailing.redo')).toBe(true);
    expect(matchesShortcutEvent(keyboard('y', { metaKey: true }), 'global.redo')).toBe(true);
    expect(matchesShortcutEvent(keyboard('i', { ctrlKey: true }), 'trailing.description')).toBe(true);
    expect(matchesShortcutEvent(keyboard('i', { metaKey: true }), 'trailing.description')).toBe(false);
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
    expect(options).toEqual([{ id: 'opt_done', label: 'Done', autoCollected: true, targetId: 'opt_done' }]);
    expect(resolveSelectedOptionId(value as any, options)).toBe('opt_done');
  });

  test('resolves collected option references through their target value nodes', () => {
    const field = {
      id: 'field_status',
      type: 'fieldDef',
      children: ['collected_ref'],
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
    const localValue = {
      id: 'local_value',
      parentId: 'field_entry',
      children: [],
      content: { text: 'Urgent', marks: [], inlineRefs: [] },
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
    } as const;
    const collectedRef = {
      ...localValue,
      id: 'collected_ref',
      parentId: 'field_status',
      type: 'reference',
      targetId: 'local_value',
      autoCollected: true,
    } as const;
    const valueRef = {
      ...localValue,
      id: 'value_ref',
      type: 'reference',
      targetId: 'local_value',
    } as const;
    const byId = new Map<string, any>([
      [field.id, field],
      [localValue.id, localValue],
      [collectedRef.id, collectedRef],
      [valueRef.id, valueRef],
    ]);

    const options = resolveFieldOptions(field as any, byId);
    expect(options).toEqual([{ id: 'collected_ref', label: 'Urgent', autoCollected: true, targetId: 'local_value' }]);
    expect(resolveSelectedOptionId(valueRef as any, options)).toBe('collected_ref');
    expect(resolveSelectedOptionId(localValue as any, options)).toBeUndefined();
  });

  test('keeps direct option order from the field definition', () => {
    const field = {
      id: 'field_status',
      type: 'fieldDef',
      children: ['opt_beta', 'opt_alpha'],
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
    const beta = {
      id: 'opt_beta',
      parentId: 'field_status',
      children: [],
      content: { text: 'Beta', marks: [], inlineRefs: [] },
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
    const alpha = {
      ...beta,
      id: 'opt_alpha',
      content: { text: 'Alpha', marks: [], inlineRefs: [] },
    } as const;
    const byId = new Map<string, any>([
      [field.id, field],
      [beta.id, beta],
      [alpha.id, alpha],
    ]);

    expect(resolveFieldOptions(field as any, byId).map((option) => option.label)).toEqual(['Beta', 'Alpha']);
  });

  test('resolves options-from-supertag from tagged content nodes', () => {
    const field = {
      id: 'field_city',
      type: 'fieldDef',
      children: ['ignored_child_option'],
      content: { text: 'City', marks: [], inlineRefs: [] },
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      showCheckbox: false,
      doneStateEnabled: false,
      fieldType: 'options_from_supertag',
      sourceSupertag: 'tag_city',
      autocollectOptions: false,
      autoCollected: false,
      toolbarVisible: false,
      filterValues: [],
    } as const;
    const taggedNode = {
      id: 'node_chengdu',
      children: [],
      content: { text: 'Chengdu', marks: [], inlineRefs: [] },
      tags: ['tag_city'],
      createdAt: 0,
      updatedAt: 0,
      locked: false,
      showCheckbox: false,
      doneStateEnabled: false,
      autocollectOptions: false,
      autoCollected: false,
      toolbarVisible: false,
      filterValues: [],
    } as const;
    const otherTagNode = {
      ...taggedNode,
      id: 'node_beijing',
      content: { text: 'Beijing', marks: [], inlineRefs: [] },
      tags: ['tag_other'],
    } as const;
    const childOption = {
      ...taggedNode,
      id: 'ignored_child_option',
      parentId: 'field_city',
      content: { text: 'Child option', marks: [], inlineRefs: [] },
      tags: [],
    } as const;
    const byId = new Map<string, any>([
      [field.id, field],
      [taggedNode.id, taggedNode],
      [otherTagNode.id, otherTagNode],
      [childOption.id, childOption],
    ]);

    expect(resolveFieldOptions(field as any, byId)).toEqual([{
      id: 'node_chengdu',
      label: 'Chengdu',
      autoCollected: false,
      targetId: 'node_chengdu',
    }]);
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

  test('blocks tree reference candidates already present in the parent list', () => {
    const parent = {
      id: 'parent',
      children: ['target', 'draft'],
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
    const target = {
      ...parent,
      id: 'target',
      parentId: 'parent',
      children: [],
      content: { text: 'Target', marks: [], inlineRefs: [] },
    };
    const draft = {
      ...target,
      id: 'draft',
      content: { text: '', marks: [], inlineRefs: [] },
    };
    const byId = new Map<string, any>([
      [parent.id, parent],
      [target.id, target],
      [draft.id, draft],
    ]);

    expect(getTreeReferenceBlockReason({
      parentId: 'parent',
      targetId: 'target',
      byId,
    })).toBe('already_in_parent');
  });

  test('only disables cycle candidates when evaluating a tree reference insertion', () => {
    const parent = makeNode('parent', 'Parent', { children: ['child'] });
    const child = makeNode('child', 'Child', { parentId: 'parent', children: ['draft'] });
    const draft = makeNode('draft', 'See ', { parentId: 'child' });
    const nodes = [parent, child, draft];
    const index = {
      projection: {
        workspaceId: 'root',
        rootId: 'parent',
        libraryId: 'parent',
        dailyNotesId: 'daily',
        schemaId: 'schema',
        searchesId: 'searches',
        recentsId: 'recents',
        trashId: 'trash',
        settingsId: 'settings',
        todayId: 'today',
        nodes,
      },
      byId: new Map(nodes.map((node) => [node.id, node])),
    } as any;

    const inlineCandidates = buildReferenceCandidates({
      index,
      currentNodeId: 'draft',
      query: 'parent',
      treeReferenceParentId: null,
    });
    const inlineParent = inlineCandidates.find((candidate) => candidate.type === 'node' && candidate.id === 'parent');
    expect(inlineParent).toMatchObject({ disabledReason: null });

    const treeCandidates = buildReferenceCandidates({
      index,
      currentNodeId: 'draft',
      query: 'parent',
      treeReferenceParentId: 'child',
    });
    const treeParent = treeCandidates.find((candidate) => candidate.type === 'node' && candidate.id === 'parent');
    expect(treeParent).toMatchObject({ disabledReason: 'Would create a display cycle' });
  });

  test('reference candidates include date shortcuts and create option', () => {
    const projection = {
      workspaceId: 'root',
      rootId: 'root',
      libraryId: 'root',
      dailyNotesId: 'daily',
      schemaId: 'schema',
      searchesId: 'searches',
      recentsId: 'recents',
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

  test('reference candidates exclude nodes in Trash', () => {
    const nodes = [
      makeNode('root', 'Root', { children: ['today', 'trash'] }),
      makeNode('today', 'Today', { parentId: 'root', children: ['current', 'visible'] }),
      makeNode('current', 'Current', { parentId: 'today' }),
      makeNode('visible', 'Visible target', { parentId: 'today' }),
      makeNode('trash', 'Trash', { parentId: 'root', children: ['deleted-parent'] }),
      makeNode('deleted-parent', 'Deleted parent', { parentId: 'trash', children: ['deleted-child'] }),
      makeNode('deleted-child', 'Deleted child', { parentId: 'deleted-parent' }),
    ];
    const projection = {
      workspaceId: 'root',
      rootId: 'root',
      libraryId: 'root',
      dailyNotesId: 'today',
      schemaId: 'schema',
      searchesId: 'searches',
      recentsId: 'recents',
      trashId: 'trash',
      settingsId: 'settings',
      todayId: 'today',
      nodes,
    };

    const candidates = buildReferenceCandidates({
      index: { projection, byId: new Map(nodes.map((node) => [node.id, node])) } as any,
      currentNodeId: 'current',
      query: 'deleted',
    });
    expect(candidates.some((candidate) => candidate.type === 'node')).toBe(false);
    expect(candidates).toContainEqual({ type: 'create', label: 'deleted' });

    const visibleCandidates = buildReferenceCandidates({
      index: { projection, byId: new Map(nodes.map((node) => [node.id, node])) } as any,
      currentNodeId: 'current',
      query: 'visible',
    });
    expect(visibleCandidates).toContainEqual(expect.objectContaining({
      id: 'visible',
      label: 'Visible target',
      type: 'node',
    }));
  });

  test('orders reference candidates by current context before untitled recent nodes', () => {
    const nodes = [
      makeNode('root', 'Root', { children: ['today', 'other'] }),
      makeNode('today', 'Today', { parentId: 'root', children: ['current', 'untitled', 'sibling'] }),
      makeNode('current', 'Current', { parentId: 'today' }),
      makeNode('untitled', '', { parentId: 'today', updatedAt: 100 }),
      makeNode('sibling', 'Sibling note', { parentId: 'today', updatedAt: 10 }),
      makeNode('other', 'Other recent', { parentId: 'root', updatedAt: 200 }),
    ];
    const projection = {
      workspaceId: 'root',
      rootId: 'root',
      libraryId: 'root',
      dailyNotesId: 'today',
      schemaId: 'schema',
      searchesId: 'searches',
      recentsId: 'recents',
      trashId: 'trash',
      settingsId: 'settings',
      todayId: 'today',
      nodes,
    };
    const candidates = buildReferenceCandidates({
      index: { projection, byId: new Map(nodes.map((node) => [node.id, node])) } as any,
      currentNodeId: 'current',
      query: '',
    });
    const labels = candidates
      .filter((candidate) => candidate.type === 'node')
      .map((candidate) => candidate.label);

    expect(labels[0]).toBe('Sibling note');
    expect(labels.indexOf('Untitled')).toBeGreaterThan(labels.indexOf('Other recent'));
  });
});
