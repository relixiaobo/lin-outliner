import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { AgentPayloadRef } from '../../src/core/agentEventLog';
import {
  createGenerateImageTool,
  generateImagePayloadsFromDetails,
  type AgentImageGenerationRuntime,
  type GenerateImageData,
} from '../../src/main/agentImageGenerationTool';
import type { ToolEnvelope } from '../../src/main/agentToolEnvelope';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP1j0wAAAABJRU5ErkJggg==';

describe('generate_image tool', () => {
  test('returns image content to the model and payload refs in details', async () => {
    const writtenPayloads: AgentPayloadRef[] = [];
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text', 'image'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'openai',
      readPayloadImage: async () => { throw new Error('not used'); },
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async ({ index, data, mimeType }) => {
        const payload: AgentPayloadRef = {
          kind: 'payload_ref',
          id: `payload-${index}`,
          storage: 'file',
          mimeType,
          byteLength: data.byteLength,
          sha256: createHash('sha256').update(data).digest('hex'),
          role: 'tool_output',
          summary: 'Generated image',
        };
        writtenPayloads.push(payload);
        return payload;
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
    expect(details.data?.images).toHaveLength(1);
    expect(details.data?.images[0]?.payload.id).toBe('payload-0');
    expect(writtenPayloads).toHaveLength(1);

    const text = result.content.find((part) => part.type === 'text');
    const image = result.content.find((part) => part.type === 'image');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    if (!text || text.type !== 'text') throw new Error('Expected text result');
    expect(text.text).not.toContain(ONE_PIXEL_PNG_BASE64);
    expect(JSON.parse(text.text)).toEqual({
      ok: true,
      data: {
        providerId: 'openai',
        modelId: 'gpt-image-2',
        modelName: 'GPT Image 2',
        images: [{
          payloadId: 'payload-0',
          mimeType: 'image/png',
          byteLength: Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64').byteLength,
          width: 1,
          height: 1,
        }],
      },
    });
    expect(generateImagePayloadsFromDetails(details)?.map((payload) => payload.id)).toEqual(['payload-0']);
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
      readPayloadImage: async () => { throw new Error('not used'); },
      readLocalImage: async () => { throw new Error('not used'); },
      writeGeneratedImage: async ({ index, data, mimeType }) => ({
        kind: 'payload_ref',
        id: `payload-${index}`,
        storage: 'file',
        mimeType,
        byteLength: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
        role: 'tool_output',
        summary: 'Generated image',
      }),
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
      readPayloadImage: async () => { throw new Error('not used'); },
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
});
