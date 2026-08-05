import { createHash } from 'node:crypto';
import { decodeThreadImageArtifactReference } from '../../core/agent/codec';
import type {
  ImageArtifactGeometry,
  ImageArtifactRetention,
  ThreadFileSource,
  ThreadImageArtifactReference,
  ThreadResourceReference,
} from '../../core/agent/protocol';

export class ImageObservationNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageObservationNormalizationError';
  }
}

export interface CreateImageArtifactInput {
  readonly createdAt?: number;
  readonly retention: ImageArtifactRetention;
  readonly original: ThreadFileSource | null;
  readonly observation: ThreadResourceReference;
  readonly sourceDimensions: { readonly width: number; readonly height: number };
  readonly observationDimensions: { readonly width: number; readonly height: number };
  readonly observationToSource?: ImageArtifactGeometry['observationToSource'];
}

export function createImageArtifactReference(input: CreateImageArtifactInput): ThreadImageArtifactReference {
  const geometry: ImageArtifactGeometry = {
    sourceWidth: input.sourceDimensions.width,
    sourceHeight: input.sourceDimensions.height,
    observationWidth: input.observationDimensions.width,
    observationHeight: input.observationDimensions.height,
    observationToSource: input.observationToSource ?? resizeObservationToSource(
      input.sourceDimensions,
      input.observationDimensions,
    ),
  };
  const fields = {
    createdAt: input.createdAt ?? Date.now(),
    retention: input.retention,
    original: input.original,
    observation: input.observation,
    geometry,
  };
  return decodeThreadImageArtifactReference({
    id: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    ...fields,
  });
}

export function resizeObservationToSource(
  source: { readonly width: number; readonly height: number },
  observation: { readonly width: number; readonly height: number },
): ImageArtifactGeometry['observationToSource'] {
  return [
    source.width / observation.width,
    0,
    0,
    source.height / observation.height,
    0,
    0,
  ];
}

export function imageArtifactResourceReferences(
  artifact: ThreadImageArtifactReference,
): ThreadResourceReference[] {
  const refs = [
    ...(artifact.original?.kind === 'threadPayload' ? [artifact.original.ref] : []),
    artifact.observation,
  ];
  return [...new Map(refs.map((ref) => [`${ref.id}\0${ref.fileName}`, ref])).values()];
}

export function isImageResourceReference(ref: ThreadResourceReference): boolean {
  return /^image\/[a-z0-9][a-z0-9.+-]*$/u.test(ref.mimeType);
}
