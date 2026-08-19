import { describe, expect, test } from 'bun:test';
import {
  resolveFlyoutPlacement,
  type FlyoutPlacementInput,
} from '../../src/renderer/ui/primitives/flyoutPlacement';

const VIEWPORT = { viewportHeight: 800, viewportWidth: 1200 };

function placement(overrides: Partial<FlyoutPlacementInput> = {}) {
  return resolveFlyoutPlacement({
    ...VIEWPORT,
    anchorLeft: 700,
    anchorRight: 940,
    anchorTop: 600,
    gap: 4,
    margin: 8,
    measuredHeight: 200,
    width: 260,
    ...overrides,
  });
}

/** One render pass: the surface is drawn at the placement it was given, so its
 *  next measured height is its content clipped by that placement's `maxHeight`. */
function settle(contentHeight: number, first = placement({ measuredHeight: contentHeight })) {
  let current = first;
  for (let pass = 0; pass < 4; pass += 1) {
    current = placement({ measuredHeight: Math.min(contentHeight, current.maxHeight) });
  }
  return current;
}

describe('side flyout placement', () => {
  test('opens level with its row and takes the space below as its ceiling', () => {
    const result = placement();
    expect(result.top).toBe(592);
    // Exactly the room left under it — not the whole viewport, which is what let
    // a growing list overflow and force the surface to move to fit.
    expect(result.maxHeight).toBe(200);
    expect(result.top + result.maxHeight).toBe(792);
  });

  test('lifts a list that is already too tall when it opens', () => {
    const result = placement({ measuredHeight: 900 });
    expect(result.top).toBe(8);
    expect(result.maxHeight).toBe(784);
  });

  test('does not move when its content grows past what fits', () => {
    const opened = placement();
    // "Show all models": the content wants far more room than it was given.
    const grown = settle(2_000, opened);
    expect(grown.top).toBe(opened.top);
    expect(grown.maxHeight).toBe(opened.maxHeight);
  });

  test('does not move when that content collapses again', () => {
    const opened = placement();
    const grown = settle(2_000, opened);
    const collapsed = placement({ measuredHeight: Math.min(200, grown.maxHeight) });
    expect(collapsed.top).toBe(opened.top);
    expect(collapsed.maxHeight).toBe(opened.maxHeight);
  });

  test('holds still across repeated passes for any opening height', () => {
    for (const contentHeight of [40, 200, 419, 784, 785, 2_000]) {
      const settled = settle(contentHeight);
      const again = placement({ measuredHeight: Math.min(contentHeight, settled.maxHeight) });
      expect(again).toEqual(settled);
    }
  });

  test('stays inside the viewport when the anchor sits at either edge', () => {
    const low = placement({ anchorTop: 795 });
    expect(low.top + low.maxHeight).toBeLessThanOrEqual(792);
    const high = placement({ anchorTop: 0 });
    expect(high.top).toBe(8);
  });

  test('opens to the reading side, and flips when that side has no room', () => {
    expect(placement().left).toBe(436);
    // Anchored against the left edge: the flyout goes to the anchor's right
    // rather than being clamped on top of the row that opened it.
    expect(placement({ anchorLeft: 40, anchorRight: 280 }).left).toBe(284);
  });
});
