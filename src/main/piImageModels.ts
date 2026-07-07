import { GoogleGenAI, Modality, type GenerateContentResponse, type Part } from '@google/genai';
import OpenAI, { toFile, type Uploadable } from 'openai';
import {
  createImagesProvider,
  envApiKeyAuth,
  type AssistantImages,
  type ImagesApi,
  type ImagesContext,
  type ImagesModel,
  type ImagesOptions,
  type ImagesOutputContent,
  type MutableImagesModels,
  type Usage,
} from '@earendil-works/pi-ai';
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';
import { piCredentialStore } from './piModels';

const OPENAI_IMAGES_API = 'openai-images';
const GOOGLE_IMAGES_API = 'google-images';
const OPENAI_IMAGES_PROVIDER_ID = 'openai';
const GOOGLE_IMAGES_PROVIDER_ID = 'google';

export type TenonImageModelOption = {
  providerId: string;
  id: string;
  name: string;
  input: ('text' | 'image')[];
  output: ('text' | 'image')[];
};

export interface TenonImagesOptions extends ImagesOptions {
  count?: number;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
}

export interface TenonImagesOptionValidationIssue {
  code: 'unsupported_option';
  message: string;
  instructions?: string;
}

let imagesModelsInstance: MutableImagesModels | null = null;

export function piImageModels(): MutableImagesModels {
  if (!imagesModelsInstance) {
    const models = builtinImagesModels({ credentials: piCredentialStore() });
    models.setProvider(createOpenAiImagesProvider());
    models.setProvider(createGoogleImagesProvider());
    imagesModelsInstance = models;
  }
  return imagesModelsInstance;
}

export function piImageProviders(): string[] {
  return piImageModels().getProviders().map((provider) => provider.id);
}

export function piImageModelsForProvider(providerId: string): ImagesModel<ImagesApi>[] {
  return piImageModels().getModels(providerId) as ImagesModel<ImagesApi>[];
}

export function piFindImageModel(providerId: string, modelId: string): ImagesModel<ImagesApi> | null {
  return piImageModels().getModel(providerId, modelId) as ImagesModel<ImagesApi> | undefined ?? null;
}

export async function piRefreshImageModels(providerId?: string): Promise<void> {
  await piImageModels().refresh(providerId);
}

export async function piGenerateImages(
  model: ImagesModel<ImagesApi>,
  context: ImagesContext,
  options?: TenonImagesOptions,
): Promise<AssistantImages> {
  return piImageModels().generateImages(model, context, options);
}

export function validateImageGenerationOptions(
  providerId: string,
  modelId: string,
  options?: TenonImagesOptions,
): TenonImagesOptionValidationIssue | null {
  if (providerId === OPENAI_IMAGES_PROVIDER_ID) return validateOpenAiImageOptions(modelId, options);
  return null;
}

export function imageModelOptionsForProvider(providerId: string): TenonImageModelOption[] {
  return piImageModelsForProvider(providerId).map((model) => ({
    providerId,
    id: model.id,
    name: model.name,
    input: [...model.input],
    output: [...model.output],
  }));
}

function createOpenAiImagesProvider() {
  return createImagesProvider({
    id: OPENAI_IMAGES_PROVIDER_ID,
    name: 'OpenAI',
    auth: { apiKey: envApiKeyAuth('OpenAI API key', ['OPENAI_API_KEY']) },
    models: OPENAI_IMAGE_MODELS,
    api: { generateImages: generateOpenAiImages },
  });
}

function createGoogleImagesProvider() {
  return createImagesProvider({
    id: GOOGLE_IMAGES_PROVIDER_ID,
    name: 'Google Gemini',
    auth: { apiKey: envApiKeyAuth('Gemini API key', ['GEMINI_API_KEY']) },
    models: GOOGLE_IMAGE_MODELS,
    api: { generateImages: generateGoogleImages },
  });
}

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OPENAI_IMAGE_MODELS = [
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    api: OPENAI_IMAGES_API,
    provider: OPENAI_IMAGES_PROVIDER_ID,
    baseUrl: 'https://api.openai.com/v1',
    input: ['text', 'image'],
    output: ['image'],
    cost: ZERO_COST,
  },
  {
    id: 'gpt-image-1.5',
    name: 'GPT Image 1.5',
    api: OPENAI_IMAGES_API,
    provider: OPENAI_IMAGES_PROVIDER_ID,
    baseUrl: 'https://api.openai.com/v1',
    input: ['text', 'image'],
    output: ['image'],
    cost: ZERO_COST,
  },
] satisfies ImagesModel<typeof OPENAI_IMAGES_API>[];

const GOOGLE_IMAGE_MODELS = [
  {
    id: 'gemini-3.1-flash-image',
    name: 'Nano Banana',
    api: GOOGLE_IMAGES_API,
    provider: GOOGLE_IMAGES_PROVIDER_ID,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    input: ['text', 'image'],
    output: ['text', 'image'],
    cost: ZERO_COST,
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    name: 'Nano Banana Lite',
    api: GOOGLE_IMAGES_API,
    provider: GOOGLE_IMAGES_PROVIDER_ID,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    input: ['text', 'image'],
    output: ['text', 'image'],
    cost: ZERO_COST,
  },
  {
    id: 'gemini-3-pro-image',
    name: 'Gemini 3 Pro Image',
    api: GOOGLE_IMAGES_API,
    provider: GOOGLE_IMAGES_PROVIDER_ID,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    input: ['text', 'image'],
    output: ['text', 'image'],
    cost: ZERO_COST,
  },
  {
    id: 'gemini-2.5-flash-image',
    name: 'Gemini 2.5 Flash Image',
    api: GOOGLE_IMAGES_API,
    provider: GOOGLE_IMAGES_PROVIDER_ID,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    input: ['text', 'image'],
    output: ['text', 'image'],
    cost: ZERO_COST,
  },
] satisfies ImagesModel<typeof GOOGLE_IMAGES_API>[];

export function openAiImageRequestParams(modelId: string, prompt: string, options?: TenonImagesOptions): Record<string, unknown> {
  return definedObject({
    model: modelId,
    prompt,
    n: imageCount(options?.count),
    size: openAiSize(modelId, options?.size),
    quality: openAiQuality(options?.quality),
    background: openAiBackground(options?.background),
    output_format: openAiOutputFormat(options?.outputFormat),
  });
}

async function generateOpenAiImages(
  model: ImagesModel<ImagesApi>,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const startedAt = Date.now();
  const requestOptions = options as TenonImagesOptions | undefined;
  if (!requestOptions?.apiKey) return imageGenerationError(model, 'OpenAI image generation requires an API key.', startedAt);
  const prompt = promptText(context);
  if (!prompt) return imageGenerationError(model, 'Image generation requires a non-empty prompt.', startedAt);

  const imageInputs = context.input.filter((part) => part.type === 'image');
  const outputFormat = openAiOutputFormat(requestOptions?.outputFormat);
  const requestParams = openAiImageRequestParams(model.id, prompt, requestOptions);
  const client = new OpenAI({
    apiKey: requestOptions.apiKey,
    timeout: requestOptions.timeoutMs,
    maxRetries: requestOptions.maxRetries,
  });

  try {
    const response = imageInputs.length > 0
      ? await client.images.edit({
          image: await Promise.all(imageInputs.map((image, index) => (
            toFile(Buffer.from(stripDataUrlPrefix(image.data), 'base64'), `input-${index}.${extensionForMime(image.mimeType)}`, {
              type: image.mimeType,
            })
          ))) as Uploadable[],
          ...requestParams,
        } as any, { signal: requestOptions.signal })
      : await client.images.generate(requestParams as any, { signal: requestOptions.signal });

    const output = await openAiImageOutput(response as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[]; output_format?: string; usage?: unknown }, outputFormat, requestOptions?.signal);
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output,
      usage: usageFromOpenAi((response as { usage?: unknown }).usage),
      stopReason: 'stop',
      timestamp: Date.now(),
    };
  } catch (error) {
    return imageGenerationError(model, errorMessage(error), startedAt);
  }
}

async function generateGoogleImages(
  model: ImagesModel<ImagesApi>,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const startedAt = Date.now();
  const requestOptions = options as TenonImagesOptions | undefined;
  if (!requestOptions?.apiKey) return imageGenerationError(model, 'Gemini image generation requires an API key.', startedAt);
  const prompt = promptText(context);
  if (!prompt) return imageGenerationError(model, 'Image generation requires a non-empty prompt.', startedAt);

  const ai = new GoogleGenAI({ apiKey: requestOptions.apiKey });
  const parts: Part[] = context.input.map((part): Part => {
    if (part.type === 'text') return { text: part.text };
    return {
      inlineData: {
        data: stripDataUrlPrefix(part.data),
        mimeType: part.mimeType,
      },
    };
  });

  try {
    const response = await ai.models.generateContent({
      model: model.id,
      contents: [{ role: 'user', parts }] as any,
      config: {
        abortSignal: requestOptions.signal,
        candidateCount: imageCount(requestOptions.count),
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        imageConfig: googleImageConfig(requestOptions),
      },
    });
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      responseId: response.responseId,
      output: googleImageOutput(response),
      usage: usageFromGoogle(response),
      stopReason: 'stop',
      timestamp: Date.now(),
    };
  } catch (error) {
    return imageGenerationError(model, errorMessage(error), startedAt);
  }
}

async function openAiImageOutput(
  response: { data?: { b64_json?: string; url?: string; revised_prompt?: string }[]; output_format?: string },
  requestedFormat: 'png' | 'jpeg' | 'webp',
  signal?: AbortSignal,
): Promise<ImagesOutputContent[]> {
  const mimeType = mimeTypeForImageFormat(response.output_format ?? requestedFormat);
  const output: ImagesOutputContent[] = [];
  for (const item of response.data ?? []) {
    if (item.b64_json) output.push({ type: 'image', data: item.b64_json, mimeType });
    if (item.url) output.push(await imageContentFromUrl(item.url, signal));
    if (item.revised_prompt) output.push({ type: 'text', text: item.revised_prompt });
  }
  return output;
}

async function imageContentFromUrl(url: string, signal?: AbortSignal): Promise<ImagesOutputContent> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to fetch generated image URL: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  return { type: 'image', data: bytes.toString('base64'), mimeType };
}

function googleImageOutput(response: GenerateContentResponse): ImagesOutputContent[] {
  const output: ImagesOutputContent[] = [];
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        output.push({
          type: 'image',
          data: stripDataUrlPrefix(part.inlineData.data),
          mimeType: part.inlineData.mimeType ?? 'image/png',
        });
      }
      if (part.text?.trim()) output.push({ type: 'text', text: part.text.trim() });
    }
  }
  if (!output.some((part) => part.type === 'image') && response.data) {
    output.unshift({ type: 'image', data: stripDataUrlPrefix(response.data), mimeType: 'image/png' });
  }
  if (!output.some((part) => part.type === 'text') && response.text?.trim()) {
    output.push({ type: 'text', text: response.text.trim() });
  }
  return output;
}

function promptText(context: ImagesContext): string {
  return context.input
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function imageGenerationError(
  model: ImagesModel<ImagesApi>,
  message: string,
  timestamp = Date.now(),
): AssistantImages {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: 'error',
    errorMessage: message,
    timestamp,
  };
}

function usageFromOpenAi(raw: unknown): Usage | undefined {
  const usage = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!usage) return undefined;
  const input = numberOrZero(usage.input_tokens);
  const output = numberOrZero(usage.output_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || input + output;
  return emptyUsage({ input, output, totalTokens });
}

function usageFromGoogle(response: GenerateContentResponse): Usage | undefined {
  const usage = response.usageMetadata;
  if (!usage) return undefined;
  const input = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  const totalTokens = usage.totalTokenCount ?? input + output;
  return emptyUsage({ input, output, totalTokens });
}

function emptyUsage(input: { input: number; output: number; totalTokens: number }): Usage {
  return {
    input: input.input,
    output: input.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input.totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function googleImageConfig(options?: TenonImagesOptions) {
  const aspectRatio = supportedGoogleAspectRatio(options?.aspectRatio);
  const imageSize = supportedGoogleImageSize(options?.size);
  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
}

function imageCount(value: unknown): number {
  return clampInteger(value, 1, 4, 1);
}

const OPENAI_GPT_IMAGE_FIXED_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const;

function validateOpenAiImageOptions(modelId: string, options?: TenonImagesOptions): TenonImagesOptionValidationIssue | null {
  const requestedSize = normalizedString(options?.size);
  if (requestedSize && !openAiSize(modelId, requestedSize)) {
    return {
      code: 'unsupported_option',
      message: `Size "${requestedSize}" is not supported by ${modelId}.`,
      instructions: openAiSizeInstructions(modelId),
    };
  }
  return null;
}

function openAiSize(modelId: string, value: unknown): string | undefined {
  const size = normalizedString(value);
  if (!size) return undefined;
  if (modelId === 'gpt-image-2') return size === 'auto' || isOpenAiWidthHeightSize(size) ? size : undefined;
  return stringUnion(size, OPENAI_GPT_IMAGE_FIXED_SIZES);
}

function openAiSizeInstructions(modelId: string): string {
  return modelId === 'gpt-image-2'
    ? 'Use auto or a WIDTHxHEIGHT value, for example 1024x1024.'
    : `Use ${OPENAI_GPT_IMAGE_FIXED_SIZES.join(', ')}.`;
}

function isOpenAiWidthHeightSize(value: string): boolean {
  return /^\d+x\d+$/.test(value);
}

function openAiQuality(value: unknown): 'low' | 'medium' | 'high' | 'auto' | undefined {
  return stringUnion(value, ['low', 'medium', 'high', 'auto']);
}

function openAiBackground(value: unknown): 'transparent' | 'opaque' | 'auto' | undefined {
  return stringUnion(value, ['transparent', 'opaque', 'auto']);
}

function openAiOutputFormat(value: unknown): 'png' | 'jpeg' | 'webp' {
  return stringUnion(value, ['png', 'jpeg', 'webp']) ?? 'png';
}

function supportedGoogleAspectRatio(value: unknown): string | undefined {
  return stringUnion(value, ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9']);
}

function supportedGoogleImageSize(value: unknown): string | undefined {
  return stringUnion(value, ['1K', '2K', '4K']);
}

function stringUnion<const T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : undefined;
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

function definedObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function mimeTypeForImageFormat(format: string): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

function stripDataUrlPrefix(value: string): string {
  const marker = ';base64,';
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
