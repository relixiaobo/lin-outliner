import { describe, expect, test } from 'bun:test';
import {
  createGenerateImageTool,
  type AgentImageGenerationRuntime,
  type GenerateImageData,
} from '../../src/main/agent/capabilities/agentImageGenerationTool';
import type { ToolEnvelope } from '../../src/main/agent/capabilities/agentToolEnvelope';
import { MAX_TOOL_PAYLOAD_IMAGE_BYTES } from '../../src/main/agent/persistence/ToolPayloadStore';
import { formatFileReferenceUri } from '../../src/core/referenceMarkup';
import { createImageArtifactReference } from '../../src/main/agent/imageArtifacts';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP1j0wAAAABJRU5ErkJggg==';
const GENERATED_IMAGE_PATH = '/scratch/agent-attachments/thread/image-artifacts/generated/image';
const ONE_PIXEL_PNG_BYTES = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
const GENERATED_IMAGE_ARTIFACT = createImageArtifactReference({
  createdAt: 1,
  retention: 'tiered',
  original: {
    kind: 'threadPayload',
    ref: {
      id: 'a'.repeat(64),
      mimeType: 'image/png',
      byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
      fileName: 'original.png',
    },
  },
  observation: {
    id: 'b'.repeat(64),
    mimeType: 'image/png',
    byteLength: ONE_PIXEL_PNG_BYTES.byteLength,
    fileName: 'prompt.png',
  },
  sourceDimensions: { width: 1, height: 1 },
  observationDimensions: { width: 1, height: 1 },
});

function generatedOutputRuntime(): Pick<
  AgentImageGenerationRuntime,
  'persistGeneratedImage'
> {
  return {
    persistGeneratedImage: async () => persistedGeneratedImage(),
  };
}

function persistedGeneratedImage() {
  return {
    artifactRef: GENERATED_IMAGE_ARTIFACT,
    path: GENERATED_IMAGE_PATH,
    observation: { data: ONE_PIXEL_PNG_BYTES, mimeType: 'image/png' },
  };
}

describe('generate_image tool', () => {
  test('returns an absolute original path and emits a bounded preview without embedding bytes in JSON', async () => {
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
      ...generatedOutputRuntime(),
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
    expect(details.data?.images[0]?.providerIndex).toBe(1);
    expect(details.data?.images[0]?.path).toBe(GENERATED_IMAGE_PATH);

    const text = result.content.find((part) => part.type === 'text');
    const image = result.content.find((part) => part.type === 'image');
    expect(image).toEqual({ type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' });
    if (!text || text.type !== 'text') throw new Error('Expected text result');
    expect(text.text).not.toContain(ONE_PIXEL_PNG_BASE64);
    expect(JSON.parse(text.text)).toEqual({
      ok: true,
      data: {
        images: [{
          providerIndex: 1,
          artifactId: GENERATED_IMAGE_ARTIFACT.id,
          path: GENERATED_IMAGE_PATH,
          mimeType: 'image/png',
          byteLength: Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64').byteLength,
          width: 1,
          height: 1,
          observationDimensions: { width: 1, height: 1 },
          sourceDimensions: { width: 1, height: 1 },
          sourcePixelsPerObservationPixel: { x: 1, y: 1 },
          observationToSource: [1, 0, 0, 1, 0, 0],
        }],
      },
      instructions: 'The generated image is saved at the returned local path. Available previews are already shown to the user; do not render them again in the final answer. Each artifact id is stable; its local path is a rematerializable access hint and can become unavailable under storage retention. If an image belongs somewhere in particular, copy it there now.',
    });
  });

  test('keeps saved siblings and provider indexes when one original write fails', async () => {
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
      ...generatedOutputRuntime(),
      persistGeneratedImage: async ({ index }) => {
        if (index === 0) throw new Error('disk write failed');
        return persistedGeneratedImage();
      },
      generateImages: async ({ modelId }) => ({
        api: 'openai-images',
        provider: 'openai',
        model: modelId,
        output: [
          { type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' },
          { type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' },
        ],
        stopReason: 'stop',
        timestamp: Date.now(),
      }),
    };

    const result = await createGenerateImageTool(runtime).execute('call-partial', {
      prompt: 'Two small squares',
      count: 2,
    });
    const details = result.details as ToolEnvelope<GenerateImageData>;

    expect(details).toMatchObject({
      ok: true,
      status: 'partial',
      data: { images: [{ providerIndex: 2, path: GENERATED_IMAGE_PATH }] },
      warnings: [expect.stringContaining('disk write failed')],
    });
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  test('saves a large original above the generic 10 MiB preview admission limit', async () => {
    const original = Buffer.alloc(MAX_TOOL_PAYLOAD_IMAGE_BYTES + 1, 0xab);
    let saved: Buffer | null = null;
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'google',
        id: 'gemini-3.1-pro-image',
        name: 'Nano Banana Pro',
        input: ['text'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'google',
      readLocalImage: async () => { throw new Error('not used'); },
      ...generatedOutputRuntime(),
      persistGeneratedImage: async ({ data }) => {
        saved = data;
        return persistedGeneratedImage();
      },
      generateImages: async ({ modelId }) => ({
        api: 'google-images',
        provider: 'google',
        model: modelId,
        output: [{ type: 'image', data: original.toString('base64'), mimeType: 'image/png' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      }),
    };

    const result = await createGenerateImageTool(runtime).execute('call-large', {
      prompt: 'A detailed 4K scene',
      size: '4K',
    });
    expect(result.details).toMatchObject({
      ok: true,
      status: 'success',
      data: {
        images: [{
          providerIndex: 1,
          path: GENERATED_IMAGE_PATH,
          byteLength: original.byteLength,
        }],
      },
      metrics: { outputBytes: original.byteLength },
    });
    expect(saved?.byteLength).toBe(original.byteLength);
    expect(result.content.filter((part) => part.type === 'image')).toEqual([
      { type: 'image', data: ONE_PIXEL_PNG_BASE64, mimeType: 'image/png' },
    ]);
  });

  test('does not admit an original when its bounded model observation cannot be prepared', async () => {
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'openai',
      readLocalImage: async () => { throw new Error('not used'); },
      ...generatedOutputRuntime(),
      persistGeneratedImage: async () => {
        throw new Error('image decode failed');
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

    const result = await createGenerateImageTool(runtime).execute('call-no-observation', {
      prompt: 'A small red square',
    });
    const details = result.details as ToolEnvelope<GenerateImageData>;

    expect(details).toMatchObject({
      ok: true,
      status: 'partial',
      data: {
        images: [],
      },
      warnings: [expect.stringContaining('image decode failed')],
      instructions: 'No generated image was saved. Follow the warnings before retrying.',
      metrics: { outputBytes: 0 },
    });
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(0);
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
      ...generatedOutputRuntime(),
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
      ...generatedOutputRuntime(),
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
      ...generatedOutputRuntime(),
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
      ...generatedOutputRuntime(),
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
      ...generatedOutputRuntime(),
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

  test('does not unwrap a legacy Markdown image when an input path is missing', async () => {
    let attemptedPath = '';
    const runtime: AgentImageGenerationRuntime = {
      listModels: async () => [{
        providerId: 'openai',
        id: 'gpt-image-2',
        name: 'GPT Image 2',
        input: ['text', 'image'],
        output: ['image'],
      }],
      getActiveProviderId: async () => 'openai',
      readLocalImage: async ({ filePath }) => {
        attemptedPath = filePath;
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      },
      ...generatedOutputRuntime(),
      generateImages: async () => { throw new Error('provider should not be called'); },
    };

    const tool = createGenerateImageTool(runtime);
    const missingTarget = '/missing/input.png';
    const missingPath = `![Missing](${formatFileReferenceUri(missingTarget)})`;
    const result = await tool.execute('call-missing-input', {
      prompt: 'Edit this image',
      image_paths: [missingPath],
    });
    const details = result.details as ToolEnvelope<GenerateImageData>;
    const visible = JSON.parse(result.content.find((part) => part.type === 'text')?.text ?? '{}');

    expect(details.ok).toBe(false);
    expect(details.error?.code).toBe('input_image_unavailable');
    expect(attemptedPath).toBe(missingPath);
    expect(details.error?.message).toContain(missingPath);
    expect(details.instructions).toContain('regenerate the missing image');
    expect(visible.error.code).toBe('input_image_unavailable');
  });
});
