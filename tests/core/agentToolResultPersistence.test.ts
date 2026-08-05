import { describe, expect, test } from 'bun:test';
import { TOOL_RESULT_VERSION } from '../../src/main/agent/capabilities/agentToolEnvelope';
import {
  persistedToolResultDetails,
  persistedToolResultText,
} from '../../src/main/agent/capabilities/agentToolResultPersistence';
import { createImageArtifactReference } from '../../src/main/agent/imageArtifacts';

describe('agent tool result persistence', () => {
  test('does not persist generic tool runtime envelopes', () => {
    const details = persistedToolResultDetails({
      toolNamespace: null,
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
    const artifactRef = generatedArtifact();
    const details = persistedToolResultDetails({
      toolNamespace: null,
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
            providerIndex: 1,
            artifactRef,
            path: '/scratch/generated-images/turn/image-0.png',
            mimeType: 'image/png',
            byteLength: 123,
            width: 1024,
            height: 1024,
            data: 'base64-image-bytes',
            originalFile: 'original file content',
            previewIndex: 0,
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
          providerIndex: 1,
          artifactRef,
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
    expect(JSON.stringify(details)).not.toContain('previewIndex');
  });

  test('removes disposable paths from built-in generated-image history text', () => {
    const sourcePath = '/scratch/provider-source/image-artifact';
    const persisted = persistedToolResultText({
      toolNamespace: null,
      toolName: 'generate_image',
      text: JSON.stringify({
        ok: true,
        tool: 'generate_image',
        data: {
          images: [{
            providerIndex: 1,
            artifactId: 'a'.repeat(64),
            path: sourcePath,
            sourceDimensions: { width: 4_000, height: 2_000 },
          }],
        },
        instructions: 'Use the returned local path.',
      }),
    });

    expect(persisted).not.toContain(sourcePath);
    expect(JSON.parse(persisted)).toEqual({
      ok: true,
      tool: 'generate_image',
      data: {
        images: [{
          providerIndex: 1,
          artifactId: 'a'.repeat(64),
          sourceDimensions: { width: 4_000, height: 2_000 },
        }],
      },
      instructions: 'Generated images shown with this result are saved in the conversation; do not render them again. Use the adjacent readable path for file operations when available.',
    });
  });

  test('preserves built-in generated-image results when no image was saved', () => {
    const text = JSON.stringify({
      ok: true,
      tool: 'generate_image',
      status: 'partial',
      data: { images: [] },
      warnings: ['Generated image 1 could not be saved.'],
      instructions: 'No generated image was saved. Follow the warnings before retrying.',
    });

    expect(persistedToolResultText({
      toolNamespace: null,
      toolName: 'generate_image',
      text,
    })).toBe(text);
  });

  test('does not persist details for namespaced tools that share the generate_image name', () => {
    expect(persistedToolResultDetails({
      toolNamespace: 'myplugin',
      toolName: 'generate_image',
      details: {
        ok: true,
        tool: 'generate_image',
        version: TOOL_RESULT_VERSION,
        status: 'success',
        data: {
          providerId: 'plugin',
          modelId: 'plugin-model',
          modelName: 'Plugin Model',
          images: [{ providerIndex: 1, caption: 'Plugin-owned fields' }],
        },
      },
    })).toBeUndefined();

    const pluginText = JSON.stringify({ ok: true, data: { images: [{ path: 'plugin://image' }] } });
    expect(persistedToolResultText({
      toolNamespace: 'myplugin',
      toolName: 'generate_image',
      text: pluginText,
    })).toBe(pluginText);
  });

  test('does not persist mismatched or failed generated image details', () => {
    expect(persistedToolResultDetails({
      toolNamespace: null,
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
          images: [{ providerIndex: 1, path: '/scratch/generated-images/turn/image-0.png' }],
        },
      },
    })).toBeUndefined();

    expect(persistedToolResultDetails({
      toolNamespace: null,
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

function generatedArtifact() {
  return createImageArtifactReference({
    createdAt: 1,
    retention: 'tiered',
    original: {
      kind: 'threadPayload',
      ref: {
        id: 'a'.repeat(64),
        mimeType: 'image/png',
        byteLength: 123,
        fileName: 'original.png',
      },
    },
    observation: {
      id: 'b'.repeat(64),
      mimeType: 'image/png',
      byteLength: 100,
      fileName: 'prompt.png',
    },
    sourceDimensions: { width: 1_024, height: 1_024 },
    observationDimensions: { width: 1_024, height: 1_024 },
  });
}
