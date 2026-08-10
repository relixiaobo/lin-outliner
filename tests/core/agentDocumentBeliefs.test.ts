import { describe, expect, test } from 'bun:test';
import {
  beliefsFromToolResult,
  driftedNodes,
  DocumentBeliefSet,
} from '../../src/main/agent/context/DocumentBeliefs';
import { revisionOf } from '../../src/main/agent/capabilities/agentNodeToolProjection';
import type { NodeProjection } from '../../src/core/types';

const PRICING = '019fb2da-0000-7000-8000-000000000001';
const PLAN = '019fb2da-0000-7000-8000-000000000002';

describe('document beliefs', () => {
  test('takes the revision the model was already shown, whichever tool showed it', () => {
    // node_read states it directly; node_search states the same fact as
    // `updatedAt`. Both are the token `node_edit` compares, so nothing here
    // invents a second notion of "changed".
    const read = beliefsFromToolResult('node_read', {
      ok: true,
      data: { items: [{ nodeId: PRICING, revision: `${PRICING}:100` }] },
    });
    const search = beliefsFromToolResult('node_search', {
      ok: true,
      data: { total: 1, items: [{ nodeId: PLAN, updatedAt: '200' }] },
    });
    const edit = beliefsFromToolResult('node_edit', {
      ok: true,
      data: { revisions: { [PRICING]: `${PRICING}:300` } },
    });

    expect(read).toEqual([{ nodeId: PRICING, revision: `${PRICING}:100` }]);
    expect(search).toEqual([{ nodeId: PLAN, revision: `${PLAN}:200` }]);
    expect(edit).toEqual([{ nodeId: PRICING, revision: `${PRICING}:300` }]);
  });

  test('yields nothing rather than throwing on a shape it does not know', () => {
    // This runs behind a live tool call and behind a rebuild from persisted
    // payloads; neither may fail over an unrecognised or truncated result.
    expect(beliefsFromToolResult('bash', { ok: true, data: { items: [{ nodeId: PRICING }] } })).toEqual([]);
    expect(beliefsFromToolResult('node_read', null)).toEqual([]);
    expect(beliefsFromToolResult('node_read', { ok: false })).toEqual([]);
    expect(beliefsFromToolResult('node_read', { ok: true, data: { items: 'truncated' } })).toEqual([]);
    // An item with no revision to state expresses no belief, rather than a
    // belief with a fabricated revision.
    expect(beliefsFromToolResult('node_read', { ok: true, data: { items: [{ nodeId: PRICING }] } })).toEqual([]);
  });

  test('reports a node whose revision moved and one that is gone, and stays quiet otherwise', () => {
    const pricing = node(PRICING, 100);
    const nodesById = new Map([[PRICING, node(PRICING, 200)]]);

    const drift = driftedNodes(
      [
        { nodeId: PRICING, revision: revisionOf(pricing) },
        { nodeId: PLAN, revision: `${PLAN}:1` },
      ],
      nodesById,
    );

    expect(drift).toEqual([
      { nodeId: PRICING, kind: 'changed', node: nodesById.get(PRICING)! },
      // Gone is the outcome a re-read cannot recover on its own.
      { nodeId: PLAN, kind: 'gone', node: null },
    ]);
    expect(driftedNodes([{ nodeId: PRICING, revision: revisionOf(node(PRICING, 200)) }], nodesById)).toEqual([]);
  });

  test('a re-observed node keeps one belief, and the newest one', () => {
    const beliefs = new DocumentBeliefSet();
    beliefs.record([{ nodeId: PRICING, revision: `${PRICING}:1` }, { nodeId: PLAN, revision: `${PLAN}:1` }]);
    beliefs.record([{ nodeId: PRICING, revision: `${PRICING}:2` }]);

    // One entry, not two: the model's belief is whatever it was shown most
    // recently, and keeping the older one would report drift it already knows.
    expect(beliefs.size).toBe(2);
    // Recency last, because that is the order the notice spends its cap on.
    expect(beliefs.beliefs()).toEqual([
      { nodeId: PLAN, revision: `${PLAN}:1` },
      { nodeId: PRICING, revision: `${PRICING}:2` },
    ]);

    beliefs.forget([PLAN]);
    expect(beliefs.beliefs().map((belief) => belief.nodeId)).toEqual([PRICING]);
  });
});

function node(id: string, updatedAt: number): NodeProjection {
  return {
    id,
    type: 'text',
    parentId: undefined,
    children: [],
    content: { text: 'Pricing model', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt,
    locked: false,
    autoCollected: false,
  } as unknown as NodeProjection;
}
