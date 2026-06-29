import { describe, expect, test } from 'bun:test';
import { isLocalBaseUrl } from '../../src/core/localEndpoint';

describe('isLocalBaseUrl', () => {
  test('accepts local http endpoints', () => {
    expect(isLocalBaseUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLocalBaseUrl('http://localhost.:1234/v1')).toBe(true);
    expect(isLocalBaseUrl('http://model.localhost:1234/v1')).toBe(true);
    expect(isLocalBaseUrl('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalBaseUrl('http://[::1]:1234/v1')).toBe(true);
  });

  test('rejects non-local or invalid endpoints', () => {
    expect(isLocalBaseUrl('https://proxy.example.com/v1')).toBe(false);
    expect(isLocalBaseUrl('file:///tmp/model.sock')).toBe(false);
    expect(isLocalBaseUrl('not a url')).toBe(false);
    expect(isLocalBaseUrl(undefined)).toBe(false);
  });
});
