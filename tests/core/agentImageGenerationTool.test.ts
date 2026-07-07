import { describe, expect, test } from 'bun:test';
import {
  createGenerateImageTool,
  type AgentImageGenerationRuntime,
  type GenerateImageData,
} from '../../src/main/agentImageGenerationTool';
import type { ToolEnvelope } from '../../src/main/agentToolEnvelope';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP1j0wAAAABJRU5ErkJggg==';
const GENERATED_IMAGE_PATH = '/tmp/tenon/generated/image-0.png';

describe('generate_image tool', () => {
  test('returns generated image paths without embedding image bytes in the tool result', async () => {
    const writtenPaths: string[] = [];
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text', 'image'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'openai',
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async ({ index }) => {
        const path = `/tmp/tenon/generated/image-${index}.png`;
        writtenPaths.push(path);
        return { path };
      },
      generateImages: async ({ modelId }) => ({
        api: 'openai-images',
        provider: 'openai',
        model: modelId,
        output: [{ type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      }),
    };

    const tool = createGenerateImageTool(runtime);
    const result = await tool.execute('call-1', { prompt: 'A small red square' });
    const details = result.details as ToolEnvelope<GenerateImageData>;

    expect(details.ok).toBe(true);
    expect(details.tool).toBe('generate_image');
    expect(details.data?.providerId).toBe('openai');
    expect(details.data?.modelId).toBe('gpt-image-2');
    expect(details.data?.modelName).toBe('GPT Image 2');
    expect(details.data?.images).toHaveLength(1);
    expect(details.data?.images[0]?.path).toBe('/tmp/tenon/generated/image-0.png');
    expect(writtenPaths).toEqual(['/tmp/tenon/generated/image-0.png']);

    const text = result.content.find((part) => part.type === 'text');
    const image = result.content.find((part) => part.type === 'image');
    expect(image).toBeUndefined();
    if (!text || text.type !== 'text') throw new Error('Expected text result');
    expect(text.text).not.toContain(ONE_PIXEL_PNG_BASE64);
    expect(JSON.parse(text.text)).toEqual({
      ok: true,
      data: {
        images: [{
          path: '/tmp/tenon/generated/image-0.png',
          mimeType: 'image/png',
          byteLength: Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64').byteLength,
          width: 1,
          height: 1,
        }],
      },
      instructions: 'Use Markdown image syntax such as ![description](</absolute/path.png>) with the returned image paths to place images in the final answer when the user should see them.',
    });
  });

  test('treats model auto as the default selection', async () => {
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text', 'image'],
        output: ['image'],
      }, {
        providerId: 'google',
        id: 'gemini-3.1-flash-image',
        name: 'Nano Banana',
        input: ['text', 'image'],
        output: ['text', 'image'],
      }],
      getActiveProviderId: async () => 'google',
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async () => ({ path: GENERATED_IMAGE_PATH }),
      generateImages: async ({ providerId, modelId }) => ({
        api: `${providerId}-images`,
        provider: providerId,
        model: modelId,
        output: [{ type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      }),
    };

    const tool = createGenerateImageTool(runtime);
    const result = await tool.execute('call-2', { prompt: 'A tiny banana icon', model: 'auto' });
    const details = result.details as ToolEnvelope<GenerateImageData>;

    expect(details.ok).toBe(true);
    expect(details.data?.providerId).toBe('google');
    expect(details.data?.modelId).toBe('gemini-3.1-flash-image');
  });

  test('uses the saved default model before automatic provider priority', async () => {
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text', 'image'],
        output: ['image'],
      }, {
        providerId: 'google',
        id: 'gemini-3.1-flash-image',
        name: 'Nano Banana',
        input: ['text', 'image'],
        output: ['text', 'image'],
      }],
      getActiveProviderId: async () => 'openai',
      getDefaultModel: async () => 'google/gemini-3.1-flash-image',
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async () => ({ path: GENERATED_IMAGE_PATH }),
      generateImages: async ({ providerId, modelId }) => ({
        api: `${providerId}-images`,
        provider: providerId,
        model: modelId,
        output: [{ type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      }),
    };

    const tool = createGenerateImageTool(runtime);
    const result = await tool.execute('call-default', { prompt: 'A tiny banana icon' });
    const details = result.details as ToolEnvelope<GenerateImageData>;

    expect(details.ok).toBe(true);
    expect(details.data?.providerId).toBe('google');
    expect(details.data?.modelId).toBe('gemini-3.1-flash-image');
  });

  test('falls back to automatic selection when the saved default model is unavailable', async () => {
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text', 'image'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'openai',
      getDefaultModel: async () => 'google/gemini-3.1-flash-image',
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async () => ({ path: GENERATED_IMAGE_PATH }),
      generateImages: async ({ providerId, modelId }) => ({
        api: `${providerId}-images`,
        provider: providerId,
        model: modelId,
        output: [{ type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      }),
    };

    const tool = createGenerateImageTool(runtime);
    const result = await tool.execute('call-fallback', { prompt: 'A tiny icon' });
    const details = result.details as ToolEnvelope<GenerateImageData>;

    expect(details.ok).toBe(true);
    expect(details.data?.providerId).toBe('openai');
    expect(details.data?.modelId).toBe('gpt-image-2');
  });

  test('returns unsupported option errors before calling the image provider', async () => {
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-1.5',
        name: 'GPT Image 1.5',
        input: ['text', 'image'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'openai',
      validateOptions: ({ options }) => (
        options.size === '2048x1024'
          ? {
              code: 'unsupported_option',
              message: 'Size "2048x1024" is not supported by gpt-image-1.5.',
              instructions: 'Use auto, 1024x1024, 1024x1536, 1536x1024.',
            }
          : null
      ),
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async () => { throw new Error('not used'); },
      generateImages: async () => { throw new Error('provider should not be called'); },
    };

    const tool = createGenerateImageTool(runtime);
    const result = await tool.execute('call-3', { prompt: 'A wide poster', size: '2048x1024' });
    const details = result.details as ToolEnvelope<GenerateImageData>;

    expect(details.ok).toBe(false);
    expect(details.error?.code).toBe('unsupported_option');
    expect(details.error?.message).toBe('Size "2048x1024" is not supported by gpt-image-1.5.');
    expect(details.instructions).toBe('Use auto, 1024x1024, 1024x1536, 1536x1024.');
  });

  test('returns rate limit instructions for quota-limited image providers', async () => {
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text', 'image'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'openai',
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async () => { throw new Error('not used'); },
      generateImages: async ({ modelId }) => ({
        api: 'openai-images',
        provider: 'openai',
        model: modelId,
        output: [],
        stopReason: 'error',
        errorMessage: '429 status code: USAGE_LIMIT_EXCEEDED WEEKLY_LIMIT_EXCEEDED',
        timestamp: Date.now(),
      }),
    };

    const tool = createGenerateImageTool(runtime);
    const result = await tool.execute('call-rate-limited', { prompt: 'A tiny icon' });
    const details = result.details as ToolEnvelope<GenerateImageData>;
    const visible = JSON.parse(result.content.find((part) => part.type === 'text')?.text ?? '{}');

    expect(details.ok).toBe(false);
    expect(details.error?.code).toBe('rate_limited');
    expect(details.instructions).toContain('Do not retry immediately');
    expect(visible.error.code).toBe('rate_limited');
    expect(visible.instructions).toContain('switch the default image model');
  });
});
