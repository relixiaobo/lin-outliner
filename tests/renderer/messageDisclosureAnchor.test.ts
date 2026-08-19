import { describe, expect, test } from 'bun:test';
import { messageDisclosureAnchor } from '../../src/renderer/agent/messageDisclosureAnchor';

describe('long-message disclosure anchor', () => {
  test('opens from the block, so revealed lines go down instead of off the top', () => {
    expect(messageDisclosureAnchor({ closing: false, ridingScrollableBottom: false })).toBe('block');
  });

  test('opens from the control while riding a tail, which is what staying at the bottom means', () => {
    expect(messageDisclosureAnchor({ closing: false, ridingScrollableBottom: true })).toBe('control');
  });

  test('closes from the control, the one point the reader is provably looking at', () => {
    // Reaching Show less in a message taller than the viewport means scrolling
    // far past the block's top edge; holding that edge pins a point off screen
    // above and drops the collapsed message out of view.
    expect(messageDisclosureAnchor({ closing: true, ridingScrollableBottom: false })).toBe('control');
    expect(messageDisclosureAnchor({ closing: true, ridingScrollableBottom: true })).toBe('control');
  });
});
