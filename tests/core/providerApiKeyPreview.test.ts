import { expect, test } from 'bun:test';
import { previewProviderApiKey } from '../../src/core/providerApiKeyPreview';

test('a key preview preserves the true length and both ends without the secret middle', () => {
  const preview = previewProviderApiKey('sk-test-secret-tail');
  expect(preview).toEqual({ prefix: 'sk-t', mask: '•••••••••••', suffix: 'tail', length: 19 });
  expect(JSON.stringify(preview)).not.toContain('secret');
});

test('short and Unicode keys never reveal their entire value or split characters', () => {
  for (const key of ['a', 'ab', 'abc', 'abcd', '12345678', '🔑abcd🔑']) {
    const preview = previewProviderApiKey(key);
    const length = Array.from(key).length;
    expect(preview.length).toBe(length);
    expect(preview.mask.length).toBeGreaterThanOrEqual(Math.ceil(length / 2));
    expect(Array.from(preview.prefix + preview.mask + preview.suffix)).toHaveLength(length);
    expect(preview.prefix + preview.suffix).not.toBe(key);
  }
});
