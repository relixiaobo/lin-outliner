import {
  GENERATE_IMAGE_TOOL_NAME,
} from './agentImageGenerationTool';
import {
  isToolEnvelope,
  TOOL_RESULT_VERSION,
  type ToolEnvelope,
} from './agentToolEnvelope';

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
  path: string;
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
  const path = requiredString(image.path);
  if (providerIndex === undefined || !path) return null;
  const mimeType = optionalString(image.mimeType);
  const byteLength = optionalPositiveNumber(image.byteLength);
  const width = optionalPositiveNumber(image.width);
  const height = optionalPositiveNumber(image.height);
  return {
    providerIndex,
    path,
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
