import { describe, expect, test } from 'bun:test';
import {
  openAiImageClientOptions,
  openAiImageRequestParams,
  sanitizeImageProviderErrorMessage,
  validateImageGenerationOptions,
} from '../../src/main/piImageModels';

describe('pi image models', () => {
  test('passes GPT Image 2 valid WIDTHxHEIGHT sizes without response_format', () => {
    const params = openAiImageRequestParams('gpt-image-2', 'Draw a landscape poster.', {
      size: '2048x1024',
    });

    expect(params).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'Draw a landscape poster.',
      n: 1,
      size: '2048x1024',
      output_format: 'png',
    });
    expect(params).not.toHaveProperty('response_format');
  });

  test('uses configured OpenAI-compatible image base URLs', () => {
    expect(openAiImageClientOptions(
      { baseUrl: 'https://api.openai.com/v1' },
      { apiKey: 'test-key', baseUrl: 'https://sub2api.wisebox.ai/v1' },
    )).toMatchObject({
      apiKey: 'test-key',
      baseURL: 'https://sub2api.wisebox.ai/v1',
    });
  });

  test('rejects GPT Image 2 sizes that violate OpenAI constraints', () => {
    expect(validateImageGenerationOptions('openai', 'gpt-image-2', {
      size: 'not-a-size',
    })).toMatchObject({
      code: 'unsupported_option',
      message: 'Size "not-a-size" is not supported by gpt-image-2.',
      instructions: 'Use auto or WIDTHxHEIGHT with both edges <= 3840, both edges multiples of 16, ratio <= 3:1, and total pixels 655360-8294400. Examples: 1024x1024, 2048x1152, 3840x2160, 2160x3840.',
    });

    for (const size of ['123x123', '4096x1024', '2048x512', '3840x3840']) {
      expect(validateImageGenerationOptions('openai', 'gpt-image-2', { size })).toMatchObject({
        code: 'unsupported_option',
        message: `Size "${size}" is not supported by gpt-image-2.`,
      });
      expect(openAiImageRequestParams('gpt-image-2', 'Draw.', { size })).not.toHaveProperty('size');
    }
  });

  test('rejects fixed-size OpenAI image model sizes that cannot be sent', () => {
    expect(validateImageGenerationOptions('openai', 'gpt-image-1.5', {
      size: '2048x1024',
    })).toMatchObject({
      code: 'unsupported_option',
      message: 'Size "2048x1024" is not supported by gpt-image-1.5.',
      instructions: 'Use auto, 1024x1024, 1024x1536, 1536x1024.',
    });
  });

  test('rejects transparent background for GPT Image 2', () => {
    expect(validateImageGenerationOptions('openai', 'gpt-image-2', {
      background: 'transparent',
    })).toMatchObject({
      code: 'unsupported_option',
      message: 'Background "transparent" is not supported by gpt-image-2.',
      instructions: 'Use auto or opaque with gpt-image-2, or select an image model that supports transparent backgrounds.',
    });
    expect(openAiImageRequestParams('gpt-image-2', 'Draw.', {
      background: 'transparent',
    })).not.toHaveProperty('background');
  });

  test('accepts fixed GPT image sizes for non-GPT-Image-2 OpenAI models', () => {
    expect(validateImageGenerationOptions('openai', 'gpt-image-1.5', {
      size: '1024x1536',
    })).toBeNull();
    expect(openAiImageRequestParams('gpt-image-1.5', 'Draw a portrait.', {
      size: '1024x1536',
    }).size).toBe('1024x1536');
  });

  test('keeps transparent background available for OpenAI image models that can receive it', () => {
    expect(validateImageGenerationOptions('openai', 'gpt-image-1.5', {
      background: 'transparent',
    })).toBeNull();
    expect(openAiImageRequestParams('gpt-image-1.5', 'Draw a sticker.', {
      background: 'transparent',
    }).background).toBe('transparent');
  });

  test('leaves non-OpenAI image provider option validation to provider adapters', () => {
    expect(validateImageGenerationOptions('google', 'gemini-3.1-flash-image', {
      size: '4K',
    })).toBeNull();
  });

  test('redacts provider error messages before they enter tool output', () => {
    expect(sanitizeImageProviderErrorMessage(
      '401 Incorrect API key provided: sk-f08c0*******************************************************3686.',
    )).toBe('401 Incorrect API key provided: [redacted API key].');
    expect(sanitizeImageProviderErrorMessage(
      'Gemini rejected key AIza********************************1234 for this project.',
    )).toBe('Gemini rejected key [redacted API key] for this project.');
  });
});
