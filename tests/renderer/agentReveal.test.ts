import { describe, expect, test } from 'bun:test';
import {
  acknowledgeAgentComposerNodeReferenceRequest,
  onAgentComposerNodeReferenceRequest,
  onAgentComposerRevealRequest,
  requestSendNodeReferenceToComposer,
} from '../../src/renderer/agent/agentReveal';

describe('agent composer reveal requests', () => {
  test('keeps a node reference pending until a mounted Composer acknowledges insertion', () => {
    const request = { nodeId: 'node:pending', title: 'Pending reference' };
    let revealCount = 0;
    const stopReveal = onAgentComposerRevealRequest(() => {
      revealCount += 1;
    });

    requestSendNodeReferenceToComposer(request);
    expect(revealCount).toBe(1);

    const firstDelivery: typeof request[] = [];
    const stopFirstComposer = onAgentComposerNodeReferenceRequest((pending) => firstDelivery.push(pending));
    expect(firstDelivery).toEqual([request]);
    stopFirstComposer();

    const replayedDelivery: typeof request[] = [];
    const stopSecondComposer = onAgentComposerNodeReferenceRequest((pending) => replayedDelivery.push(pending));
    expect(replayedDelivery).toEqual([request]);
    acknowledgeAgentComposerNodeReferenceRequest(request);
    stopSecondComposer();

    const afterAcknowledgement: typeof request[] = [];
    const stopThirdComposer = onAgentComposerNodeReferenceRequest((pending) => afterAcknowledgement.push(pending));
    expect(afterAcknowledgement).toEqual([]);
    stopThirdComposer();
    stopReveal();
  });
});
