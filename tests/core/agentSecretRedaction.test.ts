import { describe, expect, test } from 'bun:test';
import { containsSecretLikeContent, redactSecretLikeContent } from '../../src/main/agentSecretRedaction';

describe('agent secret redaction', () => {
  test('detects truncated private key headers for skill write rejection', () => {
    const content = '-----BEGIN OPENSSH PRIVATE KEY-----\ntruncated';

    expect(containsSecretLikeContent(content)).toBe(true);
    expect(redactSecretLikeContent(content)).toBe(content);
  });

  test('redacts complete private key blocks from injected memory facts', () => {
    const content = [
      'before',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'secret material',
      '-----END OPENSSH PRIVATE KEY-----',
      'after',
    ].join('\n');

    expect(containsSecretLikeContent(content)).toBe(true);
    expect(redactSecretLikeContent(content)).toBe('before\n[redacted secret-like content]\nafter');
  });
});
