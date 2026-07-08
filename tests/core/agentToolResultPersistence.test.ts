import { describe, expect, test } from 'bun:test';
import { TOOL_RESULT_VERSION } from '../../src/main/agentToolEnvelope';
import { persistedToolResultDetails } from '../../src/main/agentToolResultPersistence';

describe('agent tool result persistence', () => {
  test('does not persist generic tool runtime envelopes', () => {
    const details = persistedToolResultDetails({
      toolName: 'file_read',
      details: {
        ok: true,
        tool: 'file_read',
        version: TOOL_RESULT_VERSION,
        status: 'success',
        data: {
          path: 'large.png',
          image: { data: 'base64-image-bytes', mimeType: 'image/png' },
          content: 'full file content',
        },
      },
    });

    expect(details).toBeUndefined();
  });

  test('persists only slim generated image render metadata', () => {
    const details = persistedToolResultDetails({
      toolName: 'generate_image',
      details: {
        ok: true,
        tool: 'generate_image',
        version: TOOL_RESULT_VERSION,
        status: 'success',
        data: {
          providerId: 'openai',
          modelId: 'gpt-image-2',
          modelName: 'GPT Image 2',
          promptPreview: 'secret prompt details',
          text: ['provider side text'],
          images: [{
            path: 'generated-images/run-a/image-0.png',
            markdownImage: '![Generated image](file:^generated-images%2Frun-a%2Fimage-0.png)',
            mimeType: 'image/png',
            byteLength: 123,
            width: 1024,
            height: 1024,
            data: 'base64-image-bytes',
            originalFile: 'original file content',
          }],
        },
        instructions: 'runtime-only guidance',
        metrics: { durationMs: 42, outputBytes: 123 },
      },
    });

    expect(details).toEqual({
      ok: true,
      tool: 'generate_image',
      version: TOOL_RESULT_VERSION,
      status: 'success',
      data: {
        providerId: 'openai',
        modelId: 'gpt-image-2',
        modelName: 'GPT Image 2',
        images: [{
          path: 'generated-images/run-a/image-0.png',
          markdownImage: '![Generated image](file:^generated-images%2Frun-a%2Fimage-0.png)',
          mimeType: 'image/png',
          byteLength: 123,
          width: 1024,
          height: 1024,
        }],
      },
    });
    expect(JSON.stringify(details)).not.toContain('base64-image-bytes');
    expect(JSON.stringify(details)).not.toContain('original file content');
    expect(JSON.stringify(details)).not.toContain('secret prompt details');
  });

  test('does not persist mismatched or failed generated image details', () => {
    expect(persistedToolResultDetails({
      toolName: 'file_read',
      details: {
        ok: true,
        tool: 'generate_image',
        version: TOOL_RESULT_VERSION,
        status: 'success',
        data: {
          providerId: 'openai',
          modelId: 'gpt-image-2',
          modelName: 'GPT Image 2',
          images: [{ path: 'generated-images/run-a/image-0.png' }],
        },
      },
    })).toBeUndefined();

    expect(persistedToolResultDetails({
      toolName: 'generate_image',
      details: {
        ok: false,
        tool: 'generate_image',
        version: TOOL_RESULT_VERSION,
        status: 'error',
        error: { code: 'provider_error', message: 'failed', recoverable: true },
      },
    })).toBeUndefined();
  });
});
