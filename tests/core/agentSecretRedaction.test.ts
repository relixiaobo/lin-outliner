import { describe, expect, test } from 'bun:test';
import {
  containsSecretLikeContent,
  elideLargeBlobs,
  redactSecretKeyedValues,
  redactSecretLikeContent,
  redactSecretLikeJson,
} from '../../src/main/agent/capabilities/agentSecretRedaction';

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

  test('recognizes credential key segments without treating token accounting as a credential', () => {
    const secret = 'do-not-persist';
    const result = redactSecretLikeJson({
      secret_key: secret,
      secretKey: secret,
      session_token: secret,
      bot_token: secret,
      private_key: secret,
      api_keys: [secret],
      APIKey: secret,
      authorizationHeader: secret,
      token_budget: 200_000,
      max_total_tokens: 80_000,
    });

    expect(result.value).toEqual({
      secret_key: '[redacted]',
      secretKey: '[redacted]',
      session_token: '[redacted]',
      bot_token: '[redacted]',
      private_key: '[redacted]',
      api_keys: ['[redacted]'],
      APIKey: '[redacted]',
      authorizationHeader: '[redacted]',
      token_budget: 200_000,
      max_total_tokens: 80_000,
    });
    expect(result.redactedPaths).toEqual([
      '/secret_key',
      '/secretKey',
      '/session_token',
      '/bot_token',
      '/private_key',
      '/api_keys',
      '/APIKey',
      '/authorizationHeader',
    ]);
  });

  test('keeps ambiguous command and source text exact while redacting strong credential formats', () => {
    const command = "sed -i 's/token=old/token=abcdefghijklmnop/' config.ini";
    const source = 'const token = "placeholder1234";';
    const bearer = 'curl -H "Authorization: Bearer abcdefghijklmnop" https://example.test';

    expect(redactSecretLikeJson({ command, source }).value).toEqual({ command, source });
    expect(redactSecretLikeJson({ command: bearer }).value).toEqual({
      command: 'curl -H "Authorization: [redacted secret-like content]" https://example.test',
    });
  });

  test('redacts secret keys inside JSON-encoded provider arguments', () => {
    const encoded = JSON.stringify({ api_key: 'generic-model-secret', query: 'keep' });
    expect(redactSecretLikeJson({ arguments: encoded }).value).toEqual({
      arguments: JSON.stringify({ api_key: '[redacted]', query: 'keep' }),
    });
  });

  test('keeps formatting in JSON-encoded strings when structural redaction is unnecessary', () => {
    const encoded = '{\n  "token_budget": 120000,\n  "query": "keep spacing"\n}';

    expect(redactSecretLikeJson({ arguments: encoded })).toEqual({
      value: { arguments: encoded },
      redactedPaths: [],
    });
  });

  test('elideLargeBlobs collapses long base64 runs to a length note', () => {
    const blob = 'A'.repeat(400);
    expect(elideLargeBlobs(`img:${blob}`)).toBe('img:[base64 elided: 400 chars]');
    expect(elideLargeBlobs('short text')).toBe('short text');
  });
});
