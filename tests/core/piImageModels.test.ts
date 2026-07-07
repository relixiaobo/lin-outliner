import { describe, expect, test } from 'bun:test';
import {
  openAiImageRequestParams,
  validateImageGenerationOptions,
} from '../../src/main/piImageModels';

describe('pi image models', () => {
  test('passes GPT Image 2 WIDTHxHEIGHT sizes without response_format', () => {
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

  test('rejects OpenAI image sizes that cannot be sent', () => {
    expect(validateImageGenerationOptions('openai', 'gpt-image-2', {
      size: 'not-a-size',
    })).toMatchObject({
      code: 'unsupported_option',
      message: 'Size "not-a-size" is not supported by gpt-image-2.',
      instructions: 'Use auto or a WIDTHxHEIGHT value, for example 1024x1024.',
    });

    expect(validateImageGenerationOptions('openai', 'gpt-image-1.5', {
      size: '2048x1024',
    })).toMatchObject({
      code: 'unsupported_option',
      message: 'Size "2048x1024" is not supported by gpt-image-1.5.',
      instructions: 'Use auto, 1024x1024, 1024x1536, 1536x1024.',
    });
  });

  test('accepts fixed GPT image sizes for non-GPT-Image-2 OpenAI models', () => {
    expect(validateImageGenerationOptions('openai', 'gpt-image-1.5', {
      size: '1024x1536',
    })).toBeNull();
    expect(openAiImageRequestParams('gpt-image-1.5', 'Draw a portrait.', {
      size: '1024x1536',
    }).size).toBe('1024x1536');
  });

  test('leaves non-OpenAI image provider option validation to provider adapters', () => {
    expect(validateImageGenerationOptions('google', 'gemini-3.1-flash-image', {
      size: '4K',
    })).toBeNull();
  });
});
