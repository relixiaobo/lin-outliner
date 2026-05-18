import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import {
  SCHEMA_ID,
  TAG_DAY_ID,
  TRASH_ID,
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
  test('creates and moves nodes', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = mustFocus(core.createNode(today, null, 'First'));
    const second = mustFocus(core.createNode(today, null, 'Second'));

    core.indentNode(second);

    expect(core.state().nodes[second].parentId).toBe(first);
    expect(core.state().nodes[first].children).toContain(second);
  });

  test('updates node metadata and clears empty view settings', () => {
    const core = Core.new();
    const nodeId = mustFocus(core.createNode(core.projection().todayId, null, 'Node'));

    core.updateNodeDescription(nodeId, '  Description  ');
    core.setNodeToolbarVisible(nodeId, true);
    core.setNodeSort(nodeId, '__name', 'desc');
    core.setNodeFilter(nodeId, '__name', 'any', [' alpha ', 'Alpha', '']);
    core.setNodeGroup(nodeId, '__name');

    let node = core.state().nodes[nodeId];
    expect(node.description).toBe('Description');
    expect(node.toolbarVisible).toBe(true);
    expect(node.sortField).toBe('__name');
    expect(node.sortDirection).toBe('desc');
    expect(node.filterField).toBe('__name');
    expect(node.filterOp).toBe('any');
    expect(node.filterValues).toEqual(['alpha']);
    expect(node.groupField).toBe('__name');

    core.updateNodeDescription(nodeId, '');
    core.setNodeSort(nodeId, null, 'desc');
    core.setNodeFilter(nodeId, null, 'any', ['x']);
    core.setNodeGroup(nodeId, ' ');

    node = core.state().nodes[nodeId];
    expect(node.description).toBeUndefined();
    expect(node.sortField).toBeUndefined();
    expect(node.sortDirection).toBeUndefined();
    expect(node.filterField).toBeUndefined();
    expect(node.filterOp).toBeUndefined();
    expect(node.filterValues).toEqual([]);
    expect(node.groupField).toBeUndefined();
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
  });

  test('field config validates constraints and clears type-specific settings', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('project'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Estimate', 'plain'));
    const fieldId = core.state().nodes[templateEntryId].fieldDefId!;

    core.setFieldConfig(fieldId, {
      fieldType: 'number',
      nullable: false,
      hideField: 'empty',
      minValue: 1,
      maxValue: 5,
    });
    expect(core.state().nodes[fieldId].fieldType).toBe('number');
    expect(core.state().nodes[fieldId].nullable).toBe(false);
    expect(core.state().nodes[fieldId].hideField).toBe('empty');
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
    expect(core.state().nodes[searchId].children.length).toBe(1);
    expect(core.state().nodes[core.state().nodes[searchId].children[0]].targetId).toBe(nodeId);

    const childId = mustFocus(core.createNode(nodeId, null, 'Child'));
    expect(() => core.addReference(childId, nodeId, null)).toThrow('cannot create a reference cycle');
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
    const target = mustFocus(core.createNode(today, null, 'Target'));
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
    expect(core.state().nodes[today].children).toEqual([target, referenceId, inlineSource]);
    expect(core.backlinks(target)).toEqual(expect.arrayContaining([
      { sourceId: today, referenceId, kind: 'tree' },
      { sourceId: inlineSource, referenceId: inlineSource, kind: 'inline' },
    ]));

    core.undo();
    expect(core.state().nodes[today].children).toEqual([target, trigger, inlineSource]);
    expect(core.state().nodes[trigger].parentId).toBe(today);
    expect(core.state().nodes[referenceId]).toBeUndefined();
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
