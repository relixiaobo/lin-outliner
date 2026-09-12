import { parseReferenceMarkers } from '../referenceMarkup';
import { decodeScheduledMaterials, type ScheduledMaterial } from './scheduledMaterial';

export function scheduledMaterialKey(material: Pick<ScheduledMaterial, 'kind' | 'reference'>): string {
  return JSON.stringify([material.kind, material.reference]);
}

/** Positions live only in the shared prompt markup; this view owns no second document. */
export function scheduledInlineMaterials(prompt: string): readonly ScheduledMaterial[] {
  const sources = new Map<string, ScheduledMaterial>();
  for (const { target } of parseReferenceMarkers(prompt)) {
    const material: ScheduledMaterial = target.kind === 'node'
      ? { kind: 'note', reference: target.nodeId, required: true }
      : { kind: 'file', reference: target.path, required: true };
    sources.set(scheduledMaterialKey(material), material);
  }
  return [...sources.values()];
}

/** Explicit source policies override defaults, and detached CLI context remains intact. */
export function scheduledBriefMaterials(prompt: string, explicit: readonly ScheduledMaterial[]): readonly ScheduledMaterial[] {
  const sources = new Map(scheduledInlineMaterials(prompt).map((item) => [scheduledMaterialKey(item), item]));
  for (const item of explicit) sources.set(scheduledMaterialKey(item), item);
  return decodeScheduledMaterials([...sources.values()]);
}
