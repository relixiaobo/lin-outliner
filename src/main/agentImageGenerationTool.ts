import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantImages, ImagesContext, ImageContent as PiImageContent, TextContent as PiTextContent } from '@earendil-works/pi-ai';
import type { AgentPayloadRef } from '../core/agentEventLog';
import {
  agentToolResult,
  errorEnvelope,
  isToolEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import { readAgentImageDimensions } from './agentLocalTools';

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

const MAX_IMAGE_REFS = 4;
const MAX_GENERATED_IMAGES = 4;
const MAX_PROMPT_CHARS = 32_000;

export interface AgentImageGenerationModel {
  providerId: string;
  id: string;
  name: string;
  input: ('text' | 'image')[];
  output: ('text' | 'image')[];
}

export interface AgentImageGenerationInputImage {
  data: Buffer;
  mimeType: string;
  label?: string;
}

export interface AgentImageGenerationRuntime {
  listModels(): Promise<AgentImageGenerationModel[]>;
  getActiveProviderId(): Promise<string | null>;
  getDefaultModel?(): Promise<string | null>;
  validateOptions?(input: {
    providerId: string;
    modelId: string;
    options: GenerateImageRuntimeOptions;
  }): AgentImageGenerationOptionValidationIssue | null;
  readPayloadImage(input: { payloadId: string; runId?: string }): Promise<AgentImageGenerationInputImage>;
  readLocalImage(input: { filePath: string }): Promise<AgentImageGenerationInputImage>;
  writeGeneratedImage(input: {
    toolCallId: string;
    index: number;
    providerId: string;
    modelId: string;
    data: Buffer;
    mimeType: string;
    prompt: string;
  }): Promise<AgentPayloadRef>;
  generateImages(input: {
    providerId: string;
    modelId: string;
    context: ImagesContext;
    options: GenerateImageRuntimeOptions;
  }): Promise<AssistantImages>;
}

export interface GenerateImageRuntimeOptions {
  signal?: AbortSignal;
  baseUrl?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
}

export interface AgentImageGenerationOptionValidationIssue {
  code: string;
  message: string;
  instructions?: string;
}

export interface GenerateImageData {
  providerId: string;
  modelId: string;
  modelName: string;
  images: GeneratedImageResult[];
  text: string[];
  promptPreview: string;
}

export interface GeneratedImageResult {
  payload: AgentPayloadRef;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
}

interface NormalizedGenerateImageParams {
  prompt: string;
  model?: string;
  count: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  imageRefs: NormalizedImageRef[];
}

type NormalizedImageRef =
  | { kind: 'path'; filePath: string }
  | { kind: 'payload'; payloadId: string; runId?: string };

export function createGenerateImageTool(runtime: AgentImageGenerationRuntime): AgentTool<any, ToolEnvelope<GenerateImageData>> {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    label: 'Generate Image',
    description: [
      'Generate or edit raster images with an enabled image-capable provider.',
      'Use this for original bitmap assets such as illustrations, photos, mockups, textures, and UI artwork. Do not use it for web image search or file conversion.',
      'Omit model to use the best enabled image model. Omit image_refs for text-to-image; pass image_refs only when editing or transforming existing images.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_PROMPT_CHARS,
          description: 'Required visual instruction for generation or editing. Include subject, style, composition, text to render, and constraints the image must follow.',
        },
        model: {
          type: 'string',
          minLength: 1,
          description: 'Optional image model id. Use a bare model id when unambiguous, or provider:model / provider/model to select a provider explicitly. Omit or pass auto to use the default enabled image model.',
        },
        image_refs: {
          type: 'array',
          maxItems: MAX_IMAGE_REFS,
          description: 'Optional source images for edits or transformations. Each item may be a workspace path, payload:<id>, { path }, or { payload_id, run_id }. Omit for text-to-image.',
          items: {
            anyOf: [
              { type: 'string', minLength: 1, description: 'Workspace file path or payload:<id> image reference.' },
              {
                type: 'object',
                additionalProperties: false,
                anyOf: [
                  { required: ['path'] },
                  { required: ['payload_id'] },
                ],
                properties: {
                  path: { type: 'string', minLength: 1, description: 'Workspace image path to read and send as edit input.' },
                  payload_id: { type: 'string', minLength: 1, description: 'Agent payload id for a previously stored image.' },
                  run_id: { type: 'string', minLength: 1, description: 'Optional run id when reading an image payload from another run.' },
                },
              },
            ],
          },
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_GENERATED_IMAGES,
          description: `Optional number of images to request. Default 1, max ${MAX_GENERATED_IMAGES}. Providers may still return fewer images.`,
        },
        size: {
          type: 'string',
          description: 'Optional provider-specific output size. Examples: OpenAI 1024x1024, 1536x1024, 1024x1536, or a supported WIDTHxHEIGHT value for gpt-image-2; Google image size hints include 1K, 2K, and 4K. Omit for provider default.',
        },
        aspect_ratio: {
          type: 'string',
          description: 'Optional provider-specific aspect ratio, for example 1:1, 16:9, 9:16, 4:3, or 3:4. Use mainly for providers that expose aspect ratio separately from size. Omit for provider default.',
        },
        quality: {
          type: 'string',
          enum: ['auto', 'low', 'medium', 'high'],
          description: 'Optional quality or speed hint. Use low for drafts, medium/high for final assets, or auto for provider choice. Omit for provider default.',
        },
        background: {
          type: 'string',
          enum: ['auto', 'opaque', 'transparent'],
          description: 'Optional background hint. Use transparent only with models that support transparency; otherwise omit, use auto, or use opaque.',
        },
        output_format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: 'Optional requested output file format where supported. OpenAI defaults to png; jpeg and webp are useful when smaller files matter. Omit for provider default.',
        },
      },
    } as any,
    executionMode: 'sequential',
    execute: async (toolCallId, rawParams: unknown, signal) => {
      const startedAt = Date.now();
      const normalized = normalizeGenerateImageParams(rawParams);
      if (!normalized.ok) {
        return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, normalized.code, normalized.message, {
          metrics: { durationMs: elapsed(startedAt) },
        }));
      }

      const params = normalized.params;
      try {
        const models = await runtime.listModels();
        const activeProviderId = await runtime.getActiveProviderId();
        const defaultModel = params.model ? null : (await runtime.getDefaultModel?.() ?? null);
        const selected = selectImageModel(models, params.model ?? defaultModel ?? undefined, activeProviderId)
          ?? (!params.model && defaultModel ? selectImageModel(models, undefined, activeProviderId) : null);
        if (!selected) {
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'no_image_model', noImageModelMessage(params.model), {
            instructions: 'Enable an image-capable provider such as OpenAI, Google Gemini, or OpenRouter in Settings > Providers.',
            metrics: { durationMs: elapsed(startedAt) },
          }));
        }

        const options = {
          signal,
          count: params.count,
          size: params.size,
          aspectRatio: params.aspectRatio,
          quality: params.quality,
          background: params.background,
          outputFormat: params.outputFormat,
        };
        const optionIssue = runtime.validateOptions?.({
          providerId: selected.providerId,
          modelId: selected.id,
          options,
        });
        if (optionIssue) {
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, optionIssue.code, optionIssue.message, {
            instructions: optionIssue.instructions,
            metrics: { durationMs: elapsed(startedAt) },
          }));
        }

        const inputImages = await Promise.all(params.imageRefs.map((ref) => resolveImageRef(runtime, ref)));
        if (inputImages.length > 0 && !selected.input.includes('image')) {
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'model_does_not_accept_images', `${selected.name} does not accept input images.`, {
            instructions: 'Use a model whose capability lists image input, or remove image_refs.',
            metrics: { durationMs: elapsed(startedAt) },
          }));
        }

        const context: ImagesContext = {
          input: [
            { type: 'text', text: params.prompt } satisfies PiTextContent,
            ...inputImages.map((image): PiImageContent => ({
              type: 'image',
              data: image.data.toString('base64'),
              mimeType: image.mimeType,
            })),
          ],
        };
        const response = await runtime.generateImages({
          providerId: selected.providerId,
          modelId: selected.id,
          context,
          options,
        });
        if (response.stopReason === 'error') {
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'provider_error', response.errorMessage ?? 'Image generation failed.', {
            metrics: { durationMs: elapsed(startedAt) },
          }));
        }

        const imageOutputs = response.output.filter((part): part is PiImageContent => part.type === 'image');
        const textOutputs = response.output.filter((part): part is PiTextContent => part.type === 'text').map((part) => part.text);
        if (imageOutputs.length === 0) {
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'no_image_output', 'The provider returned no image output.', {
            data: {
              providerId: selected.providerId,
              modelId: selected.id,
              modelName: selected.name,
              images: [],
              text: textOutputs,
              promptPreview: promptPreview(params.prompt),
            },
            metrics: { durationMs: elapsed(startedAt) },
          }));
        }

        const images = await Promise.all(imageOutputs.map(async (image, index): Promise<GeneratedImageResult> => {
          const data = Buffer.from(stripDataUrlPrefix(image.data), 'base64');
          const dimensions = readAgentImageDimensions(data, image.mimeType);
          const payload = await runtime.writeGeneratedImage({
            toolCallId,
            index,
            providerId: selected.providerId,
            modelId: selected.id,
            data,
            mimeType: image.mimeType,
            prompt: params.prompt,
          });
          return {
            payload: dimensions ? { ...payload, display: dimensions } : payload,
            mimeType: image.mimeType,
            byteLength: data.byteLength,
            ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
          };
        }));

        const data: GenerateImageData = {
          providerId: selected.providerId,
          modelId: selected.id,
          modelName: selected.name,
          images,
          text: textOutputs,
          promptPreview: promptPreview(params.prompt),
        };
        return agentToolResult(
          successEnvelope(GENERATE_IMAGE_TOOL_NAME, data, {
            metrics: {
              durationMs: elapsed(startedAt),
              outputBytes: images.reduce((total, image) => total + image.byteLength, 0),
            },
          }),
          modelVisibleGenerateImageData(data),
          imageOutputs,
        );
      } catch (error) {
        return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'image_generation_failed', errorMessage(error), {
          metrics: { durationMs: elapsed(startedAt) },
        }));
      }
    },
  };
}

export function generateImagePayloadsFromDetails(details: unknown): AgentPayloadRef[] | null {
  if (!isToolEnvelope(details) || details.tool !== GENERATE_IMAGE_TOOL_NAME || !details.ok) return null;
  const data = details.data as { images?: unknown } | undefined;
  if (!data || !Array.isArray(data.images)) return null;
  const payloads = data.images
    .map((image) => image && typeof image === 'object' ? (image as { payload?: unknown }).payload : undefined)
    .filter(isAgentPayloadRef);
  return payloads.length > 0 ? payloads : null;
}

function normalizeGenerateImageParams(rawParams: unknown):
  | { ok: true; params: NormalizedGenerateImageParams }
  | { ok: false; code: string; message: string } {
  const record = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
    ? rawParams as Record<string, unknown>
    : {};
  const prompt = stringParam(record.prompt);
  if (!prompt) return { ok: false, code: 'missing_prompt', message: 'generate_image requires a prompt.' };
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, code: 'prompt_too_large', message: `Prompt is too large. Maximum ${MAX_PROMPT_CHARS} characters.` };
  }
  const imageRefs = normalizeImageRefs(record.image_refs);
  if (!imageRefs.ok) return imageRefs;
  return {
    ok: true,
    params: {
      prompt,
      model: normalizeModelParam(record.model),
      count: clampInteger(record.count, 1, MAX_GENERATED_IMAGES, 1),
      size: stringParam(record.size),
      aspectRatio: stringParam(record.aspect_ratio),
      quality: stringParam(record.quality),
      background: stringParam(record.background),
      outputFormat: stringParam(record.output_format),
      imageRefs: imageRefs.refs,
    },
  };
}

function normalizeImageRefs(raw: unknown):
  | { ok: true; refs: NormalizedImageRef[] }
  | { ok: false; code: string; message: string } {
  if (raw === undefined || raw === null) return { ok: true, refs: [] };
  if (!Array.isArray(raw)) return { ok: false, code: 'invalid_image_refs', message: 'image_refs must be an array.' };
  if (raw.length > MAX_IMAGE_REFS) return { ok: false, code: 'too_many_image_refs', message: `At most ${MAX_IMAGE_REFS} input images are supported.` };
  const refs: NormalizedImageRef[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const value = item.trim();
      if (!value) continue;
      refs.push(value.startsWith('payload:') ? { kind: 'payload', payloadId: value.slice('payload:'.length).trim() } : { kind: 'path', filePath: value });
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const filePath = stringParam(record.path);
      const payloadId = stringParam(record.payload_id);
      if (filePath && payloadId) return { ok: false, code: 'invalid_image_ref', message: 'Each image_ref may specify either path or payload_id, not both.' };
      if (filePath) refs.push({ kind: 'path', filePath });
      else if (payloadId) refs.push({ kind: 'payload', payloadId, runId: stringParam(record.run_id) });
      else return { ok: false, code: 'invalid_image_ref', message: 'Each image_ref object needs path or payload_id.' };
      continue;
    }
    return { ok: false, code: 'invalid_image_ref', message: 'Each image_ref must be a path string, payload:<id>, or object.' };
  }
  return { ok: true, refs };
}

async function resolveImageRef(runtime: AgentImageGenerationRuntime, ref: NormalizedImageRef): Promise<AgentImageGenerationInputImage> {
  return ref.kind === 'payload'
    ? runtime.readPayloadImage({ payloadId: ref.payloadId, runId: ref.runId })
    : runtime.readLocalImage({ filePath: ref.filePath });
}

function selectImageModel(
  models: readonly AgentImageGenerationModel[],
  requested: string | undefined,
  activeProviderId: string | null,
): AgentImageGenerationModel | null {
  if (requested) return selectRequestedImageModel(models, requested, activeProviderId);
  const priority = providerPriority(activeProviderId);
  return [...models].sort((left, right) => priorityIndex(priority, left.providerId) - priorityIndex(priority, right.providerId))[0] ?? null;
}

function selectRequestedImageModel(
  models: readonly AgentImageGenerationModel[],
  requestedInput: string,
  activeProviderId: string | null,
): AgentImageGenerationModel | null {
  const requested = requestedInput.trim();
  for (const model of models) {
    if (requested === `${model.providerId}:${model.id}` || requested === `${model.providerId}/${model.id}`) return model;
  }
  const exact = models.filter((model) => model.id === requested);
  if (exact.length <= 1) return exact[0] ?? null;
  const priority = providerPriority(activeProviderId);
  return exact.sort((left, right) => priorityIndex(priority, left.providerId) - priorityIndex(priority, right.providerId))[0] ?? null;
}

function providerPriority(activeProviderId: string | null): string[] {
  return [...new Set([activeProviderId, 'openai', 'google', 'openrouter'].filter((value): value is string => Boolean(value)))];
}

function priorityIndex(priority: readonly string[], providerId: string): number {
  const index = priority.indexOf(providerId);
  return index >= 0 ? index : priority.length;
}

function noImageModelMessage(requested: string | undefined): string {
  return requested
    ? `No enabled image model matched ${requested}.`
    : 'No enabled image-capable provider is configured.';
}

function modelVisibleGenerateImageData(data: GenerateImageData) {
  return {
    images: data.images.map((image) => ({
      payloadId: image.payload.id,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
    })),
    ...(data.text.length ? { text: data.text } : {}),
  };
}

function isAgentPayloadRef(value: unknown): value is AgentPayloadRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentPayloadRef>;
  return candidate.kind === 'payload_ref'
    && typeof candidate.id === 'string'
    && candidate.storage === 'file'
    && typeof candidate.mimeType === 'string'
    && typeof candidate.byteLength === 'number'
    && typeof candidate.sha256 === 'string';
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeModelParam(value: unknown): string | undefined {
  const model = stringParam(value);
  return model && model.toLowerCase() !== 'auto' ? model : undefined;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function promptPreview(prompt: string): string {
  return prompt.length > 160 ? `${prompt.slice(0, 157)}...` : prompt;
}

function stripDataUrlPrefix(value: string): string {
  const marker = ';base64,';
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
