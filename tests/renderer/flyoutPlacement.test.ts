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
    placementHeight: 200,
    width: 260,
    ...overrides,
  });
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
    const result = placement({ placementHeight: 900 });
    expect(result.top).toBe(8);
    expect(result.maxHeight).toBe(784);
  });

  test('does not move when its content grows or collapses', () => {
    // The opening height is frozen, so "Show all" and "Show less" are the same
    // input to the placement — only the ceiling absorbs them.
    const opened = placement();
    expect(placement()).toEqual(opened);
  });

  test('keeps tracking an anchor that moves, in both directions', () => {
    // The regression this guards: a ceiling fed back from the flyout's own
    // clipped height makes `top` monotonically non-increasing, so the surface
    // ratchets toward the top of the viewport and never returns to its row.
    const rest = placement({ anchorTop: 600 });
    const lifted = placement({ anchorTop: 300 });
    expect(lifted.top).toBeLessThan(rest.top);
    expect(placement({ anchorTop: 600 })).toEqual(rest);
  });

  test('stays inside the viewport when the anchor sits at either edge', () => {
    const low = placement({ anchorTop: 795 });
    expect(low.top + low.maxHeight).toBeLessThanOrEqual(792);
    expect(placement({ anchorTop: 0 }).top).toBe(8);
  });

  test('never proposes a surface that starts below the viewport', () => {
    for (const anchorTop of [0, 300, 600, 795, 2_000]) {
      for (const placementHeight of [0, 40, 200, 784, 785, 2_000]) {
        const result = placement({ anchorTop, placementHeight });
        expect(result.top).toBeGreaterThanOrEqual(8);
        expect(result.top).toBeLessThanOrEqual(792);
        expect(result.maxHeight).toBeGreaterThanOrEqual(0);
        expect(result.top + result.maxHeight).toBeLessThanOrEqual(792);
      }
    }
  });

  test('opens to the reading side, and flips when that side has no room', () => {
    expect(placement().left).toBe(436);
    // Anchored against the left edge: the flyout goes to the anchor's right
    // rather than being clamped on top of the row that opened it.
    expect(placement({ anchorLeft: 40, anchorRight: 280 }).left).toBe(284);
  });

  test('can prefer the trailing side and flips before overlapping its anchor', () => {
    expect(placement({
      anchorLeft: 300,
      anchorRight: 540,
      preferredSide: 'right',
    }).left).toBe(544);
    expect(placement({
      anchorLeft: 900,
      anchorRight: 1140,
      preferredSide: 'right',
    }).left).toBe(636);
  });
});
