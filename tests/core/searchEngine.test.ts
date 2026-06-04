import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import {
  buildTextSearchIndex,
  runSearchExpr,
  runSearchNode,
  SEARCH_EXECUTABLE_QUERY_OPS,
  SEARCH_UNSUPPORTED_QUERY_OPS,
  searchNodeToQueryExpr,
} from '../../src/core/searchEngine';
import type { TextSearchIndex } from '../../src/core/textSearchIndex';
import { QUERY_OPS, type EmbedNode, type ImageNode, type QueryOp } from '../../src/core/types';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function isoLocalDate(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addLocalDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addFieldValue(core: Core, nodeId: string, fieldDefId: string, value: string) {
  const fieldEntryId = core.state().nodes[nodeId]!.children
    .find((childId) => core.state().nodes[childId]!.fieldDefId === fieldDefId);
  expect(fieldEntryId).toBeDefined();
  return mustFocus(core.createNode(fieldEntryId!, null, value));
}

function ensureDateNodeFor(core: Core, date: Date) {
  return mustFocus(core.ensureDateNode(date.getFullYear(), date.getMonth() + 1, date.getDate()));
}

describe('core search engine', () => {
  test('classifies every query operator as executable or explicitly unsupported', () => {
    const classified = [
      ...SEARCH_EXECUTABLE_QUERY_OPS,
      ...SEARCH_UNSUPPORTED_QUERY_OPS,
    ];
    const duplicateOps = classified.filter((op, index) => classified.indexOf(op) !== index);
    const allOps = [...QUERY_OPS].sort();
    const classifiedOps = [...classified].sort();
    const executable = new Set<QueryOp>(SEARCH_EXECUTABLE_QUERY_OPS);

    expect(duplicateOps).toEqual([]);
    expect(classifiedOps).toEqual(allOps);
    expect(executable.has('STRING_MATCH')).toBe(true);
    expect(executable.has('HAS_TAG')).toBe(true);
    expect(executable.has('LINKS_TO')).toBe(true);
    expect(executable.has('FIELD_CONTAINS')).toBe(true);
  });

  test('executes canonical query expressions', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('project'));
    const tagged = mustFocus(core.createNode(today, null, 'Launch plan'));
    const other = mustFocus(core.createNode(today, null, 'Launch notes'));
    core.applyTag(tagged, tagId);

    const result = runSearchExpr(core.state(), {
      kind: 'group',
      logic: 'AND',
      children: [
        { kind: 'rule', op: 'STRING_MATCH', text: 'Launch' },
        { kind: 'rule', op: 'HAS_TAG', tagDefId: tagId },
      ],
    });

    const hits = result.ok ? result.hits.map((hit) => hit.nodeId) : [];
    expect(hits).toEqual([tagged]);
    expect(hits).not.toContain(other);

    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Any tagged'));
    const conditionId = mustFocus(core.createNode(searchId, null, 'Has tag'));
    const state = core.state();
    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'HAS_TAG';

    const anyTagged = runSearchNode(state, searchId);
    expect(anyTagged.ok ? anyTagged.hits.map((hit) => hit.nodeId) : []).toContain(tagged);
    expect(anyTagged.ok ? anyTagged.hits.map((hit) => hit.nodeId) : []).not.toContain(other);
  });

  test('sorts saved search hits by explicit timestamp sort settings', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const older = mustFocus(core.createNode(today, null, 'match older'));
    const newer = mustFocus(core.createNode(today, null, 'match newer'));
    const searchId = mustFocus(core.createSearchNode(core.projection().searchesId, null, {
      title: 'Recently edited',
      query: { kind: 'rule', op: 'STRING_MATCH', text: 'match' },
    }));
    core.addSortRule(searchId, 'sys:updatedAt', 'desc');
    const state = core.state();
    state.nodes[older]!.updatedAt = 1;
    state.nodes[newer]!.updatedAt = 2;

    const descending = runSearchNode(state, searchId);
    expect(descending.ok ? descending.hits.map((hit) => hit.nodeId) : []).toEqual([newer, older]);

    const viewDef = state.nodes[searchId]!.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'viewDef')!;
    const sortRule = viewDef.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'sortRule')!;
    sortRule.sortDirection = 'asc';
    const ascending = runSearchNode(state, searchId);
    expect(ascending.ok ? ascending.hits.map((hit) => hit.nodeId) : []).toEqual([older, newer]);

    const indexedAscending = runSearchNode(state, searchId, { textIndex: buildTextSearchIndex(state) });
    expect(indexedAscending.ok ? indexedAscending.hits.map((hit) => hit.nodeId) : []).toEqual([older, newer]);
  });

  test('uses text index relevance for loose multi-term string matches', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const exact = mustFocus(core.createNode(today, null, 'Launch design'));
    const loose = mustFocus(core.createNode(today, null, 'Design review'));
    core.updateNodeDescription(loose, 'Launch notes');
    const partial = mustFocus(core.createNode(today, null, 'Launch only'));
    const textIndex = buildTextSearchIndex(core.state());

    const result = runSearchExpr(core.state(), {
      kind: 'rule',
      op: 'STRING_MATCH',
      text: 'launch design',
    }, { textIndex });

    expect(result.ok).toBe(true);
    const hits = result.ok ? result.hits.map((hit) => hit.nodeId) : [];
    expect(hits.slice(0, 2)).toEqual([exact, loose]);
    expect(hits).not.toContain(partial);
  });

  test('does not turn indexed string match into partial-term OR matching', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    mustFocus(core.createNode(today, null, 'Alpha project'));
    mustFocus(core.createNode(today, null, 'Beta launch'));
    mustFocus(core.createNode(today, null, 'Alpha beta'));
    const textIndex = buildTextSearchIndex(core.state());

    const legacy = runSearchExpr(core.state(), {
      kind: 'rule',
      op: 'STRING_MATCH',
      text: 'alpha gamma',
    });
    const indexed = runSearchExpr(core.state(), {
      kind: 'rule',
      op: 'STRING_MATCH',
      text: 'alpha gamma',
    }, { textIndex });

    expect(legacy.ok ? legacy.hits : []).toEqual([]);
    expect(indexed.ok ? indexed.hits : []).toEqual([]);
  });

  test('does not use legacy fallback for short non-prefix substring matches', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const launch = mustFocus(core.createNode(today, null, 'Launch plan'));
    const textIndex = buildTextSearchIndex(core.state());

    const result = runSearchExpr(core.state(), {
      kind: 'rule',
      op: 'STRING_MATCH',
      text: 'au',
    }, { textIndex });

    expect(result.ok ? result.hits.map((hit) => hit.nodeId) : []).not.toContain(launch);
  });

  test('does not fall back to legacy scoring when an indexed candidate is rejected', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const launch = mustFocus(core.createNode(today, null, 'Launch plan'));
    const rejectingTextIndex: TextSearchIndex = {
      size: 1,
      hasRecord: (id) => id === launch,
      candidateIds: () => new Set([launch]),
      search: () => [],
      scoreRecord: () => null,
      scoreAnalyzedRecord: () => null,
    };

    const result = runSearchExpr(core.state(), {
      kind: 'rule',
      op: 'STRING_MATCH',
      text: 'Launch',
    }, { textIndex: rejectingTextIndex });

    expect(result.ok ? result.hits : []).toEqual([]);
  });

  test('keeps OR semantics when only one branch can use text candidates', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const alpha = mustFocus(core.createNode(today, null, 'Alpha note'));
    const tagged = mustFocus(core.createNode(today, null, 'Tagged beta'));
    const tagId = mustFocus(core.createTag('project'));
    core.applyTag(tagged, tagId);
    const textIndex = buildTextSearchIndex(core.state());

    const result = runSearchExpr(core.state(), {
      kind: 'group',
      logic: 'OR',
      children: [
        { kind: 'rule', op: 'STRING_MATCH', text: 'Alpha' },
        { kind: 'rule', op: 'HAS_TAG', tagDefId: tagId },
      ],
    }, { textIndex });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([alpha, tagged]));
  });

  test('converts nested saved search conditions to QueryExpr', () => {
    const core = Core.new();
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Search'));
    const groupId = mustFocus(core.createNode(searchId, null, 'All'));
    const textConditionId = mustFocus(core.createNode(groupId, null, 'Launch'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[groupId]!.type = 'queryCondition';
    state.nodes[groupId]!.queryLogic = 'AND';
    state.nodes[textConditionId]!.type = 'queryCondition';
    state.nodes[textConditionId]!.queryOp = 'STRING_MATCH';

    const resolved = searchNodeToQueryExpr(state, searchId);

    expect(resolved).toEqual({
      ok: true,
      query: {
        kind: 'group',
        logic: 'AND',
        children: [{ kind: 'rule', op: 'STRING_MATCH', text: 'Launch' }],
      },
    });
  });

  test('converts full saved search logic without a simple compatibility layer', () => {
    const core = Core.new();
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Search'));
    const groupId = mustFocus(core.createNode(searchId, null, 'Any'));
    const doneId = mustFocus(core.createNode(groupId, null, 'Done'));
    const todoId = mustFocus(core.createNode(groupId, null, 'Todo'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[groupId]!.type = 'queryCondition';
    state.nodes[groupId]!.queryLogic = 'OR';
    state.nodes[doneId]!.type = 'queryCondition';
    state.nodes[doneId]!.queryOp = 'DONE';
    state.nodes[todoId]!.type = 'queryCondition';
    state.nodes[todoId]!.queryOp = 'TODO';

    const resolved = searchNodeToQueryExpr(state, searchId);
    expect(resolved).toEqual({
      ok: true,
      query: {
        kind: 'group',
        logic: 'OR',
        children: [
          { kind: 'rule', op: 'DONE' },
          { kind: 'rule', op: 'TODO' },
        ],
      },
    });
  });

  test('executes saved search AND OR and NOT groups', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const alpha = mustFocus(core.createNode(today, null, 'Alpha note'));
    const beta = mustFocus(core.createNode(today, null, 'Beta note'));
    const gamma = mustFocus(core.createNode(today, null, 'Gamma note'));
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Complex search'));
    const andGroupId = mustFocus(core.createNode(searchId, null, 'All'));
    const orGroupId = mustFocus(core.createNode(andGroupId, null, 'Any text'));
    const alphaConditionId = mustFocus(core.createNode(orGroupId, null, 'Alpha'));
    const betaConditionId = mustFocus(core.createNode(orGroupId, null, 'Beta'));
    const notGroupId = mustFocus(core.createNode(andGroupId, null, 'Not gamma'));
    const gammaConditionId = mustFocus(core.createNode(notGroupId, null, 'Gamma'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[andGroupId]!.type = 'queryCondition';
    state.nodes[andGroupId]!.queryLogic = 'AND';
    state.nodes[orGroupId]!.type = 'queryCondition';
    state.nodes[orGroupId]!.queryLogic = 'OR';
    state.nodes[alphaConditionId]!.type = 'queryCondition';
    state.nodes[alphaConditionId]!.queryOp = 'STRING_MATCH';
    state.nodes[betaConditionId]!.type = 'queryCondition';
    state.nodes[betaConditionId]!.queryOp = 'STRING_MATCH';
    state.nodes[notGroupId]!.type = 'queryCondition';
    state.nodes[notGroupId]!.queryLogic = 'NOT';
    state.nodes[gammaConditionId]!.type = 'queryCondition';
    state.nodes[gammaConditionId]!.queryOp = 'STRING_MATCH';

    const result = runSearchNode(state, searchId);

    expect(result.ok).toBe(true);
    const resultIds = result.ok ? result.hits.map((hit) => hit.nodeId) : [];
    expect(resultIds).toHaveLength(2);
    expect(resultIds).toEqual(expect.arrayContaining([alpha, beta]));
    expect(resultIds).not.toContain(gamma);
  });

  test('executes checkbox query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const todo = mustFocus(core.createNode(today, null, 'Todo task'));
    const done = mustFocus(core.createNode(today, null, 'Done task'));
    const plain = mustFocus(core.createNode(today, null, 'Plain note'));
    core.setNodeCheckboxVisible(todo, true);
    core.toggleDone(done);
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Done search'));
    const doneConditionId = mustFocus(core.createNode(searchId, null, 'Done'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[doneConditionId]!.type = 'queryCondition';
    state.nodes[doneConditionId]!.queryOp = 'DONE';

    const doneResult = runSearchNode(state, searchId);
    expect(doneResult.ok ? doneResult.hits.map((hit) => hit.nodeId) : []).toEqual([done]);

    state.nodes[doneConditionId]!.queryOp = 'NOT_DONE';
    const notDoneResult = runSearchNode(state, searchId);
    expect(notDoneResult.ok ? notDoneResult.hits.map((hit) => hit.nodeId) : []).toEqual([todo]);
    expect(notDoneResult.ok ? notDoneResult.hits.map((hit) => hit.nodeId) : []).not.toContain(plain);

    state.nodes[doneConditionId]!.queryOp = 'TODO';
    const todoResult = runSearchNode(state, searchId);
    expect(todoResult.ok ? todoResult.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([todo, done]));
  });

  test('executes field equality and emptiness query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const taskTagId = mustFocus(core.createTag('task'));
    const templateEntryId = mustFocus(core.createFieldDef(taskTagId, 'Status', 'plain'));
    const statusFieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;
    const active = mustFocus(core.createNode(today, null, 'Active task'));
    const waiting = mustFocus(core.createNode(today, null, 'Waiting task'));
    const empty = mustFocus(core.createNode(today, null, 'Empty task'));
    const noStatus = mustFocus(core.createNode(today, null, 'No status task'));
    core.applyTag(active, taskTagId);
    core.applyTag(waiting, taskTagId);
    core.applyTag(empty, taskTagId);
    const activeFieldId = core.state().nodes[active]!.children.find((childId) => core.state().nodes[childId]!.fieldDefId === statusFieldDefId)!;
    const waitingFieldId = core.state().nodes[waiting]!.children.find((childId) => core.state().nodes[childId]!.fieldDefId === statusFieldDefId)!;
    core.createNode(activeFieldId, null, 'Active');
    core.createNode(waitingFieldId, null, 'Waiting');

    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Field search'));
    const conditionId = mustFocus(core.createNode(searchId, null, 'Active'));
    const valueId = mustFocus(core.createNode(conditionId, null, 'Active'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'FIELD_IS';
    state.nodes[conditionId]!.queryFieldDefId = statusFieldDefId;
    expect(state.nodes[valueId]!.content.text).toBe('Active');

    const fieldIs = runSearchNode(state, searchId);
    expect(fieldIs.ok ? fieldIs.hits.map((hit) => hit.nodeId) : []).toEqual([active]);

    state.nodes[conditionId]!.queryOp = 'FIELD_IS_NOT';
    const fieldIsNot = runSearchNode(state, searchId);
    expect(fieldIsNot.ok ? fieldIsNot.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([waiting, empty]));
    expect(fieldIsNot.ok ? fieldIsNot.hits.map((hit) => hit.nodeId) : []).not.toContain(active);

    state.nodes[conditionId]!.queryOp = 'IS_EMPTY';
    const isEmpty = runSearchNode(state, searchId);
    expect(isEmpty.ok ? isEmpty.hits.map((hit) => hit.nodeId) : []).toEqual([empty]);

    state.nodes[conditionId]!.queryOp = 'IS_NOT_EMPTY';
    const isNotEmpty = runSearchNode(state, searchId);
    expect(isNotEmpty.ok ? isNotEmpty.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([active, waiting]));
    expect(isNotEmpty.ok ? isNotEmpty.hits.map((hit) => hit.nodeId) : []).not.toContain(empty);

    state.nodes[conditionId]!.queryOp = 'FIELD_IS_SET';
    const isSet = runSearchNode(state, searchId);
    expect(isSet.ok ? isSet.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([active, waiting]));
    expect(isSet.ok ? isSet.hits.map((hit) => hit.nodeId) : []).not.toContain(empty);

    state.nodes[conditionId]!.queryOp = 'FIELD_IS_NOT_SET';
    const isNotSet = runSearchNode(state, searchId);
    expect(isNotSet.ok ? isNotSet.hits.map((hit) => hit.nodeId) : []).toContain(empty);
    expect(isNotSet.ok ? isNotSet.hits.map((hit) => hit.nodeId) : []).toContain(noStatus);
    expect(isNotSet.ok ? isNotSet.hits.map((hit) => hit.nodeId) : []).not.toContain(active);

    state.nodes[conditionId]!.queryOp = 'FIELD_IS_DEFINED';
    const isDefined = runSearchNode(state, searchId);
    expect(isDefined.ok ? isDefined.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([active, waiting, empty]));
    expect(isDefined.ok ? isDefined.hits.map((hit) => hit.nodeId) : []).not.toContain(noStatus);

    state.nodes[conditionId]!.queryOp = 'FIELD_IS_NOT_DEFINED';
    const isNotDefined = runSearchNode(state, searchId);
    expect(isNotDefined.ok ? isNotDefined.hits.map((hit) => hit.nodeId) : []).toContain(noStatus);
    expect(isNotDefined.ok ? isNotDefined.hits.map((hit) => hit.nodeId) : []).not.toContain(active);
  });

  test('executes field presence and scalar comparison query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const taskTagId = mustFocus(core.createTag('task'));
    const templateEntryId = mustFocus(core.createFieldDef(taskTagId, 'Estimate', 'number'));
    const estimateFieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;
    const small = mustFocus(core.createNode(today, null, 'Small task'));
    const large = mustFocus(core.createNode(today, null, 'Large task'));
    const empty = mustFocus(core.createNode(today, null, 'Unestimated task'));
    core.applyTag(small, taskTagId);
    core.applyTag(large, taskTagId);
    core.applyTag(empty, taskTagId);
    const smallFieldId = core.state().nodes[small]!.children.find((childId) => core.state().nodes[childId]!.fieldDefId === estimateFieldDefId)!;
    const largeFieldId = core.state().nodes[large]!.children.find((childId) => core.state().nodes[childId]!.fieldDefId === estimateFieldDefId)!;
    core.createNode(smallFieldId, null, '3');
    core.createNode(largeFieldId, null, '8');

    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Estimate search'));
    const conditionId = mustFocus(core.createNode(searchId, null, '5'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'GT';
    state.nodes[conditionId]!.queryFieldDefId = estimateFieldDefId;

    const greaterThan = runSearchNode(state, searchId);
    expect(greaterThan.ok ? greaterThan.hits.map((hit) => hit.nodeId) : []).toEqual([large]);

    state.nodes[conditionId]!.queryOp = 'LT';
    const lessThan = runSearchNode(state, searchId);
    expect(lessThan.ok ? lessThan.hits.map((hit) => hit.nodeId) : []).toEqual([small]);

    state.nodes[conditionId]!.queryOp = 'HAS_FIELD';
    const hasField = runSearchNode(state, searchId);
    expect(hasField.ok ? hasField.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([small, large, empty]));
  });

  test('executes scope type and regexp query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('topic'));
    const parent = mustFocus(core.createNode(today, null, 'Project'));
    const alpha = mustFocus(core.createNode(parent, null, 'Alpha child'));
    const beta = mustFocus(core.createNode(parent, null, 'Beta child'));
    const grandchild = mustFocus(core.createNode(alpha, null, 'Alpha grandchild'));
    const outside = mustFocus(core.createNode(today, null, 'Outside alpha'));
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Scope search'));
    const conditionId = mustFocus(core.createNode(searchId, null, 'Alpha.*child'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'REGEXP_MATCH';

    const regexp = runSearchNode(state, searchId);
    expect(regexp.ok ? regexp.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([alpha, grandchild]));
    expect(regexp.ok ? regexp.hits.map((hit) => hit.nodeId) : []).not.toContain(outside);

    state.nodes[conditionId]!.queryOp = 'CHILD_OF';
    state.nodes[conditionId]!.queryTargetId = parent;
    const childOf = runSearchNode(state, searchId);
    expect(childOf.ok ? childOf.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([alpha, beta]));
    expect(childOf.ok ? childOf.hits.map((hit) => hit.nodeId) : []).not.toContain(grandchild);

    delete state.nodes[conditionId]!.queryTargetId;
    state.nodes[conditionId]!.queryOp = 'IS_TYPE';
    state.nodes[conditionId]!.content.text = 'tagDef';
    const typeSearch = runSearchNode(state, searchId);
    expect(typeSearch.ok ? typeSearch.hits.map((hit) => hit.nodeId) : []).toContain(tagId);
  });

  test('executes context scope and ownership query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const area = mustFocus(core.createNode(today, null, 'Area'));
    const parent = mustFocus(core.createNode(today, null, 'Project'));
    const nestedProject = mustFocus(core.createNode(area, null, 'Nested project'));
    const nestedTask = mustFocus(core.createNode(nestedProject, null, 'Nested task'));
    const owned = mustFocus(core.createNode(parent, null, 'Owned child'));
    const grandchild = mustFocus(core.createNode(owned, null, 'Owned grandchild'));
    const referenced = mustFocus(core.createNode(today, null, 'Referenced elsewhere'));
    const meetingNotes = mustFocus(core.createNode(parent, null, 'Meeting notes'));
    const meetingItem = mustFocus(core.createNode(meetingNotes, null, 'Agenda item'));
    const outside = mustFocus(core.createNode(today, null, 'Outside'));
    core.addReference(parent, referenced, null);
    const scopedSearchId = mustFocus(core.createNode(parent, null, 'Scoped search'));
    const scopedConditionId = mustFocus(core.createNode(scopedSearchId, null, 'Scope'));
    const grandparentSearchId = mustFocus(core.createNode(nestedProject, null, 'Grandparent scope'));
    const grandparentConditionId = mustFocus(core.createNode(grandparentSearchId, null, 'Scope'));
    const state = core.state();

    state.nodes[scopedSearchId]!.type = 'search';
    state.nodes[scopedConditionId]!.type = 'queryCondition';
    state.nodes[scopedConditionId]!.queryOp = 'PARENTS_DESCENDANTS';

    const descendants = runSearchNode(state, scopedSearchId);
    expect(descendants.ok ? descendants.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([owned, grandchild]));
    expect(descendants.ok ? descendants.hits.map((hit) => hit.nodeId) : []).not.toContain(parent);
    expect(descendants.ok ? descendants.hits.map((hit) => hit.nodeId) : []).not.toContain(referenced);
    expect(descendants.ok ? descendants.hits.map((hit) => hit.nodeId) : []).not.toContain(outside);

    state.nodes[scopedConditionId]!.queryOp = 'PARENTS_DESCENDANTS_WITH_REFS';
    const descendantsWithRefs = runSearchNode(state, scopedSearchId);
    expect(descendantsWithRefs.ok ? descendantsWithRefs.hits.map((hit) => hit.nodeId) : []).toContain(referenced);
    expect(descendantsWithRefs.ok ? descendantsWithRefs.hits.map((hit) => hit.nodeId) : []).not.toContain(outside);

    state.nodes[scopedConditionId]!.queryOp = 'SIBLING_NAMED';
    state.nodes[scopedConditionId]!.content.text = 'Meeting notes';
    const siblingNamed = runSearchNode(state, scopedSearchId);
    expect(siblingNamed.ok ? siblingNamed.hits.map((hit) => hit.nodeId) : []).toContain(meetingItem);
    expect(siblingNamed.ok ? siblingNamed.hits.map((hit) => hit.nodeId) : []).not.toContain(owned);

    state.nodes[grandparentSearchId]!.type = 'search';
    state.nodes[grandparentConditionId]!.type = 'queryCondition';
    state.nodes[grandparentConditionId]!.queryOp = 'GRANDPARENTS_DESCENDANTS';
    const grandparentDescendants = runSearchNode(state, grandparentSearchId);
    expect(grandparentDescendants.ok ? grandparentDescendants.hits.map((hit) => hit.nodeId) : []).toContain(nestedTask);
    expect(grandparentDescendants.ok ? grandparentDescendants.hits.map((hit) => hit.nodeId) : []).not.toContain(parent);

    const relationSearchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Relation search'));
    const relationConditionId = mustFocus(core.createNode(relationSearchId, null, 'Relation'));
    const relationState = core.state();
    relationState.nodes[relationSearchId]!.type = 'search';
    relationState.nodes[relationConditionId]!.type = 'queryCondition';
    relationState.nodes[relationConditionId]!.queryOp = 'CHILD_OF';
    relationState.nodes[relationConditionId]!.queryTargetId = parent;

    const childOf = runSearchNode(relationState, relationSearchId);
    expect(childOf.ok ? childOf.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([owned, referenced]));
    expect(childOf.ok ? childOf.hits.map((hit) => hit.nodeId) : []).not.toContain(grandchild);

    relationState.nodes[relationConditionId]!.queryOp = 'OWNED_BY';
    const ownedBy = runSearchNode(relationState, relationSearchId);
    expect(ownedBy.ok ? ownedBy.hits.map((hit) => hit.nodeId) : []).toContain(owned);
    expect(ownedBy.ok ? ownedBy.hits.map((hit) => hit.nodeId) : []).not.toContain(referenced);

    relationState.nodes[relationConditionId]!.queryOp = 'DESCENDANT_OF';
    const descendantOf = runSearchNode(relationState, relationSearchId);
    expect(descendantOf.ok ? descendantOf.hits.map((hit) => hit.nodeId) : []).toContain(grandchild);
    expect(descendantOf.ok ? descendantOf.hits.map((hit) => hit.nodeId) : []).not.toContain(referenced);

    relationState.nodes[relationConditionId]!.queryOp = 'DESCENDANT_OF_WITH_REFS';
    const descendantOfWithRefs = runSearchNode(relationState, relationSearchId);
    expect(descendantOfWithRefs.ok ? descendantOfWithRefs.hits.map((hit) => hit.nodeId) : []).toContain(referenced);
  });

  test('executes library and day-node scope query rules', () => {
    const core = Core.new();
    const projection = core.projection();
    const libraryNode = mustFocus(core.createNode(projection.libraryId, null, 'Library item'));
    const dayChild = mustFocus(core.createNode(projection.todayId, null, 'Journal item'));
    const dayGrandchild = mustFocus(core.createNode(dayChild, null, 'Nested journal item'));
    const searchId = mustFocus(core.createNode(projection.searchesId, null, 'Scope search'));
    const conditionId = mustFocus(core.createNode(searchId, null, 'Scope'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'IN_LIBRARY';

    const library = runSearchNode(state, searchId);
    expect(library.ok ? library.hits.map((hit) => hit.nodeId) : []).toContain(libraryNode);
    expect(library.ok ? library.hits.map((hit) => hit.nodeId) : []).not.toContain(dayChild);

    state.nodes[conditionId]!.queryOp = 'ON_DAY_NODE';
    const dayNode = runSearchNode(state, searchId);
    expect(dayNode.ok ? dayNode.hits.map((hit) => hit.nodeId) : []).toContain(dayChild);
    expect(dayNode.ok ? dayNode.hits.map((hit) => hit.nodeId) : []).not.toContain(dayGrandchild);
  });

  test('executes absolute and relative date query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const eventTagId = mustFocus(core.createTag('event'));
    const templateEntryId = mustFocus(core.createFieldDef(eventTagId, 'Date', 'date'));
    const dateFieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;
    const todayDate = new Date();
    const yesterday = isoLocalDate(addLocalDays(todayDate, -1));
    const todayIso = isoLocalDate(todayDate);
    const tomorrow = isoLocalDate(addLocalDays(todayDate, 1));
    const titleMatch = mustFocus(core.createNode(today, null, 'Launch 2026-05-14'));
    const inlineRefMatch = mustFocus(core.createNode(today, null, 'Referenced date'));
    const fieldMatch = mustFocus(core.createNode(today, null, 'Field date'));
    const dateTimeFieldMatch = mustFocus(core.createNode(today, null, 'Field date time'));
    const relativeMatch = mustFocus(core.createNode(today, null, 'Today field'));
    const relativeDateTimeRangeMatch = mustFocus(core.createNode(today, null, 'Today date time range'));
    const rangeMatch = mustFocus(core.createNode(today, null, 'Range field'));
    const legacyRangeMiss = mustFocus(core.createNode(today, null, 'Legacy range field'));
    const relativeMiss = mustFocus(core.createNode(today, null, 'Yesterday field'));
    const unrelated = mustFocus(core.createNode(today, null, 'No date'));
    const dayId = mustFocus(core.ensureDateNode(2026, 5, 14));
    core.applyTag(fieldMatch, eventTagId);
    core.applyTag(dateTimeFieldMatch, eventTagId);
    core.applyTag(relativeMatch, eventTagId);
    core.applyTag(relativeDateTimeRangeMatch, eventTagId);
    core.applyTag(rangeMatch, eventTagId);
    core.applyTag(legacyRangeMiss, eventTagId);
    core.applyTag(relativeMiss, eventTagId);
    addFieldValue(core, fieldMatch, dateFieldDefId, '2026-05-14');
    addFieldValue(core, dateTimeFieldMatch, dateFieldDefId, '2026-05-14T09:30');
    addFieldValue(core, relativeMatch, dateFieldDefId, todayIso);
    addFieldValue(core, relativeDateTimeRangeMatch, dateFieldDefId, `${todayIso}T09:00/${tomorrow}T17:00`);
    addFieldValue(core, rangeMatch, dateFieldDefId, `${yesterday}/${tomorrow}`);
    addFieldValue(core, legacyRangeMiss, dateFieldDefId, `${yesterday}..${tomorrow}`);
    addFieldValue(core, relativeMiss, dateFieldDefId, yesterday);

    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Date search'));
    const conditionId = mustFocus(core.createNode(searchId, null, '2026-05-14'));
    const state = core.state();

    state.nodes[inlineRefMatch]!.content.inlineRefs = [{ offset: 0, target: { kind: 'node', nodeId: dayId  }}];
    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'FOR_DATE';

    const absolute = runSearchNode(state, searchId);
    const absoluteIds = absolute.ok ? absolute.hits.map((hit) => hit.nodeId) : [];
    expect(absoluteIds).toEqual(expect.arrayContaining([titleMatch, inlineRefMatch, fieldMatch, dateTimeFieldMatch]));
    expect(absoluteIds).not.toContain(unrelated);

    state.nodes[conditionId]!.queryOp = 'FOR_RELATIVE_DATE';
    state.nodes[conditionId]!.content.text = 'today';
    const relative = runSearchNode(state, searchId);
    const relativeIds = relative.ok ? relative.hits.map((hit) => hit.nodeId) : [];
    expect(relativeIds).toContain(relativeMatch);
    expect(relativeIds).toContain(relativeDateTimeRangeMatch);
    expect(relativeIds).toContain(rangeMatch);
    expect(relativeIds).not.toContain(legacyRangeMiss);
    expect(relativeIds).not.toContain(relativeMiss);

    state.nodes[conditionId]!.queryOp = 'FIELD_IS';
    state.nodes[conditionId]!.queryFieldDefId = dateFieldDefId;
    const dateFieldRelative = runSearchNode(state, searchId);
    const dateFieldRelativeIds = dateFieldRelative.ok ? dateFieldRelative.hits.map((hit) => hit.nodeId) : [];
    expect(dateFieldRelativeIds).toContain(relativeMatch);
    expect(dateFieldRelativeIds).toContain(relativeDateTimeRangeMatch);
    expect(dateFieldRelativeIds).toContain(rangeMatch);
    expect(dateFieldRelativeIds).not.toContain(legacyRangeMiss);
    expect(dateFieldRelativeIds).not.toContain(relativeMiss);

    state.nodes[conditionId]!.content.text = todayIso.replaceAll('-', '/');
    const nonCanonicalDateField = runSearchNode(state, searchId);
    const nonCanonicalDateFieldIds = nonCanonicalDateField.ok ? nonCanonicalDateField.hits.map((hit) => hit.nodeId) : [];
    expect(nonCanonicalDateFieldIds).not.toContain(relativeMatch);
    expect(nonCanonicalDateFieldIds).not.toContain(rangeMatch);

    state.nodes[conditionId]!.queryOp = 'DATE_OVERLAPS';
    state.nodes[conditionId]!.content.text = todayIso;
    const overlapsToday = runSearchNode(state, searchId);
    const overlapsTodayIds = overlapsToday.ok ? overlapsToday.hits.map((hit) => hit.nodeId) : [];
    expect(overlapsTodayIds).toContain(relativeMatch);
    expect(overlapsTodayIds).toContain(relativeDateTimeRangeMatch);
    expect(overlapsTodayIds).toContain(rangeMatch);
    expect(overlapsTodayIds).not.toContain(relativeMiss);
  });

  test('executes ancestor operands for fields and date parents', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const projectTagId = mustFocus(core.createTag('project'));
    const sprintTemplateEntryId = mustFocus(core.createFieldDef(projectTagId, 'Sprint date', 'date'));
    const sprintFieldDefId = core.state().nodes[sprintTemplateEntryId]!.fieldDefId!;
    const taskTagId = mustFocus(core.createTag('task'));
    const dueTemplateEntryId = mustFocus(core.createFieldDef(taskTagId, 'Due', 'date'));
    const dueFieldDefId = core.state().nodes[dueTemplateEntryId]!.fieldDefId!;
    const projectId = mustFocus(core.createNode(today, null, 'Project'));
    core.applyTag(projectId, projectTagId);
    addFieldValue(core, projectId, sprintFieldDefId, '2026-05-20');
    const matchingTask = mustFocus(core.createNode(projectId, null, 'Matching task'));
    const laterTask = mustFocus(core.createNode(projectId, null, 'Later task'));
    core.applyTag(matchingTask, taskTagId);
    core.applyTag(laterTask, taskTagId);
    addFieldValue(core, matchingTask, dueFieldDefId, '2026-05-20');
    addFieldValue(core, laterTask, dueFieldDefId, '2026-05-21');
    const dayId = mustFocus(core.ensureDateNode(2026, 5, 20));
    const fieldSearchId = mustFocus(core.createNode(projectId, null, 'Project tasks'));
    const fieldConditionId = mustFocus(core.createNode(fieldSearchId, null, 'PARENT.Sprint date'));
    const daySearchId = mustFocus(core.createNode(dayId, null, 'Day tasks'));
    const dayConditionId = mustFocus(core.createNode(daySearchId, null, 'PARENT'));
    const state = core.state();

    state.nodes[fieldSearchId]!.type = 'search';
    state.nodes[fieldConditionId]!.type = 'queryCondition';
    state.nodes[fieldConditionId]!.queryOp = 'FIELD_IS';
    state.nodes[fieldConditionId]!.queryFieldDefId = dueFieldDefId;

    const fieldIs = runSearchNode(state, fieldSearchId);
    expect(fieldIs.ok ? fieldIs.hits.map((hit) => hit.nodeId) : []).toContain(matchingTask);
    expect(fieldIs.ok ? fieldIs.hits.map((hit) => hit.nodeId) : []).not.toContain(laterTask);

    state.nodes[fieldConditionId]!.queryOp = 'LT';
    state.nodes[fieldConditionId]!.content.text = 'PARENT.Sprint date+1';
    const beforeNextDay = runSearchNode(state, fieldSearchId);
    expect(beforeNextDay.ok ? beforeNextDay.hits.map((hit) => hit.nodeId) : []).toContain(matchingTask);
    expect(beforeNextDay.ok ? beforeNextDay.hits.map((hit) => hit.nodeId) : []).not.toContain(laterTask);

    state.nodes[daySearchId]!.type = 'search';
    state.nodes[dayConditionId]!.type = 'queryCondition';
    state.nodes[dayConditionId]!.queryOp = 'FIELD_IS';
    state.nodes[dayConditionId]!.queryFieldDefId = dueFieldDefId;
    const parentDate = runSearchNode(state, daySearchId);
    expect(parentDate.ok ? parentDate.hits.map((hit) => hit.nodeId) : []).toContain(matchingTask);
    expect(parentDate.ok ? parentDate.hits.map((hit) => hit.nodeId) : []).not.toContain(laterTask);

    const weekId = core.state().nodes[dayId]!.parentId!;
    const weekSearchId = mustFocus(core.createNode(weekId, null, 'Week tasks'));
    const weekConditionId = mustFocus(core.createNode(weekSearchId, null, 'PARENT'));
    const nextWeekTask = mustFocus(core.createNode(projectId, null, 'Next week task'));
    core.applyTag(nextWeekTask, taskTagId);
    addFieldValue(core, nextWeekTask, dueFieldDefId, '2026-05-27');
    const weekState = core.state();
    weekState.nodes[weekSearchId]!.type = 'search';
    weekState.nodes[weekConditionId]!.type = 'queryCondition';
    weekState.nodes[weekConditionId]!.queryOp = 'FIELD_IS';
    weekState.nodes[weekConditionId]!.queryFieldDefId = dueFieldDefId;

    const parentWeek = runSearchNode(weekState, weekSearchId);
    const parentWeekIds = parentWeek.ok ? parentWeek.hits.map((hit) => hit.nodeId) : [];
    expect(parentWeekIds).toContain(matchingTask);
    expect(parentWeekIds).toContain(laterTask);
    expect(parentWeekIds).not.toContain(nextWeekTask);
  });

  test('executes overdue query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const todayDate = new Date();
    const yesterdayDate = addLocalDays(todayDate, -1);
    const twoDaysAgoDate = addLocalDays(todayDate, -2);
    const tomorrowDate = addLocalDays(todayDate, 1);
    const twoDaysAgo = isoLocalDate(twoDaysAgoDate);
    const yesterday = isoLocalDate(yesterdayDate);
    const todayIso = isoLocalDate(todayDate);
    const tomorrow = isoLocalDate(tomorrowDate);
    const taskTagId = mustFocus(core.createTag('task'));
    const dueTemplateEntryId = mustFocus(core.createFieldDef(taskTagId, 'Due', 'date'));
    const dueFieldDefId = core.state().nodes[dueTemplateEntryId]!.fieldDefId!;
    const startTemplateEntryId = mustFocus(core.createFieldDef(taskTagId, 'Start', 'date'));
    const startFieldDefId = core.state().nodes[startTemplateEntryId]!.fieldDefId!;
    const overdue = mustFocus(core.createNode(today, null, 'Overdue'));
    const refOverdue = mustFocus(core.createNode(today, null, 'Reference overdue'));
    const dueToday = mustFocus(core.createNode(today, null, 'Due today'));
    const dueTomorrow = mustFocus(core.createNode(today, null, 'Due tomorrow'));
    const doneOverdue = mustFocus(core.createNode(today, null, 'Done overdue'));
    const noDate = mustFocus(core.createNode(today, null, 'No date'));
    const startOnlyOverdue = mustFocus(core.createNode(today, null, 'Start only overdue'));
    const activeRange = mustFocus(core.createNode(today, null, 'Active range'));
    const endedRange = mustFocus(core.createNode(today, null, 'Ended range'));
    const yesterdayDayId = ensureDateNodeFor(core, yesterdayDate);

    for (const nodeId of [overdue, refOverdue, dueToday, dueTomorrow, doneOverdue, noDate, startOnlyOverdue, activeRange, endedRange]) {
      core.applyTag(nodeId, taskTagId);
    }
    addFieldValue(core, overdue, dueFieldDefId, yesterday);
    const refOverdueValueId = addFieldValue(core, refOverdue, dueFieldDefId, '');
    addFieldValue(core, dueToday, dueFieldDefId, todayIso);
    addFieldValue(core, dueTomorrow, dueFieldDefId, tomorrow);
    addFieldValue(core, doneOverdue, dueFieldDefId, yesterday);
    addFieldValue(core, startOnlyOverdue, dueFieldDefId, tomorrow);
    addFieldValue(core, startOnlyOverdue, startFieldDefId, yesterday);
    addFieldValue(core, activeRange, dueFieldDefId, `${yesterday}/${tomorrow}`);
    addFieldValue(core, endedRange, dueFieldDefId, `${twoDaysAgo}/${yesterday}`);

    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Overdue search'));
    const conditionId = mustFocus(core.createNode(searchId, null, 'Overdue'));
    const state = core.state();

    state.nodes[refOverdueValueId]!.type = 'reference';
    state.nodes[refOverdueValueId]!.targetId = yesterdayDayId;
    state.nodes[doneOverdue]!.completedAt = Date.now();
    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'OVERDUE';

    const anyDateField = runSearchNode(state, searchId);
    const anyDateFieldIds = anyDateField.ok ? anyDateField.hits.map((hit) => hit.nodeId) : [];
    expect(anyDateFieldIds).toEqual(expect.arrayContaining([overdue, refOverdue, startOnlyOverdue, endedRange]));
    expect(anyDateFieldIds).not.toContain(activeRange);
    expect(anyDateFieldIds).not.toContain(dueToday);
    expect(anyDateFieldIds).not.toContain(dueTomorrow);
    expect(anyDateFieldIds).not.toContain(doneOverdue);
    expect(anyDateFieldIds).not.toContain(noDate);

    state.nodes[conditionId]!.queryFieldDefId = dueFieldDefId;
    const dueFieldOnly = runSearchNode(state, searchId);
    const dueFieldOnlyIds = dueFieldOnly.ok ? dueFieldOnly.hits.map((hit) => hit.nodeId) : [];
    expect(dueFieldOnlyIds).toEqual(expect.arrayContaining([overdue, refOverdue, endedRange]));
    expect(dueFieldOnlyIds).not.toContain(startOnlyOverdue);
    expect(dueFieldOnlyIds).not.toContain(activeRange);
  });

  test('executes relative timestamp query rules', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const recent = mustFocus(core.createNode(today, null, 'Recent'));
    const old = mustFocus(core.createNode(today, null, 'Old'));
    const doneRecent = mustFocus(core.createNode(today, null, 'Done recent'));
    const doneOld = mustFocus(core.createNode(today, null, 'Done old'));
    core.toggleDone(doneRecent);
    core.toggleDone(doneOld);
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Time search'));
    const conditionId = mustFocus(core.createNode(searchId, null, '7'));
    const state = core.state();
    const now = Date.now();
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    const tenDays = 10 * 24 * 60 * 60 * 1000;

    state.nodes[recent]!.createdAt = now - twoDays;
    state.nodes[old]!.createdAt = now - tenDays;
    state.nodes[doneRecent]!.completedAt = now - twoDays;
    state.nodes[doneOld]!.completedAt = now - tenDays;
    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'CREATED_LAST_DAYS';

    const created = runSearchNode(state, searchId);
    expect(created.ok ? created.hits.map((hit) => hit.nodeId) : []).toContain(recent);
    expect(created.ok ? created.hits.map((hit) => hit.nodeId) : []).not.toContain(old);

    state.nodes[recent]!.updatedAt = now - tenDays;
    state.nodes[old]!.updatedAt = now - twoDays;
    state.nodes[conditionId]!.queryOp = 'EDITED_LAST_DAYS';
    const edited = runSearchNode(state, searchId);
    expect(edited.ok ? edited.hits.map((hit) => hit.nodeId) : []).toContain(old);
    expect(edited.ok ? edited.hits.map((hit) => hit.nodeId) : []).not.toContain(recent);

    state.nodes[conditionId]!.queryOp = 'DONE_LAST_DAYS';
    const done = runSearchNode(state, searchId);
    expect(done.ok ? done.hits.map((hit) => hit.nodeId) : []).toContain(doneRecent);
    expect(done.ok ? done.hits.map((hit) => hit.nodeId) : []).not.toContain(doneOld);
  });

  test('executes media query rules and searches media nodes', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const image = mustFocus(core.createNode(today, null, 'Screenshot asset'));
    const audio = mustFocus(core.createNode(today, null, 'Call recording'));
    const video = mustFocus(core.createNode(today, null, 'Demo video'));
    const embed = mustFocus(core.createNode(today, null, 'Demo embed'));
    const plain = mustFocus(core.createNode(today, null, 'Plain note'));
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Media search'));
    const conditionId = mustFocus(core.createNode(searchId, null, 'Media'));
    const state = core.state();

    // Media fields live only on their owning variants now: mediaUrl on image
    // nodes, embedType/sourceUrl on embed nodes. Audio/video are embeds whose
    // kind is resolved from the embed type or the source URL extension.
    state.nodes[image]!.type = 'image';
    (state.nodes[image] as ImageNode).mediaUrl = 'file:///tmp/screenshot.png';
    state.nodes[audio]!.type = 'embed';
    (state.nodes[audio] as EmbedNode).sourceUrl = 'file:///tmp/recording.mp3';
    state.nodes[video]!.type = 'embed';
    (state.nodes[video] as EmbedNode).embedType = 'video';
    state.nodes[embed]!.type = 'embed';
    (state.nodes[embed] as EmbedNode).sourceUrl = 'https://example.com/demo';
    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'HAS_MEDIA';

    const media = runSearchNode(state, searchId);
    expect(media.ok ? media.hits.map((hit) => hit.nodeId) : []).toEqual(expect.arrayContaining([image, audio, video, embed]));
    expect(media.ok ? media.hits.map((hit) => hit.nodeId) : []).not.toContain(plain);

    state.nodes[conditionId]!.queryOp = 'HAS_IMAGE';
    const images = runSearchNode(state, searchId);
    expect(images.ok ? images.hits.map((hit) => hit.nodeId) : []).toContain(image);
    expect(images.ok ? images.hits.map((hit) => hit.nodeId) : []).not.toContain(audio);

    state.nodes[conditionId]!.queryOp = 'HAS_AUDIO';
    const audioResults = runSearchNode(state, searchId);
    expect(audioResults.ok ? audioResults.hits.map((hit) => hit.nodeId) : []).toContain(audio);
    expect(audioResults.ok ? audioResults.hits.map((hit) => hit.nodeId) : []).not.toContain(video);

    state.nodes[conditionId]!.queryOp = 'HAS_VIDEO';
    const videoResults = runSearchNode(state, searchId);
    expect(videoResults.ok ? videoResults.hits.map((hit) => hit.nodeId) : []).toContain(video);
    expect(videoResults.ok ? videoResults.hits.map((hit) => hit.nodeId) : []).not.toContain(audio);

    const keyword = runSearchExpr(state, { kind: 'rule', op: 'STRING_MATCH', text: 'Screenshot' });
    expect(keyword.ok ? keyword.hits.map((hit) => hit.nodeId) : []).toContain(image);
  });

  test('executes Tana-style node type aliases', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('topic'));
    const fieldEntryId = mustFocus(core.createFieldDef(tagId, 'Status', 'plain'));
    const fieldDefId = core.state().nodes[fieldEntryId]!.fieldDefId!;
    const dayId = mustFocus(core.ensureDateNode(2026, 5, 20));
    const plain = mustFocus(core.createNode(today, null, 'Plain'));
    const searchId = mustFocus(core.createNode(core.projection().searchesId, null, 'Type search'));
    const conditionId = mustFocus(core.createNode(searchId, null, 'Calendar Node'));
    const state = core.state();

    state.nodes[searchId]!.type = 'search';
    state.nodes[conditionId]!.type = 'queryCondition';
    state.nodes[conditionId]!.queryOp = 'IS_TYPE';

    const calendar = runSearchNode(state, searchId);
    expect(calendar.ok ? calendar.hits.map((hit) => hit.nodeId) : []).toContain(dayId);
    expect(calendar.ok ? calendar.hits.map((hit) => hit.nodeId) : []).not.toContain(plain);

    state.nodes[conditionId]!.content.text = 'supertag';
    const tags = runSearchNode(state, searchId);
    expect(tags.ok ? tags.hits.map((hit) => hit.nodeId) : []).toContain(tagId);

    state.nodes[conditionId]!.content.text = 'field';
    const fields = runSearchNode(state, searchId);
    expect(fields.ok ? fields.hits.map((hit) => hit.nodeId) : []).toContain(fieldDefId);
  });

  test('persists a node-target query rule (queryTargetId) across serialize/reload', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target parent'));
    const child = mustFocus(core.createNode(target, null, 'Child note'));
    const outsider = mustFocus(core.createNode(today, null, 'Unrelated'));
    const searchId = mustFocus(core.createSearchNode(core.projection().searchesId, null, {
      title: 'Children of Target',
      query: { kind: 'rule', op: 'CHILD_OF', targetId: target },
    }));

    // Sanity: the target-based rule resolves before any round-trip.
    const before = runSearchNode(core.state(), searchId);
    expect(before.ok ? before.hits.map((hit) => hit.nodeId) : []).toContain(child);
    expect(before.ok ? before.hits.map((hit) => hit.nodeId) : []).not.toContain(outsider);

    // Round-trip through the Loro snapshot. The query-rule target now persists
    // under `queryTargetId` (split from the reference-only `targetId`), so this
    // proves NODE_SCALAR_KEYS carries the new key and the reloaded condition
    // still resolves its target.
    const reloaded = Core.fromState(Core.deserializeState(core.serializeState()));

    const conditionNode = Object.values(reloaded.state().nodes)
      .find((node) => node.type === 'queryCondition' && node.queryOp === 'CHILD_OF');
    expect(conditionNode?.type === 'queryCondition' ? conditionNode.queryTargetId : undefined).toBe(target);

    const after = runSearchNode(reloaded.state(), searchId);
    expect(after.ok ? after.hits.map((hit) => hit.nodeId) : []).toContain(child);
    expect(after.ok ? after.hits.map((hit) => hit.nodeId) : []).not.toContain(outsider);
  });
});
