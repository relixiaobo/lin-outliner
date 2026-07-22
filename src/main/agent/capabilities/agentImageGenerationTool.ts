import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantImages, ImagesContext, ImageContent as PiImageContent, TextContent as PiTextContent } from '@earendil-works/pi-ai';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import { readAgentImageDimensions } from './agentLocalTools';
import {
  formatLocalFileReferenceUrl,
  parseLocalFileReferenceUrl,
  splitFileReferenceMarkers,
  type FileReferenceSegment,
} from '../../../core/referenceMarkup';

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

const MAX_IMAGE_PATHS = 4;
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
  readLocalImage(input: { filePath: string }): Promise<AgentImageGenerationInputImage>;
  writeGeneratedImage(input: {
    toolCallId: string;
    index: number;
    providerId: string;
    modelId: string;
    data: Buffer;
    mimeType: string;
    prompt: string;
  }): Promise<{ path: string }>;
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
  path: string;
  markdownImage: string;
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
  imagePaths: string[];
}

export function createGenerateImageTool(runtime: AgentImageGenerationRuntime): AgentTool<any, ToolEnvelope<GenerateImageData>> {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    label: 'Generate Image',
    description: [
      'Generate or edit raster images with an enabled image-capable provider.',
      'Use this for original bitmap assets such as illustrations, photos, mockups, textures, and UI artwork. Do not use it for web image search or file conversion.',
      'Omit model to use the best enabled image model. Omit image_paths for text-to-image; pass image_paths only when editing or transforming existing local images. When the user should see generated images, place the returned markdownImage exactly where each image belongs in the final answer.',
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
        image_paths: {
          type: 'array',
          maxItems: MAX_IMAGE_PATHS,
          description: 'Optional local image paths for edits or transformations. Use path values or markdownImage values returned by earlier tool results, absolute paths, or workspace-relative paths for user files. Omit for text-to-image.',
          items: { type: 'string', minLength: 1, description: 'Readable local image path, file:^... target, Markdown image, or [[file:...]] marker to use as an edit/reference input.' },
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

        if (params.imagePaths.length > 0 && !selected.input.includes('image')) {
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'model_does_not_accept_images', `${selected.name} does not accept input images.`, {
            instructions: 'Use a model whose capability lists image input, or remove image_paths.',
            metrics: { durationMs: elapsed(startedAt) },
          }));
        }
        const inputImages = await readInputImages(runtime, params.imagePaths);
        if (!inputImages.ok) {
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'input_image_unavailable', `Input image is not readable: ${inputImages.path}. ${inputImages.message}`, {
            instructions: 'Use an existing local image path, regenerate the missing image, or remove image_paths for text-to-image.',
            metrics: { durationMs: elapsed(startedAt) },
          }));
        }

        const context: ImagesContext = {
          input: [
            { type: 'text', text: params.prompt } satisfies PiTextContent,
            ...inputImages.images.map((image): PiImageContent => ({
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
          const providerError = classifyImageProviderError(response.errorMessage ?? 'Image generation failed.');
          return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, providerError.code, providerError.message, {
            instructions: providerError.instructions,
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
          const saved = await runtime.writeGeneratedImage({
            toolCallId,
            index,
            providerId: selected.providerId,
            modelId: selected.id,
            data,
            mimeType: image.mimeType,
            prompt: params.prompt,
          });
          return {
            path: saved.path,
            markdownImage: `![${generatedImageAlt(index)}](${formatLocalFileReferenceUrl(saved.path)})`,
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
            instructions: 'Use each returned markdownImage value verbatim to place generated images in the final answer. Use path or markdownImage in image_paths for follow-up edits.',
            metrics: {
              durationMs: elapsed(startedAt),
              outputBytes: images.reduce((total, image) => total + image.byteLength, 0),
            },
          }),
          modelVisibleGenerateImageData(data),
        );
      } catch (error) {
        return agentToolResult(errorEnvelope(GENERATE_IMAGE_TOOL_NAME, 'image_generation_failed', errorMessage(error), {
          metrics: { durationMs: elapsed(startedAt) },
        }));
      }
    },
  };
}

function classifyImageProviderError(message: string): { code: string; message: string; instructions?: string } {
  if (isImageRateLimitError(message)) {
    return {
      code: 'rate_limited',
      message,
      instructions: 'The selected image provider is rate-limited or out of quota. Do not retry immediately; ask the user to wait, switch the default image model to another enabled provider, or update the provider quota/key.',
    };
  }
  return { code: 'provider_error', message };
}

async function readInputImages(
  runtime: AgentImageGenerationRuntime,
  imagePaths: string[],
): Promise<
  | { ok: true; images: AgentImageGenerationInputImage[] }
  | { ok: false; path: string; message: string }
> {
  const images: AgentImageGenerationInputImage[] = [];
  for (const filePath of imagePaths) {
    try {
      images.push(await runtime.readLocalImage({ filePath }));
    } catch (error) {
      return { ok: false, path: filePath, message: errorMessage(error) };
    }
  }
  return { ok: true, images };
}

function isImageRateLimitError(message: string): boolean {
  return /\\b429\\b|rate.?limit|usage_limit|quota|weekly_limit/i.test(message);
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
  const imagePaths = normalizeImagePaths(record.image_paths);
  if (!imagePaths.ok) return imagePaths;
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
      imagePaths: imagePaths.paths,
    },
  };
}

function normalizeImagePaths(raw: unknown):
  | { ok: true; paths: string[] }
  | { ok: false; code: string; message: string } {
  if (raw === undefined || raw === null) return { ok: true, paths: [] };
  if (!Array.isArray(raw)) return { ok: false, code: 'invalid_image_paths', message: 'image_paths must be an array.' };
  if (raw.length > MAX_IMAGE_PATHS) return { ok: false, code: 'too_many_image_paths', message: `At most ${MAX_IMAGE_PATHS} input images are supported.` };
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const value = item.trim();
      if (!value) continue;
      paths.push(normalizeImagePathValue(value));
      continue;
    }
    return { ok: false, code: 'invalid_image_path', message: 'Each image_paths item must be a local image path string.' };
  }
  return { ok: true, paths };
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
      path: image.path,
      markdownImage: image.markdownImage,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
    })),
    ...(data.text.length ? { text: data.text } : {}),
  };
}

function normalizeImagePathValue(value: string): string {
  const fileUrl = parseLocalFileReferenceUrl(value);
  if (fileUrl?.entryKind === 'file') return fileUrl.path;
  const markdownTarget = markdownImageTarget(value);
  if (markdownTarget) {
    const markdownFileUrl = parseLocalFileReferenceUrl(markdownTarget);
    if (markdownFileUrl?.entryKind === 'file') return markdownFileUrl.path;
  }
  const segments = splitFileReferenceMarkers(value);
  const files = segments.filter((segment): segment is FileReferenceSegment => segment.type === 'file');
  if (files.length !== 1) return value;
  const text = segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.text)
    .join('');
  if (text === '' || text === '!' || text.trim() === '') return files[0]!.path;
  return value;
}

function markdownImageTarget(value: string): string | null {
  const match = value.match(/^!\[[^\]\r\n]*\]\(([^()\s]+)\)$/u);
  return match?.[1] ?? null;
}

function generatedImageAlt(index: number): string {
  return `Generated image ${index + 1}`;
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
