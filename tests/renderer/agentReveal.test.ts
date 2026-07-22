import { describe, expect, test } from 'bun:test';
import {
  acknowledgeThreadComposerNodeReferenceRequest,
  onThreadComposerNodeReferenceRequest,
  onThreadRailRevealRequest,
  requestSendNodeReferenceToThreadComposer,
} from '../../src/renderer/agent/agentReveal';

describe('Thread composer reveal requests', () => {
  test('keeps a Node reference pending until a mounted composer acknowledges insertion', () => {
    const request = { nodeId: 'node:pending', title: 'Pending reference' };
    let revealCount = 0;
    const stopReveal = onThreadRailRevealRequest(() => {
      revealCount += 1;
    });

    requestSendNodeReferenceToThreadComposer(request);
    expect(revealCount).toBe(1);

    const firstDelivery: typeof request[] = [];
    const stopFirstComposer = onThreadComposerNodeReferenceRequest((pending) => firstDelivery.push(pending));
    expect(firstDelivery).toEqual([request]);
    stopFirstComposer();

    const replayedDelivery: typeof request[] = [];
    const stopSecondComposer = onThreadComposerNodeReferenceRequest((pending) => replayedDelivery.push(pending));
    expect(replayedDelivery).toEqual([request]);
    acknowledgeThreadComposerNodeReferenceRequest(request);
    stopSecondComposer();

    const afterAcknowledgement: typeof request[] = [];
    const stopThirdComposer = onThreadComposerNodeReferenceRequest((pending) => afterAcknowledgement.push(pending));
    expect(afterAcknowledgement).toEqual([]);
    stopThirdComposer();
    stopReveal();
  });
});
