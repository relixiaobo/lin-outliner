import {
  GENERATE_IMAGE_TOOL_NAME,
} from './agentImageGenerationTool';
import {
  isToolEnvelope,
  TOOL_RESULT_VERSION,
  type ToolEnvelope,
} from './agentToolEnvelope';
import { decodeThreadImageArtifactReference } from '../../../core/agent/codec';
import type { ThreadImageArtifactReference } from '../../../core/agent/protocol';

export interface PersistedToolResultDetailsInput {
  toolNamespace: string | null;
  toolName: string;
  details?: unknown;
}

export interface PersistedGeneratedImageDetailsData {
  providerId: string;
  modelId: string;
  modelName: string;
  images: PersistedGeneratedImageDetailsImage[];
}

export interface PersistedGeneratedImageDetailsImage {
  providerIndex: number;
  artifactRef: ThreadImageArtifactReference;
  mimeType?: string;
  byteLength?: number;
  width?: number;
  height?: number;
}

export function persistedToolResultDetails(input: PersistedToolResultDetailsInput): unknown | undefined {
  const details = input.details;
  if (!isToolEnvelope(details)) return undefined;
  if (
    input.toolNamespace !== null
    || input.toolName !== GENERATE_IMAGE_TOOL_NAME
    || details.tool !== GENERATE_IMAGE_TOOL_NAME
  ) return undefined;
  return persistedGenerateImageDetails(details);
}

export function persistedToolResultText(input: {
  readonly toolNamespace: string | null;
  readonly toolName: string;
  readonly text: string;
}): string {
  if (input.toolNamespace !== null) return input.text;
  try {
    const visible = JSON.parse(input.text) as unknown;
    if (['web_fetch', 'bash', 'task_stop', 'skill'].includes(input.toolName)) {
      return JSON.stringify(withoutToolArtifactPaths(visible), null, 2);
    }
    if (input.toolName !== GENERATE_IMAGE_TOOL_NAME) return input.text;
    if (
      !isRecord(visible)
      || visible.ok !== true
      || !isRecord(visible.data)
      || !Array.isArray(visible.data.images)
    ) return input.text;
    if (visible.data.images.length === 0) return input.text;
    const images = visible.data.images.map((image) => {
      if (!isRecord(image)) return image;
      const persisted = { ...image };
      delete persisted.path;
      return persisted;
    });
    return JSON.stringify({
      ...visible,
      data: { ...visible.data, images },
      instructions: 'Generated images shown with this result are saved in the conversation; do not render them again. Use the adjacent readable path for file operations when available.',
    }, null, 2);
  } catch {
    return input.text;
  }
}

function withoutToolArtifactPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutToolArtifactPaths);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
    (key === 'filePath' || key === 'temporaryOutputPath') && typeof entry === 'string'
      ? []
      : [[key, withoutToolArtifactPaths(entry)]]
  )));
}

function persistedGenerateImageDetails(details: ToolEnvelope): ToolEnvelope<PersistedGeneratedImageDetailsData> | undefined {
  if (!details.ok || !isRecord(details.data)) return undefined;
  const providerId = requiredString(details.data.providerId);
  const modelId = requiredString(details.data.modelId);
  const modelName = requiredString(details.data.modelName);
  if (!providerId || !modelId || !modelName || !Array.isArray(details.data.images)) return undefined;

  const images = details.data.images.flatMap((image): PersistedGeneratedImageDetailsImage[] => {
    const slim = persistedGeneratedImage(image);
    return slim ? [slim] : [];
  });
  if (images.length === 0) return undefined;

  return {
    ok: true,
    tool: GENERATE_IMAGE_TOOL_NAME,
    version: TOOL_RESULT_VERSION,
    status: details.status,
    data: {
      providerId,
      modelId,
      modelName,
      images,
    },
  };
}

function persistedGeneratedImage(image: unknown): PersistedGeneratedImageDetailsImage | null {
  if (!isRecord(image)) return null;
  const providerIndex = optionalPositiveInteger(image.providerIndex);
  if (providerIndex === undefined || image.artifactRef === undefined) return null;
  let artifactRef: ThreadImageArtifactReference;
  try {
    artifactRef = decodeThreadImageArtifactReference(image.artifactRef, 'generatedImage.artifactRef');
  } catch {
    return null;
  }
  const mimeType = optionalString(image.mimeType);
  const byteLength = optionalPositiveNumber(image.byteLength);
  const width = optionalPositiveNumber(image.width);
  const height = optionalPositiveNumber(image.height);
  return {
    providerIndex,
    artifactRef,
    ...(mimeType ? { mimeType } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
