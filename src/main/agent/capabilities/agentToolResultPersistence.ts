import {
  GENERATE_IMAGE_TOOL_NAME,
} from './agentImageGenerationTool';
import {
  isToolEnvelope,
  TOOL_RESULT_VERSION,
  type ToolEnvelope,
} from './agentToolEnvelope';

export interface PersistedToolResultDetailsInput {
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
  mimeType?: string;
  byteLength?: number;
  width?: number;
  height?: number;
}

export function persistedToolResultDetails(input: PersistedToolResultDetailsInput): unknown | undefined {
  const details = input.details;
  if (!isToolEnvelope(details)) return undefined;
  if (input.toolName !== GENERATE_IMAGE_TOOL_NAME || details.tool !== GENERATE_IMAGE_TOOL_NAME) return undefined;
  return persistedGenerateImageDetails(details);
}

export function persistedToolResultText(input: {
  readonly toolName: string;
  readonly text: string;
}): string {
  if (input.toolName !== GENERATE_IMAGE_TOOL_NAME) return input.text;
  try {
    const visible = JSON.parse(input.text) as unknown;
    if (
      !isRecord(visible)
      || visible.ok !== true
      || !isRecord(visible.data)
      || !Array.isArray(visible.data.images)
    ) {
      return input.text;
    }
    return JSON.stringify({
      ...visible,
      data: {
        ...visible.data,
        images: visible.data.images.flatMap((image): PersistedGeneratedImageDetailsImage[] => {
          const persisted = persistedGeneratedImage(image);
          return persisted ? [persisted] : [];
        }),
      },
      instructions: 'Generated images shown with this result are saved in the conversation; do not render them again. Use an adjacent readable_path for file operations when available.',
    }, null, 2);
  } catch {
    return input.text;
  }
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
  const mimeType = optionalString(image.mimeType);
  const byteLength = optionalPositiveNumber(image.byteLength);
  const width = optionalPositiveNumber(image.width);
  const height = optionalPositiveNumber(image.height);
  if (!mimeType && byteLength === undefined && width === undefined && height === undefined) return null;
  return {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
