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
      apikey: secret,
      APIKEY: secret,
      authtoken: secret,
      accesstoken: secret,
      api_token: secret,
      oauthToken: secret,
      authorizationHeader: secret,
      'x-api-key': secret,
      credentials: secret,
      openai_api_key: secret,
      anthropic_api_key: secret,
      OPENAI_API_KEY: secret,
      aws_secret_access_key: secret,
      user_password: secret,
      db_password: secret,
      admin_password: secret,
      basic_auth_password: secret,
      password_hash: secret,
      root_passwd: secret,
      smtp_pwd: secret,
      jwt_secret: secret,
      webhook_secret: secret,
      app_secret: secret,
      shared_secret: secret,
      oauth_secret: secret,
      ssh_private_key: secret,
      privateKeyPem: secret,
      auth_key: secret,
      clientKey: secret,
      encryption_key: secret,
      signingKey: secret,
      validation_token: secret,
      gh_token: secret,
      npm_token: secret,
      proxy_authorization: secret,
      'X-Authorization': secret,
      authorization_url: 'https://example.test/oauth/authorize',
      passwordPolicy: 'at least twelve characters',
      secretPolicy: 'rotate every ninety days',
      token_budget: 200_000,
      max_total_tokens: 80_000,
      maxTokens: 32_000,
      totalTokens: 12_345,
      input_tokens: 8_000,
      outputTokens: 4_345,
    });

    expect(result.value).toEqual({
      secret_key: '[redacted]',
      secretKey: '[redacted]',
      session_token: '[redacted]',
      bot_token: '[redacted]',
      private_key: '[redacted]',
      api_keys: ['[redacted]'],
      APIKey: '[redacted]',
      apikey: '[redacted]',
      APIKEY: '[redacted]',
      authtoken: '[redacted]',
      accesstoken: '[redacted]',
      api_token: '[redacted]',
      oauthToken: '[redacted]',
      authorizationHeader: '[redacted]',
      'x-api-key': '[redacted]',
      credentials: '[redacted]',
      openai_api_key: '[redacted]',
      anthropic_api_key: '[redacted]',
      OPENAI_API_KEY: '[redacted]',
      aws_secret_access_key: '[redacted]',
      user_password: '[redacted]',
      db_password: '[redacted]',
      admin_password: '[redacted]',
      basic_auth_password: '[redacted]',
      password_hash: '[redacted]',
      root_passwd: '[redacted]',
      smtp_pwd: '[redacted]',
      jwt_secret: '[redacted]',
      webhook_secret: '[redacted]',
      app_secret: '[redacted]',
      shared_secret: '[redacted]',
      oauth_secret: '[redacted]',
      ssh_private_key: '[redacted]',
      privateKeyPem: '[redacted]',
      auth_key: '[redacted]',
      clientKey: '[redacted]',
      encryption_key: '[redacted]',
      signingKey: '[redacted]',
      validation_token: '[redacted]',
      gh_token: '[redacted]',
      npm_token: '[redacted]',
      proxy_authorization: '[redacted]',
      'X-Authorization': '[redacted]',
      authorization_url: 'https://example.test/oauth/authorize',
      passwordPolicy: 'at least twelve characters',
      secretPolicy: 'rotate every ninety days',
      token_budget: 200_000,
      max_total_tokens: 80_000,
      maxTokens: 32_000,
      totalTokens: 12_345,
      input_tokens: 8_000,
      outputTokens: 4_345,
    });
    expect(result.redactedPaths).toEqual([
      '/secret_key',
      '/secretKey',
      '/session_token',
      '/bot_token',
      '/private_key',
      '/api_keys',
      '/APIKey',
      '/apikey',
      '/APIKEY',
      '/authtoken',
      '/accesstoken',
      '/api_token',
      '/oauthToken',
      '/authorizationHeader',
      '/x-api-key',
      '/credentials',
      '/openai_api_key',
      '/anthropic_api_key',
      '/OPENAI_API_KEY',
      '/aws_secret_access_key',
      '/user_password',
      '/db_password',
      '/admin_password',
      '/basic_auth_password',
      '/password_hash',
      '/root_passwd',
      '/smtp_pwd',
      '/jwt_secret',
      '/webhook_secret',
      '/app_secret',
      '/shared_secret',
      '/oauth_secret',
      '/ssh_private_key',
      '/privateKeyPem',
      '/auth_key',
      '/clientKey',
      '/encryption_key',
      '/signingKey',
      '/validation_token',
      '/gh_token',
      '/npm_token',
      '/proxy_authorization',
      '/X-Authorization',
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

  test('redacts secret-keyed JSON strings without reformatting unrelated bytes', () => {
    const encoded = [
      '{',
      '  "client_secret" : "9f3a2c8d5e71b04a",',
      '  "password": "s3cr3t-value-1234",',
      '  "authorization_url": "https://example.test/oauth",',
      '  "passwordPolicy": "at least twelve characters",',
      '  "nested": { "query": "keep spacing" }',
      '}',
    ].join('\n');
    const expected = encoded
      .replace('"9f3a2c8d5e71b04a"', '"[redacted]"')
      .replace('"s3cr3t-value-1234"', '"[redacted]"');

    expect(redactSecretLikeJson({ body: encoded })).toEqual({
      value: { body: expected },
      redactedPaths: ['/body'],
    });
  });

  test('redacts nested JSON strings without reformatting the containing document', () => {
    const body = '{\n  "client_secret": "nested-secret-value",\n  "safe": "keep"\n}';
    const encoded = JSON.stringify({ body, query: 'keep' }, null, 2);
    const result = redactSecretLikeJson({ arguments: encoded });

    expect(result.redactedPaths).toEqual(['/arguments']);
    expect(JSON.parse(result.value.arguments as string)).toEqual({
      body: '{\n  "client_secret": "[redacted]",\n  "safe": "keep"\n}',
      query: 'keep',
    });
    expect(result.value.arguments).toContain('\n  "body":');
  });

  test('keeps formatting in JSON-encoded strings when structural redaction is unnecessary', () => {
    const encoded = '{\n  "token_budget": 120000,\n  "query": "keep spacing"\n}';

    expect(redactSecretLikeJson({ arguments: encoded })).toEqual({
      value: { arguments: encoded },
      redactedPaths: [],
    });
  });

  test('fails closed when valid JSON exceeds the formatting-preserving scanner depth', () => {
    const depth = 100_000;
    const encoded = '['.repeat(depth)
      + '{"password":"deep-secret-value"}'
      + ']'.repeat(depth);

    expect(() => JSON.parse(encoded)).not.toThrow();
    expect(redactSecretLikeJson({ body: encoded })).toEqual({
      value: { body: '[redacted unscannable JSON]' },
      redactedPaths: ['/body'],
    });
  });

  test('reports a redaction path only when the persisted value changes', () => {
    expect(redactSecretLikeJson({ secret: false, authorization: null, token: 0 })).toEqual({
      value: { secret: false, authorization: null, token: 0 },
      redactedPaths: [],
    });
  });

  test('elideLargeBlobs collapses long base64 runs to a length note', () => {
    const blob = 'A'.repeat(400);
    expect(elideLargeBlobs(`img:${blob}`)).toBe('img:[base64 elided: 400 chars]');
    expect(elideLargeBlobs('short text')).toBe('short text');
  });
});
