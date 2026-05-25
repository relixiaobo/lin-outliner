import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { LoroOutlinerDocument } from '../../src/core/loroDocument';
import { runSearchNode } from '../../src/core/searchEngine';
import {
  AREAS_ID,
  DAILY_NOTES_ID,
  LIBRARY_ID,
  PROJECTS_ID,
  RECENTS_ID,
  RESOURCES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  SETTINGS_ID,
  TAG_DAY_ID,
  TRASH_ID,
  WORKSPACE_ID,
  plainText,
  replaceAllRichTextPatch,
  type CreateNodeTree,
  type RichText,
} from '../../src/core/types';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

describe('Core', () => {
  test('initializes Recents as a saved search node', () => {
    const core = Core.new();
    const projection = core.projection();
    const state = core.state();
    const recents = state.nodes[projection.recentsId];
    expect(projection.recentsId).toBe(RECENTS_ID);
    expect(recents).toMatchObject({
      type: 'search',
      parentId: projection.searchesId,
      content: { text: 'Recents' },
    });
    const viewDef = recents.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'viewDef');
    expect(viewDef).toMatchObject({ viewMode: 'list' });
    const sortRule = viewDef?.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'sortRule');
    expect(sortRule).toMatchObject({ sortField: 'sys:updatedAt', sortDirection: 'desc' });
    const condition = recents.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'queryCondition');
    expect(condition).toMatchObject({
      queryOp: 'EDITED_LAST_DAYS',
      content: { text: '30' },
    });
  });

  test('initializes root without PARA buckets', () => {
    const core = Core.new();
    const state = core.state();
    const root = state.nodes[core.projection().rootId]!;

    expect(root.children).toEqual([
      DAILY_NOTES_ID,
      LIBRARY_ID,
      SCHEMA_ID,
      SEARCHES_ID,
      TRASH_ID,
      SETTINGS_ID,
    ]);
    expect(state.nodes[PROJECTS_ID]).toBeUndefined();
    expect(state.nodes[AREAS_ID]).toBeUndefined();
    expect(state.nodes[RESOURCES_ID]).toBeUndefined();
  });

  test('migrates legacy PARA root nodes without losing content', () => {
    const legacy = new LoroOutlinerDocument();
    legacy.createNodeWithId(WORKSPACE_ID, undefined, undefined, undefined, (node) => {
      node.content = plainText('Lin Outliner');
      node.locked = true;
    });
    legacy.createNodeWithId(LIBRARY_ID, WORKSPACE_ID, undefined, undefined, (node) => {
      node.content = plainText('Library');
      node.locked = true;
    });
    legacy.createNodeWithId(PROJECTS_ID, WORKSPACE_ID, undefined, undefined, (node) => {
      node.content = plainText('Projects');
      node.locked = true;
    });
    legacy.createNodeWithId(RESOURCES_ID, WORKSPACE_ID, undefined, undefined, (node) => {
      node.content = plainText('Resources');
      node.description = 'Legacy resource bucket';
      node.locked = true;
    });
    legacy.createNodeWithId('legacy-resource-child', RESOURCES_ID, undefined, undefined, (node) => {
      node.content = plainText('Saved reference');
    });

    const restored = Core.fromState(legacy.serialize('__legacy__'));
    const state = restored.state();

    expect(state.nodes[PROJECTS_ID]).toBeUndefined();
    expect(state.nodes[RESOURCES_ID]).toMatchObject({
      parentId: LIBRARY_ID,
      locked: false,
      content: { text: 'Resources' },
      children: ['legacy-resource-child'],
    });
    expect(state.nodes['legacy-resource-child']?.parentId).toBe(RESOURCES_ID);
    expect(state.nodes[WORKSPACE_ID]!.children).not.toContain(PROJECTS_ID);
    expect(state.nodes[WORKSPACE_ID]!.children).not.toContain(RESOURCES_ID);
    expect(state.nodes[LIBRARY_ID]!.children).toContain(RESOURCES_ID);
  });

  test('creates and moves nodes', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = mustFocus(core.createNode(today, null, 'First'));
    const second = mustFocus(core.createNode(today, null, 'Second'));

    core.indentNode(second);

    expect(core.state().nodes[second].parentId).toBe(first);
    expect(core.state().nodes[first].children).toContain(second);
  });

  test('focuses the last inserted root when creating a tree batch', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const outcome = core.createNodesFromTree(today, [
      { content: plainText('Committed text'), children: [] },
      { content: plainText('Continuation'), children: [] },
    ]);

    expect(core.state().nodes[outcome.focus!.nodeId].content.text).toBe('Continuation');
    expect(outcome.focus).toMatchObject({
      parentId: today,
      placement: { kind: 'end' },
    });
  });

  test('creates a tagged node in one core command', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('project'));
    const outcome = core.createTaggedNode(today, plainText('Launch'), tagId);
    const nodeId = mustFocus(outcome);

    expect(core.state().nodes[nodeId]).toMatchObject({
      content: { text: 'Launch' },
      parentId: today,
      tags: [tagId],
    });
    expect(outcome.focus).toMatchObject({
      parentId: today,
      placement: { kind: 'end' },
    });
  });

  test('creates a rich text node in one core command', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const content: RichText = {
      text: 'See Target',
      marks: [{ start: 0, end: 3, type: 'bold' }],
      inlineRefs: [{ offset: 4, targetNodeId: target, displayName: 'Target' }],
    };
    const outcome = core.createRichTextContentNode(today, null, content);
    const nodeId = mustFocus(outcome);

    expect(core.state().nodes[nodeId]).toMatchObject({
      content,
      parentId: today,
    });
    expect(outcome.focus).toMatchObject({
      parentId: today,
      placement: { kind: 'end' },
    });
  });

  test('creates a missing tag and tagged node in one core command', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const outcome = core.createTagAndTaggedNode(today, plainText(''), 'brand-new-tag');
    const nodeId = mustFocus(outcome);
    const tag = Object.values(core.state().nodes).find((node) =>
      node.type === 'tagDef' && node.content.text === 'brand-new-tag');

    expect(tag).toBeDefined();
    expect(core.state().nodes[nodeId]).toMatchObject({
      content: { text: '' },
      parentId: today,
      tags: [tag!.id],
    });
  });

  test('updates node metadata and clears empty view settings', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'Node'));

    core.updateNodeDescription(nodeId, '  Description  ');
    core.setViewToolbarVisible(nodeId, true);
    core.addSortRule(nodeId, 'sys:name', 'desc');
    core.addFilterRule(nodeId, 'sys:name', 'contains', [' alpha ', 'Alpha', ''], 'any');
    core.setGroupField(nodeId, 'sys:name');

    let node = core.state().nodes[nodeId];
    let viewDef = node.children.map((childId) => core.state().nodes[childId]).find((child) => child?.type === 'viewDef')!;
    let sortRule = viewDef.children.map((childId) => core.state().nodes[childId]).find((child) => child?.type === 'sortRule')!;
    let filterRule = viewDef.children.map((childId) => core.state().nodes[childId]).find((child) => child?.type === 'filterRule')!;
    expect(node.description).toBe('Description');
    expect(viewDef.toolbarVisible).toBe(true);
    expect(sortRule.sortField).toBe('sys:name');
    expect(sortRule.sortDirection).toBe('desc');
    expect(filterRule.filterField).toBe('sys:name');
    expect(filterRule.filterOperator).toBe('contains');
    expect(filterRule.filterValueLogic).toBe('any');
    expect(filterRule.filterValues).toEqual(['alpha']);
    expect(viewDef.groupField).toBe('sys:name');

    core.updateNodeDescription(nodeId, '');
    core.clearSortRules(nodeId);
    core.clearFilterRules(nodeId);
    core.setGroupField(nodeId, null);

    node = core.state().nodes[nodeId];
    viewDef = node.children.map((childId) => core.state().nodes[childId]).find((child) => child?.type === 'viewDef')!;
    expect(node.description).toBeUndefined();
    expect(viewDef.children.map((childId) => core.state().nodes[childId]?.type)).not.toContain('sortRule');
    expect(viewDef.children.map((childId) => core.state().nodes[childId]?.type)).not.toContain('filterRule');
    expect(viewDef.groupField).toBeUndefined();
  });

  test('toggle done enables and preserves checkbox affordance', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'Task'));

    core.toggleDone(nodeId);
    expect(core.state().nodes[nodeId].completedAt).toBeDefined();
    expect(core.state().nodes[nodeId].showCheckbox).toBe(true);

    core.toggleDone(nodeId);
    expect(core.state().nodes[nodeId].completedAt).toBeUndefined();
    expect(core.state().nodes[nodeId].showCheckbox).toBe(true);
  });

  test('batch toggle done enables checkbox affordance on each target', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = mustFocus(core.createNode(today, null, 'First'));
    const second = mustFocus(core.createNode(today, null, 'Second'));

    core.batchToggleDone([first, second]);

    expect(core.state().nodes[first].completedAt).toBeDefined();
    expect(core.state().nodes[first].showCheckbox).toBe(true);
    expect(core.state().nodes[second].completedAt).toBeDefined();
    expect(core.state().nodes[second].showCheckbox).toBe(true);
  });

  test('keyboard cycle moves through no checkbox, undone, and done', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'Task'));

    expect(core.state().nodes[nodeId].showCheckbox).toBe(false);
    expect(core.state().nodes[nodeId].completedAt).toBeUndefined();

    core.cycleDoneState(nodeId);
    expect(core.state().nodes[nodeId].showCheckbox).toBe(true);
    expect(core.state().nodes[nodeId].completedAt).toBeUndefined();

    core.cycleDoneState(nodeId);
    expect(core.state().nodes[nodeId].showCheckbox).toBe(true);
    expect(core.state().nodes[nodeId].completedAt).toBeDefined();

    core.cycleDoneState(nodeId);
    expect(core.state().nodes[nodeId].showCheckbox).toBe(false);
    expect(core.state().nodes[nodeId].completedAt).toBeUndefined();
  });

  test('keyboard cycle preserves forced done affordance', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createTag('configured task'));
    core.setTagConfig(nodeId, { doneStateEnabled: true });

    core.cycleDoneState(nodeId);
    expect(core.state().nodes[nodeId].showCheckbox).toBe(true);
    expect(core.state().nodes[nodeId].completedAt).toBeDefined();

    core.cycleDoneState(nodeId);
    expect(core.state().nodes[nodeId].showCheckbox).toBe(true);
    expect(core.state().nodes[nodeId].completedAt).toBeUndefined();
  });

  test('merge preserves UTF-16 rich text offsets', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const first = mustFocus(core.createNode(today, null, '😀'));
    const second = mustFocus(core.createNode(today, null, 'Hi'));

    core.applyNodeTextPatch(first, replaceAllRichTextPatch({
      text: '😀',
      marks: [{ start: 0, end: 2, type: 'bold' }],
      inlineRefs: [{ offset: 2, targetNodeId: target, displayName: 'Target' }],
    }));
    core.applyNodeTextPatch(second, replaceAllRichTextPatch({
      text: 'Hi',
      marks: [{ start: 0, end: 2, type: 'code' }],
      inlineRefs: [{ offset: 1, targetNodeId: target, displayName: 'Target' }],
    }));

    core.mergeNodeInto(second, first);

    const merged = core.state().nodes[first].content;
    expect(merged.text).toBe('😀Hi');
    expect(merged.marks.map((mark) => [mark.start, mark.end])).toEqual([[0, 2], [2, 4]]);
    expect(merged.inlineRefs.map((ref) => ref.offset)).toEqual([2, 3]);
    expect(core.state().nodes[second]).toBeUndefined();
  });

  test('batch duplicate clones subtrees after source', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = mustFocus(core.createNode(today, null, 'First'));
    const child = mustFocus(core.createNode(first, null, 'Child'));
    const second = mustFocus(core.createNode(today, null, 'Second'));

    const cloneId = mustFocus(core.batchDuplicateNodes([first]));
    const siblings = core.state().nodes[today].children;
    const firstIndex = siblings.indexOf(first);

    expect(siblings[firstIndex + 1]).toBe(cloneId);
    expect(siblings[firstIndex + 2]).toBe(second);
    expect(cloneId).not.toBe(first);
    expect(core.state().nodes[cloneId].content.text).toBe('First');
    const clonedChild = core.state().nodes[cloneId].children[0];
    expect(clonedChild).not.toBe(child);
    expect(core.state().nodes[clonedChild].parentId).toBe(cloneId);
    expect(core.state().nodes[clonedChild].content.text).toBe('Child');
  });

  test('tag template instantiates fields and removal cleans them up', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('project'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Status', 'plain'));
    const fieldId = core.state().nodes[templateEntryId].fieldDefId!;
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'Launch'));

    core.applyTag(nodeId, tagId);
    expect(core.state().nodes[nodeId].children.some((childId) => {
      const child = core.state().nodes[childId];
      return child.type === 'fieldEntry' && child.fieldDefId === fieldId;
    })).toBe(true);

    core.removeTag(nodeId, tagId);
    expect(core.state().nodes[nodeId].children.some((childId) => {
      const child = core.state().nodes[childId];
      return child.type === 'fieldEntry' && child.fieldDefId === fieldId;
    })).toBe(false);
  });

  test('options field registers and selects reference values', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const fieldEntryId = mustFocus(core.createInlineField(today, null, 'Status', 'options'));
    const fieldDefId = core.state().nodes[fieldEntryId].fieldDefId!;
    const optionId = mustFocus(core.registerCollectedOption(fieldDefId, 'Done'));

    expect(core.state().nodes[optionId].parentId).toBe(fieldDefId);
    expect(core.state().nodes[optionId].autoCollected).toBe(true);

    core.selectFieldOption(fieldEntryId, optionId);

    const valueId = core.state().nodes[fieldEntryId].children[0];
    expect(core.state().nodes[valueId].type).toBe('reference');
    expect(core.state().nodes[valueId].targetId).toBe(optionId);
    expect(mustFocus(core.registerCollectedOption(fieldDefId, 'done'))).toBe(optionId);

    core.clearFieldValue(fieldEntryId);
    expect(core.state().nodes[fieldEntryId].children).toEqual([]);
  });

  test('auto-collected options keep the value local and collect a reference', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const fieldEntryId = mustFocus(core.createInlineField(today, null, 'Status', 'options'));
    const fieldDefId = core.state().nodes[fieldEntryId].fieldDefId!;

    core.createCollectedFieldOption(fieldEntryId, 'Urgent');

    const valueId = core.state().nodes[fieldEntryId].children[0];
    const value = core.state().nodes[valueId];
    expect(value.type).toBeUndefined();
    expect(value.content.text).toBe('Urgent');

    const collectedRefId = core.state().nodes[fieldDefId].children[0];
    const collectedRef = core.state().nodes[collectedRefId];
    expect(collectedRef.type).toBe('reference');
    expect(collectedRef.targetId).toBe(valueId);
    expect(collectedRef.autoCollected).toBe(true);

    core.selectFieldOption(fieldEntryId, collectedRefId);
    expect(core.state().nodes[fieldEntryId].children).toEqual([valueId]);

    core.clearFieldValue(fieldEntryId);
    expect(core.state().nodes[fieldEntryId].children).toEqual([]);
    expect(core.state().nodes[fieldDefId].children).toEqual([]);
  });

  test('clearing an auto-collected source preserves references by promoting the option', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('Task'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Status', 'options'));
    const fieldDefId = core.state().nodes[templateEntryId].fieldDefId!;
    const firstNodeId = mustFocus(core.createNode(today, null, 'First'));
    const secondNodeId = mustFocus(core.createNode(today, null, 'Second'));
    core.applyTag(firstNodeId, tagId);
    core.applyTag(secondNodeId, tagId);
    const fieldEntryFor = (nodeId: string) => {
      const entryId = core.state().nodes[nodeId].children.find((childId) => {
        const child = core.state().nodes[childId];
        return child.type === 'fieldEntry' && child.fieldDefId === fieldDefId;
      });
      expect(entryId).toBeDefined();
      return entryId!;
    };
    const firstEntryId = fieldEntryFor(firstNodeId);
    const secondEntryId = fieldEntryFor(secondNodeId);

    core.createCollectedFieldOption(firstEntryId, 'Urgent');
    const sourceValueId = core.state().nodes[firstEntryId].children[0];
    const collectedRefId = core.state().nodes[fieldDefId].children[0];
    core.selectFieldOption(secondEntryId, collectedRefId);
    const secondValueId = core.state().nodes[secondEntryId].children[0];
    expect(core.state().nodes[secondValueId].targetId).toBe(sourceValueId);

    core.clearFieldValue(firstEntryId);

    const state = core.state();
    expect(state.nodes[firstEntryId].children).toEqual([]);
    expect(state.nodes[sourceValueId].parentId).toBe(fieldDefId);
    expect(state.nodes[sourceValueId].autoCollected).toBe(true);
    expect(state.nodes[secondValueId].targetId).toBe(sourceValueId);
    expect(state.nodes[fieldDefId].children).toEqual([sourceValueId]);
  });

  test('list options append unique values instead of replacing', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const fieldEntryId = mustFocus(core.createInlineField(today, null, 'Tags', 'options'));
    const fieldDefId = core.state().nodes[fieldEntryId].fieldDefId!;
    core.setFieldConfig(fieldDefId, { cardinality: 'list' });
    const first = mustFocus(core.registerCollectedOption(fieldDefId, 'Alpha'));
    const second = mustFocus(core.registerCollectedOption(fieldDefId, 'Beta'));

    core.selectFieldOption(fieldEntryId, first);
    core.selectFieldOption(fieldEntryId, second);
    core.selectFieldOption(fieldEntryId, first);

    const values = core.state().nodes[fieldEntryId].children.map((childId) => core.state().nodes[childId].targetId);
    expect(values).toEqual([first, second]);
  });

  test('options from supertag selects tagged nodes instead of field children', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const sourceTagId = mustFocus(core.createTag('City'));
    const fieldEntryId = mustFocus(core.createInlineField(today, null, 'Destination', 'options_from_supertag'));
    const fieldDefId = core.state().nodes[fieldEntryId].fieldDefId!;
    core.setFieldConfig(fieldDefId, {
      fieldType: 'options_from_supertag',
      sourceSupertag: sourceTagId,
    });

    const chengduId = mustFocus(core.createNode(today, null, 'Chengdu'));
    core.applyTag(chengduId, sourceTagId);
    core.selectFieldOption(fieldEntryId, chengduId);

    const valueId = core.state().nodes[fieldEntryId].children[0];
    expect(core.state().nodes[valueId].type).toBe('reference');
    expect(core.state().nodes[valueId].targetId).toBe(chengduId);
    expect(() => core.registerCollectedOption(fieldDefId, 'Beijing')).toThrow('direct options');
  });

  test('field config validates constraints and clears type-specific settings', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('project'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Estimate', 'plain'));
    const fieldId = core.state().nodes[templateEntryId].fieldDefId!;

    core.setFieldConfig(fieldId, {
      fieldType: 'number',
      cardinality: 'list',
      nullable: false,
      hideField: 'empty',
      autoInitialize: 'ancestor_field_value',
      minValue: 1,
      maxValue: 5,
    });
    expect(core.state().nodes[fieldId].fieldType).toBe('number');
    expect(core.state().nodes[fieldId].cardinality).toBe('list');
    expect(core.state().nodes[fieldId].nullable).toBe(false);
    expect(core.state().nodes[fieldId].hideField).toBe('empty');
    expect(core.state().nodes[fieldId].autoInitialize).toBe('ancestor_field_value');
    expect(core.state().nodes[fieldId].minValue).toBe(1);
    expect(core.state().nodes[fieldId].maxValue).toBe(5);

    core.setFieldConfig(fieldId, { fieldType: 'options', autocollectOptions: true });
    expect(core.state().nodes[fieldId].fieldType).toBe('options');
    expect(core.state().nodes[fieldId].autocollectOptions).toBe(true);
    expect(core.state().nodes[fieldId].minValue).toBeUndefined();
    expect(core.state().nodes[fieldId].maxValue).toBeUndefined();

    const sourceTagId = mustFocus(core.createTag('source'));
    core.setFieldConfig(fieldId, {
      fieldType: 'options_from_supertag',
      sourceSupertag: sourceTagId,
    });
    expect(core.state().nodes[fieldId].fieldType).toBe('options_from_supertag');
    expect(core.state().nodes[fieldId].sourceSupertag).toBe(sourceTagId);
    expect(core.state().nodes[fieldId].autocollectOptions).toBe(false);

    expect(() => core.setFieldConfig(fieldId, { autocollectOptions: true }))
      .toThrow('auto-collect options');
    expect(() => core.setFieldConfig(fieldId, { fieldType: 'number', minValue: 10, maxValue: 1 }))
      .toThrow('minimum value');
    expect(() => core.setFieldConfig(fieldId, { autoInitialize: 'unknown_strategy' }))
      .toThrow('auto-initialize');
  });

  test('paste nodes is one undoable rich structural operation', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const current = mustFocus(core.createNode(today, null, 'Current'));
    const next = mustFocus(core.createNode(today, null, 'Next'));
    const tree = (text: string, children: CreateNodeTree[] = []): CreateNodeTree => ({
      content: { text, marks: [], inlineRefs: [] },
      children,
    });

    const outcome = core.pasteNodesIntoNode(
      current,
      { text: 'Pasted', marks: [], inlineRefs: [] },
      [tree('Child')],
      [tree('Sibling A'), tree('Sibling B')],
    );

    expect(core.state().nodes[current].content.text).toBe('Pasted');
    expect(core.state().nodes[core.state().nodes[current].children[0]].content.text).toBe('Child');
    const todayChildren = core.state().nodes[today].children;
    const currentIndex = todayChildren.indexOf(current);
    expect(todayChildren[currentIndex + 3]).toBe(next);
    expect(core.state().nodes[outcome.focus!.nodeId].content.text).toBe('Sibling B');

    core.undo();
    expect(core.state().nodes[current].content.text).toBe('Current');
    expect(core.state().nodes[current].children).toEqual([]);
    expect(core.state().nodes[today].children).toEqual([current, next]);
  });

  test('batch move preserves sibling block order', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = mustFocus(core.createNode(today, null, 'First'));
    const second = mustFocus(core.createNode(today, null, 'Second'));
    const third = mustFocus(core.createNode(today, null, 'Third'));
    const fourth = mustFocus(core.createNode(today, null, 'Fourth'));

    core.batchMoveNodesDown([second, third]);
    expect(core.state().nodes[today].children).toEqual([first, fourth, second, third]);

    core.batchMoveNodesUp([second, third]);
    expect(core.state().nodes[today].children).toEqual([first, second, third, fourth]);
  });

  test('inline field trigger converts the current row in place and undo restores it', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const before = mustFocus(core.createNode(today, null, 'Before'));
    const trigger = mustFocus(core.createNode(today, null, '/priority'));
    const after = mustFocus(core.createNode(today, null, 'After'));

    const fieldEntryId = mustFocus(core.createInlineFieldAfterNode(trigger, 'Priority', 'plain'));
    const fieldId = core.state().nodes[fieldEntryId].fieldDefId!;

    expect(fieldEntryId).toBe(trigger);
    expect(core.state().nodes[today].children).toEqual([before, trigger, after]);
    expect(core.state().nodes[fieldEntryId].type).toBe('fieldEntry');
    expect(core.state().nodes[fieldEntryId].content.text).toBe('');
    expect(core.state().nodes[fieldId].type).toBe('fieldDef');
    expect(core.state().nodes[fieldId].parentId).toBe(SCHEMA_ID);

    core.undo();
    expect(core.state().nodes[today].children).toEqual([before, trigger, after]);
    expect(core.state().nodes[trigger].parentId).toBe(today);
    expect(core.state().nodes[trigger].type).toBeUndefined();
    expect(core.state().nodes[trigger].content.text).toBe('/priority');
    expect(core.state().nodes[fieldId]).toBeUndefined();
  });

  test('inline fields can start with an empty placeholder name', () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const fieldEntryId = mustFocus(core.createInlineField(today, null, '', 'plain'));
    const fieldId = core.state().nodes[fieldEntryId].fieldDefId!;

    expect(core.state().nodes[fieldEntryId].content.text).toBe('');
    expect(core.state().nodes[fieldId].content.text).toBe('');
  });

  test('date nodes, tag search, and reference cycle behavior', () => {
    const core = Core.new();
    const dayId = mustFocus(core.ensureDateNode(2026, 5, 14));
    expect(core.state().nodes[dayId].content.text).toBe('2026-05-14');
    expect(core.state().nodes[dayId].tags).toContain(TAG_DAY_ID);

    const nodeId = mustFocus(core.createNode(dayId, null, 'Tagged'));
    const tagId = mustFocus(core.createTag('project'));
    core.applyTag(nodeId, tagId);
    const searchId = mustFocus(core.ensureTagSearch(tagId));
    expect(core.state().nodes[searchId].type).toBe('search');
    const searchChildren = core.state().nodes[searchId].children;
    const conditionId = searchChildren.find((childId) => core.state().nodes[childId]!.type === 'queryCondition');
    expect(conditionId).toBeDefined();
    const condition = core.state().nodes[conditionId!];
    expect(condition.type).toBe('queryCondition');
    expect(condition.queryOp).toBe('HAS_TAG');
    expect(condition.queryTagDefId).toBe(tagId);
    const resultRefs = searchChildren
      .map((childId) => core.state().nodes[childId]!)
      .filter((child) => child.type === 'reference');
    expect(resultRefs.map((ref) => ref.targetId)).toContain(nodeId);
    const tagSearch = runSearchNode(core.state(), searchId);
    expect(tagSearch.ok ? tagSearch.hits.map((hit) => hit.nodeId) : []).toContain(nodeId);

    const childId = mustFocus(core.createNode(nodeId, null, 'Child'));
    expect(() => core.addReference(childId, nodeId, null)).toThrow('cannot create a reference cycle');
  });

  test('saved search refresh materializes result references by diff', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('project'));
    const alpha = mustFocus(core.createNode(today, null, 'Alpha'));
    const beta = mustFocus(core.createNode(today, null, 'Beta'));
    const gamma = mustFocus(core.createNode(today, null, 'Gamma'));
    core.applyTag(alpha, tagId);
    core.applyTag(beta, tagId);

    const searchId = mustFocus(core.createSearchNode(core.projection().searchesId, null, {
      title: 'Projects',
      query: { kind: 'rule', op: 'HAS_TAG', tagDefId: tagId },
    }));
    let state = core.state();
    const refsByTarget = Object.fromEntries(state.nodes[searchId]!.children
      .map((childId) => state.nodes[childId]!)
      .filter((child) => child.type === 'reference')
      .map((ref) => [ref.targetId!, ref.id]));
    expect(new Set(Object.keys(refsByTarget))).toEqual(new Set([alpha, beta]));

    const betaRef = refsByTarget[beta]!;
    const betaRefTargetIndex = state.nodes[searchId]!.children
      .findIndex((childId) => state.nodes[childId]?.type === 'queryCondition') + 1;
    core.moveNode(betaRef, searchId, betaRefTargetIndex);
    core.removeTag(alpha, tagId);
    core.applyTag(gamma, tagId);
    const expectedHitOrder = runSearchNode(core.state(), searchId);

    core.refreshSearchNodeResults(searchId);
    state = core.state();
    const refs = state.nodes[searchId]!.children
      .map((childId) => state.nodes[childId]!)
      .filter((child) => child.type === 'reference');
    expect(refs.map((ref) => ref.targetId)).toEqual(expectedHitOrder.ok
      ? expectedHitOrder.hits.map((hit) => hit.nodeId)
      : []);
    expect(refs.find((ref) => ref.targetId === beta)?.id).toBe(betaRef);
    expect(state.nodes[refsByTarget[alpha]!]).toBeUndefined();
    const afterRefresh = JSON.stringify(state);
    core.refreshSearchNodeResults(searchId);
    expect(JSON.stringify(core.state())).toBe(afterRefresh);
  });

  test('saved search refresh keeps result references in hit order', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const exact = mustFocus(core.createNode(today, null, 'Beta'));
    const partial = mustFocus(core.createNode(today, null, 'Alpha Beta'));
    const searchId = mustFocus(core.createSearchNode(core.projection().searchesId, null, {
      title: 'Beta search',
      query: { kind: 'rule', op: 'STRING_MATCH', text: 'Beta' },
    }));

    let refs = core.state().nodes[searchId]!.children
      .map((childId) => core.state().nodes[childId]!)
      .filter((child) => child.type === 'reference');
    expect(refs.map((ref) => ref.targetId)).toEqual([exact, partial]);

    core.moveNode(refs[1]!.id, searchId, 1);
    core.refreshSearchNodeResults(searchId);
    refs = core.state().nodes[searchId]!.children
      .map((childId) => core.state().nodes[childId]!)
      .filter((child) => child.type === 'reference');
    expect(refs.map((ref) => ref.targetId)).toEqual([exact, partial]);
  });

  test('tag inheritance instantiates inherited fields and applies child supertags', () => {
    const core = Core.new();
    const parentTagId = mustFocus(core.createTag('project'));
    const childTagId = mustFocus(core.createTag('task'));
    const defaultChildTagId = mustFocus(core.createTag('step'));
    const templateEntryId = mustFocus(core.createFieldDef(parentTagId, 'Owner', 'plain'));
    const fieldId = core.state().nodes[templateEntryId].fieldDefId!;

    core.setTagConfig(childTagId, {
      extends: parentTagId,
      childSupertag: defaultChildTagId,
      showCheckbox: true,
      doneStateEnabled: true,
    });

    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'Launch'));
    core.applyTag(nodeId, childTagId);
    const inheritedFieldEntryId = core.state().nodes[nodeId].children.find((childId) => {
      const child = core.state().nodes[childId];
      return child?.type === 'fieldEntry' && child.fieldDefId === fieldId;
    });
    expect(inheritedFieldEntryId).toBeDefined();
    expect(core.state().nodes[inheritedFieldEntryId!].templateId).toBe(templateEntryId);

    const childNodeId = mustFocus(core.createNode(nodeId, null, 'Checklist item'));
    expect(core.state().nodes[childNodeId].tags).toContain(defaultChildTagId);
    expect(core.state().nodes[childTagId].showCheckbox).toBe(true);
    expect(core.state().nodes[childTagId].doneStateEnabled).toBe(true);
    expect(() => core.setTagConfig(parentTagId, { extends: childTagId }))
      .toThrow('tag inheritance cannot create a cycle');
  });

  test('replace node with reference creates backlinks and remains undoable', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParent = mustFocus(core.createNode(today, null, 'Targets'));
    const target = mustFocus(core.createNode(targetParent, null, 'Target'));
    const trigger = mustFocus(core.createNode(today, null, '@Target'));
    const inlineSource = mustFocus(core.createNode(today, null, 'Inline'));

    core.applyNodeTextPatch(inlineSource, replaceAllRichTextPatch({
      text: 'Inline ref',
      marks: [],
      inlineRefs: [{ offset: 6, targetNodeId: target, displayName: 'Target' }],
    }));
    const referenceId = mustFocus(core.replaceNodeWithReference(trigger, target));

    expect(core.state().nodes[referenceId].type).toBe('reference');
    expect(core.state().nodes[referenceId].targetId).toBe(target);
    expect(core.state().nodes[trigger].parentId).toBe(TRASH_ID);
    expect(core.state().nodes[today].children).toEqual([targetParent, referenceId, inlineSource]);
    expect(core.backlinks(target)).toEqual(expect.arrayContaining([
      { sourceId: today, referenceId, kind: 'tree' },
      { sourceId: inlineSource, referenceId: inlineSource, kind: 'inline' },
    ]));

    core.undo();
    expect(core.state().nodes[today].children).toEqual([targetParent, trigger, inlineSource]);
    expect(core.state().nodes[trigger].parentId).toBe(today);
    expect(core.state().nodes[referenceId]).toBeUndefined();
  });

  test('trashing a reference target keeps references restorable', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParent = mustFocus(core.createNode(today, null, 'Targets'));
    const target = mustFocus(core.createNode(targetParent, null, 'Target'));
    const referenceId = mustFocus(core.addReference(today, target, null));

    core.trashNode(target);

    expect(core.state().nodes[target].parentId).toBe(TRASH_ID);
    expect(core.state().nodes[referenceId].type).toBe('reference');
    expect(core.state().nodes[referenceId].targetId).toBe(target);
  });

  test('permanent delete removes tree references and inline references to the target', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParent = mustFocus(core.createNode(today, null, 'Targets'));
    const target = mustFocus(core.createNode(targetParent, null, 'Target'));
    const referenceId = mustFocus(core.addReference(today, target, null));
    const otherReferenceParent = mustFocus(core.createNode(today, null, 'Other references'));
    const referenceToReferenceId = mustFocus(core.addReference(otherReferenceParent, referenceId, null));
    const inlineSource = mustFocus(core.createNode(today, null, 'Inline source'));

    core.applyNodeTextPatch(inlineSource, replaceAllRichTextPatch({
      text: 'See target',
      marks: [{ start: 0, end: 3, type: 'bold' }],
      inlineRefs: [{ offset: 4, targetNodeId: target, displayName: 'Target' }],
    }));

    core.deleteNode(target);

    const state = core.state();
    expect(state.nodes[target]).toBeUndefined();
    expect(state.nodes[referenceId]).toBeUndefined();
    expect(state.nodes[referenceToReferenceId]).toBeUndefined();
    expect(state.nodes[today].children).not.toContain(referenceId);
    expect(state.nodes[today].children).not.toContain(referenceToReferenceId);
    expect(state.nodes[inlineSource].content).toEqual({
      text: 'See target',
      marks: [{ start: 0, end: 3, type: 'bold' }],
      inlineRefs: [],
    });

    core.undo();

    expect(core.state().nodes[target]).toBeDefined();
    expect(core.state().nodes[referenceId].targetId).toBe(target);
    expect(core.state().nodes[referenceToReferenceId].targetId).toBe(target);
    expect(core.state().nodes[inlineSource].content.inlineRefs).toEqual([
      { offset: 4, targetNodeId: target, displayName: 'Target' },
    ]);
  });

  test('reference nodes normalize targets and convert to unchanged inline atoms', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParent = mustFocus(core.createNode(today, null, 'Targets'));
    const nestedReferenceParent = mustFocus(core.createNode(today, null, 'Nested references'));
    const target = mustFocus(core.createNode(targetParent, null, 'Target'));
    const reference = mustFocus(core.addReference(today, target, null));
    const nestedReference = mustFocus(core.addReference(nestedReferenceParent, reference, null));

    expect(core.state().nodes[nestedReference].targetId).toBe(target);

    const inlineNode = mustFocus(core.convertReferenceToInlineNode(reference));
    let state = core.state();
    expect(state.nodes[reference]).toBeUndefined();
    expect(state.nodes[inlineNode].parentId).toBe(today);
    expect(state.nodes[inlineNode].content).toEqual({
      text: '',
      marks: [],
      inlineRefs: [{ offset: 0, targetNodeId: target, displayName: 'Target' }],
    });

    const restoredReference = mustFocus(core.restoreInlineReferenceNodeToReference(inlineNode, target));
    state = core.state();
    expect(state.nodes[inlineNode]).toBeUndefined();
    expect(state.nodes[restoredReference].type).toBe('reference');
    expect(state.nodes[restoredReference].targetId).toBe(target);
    expect(state.nodes[today].children).toEqual([targetParent, nestedReferenceParent, restoredReference]);
    expect(state.nodes[nestedReferenceParent].children).toEqual([nestedReference]);

    const emptyRestoreParent = mustFocus(core.createNode(today, null, 'Empty restore parent'));
    const secondReference = mustFocus(core.addReference(emptyRestoreParent, target, null));
    const secondInlineNode = mustFocus(core.convertReferenceToInlineNode(secondReference));
    core.applyNodeTextPatch(secondInlineNode, replaceAllRichTextPatch({ text: '', marks: [], inlineRefs: [] }));
    const restoredFromEmpty = mustFocus(core.restoreInlineReferenceNodeToReference(secondInlineNode, target));
    state = core.state();
    expect(state.nodes[secondInlineNode]).toBeUndefined();
    expect(state.nodes[restoredFromEmpty].parentId).toBe(emptyRestoreParent);
    expect(state.nodes[restoredFromEmpty].type).toBe('reference');
    expect(state.nodes[restoredFromEmpty].targetId).toBe(target);
  });

  test('creates reference conversion rows atomically for whole-row @ insertion', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParent = mustFocus(core.createNode(today, null, 'Targets'));
    const target = mustFocus(core.createNode(targetParent, null, 'Target'));
    const conversionParent = mustFocus(core.createNode(today, null, 'Conversions'));

    const added = mustFocus(core.addReferenceConversion(conversionParent, target, null));
    let state = core.state();
    expect(state.nodes[added].parentId).toBe(conversionParent);
    expect(state.nodes[added].type).toBeUndefined();
    expect(state.nodes[added].content).toEqual({
      text: '',
      marks: [],
      inlineRefs: [{ offset: 0, targetNodeId: target, displayName: 'Target' }],
    });

    const draft = mustFocus(core.createNode(conversionParent, null, '@Target'));
    const replaced = mustFocus(core.replaceNodeWithReferenceConversion(draft, target));
    state = core.state();
    expect(state.nodes[draft].parentId).toBe(TRASH_ID);
    expect(state.nodes[replaced].parentId).toBe(conversionParent);
    expect(state.nodes[replaced].type).toBeUndefined();
    expect(state.nodes[replaced].content).toEqual({
      text: '',
      marks: [],
      inlineRefs: [{ offset: 0, targetNodeId: target, displayName: 'Target' }],
    });
    expect(state.nodes[conversionParent].children).toEqual([added, replaced]);
  });

  test('blocks duplicate block instances of the same reference target in one parent', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const draft = mustFocus(core.createNode(today, null, '@Target'));

    expect(() => core.addReference(today, target, null)).toThrow('node already exists in this list');
    expect(() => core.replaceNodeWithReference(draft, target)).toThrow('node already exists in this list');
  });

  test('replaces a draft row with an inline reference conversion atomically', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const draft = mustFocus(core.createNode(today, null, ''));
    const outcome = core.replaceNodeWithInlineReference(draft, target);
    const inlineNode = mustFocus(outcome);
    const state = core.state();

    expect(outcome.focus).toMatchObject({
      nodeId: inlineNode,
      parentId: today,
      placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
    });
    expect(state.nodes[draft].parentId).toBe(TRASH_ID);
    expect(state.nodes[inlineNode].parentId).toBe(today);
    expect(state.nodes[inlineNode].content).toEqual({
      text: '',
      marks: [],
      inlineRefs: [{ offset: 0, targetNodeId: target, displayName: 'Target' }],
    });
    expect(state.nodes[target].content.text).toBe('Target');
  });

  test('blocks restoring a same-parent inline reference into a tree reference', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const draft = mustFocus(core.createNode(today, null, ''));
    const inlineNode = mustFocus(core.replaceNodeWithInlineReference(draft, target));

    expect(() => core.restoreInlineReferenceNodeToReference(inlineNode, target))
      .toThrow('node already exists in this list');
    expect(core.state().nodes[inlineNode].content.inlineRefs).toEqual([
      { offset: 0, targetNodeId: target, displayName: 'Target' },
    ]);
  });

  test('permanent delete of an option target clears selected field references', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const fieldEntryId = mustFocus(core.createInlineField(today, null, 'Status', 'options'));
    const fieldDefId = core.state().nodes[fieldEntryId].fieldDefId!;
    const optionId = mustFocus(core.registerCollectedOption(fieldDefId, 'Done'));
    core.selectFieldOption(fieldEntryId, optionId);
    const valueReferenceId = core.state().nodes[fieldEntryId].children[0];

    core.deleteNode(optionId);

    const state = core.state();
    expect(state.nodes[optionId]).toBeUndefined();
    expect(state.nodes[valueReferenceId]).toBeUndefined();
    expect(state.nodes[fieldEntryId].children).toEqual([]);
  });

  test('undo restores trash operations', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = mustFocus(core.createNode(today, null, 'First'));
    const second = mustFocus(core.createNode(today, null, 'Second'));

    core.batchTrashNodes([first, second]);
    expect(core.state().nodes[first].parentId).toBe(TRASH_ID);
    expect(core.state().nodes[second].parentId).toBe(TRASH_ID);

    core.undo();
    expect(core.state().nodes[first].parentId).toBe(today);
    expect(core.state().nodes[second].parentId).toBe(today);
  });

  test('agent undo only reverts agent-origin commits', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const userNode = mustFocus(core.createNode(today, null, 'User node'));
    const agentNode = mustFocus(core.withOrigin('agent', () => core.createNode(today, null, 'Agent node')));

    core.undoAgent();

    expect(core.state().nodes[userNode]).toBeDefined();
    expect(core.state().nodes[agentNode]).toBeUndefined();

    core.redoAgent();
    expect(core.state().nodes[userNode]).toBeDefined();
    expect(core.state().nodes[agentNode]).toBeDefined();
  });

  test('projection-created today node is not rolled into user undo history', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const nodeId = mustFocus(core.createNode(today, null, 'User node'));

    core.undo();

    expect(core.state().nodes[today]).toBeDefined();
    expect(core.state().nodes[nodeId]).toBeUndefined();
  });

  test('new operations clear stale origin-specific redo stacks', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const agentNode = mustFocus(core.withOrigin('agent', () => core.createNode(today, null, 'Agent node')));

    core.undoAgent();
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).canRedo).toBe(true);

    core.createNode(today, null, 'User node');

    expect(core.operationHistory({ action: 'list', origin: 'agent' }).canRedo).toBe(false);
    expect(core.operationHistory({ action: 'redo', origin: 'agent' }).count).toBe(0);
    expect(core.state().nodes[agentNode]).toBeUndefined();
  });

  test('operation history guards against the Loro stack top operation id', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const agentNode = mustFocus(core.withOrigin('agent', () => core.createNode(today, null, 'Agent node')));
    const history = core.operationHistory({ action: 'list', origin: 'agent' });
    const operationId = history.cursor?.topUndoOperationId;

    expect(operationId).toBe(history.items?.[0]?.operationId);
    expect(core.operationHistory({ action: 'undo', origin: 'agent', operationId: 'op:not-top' }).count).toBe(0);
    expect(core.state().nodes[agentNode]).toBeDefined();

    expect(core.operationHistory({ action: 'undo', origin: 'agent', operationId }).count).toBe(1);
    expect(core.state().nodes[agentNode]).toBeUndefined();
  });

  test('failed transactions roll back uncommitted Loro changes', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    await expect(core.transaction('agent', async () => {
      core.createNode(today, null, 'Partial agent node');
      throw new Error('abort transaction');
    }, { tool: 'node_create' })).rejects.toThrow('abort transaction');

    expect(Object.values(core.state().nodes).map((node) => node.content.text)).not.toContain('Partial agent node');
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toEqual([]);
    expect(core.operationHistory({ action: 'undo', origin: 'agent' }).count).toBe(0);
  });

  test('rich text marks and inline refs round-trip through the Loro text snapshot', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const nodeId = mustFocus(core.createNode(today, null, 'Rich'));
    const content = {
      text: 'HelloWorld',
      marks: [
        { start: 0, end: 5, type: 'bold' as const },
        { start: 5, end: 10, type: 'link' as const, attrs: { href: 'https://example.com' } },
      ],
      inlineRefs: [{ offset: 5, targetNodeId: target, displayName: 'Target' }],
    };

    core.applyNodeTextPatch(nodeId, replaceAllRichTextPatch(content));
    const restored = Core.fromState(Core.deserializeState(core.serializeState()));

    expect(restored.state().nodes[nodeId]!.content).toEqual(content);
  });

  test('splits a node into a focused sibling at the start of moved content', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const nodeId = mustFocus(core.createNode(today, null, 'HelloWorld'));

    const outcome = core.splitNode(
      nodeId,
      { text: 'Hello', marks: [], inlineRefs: [] },
      { text: 'World', marks: [], inlineRefs: [] },
    );
    const newId = mustFocus(outcome);

    expect(core.state().nodes[nodeId]!.content.text).toBe('Hello');
    expect(core.state().nodes[newId]!.content.text).toBe('World');
    expect(core.state().nodes[newId]!.parentId).toBe(today);
    expect(outcome.focus).toMatchObject({
      nodeId: newId,
      parentId: today,
      placement: { kind: 'start' },
    });
  });

  test('can split an expanded parent into its first child', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const parentId = mustFocus(core.createNode(today, null, 'ParentTail'));
    const existingChildId = mustFocus(core.createNode(parentId, null, 'Existing child'));

    const outcome = core.splitNode(
      parentId,
      { text: 'Parent', marks: [], inlineRefs: [] },
      { text: 'Tail', marks: [], inlineRefs: [] },
      { targetParentId: parentId, targetIndex: 0, focusPlacement: { kind: 'start' } },
    );
    const newChildId = mustFocus(outcome);

    expect(core.state().nodes[parentId]!.content.text).toBe('Parent');
    expect(core.state().nodes[parentId]!.children).toEqual([newChildId, existingChildId]);
    expect(core.state().nodes[newChildId]!.content.text).toBe('Tail');
    expect(outcome.focus).toMatchObject({
      nodeId: newChildId,
      parentId,
      placement: { kind: 'start' },
    });
  });

  test('applies node text patches directly to Loro text', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const nodeId = mustFocus(core.createNode(today, null, 'Hello'));

    const outcome = core.applyNodeTextPatch(nodeId, {
      ops: [{
        type: 'replace',
        from: 5,
        to: 5,
        content: {
          text: ' world',
          marks: [{ start: 1, end: 6, type: 'bold' }],
          inlineRefs: [{ offset: 6, targetNodeId: target, displayName: 'Target' }],
        },
      }],
    });
    expect(outcome.focus).toMatchObject({
      nodeId,
      placement: { kind: 'preserve' },
    });
    core.applyNodeTextPatch(nodeId, {
      ops: [{ type: 'add_mark', from: 0, to: 5, markType: 'italic' }],
    });

    expect(core.state().nodes[nodeId]!.content).toEqual({
      text: 'Hello world',
      marks: [
        { start: 0, end: 5, type: 'italic' },
        { start: 6, end: 11, type: 'bold' },
      ],
      inlineRefs: [{ offset: 11, targetNodeId: target, displayName: 'Target' }],
    });

    core.applyNodeTextPatch(nodeId, {
      ops: [{ type: 'replace', from: 11, to: 11, content: { text: '', marks: [], inlineRefs: [] }, deletedInlineRefs: [{ offset: 11, targetNodeId: target, displayName: 'Target' }] }],
    });
    expect(core.state().nodes[nodeId]!.content.inlineRefs).toEqual([]);

    core.applyNodeTextPatch(nodeId, replaceAllRichTextPatch({
      text: '!',
      marks: [],
      inlineRefs: [{ offset: 0, targetNodeId: target, displayName: 'Target' }],
    }));
    core.applyNodeTextPatch(nodeId, {
      ops: [{ type: 'replace', from: 0, to: 1, content: plainText('') }],
    });
    expect(core.state().nodes[nodeId]!.content).toEqual({
      text: '',
      marks: [],
      inlineRefs: [{ offset: 0, targetNodeId: target, displayName: 'Target' }],
    });
  });

  test('groups continuous text patches into one Loro undo item and one journal entry', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, ''));

    core.beginUndoGroup();
    core.withOrigin('user', () => core.applyNodeTextPatch(nodeId, {
      ops: [{ type: 'replace', from: 0, to: 0, content: plainText('A') }],
    }), { operationId: 'op:text-session', summary: 'Edited node text.' });
    core.withOrigin('user', () => core.applyNodeTextPatch(nodeId, {
      ops: [{ type: 'replace', from: 1, to: 1, content: plainText('B') }],
    }), { operationId: 'op:text-session', summary: 'Edited node text.' });
    core.endUndoGroup();

    const history = core.operationHistory({ action: 'list', origin: 'user' });
    expect(history.items?.filter((item) => item.operationId === 'op:text-session')).toHaveLength(1);
    expect(core.state().nodes[nodeId]!.content.text).toBe('AB');

    core.undoUser();
    expect(core.state().nodes[nodeId]!.content.text).toBe('');
  });

  test('converts a plain node into a code block and edits its text', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'const x = 1'));

    core.setCodeBlock(nodeId, 'TypeScript');
    expect(core.state().nodes[nodeId]).toMatchObject({
      type: 'codeBlock',
      codeLanguage: 'typescript',
      content: { text: 'const x = 1' },
    });

    core.applyNodeTextPatch(nodeId, replaceAllRichTextPatch(plainText('const x = 1\nconst y = 2')));
    expect(core.state().nodes[nodeId]!.content.text).toBe('const x = 1\nconst y = 2');
    expect(core.state().nodes[nodeId]!.type).toBe('codeBlock');
  });

  test('changes and clears a code block language', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'code'));
    core.setCodeBlock(nodeId);
    expect(core.state().nodes[nodeId]!.codeLanguage).toBeUndefined();

    core.setCodeLanguage(nodeId, 'Python');
    expect(core.state().nodes[nodeId]!.codeLanguage).toBe('python');

    core.setCodeLanguage(nodeId, '');
    expect(core.state().nodes[nodeId]!.codeLanguage).toBeUndefined();
  });

  test('rejects invalid code block conversions', () => {
    const core = Core.new();
    const plainId = mustFocus(core.createNode(core.projection().todayId, null, 'plain'));
    expect(() => core.setCodeLanguage(plainId, 'ts')).toThrow();

    const tagId = mustFocus(core.createTag('topic'));
    expect(() => core.setCodeBlock(tagId)).toThrow();
  });

  test('state serializes and restores the Loro-backed projection', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'Plain'));
    core.updateNodeDescription(nodeId, 'Persisted description');
    const raw = core.serializeState();
    const restored = Core.fromState(Core.deserializeState(raw));
    const projected = restored.projection().nodes.find((node) => node.id === nodeId)!;

    expect(projected.id).toBe(nodeId);
    expect(projected.content.text).toBe('Plain');
    expect(projected.description).toBe('Persisted description');
    expect(restored.state().nodes[SCHEMA_ID]).toBeDefined();
  });
});
