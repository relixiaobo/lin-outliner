import { describe, expect, test } from 'bun:test';
import { containsSecretLikeContent, elideLargeBlobs, redactSecretKeyedValues, redactSecretLikeContent } from '../../src/main/agentSecretRedaction';

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

  test('redacts non-sk bearer / github / jwt / password secrets in free text', () => {
    expect(redactSecretLikeContent("curl -H 'Authorization: Bearer ghp_0123456789abcdefghij'"))
      .not.toContain('ghp_0123456789abcdefghij');
    expect(redactSecretLikeContent('PGPASSWORD=hunter2hunter2hunter2')).toContain('[redacted secret-like content]');
    expect(redactSecretLikeContent('token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2'))
      .toContain('[redacted secret-like content]');
  });

  test('redactSecretKeyedValues redacts values under secret-named keys, recursively', () => {
    const redacted = redactSecretKeyedValues({ api_key: 'x', nested: { authorization: 'y', safe: 'keep' } }) as Record<string, unknown>;
    expect(redacted.api_key).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).safe).toBe('keep');
  });

  test('elideLargeBlobs collapses long base64 runs to a length note', () => {
    const blob = 'A'.repeat(400);
    expect(elideLargeBlobs(`img:${blob}`)).toBe('img:[base64 elided: 400 chars]');
    expect(elideLargeBlobs('short text')).toBe('short text');
  });
});
