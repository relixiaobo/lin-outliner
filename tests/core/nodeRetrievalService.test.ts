import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import { NodeRetrievalService } from '../../src/main/nodeRetrievalService';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

describe('NodeRetrievalService', () => {
  test('routes text search through the shared indexed evaluator', () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const exact = mustFocus(core.createNode(parentId, null, 'Launch plan'));
    const prefix = mustFocus(core.createNode(parentId, null, 'Launch plan review'));
    mustFocus(core.createNode(parentId, null, 'Archive note'));
    const service = new NodeRetrievalService({
      getProjection: () => core.projection(),
      getTextSearchIndex: () => buildTextSearchIndex(core.projection()),
    });

    expect(service.searchText('').map((hit) => hit.nodeId)).toEqual([]);
    expect(service.searchText('launch plan').map((hit) => hit.nodeId)).toEqual([exact, prefix]);
    expect(service.searchText('launch plan', { limit: 1 }).map((hit) => hit.nodeId)).toEqual([exact]);
  });

  test('keeps structured query verification authoritative', () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const tagId = mustFocus(core.createTag('project'));
    const tagged = mustFocus(core.createNode(parentId, null, 'Launch plan'));
    const untagged = mustFocus(core.createNode(parentId, null, 'Launch plan'));
    core.applyTag(tagged, tagId);
    const service = new NodeRetrievalService({
      getProjection: () => core.projection(),
      getTextSearchIndex: () => buildTextSearchIndex(core.projection()),
    });

    const hits = service.searchQuery({
      kind: 'group',
      logic: 'AND',
      children: [
        { kind: 'rule', op: 'STRING_MATCH', text: 'launch plan' },
        { kind: 'rule', op: 'HAS_TAG', tagDefId: tagId },
      ],
    }).map((hit) => hit.nodeId);

    expect(hits).toEqual([tagged]);
    expect(hits).not.toContain(untagged);
  });
});
