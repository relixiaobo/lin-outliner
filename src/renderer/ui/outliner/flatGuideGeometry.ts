import type { NodeId } from '../../api/types';

export interface FlatGuideGeometry {
  key: string;
  nodeId: NodeId;
  left: number;
  top: number;
  height: number;
}

export interface FlatGuideMeasurement {
  key: string;
  nodeId: NodeId;
  geometry?: FlatGuideGeometry;
}

export function sameFlatGuides(
  a: readonly FlatGuideGeometry[],
  b: readonly FlatGuideGeometry[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((guide, index) => {
    const other = b[index];
    return other !== undefined
      && guide.key === other.key
      && guide.nodeId === other.nodeId
      && Math.abs(guide.left - other.left) < 0.5
      && Math.abs(guide.top - other.top) < 0.5
      && Math.abs(guide.height - other.height) < 0.5;
  });
}

export function resolveFlatGuideMeasurements(
  current: readonly FlatGuideGeometry[],
  measurements: readonly FlatGuideMeasurement[],
): FlatGuideGeometry[] {
  const currentByKey = new Map(current.map((guide) => [guide.key, guide]));
  return measurements.flatMap((measurement) => {
    if (measurement.geometry) return [measurement.geometry];
    const previous = currentByKey.get(measurement.key);
    return previous?.nodeId === measurement.nodeId ? [previous] : [];
  });
}
