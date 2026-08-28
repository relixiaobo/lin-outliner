import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { plainText, replaceAllRichTextPatch } from '../../src/core/types';

describe('Core Runtime fork', () => {
  test('uses an isolated native candidate without serializing the workspace', () => {
    const source = Core.new();
    const parentId = source.projection().todayId;
    const sourceNodeId = requiredFocus(source.createNode(parentId, null, 'Source'));
    const sourceRevision = source.revision();
    const sourcePeerId = source.persistenceIdentity().loroSessionPeerId;
    const sourceProjection = source.projection();

    Object.defineProperty(source, 'serializeState', {
      value: () => {
        throw new Error('Runtime fork must not serialize the workspace');
      },
    });

    const candidate = source.forkForRuntime({ idFactory: () => 'node:runtime-candidate' });
    const candidateNodeId = requiredFocus(candidate.createNode(parentId, null, 'Candidate'));
    candidate.applyNodeTextPatch(sourceNodeId, replaceAllRichTextPatch(plainText('Candidate edit')));

    expect(candidate.persistenceIdentity()).toMatchObject({
      installationId: source.persistenceIdentity().installationId,
      workspaceId: source.persistenceIdentity().workspaceId,
      documentId: source.persistenceIdentity().documentId,
      replicaId: source.persistenceIdentity().replicaId,
    });
    expect(candidate.persistenceIdentity().loroSessionPeerId).not.toBe(sourcePeerId);
    expect(candidate.state().nodes[candidateNodeId]?.content.text).toBe('Candidate');
    expect(candidate.state().nodes[sourceNodeId]?.content.text).toBe('Candidate edit');

    expect(source.revision()).toBe(sourceRevision);
    expect(source.state().nodes[candidateNodeId]).toBeUndefined();
    expect(source.state().nodes[sourceNodeId]?.content.text).toBe('Source');
    expect(source.projection()).toEqual(sourceProjection);
  });

  test('copies operation journal entries before candidate-local merges', () => {
    const source = Core.new();
    const parentId = source.projection().todayId;
    source.withOrigin('user', () => source.createNode(parentId, null, 'Source history'), {
      operationId: 'op:shared-history',
      summary: 'Source summary.',
    });

    const candidate = source.forkForRuntime();
    candidate.withOrigin('user', () => candidate.createNode(parentId, null, 'Candidate history'), {
      operationId: 'op:shared-history',
      summary: 'Candidate summary.',
    });

    expect(candidate.operationHistory({ origin: 'user' }).items?.[0]?.summary).toBe('Candidate summary.');
    expect(source.operationHistory({ origin: 'user' }).items?.[0]?.summary).toBe('Source summary.');
  });
});

function requiredFocus(outcome: { focus?: { nodeId: string } }): string {
  if (!outcome.focus) throw new Error('Expected a focused node');
  return outcome.focus.nodeId;
}
