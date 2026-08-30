import { describe, expect, test } from 'bun:test';
import {
  resolveFlatGuideMeasurements,
  sameFlatGuides,
  type FlatGuideGeometry,
} from '../../src/renderer/ui/outliner/flatGuideGeometry';

const existing: FlatGuideGeometry = {
  key: 'owner',
  nodeId: 'owner',
  left: 20,
  top: 24,
  height: 180,
};

describe('flat guide geometry', () => {
  test('keeps prior geometry while a structurally required marker is temporarily unavailable', () => {
    expect(resolveFlatGuideMeasurements([existing], [{
      key: existing.key,
      nodeId: existing.nodeId,
    }])).toEqual([existing]);
  });

  test('removes geometry only when the structural measurement is omitted', () => {
    expect(resolveFlatGuideMeasurements([existing], [])).toEqual([]);
  });

  test('replaces prior geometry when the final marker is measurable again', () => {
    const measured = { ...existing, height: 212 };
    expect(resolveFlatGuideMeasurements([existing], [{
      key: existing.key,
      nodeId: existing.nodeId,
      geometry: measured,
    }])).toEqual([measured]);
  });

  test('treats subpixel measurement noise as unchanged', () => {
    expect(sameFlatGuides([existing], [{ ...existing, left: 20.2, height: 180.3 }])).toBe(true);
  });
});
