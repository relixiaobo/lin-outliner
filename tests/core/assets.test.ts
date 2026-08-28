import { describe, expect, test } from 'bun:test';
import { assetIdFromUrl, assetUrl } from '../../src/core/assets';

describe('asset URLs', () => {
  test('round-trips Runtime logical IDs through one encoded path segment', () => {
    const assetId = 'asset:123e4567-e89b-12d3-a456-426614174000';
    const url = assetUrl(assetId);

    expect(url).toBe('asset://local/asset%3A123e4567-e89b-12d3-a456-426614174000');
    expect(() => new URL(url)).not.toThrow();
    expect(assetIdFromUrl(url)).toBe(assetId);
  });

  test('rejects another authority, extra URL state, and encoded path separators', () => {
    expect(assetIdFromUrl('asset://remote/asset%3Aone')).toBeNull();
    expect(assetIdFromUrl('asset://local/asset%3Aone/extra')).toBeNull();
    expect(assetIdFromUrl('asset://local/asset%3Aone?range=all')).toBeNull();
    expect(assetIdFromUrl('asset://local/asset%3Aone#fragment')).toBeNull();
    expect(assetIdFromUrl('asset://local/asset%3Aone%2Fescape')).toBeNull();
    expect(assetIdFromUrl('not a URL')).toBeNull();
  });
});
