import { describe, expect, test } from 'bun:test';
import {
  containsSecretLikeContent,
  elideLargeBlobs,
  redactJsonEncodedSecretValues,
  redactSecretKeyedValues,
  redactSecretLikeContent,
  redactSecretLikeJson,
} from '../../src/main/agent/capabilities/agentSecretRedaction';

const OPENAI_KEY = `sk-proj-${'A'.repeat(74)}T3BlbkFJ${'B'.repeat(74)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${'C'.repeat(93)}AA`;

describe('agent secret redaction', () => {
  test('detects truncated private key headers for skill write rejection', () => {
    const content = '-----BEGIN OPENSSH PRIVATE KEY-----\ntruncated';

    expect(containsSecretLikeContent(content)).toBe(true);
    expect(redactSecretLikeContent(content)).toBe(content);
  });

  test('does not hard-block ambiguous credential-like prose', () => {
    expect(containsSecretLikeContent('token=abcdefghijklmnop')).toBe(false);
    expect(containsSecretLikeContent('password=not-a-real-credential')).toBe(false);
  });

  test('uses Secretlint to redact complete credential formats from free text', () => {
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      `MI${'A'.repeat(110)}`,
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const content = `before\n${privateKey}\n${OPENAI_KEY}\n${ANTHROPIC_KEY}\nafter`;
    const redacted = redactSecretLikeContent(content);

    expect(containsSecretLikeContent(content)).toBe(true);
    expect(redacted).not.toContain(privateKey);
    expect(redacted).not.toContain(OPENAI_KEY);
    expect(redacted).not.toContain(ANTHROPIC_KEY);
    expect(redacted).toStartWith('before\n[redacted secret-like content]');
    expect(redacted).toEndWith('[redacted secret-like content]\nafter');
  });

  test('redacts explicit bearer, JWT, and password assignments in memory text', () => {
    expect(redactSecretLikeContent("curl -H 'Authorization: Bearer ghp_0123456789abcdefghij'"))
      .not.toContain('ghp_0123456789abcdefghij');
    expect(redactSecretLikeContent('PGPASSWORD=hunter2hunter2hunter2')).toContain('[redacted secret-like content]');
    expect(redactSecretLikeContent('token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2'))
      .toContain('[redacted secret-like content]');
  });

  test('redactSecretKeyedValues changes only credential-candidate strings', () => {
    expect(redactSecretKeyedValues({
      api_key: 'live-value',
      nested: { authorization: 'live-value', safe: 'keep' },
      token: 4_096,
      secret: false,
      credentials: { name: 'ordinary' },
      api_keys: ['ambiguous-value'],
    })).toEqual({
      api_key: '[redacted]',
      nested: { authorization: '[redacted]', safe: 'keep' },
      token: 4_096,
      secret: false,
      credentials: { name: 'ordinary' },
      api_keys: ['ambiguous-value'],
    });
  });

  test('redacts table-driven credential string field spellings', () => {
    const keys = [
      'secret_key',
      'secretKey',
      'session_token',
      'bot_token',
      'private_key',
      'APIKey',
      'apikey',
      'APIKEY',
      'authtoken',
      'accesstoken',
      'api_token',
      'oauthToken',
      'authorizationHeader',
      'x-api-key',
      'credentials',
      'openai_api_key',
      'anthropic_api_key',
      'OPENAI_API_KEY',
      'aws_secret_access_key',
      'user_password',
      'db_password',
      'admin_password',
      'basic_auth_password',
      'password_hash',
      'root_passwd',
      'smtp_pwd',
      'jwt_secret',
      'webhook_secret',
      'app_secret',
      'shared_secret',
      'oauth_secret',
      'ssh_private_key',
      'privateKeyPem',
      'auth_key',
      'clientKey',
      'encryption_key',
      'signingKey',
      'validation_token',
      'gh_token',
      'npm_token',
      'proxy_authorization',
      'X-Authorization',
    ];

    for (const key of keys) {
      const result = redactSecretLikeJson({ [key]: 'do-not-persist' });
      expect(result.value, key).toEqual({ [key]: '[redacted]' });
      expect(result.redactedPaths, key).toEqual([`/${key}`]);
    }
  });

  test('passes table-driven benign secret-like fields and non-string shapes unchanged', () => {
    const value = {
      max_new_tokens: 512,
      budget_tokens: 4_096,
      tokens: 4_096,
      usedTokens: 128,
      max_completion_tokens: 2_048,
      cache_read_input_tokens: 900,
      tokenizerEnabled: true,
      secretary: { name: 'Ada' },
      authorization_url: 'https://example.test/oauth/authorize',
      authorizationEndpoint: 'https://example.test/oauth/authorize',
      passwordPolicy: 'at least twelve characters',
      secretPolicy: 'rotate every ninety days',
      tokenType: 'input',
      waitingForAuthorization: true,
      api_keys: ['ambiguous-value'],
      secret: false,
      authorization: null,
      token: 0,
      credentials: { name: 'ordinary' },
      numericToken: '4096',
      exponentToken: '1e6',
      hexadecimalToken: '0x1000',
      separatedNumericToken: '4_096',
      placeholderToken: '${OPENAI_API_KEY}',
      dollarToken: '$OPENAI_API_KEY',
      windowsToken: '%OPENAI_API_KEY%',
      mustacheToken: '{{ OPENAI_API_KEY }}',
      angleToken: '<OPENAI_API_KEY>',
    };

    expect(redactSecretLikeJson(value)).toEqual({ value, redactedPaths: [] });
  });

  test('uses Secretlint value signatures even under neutral field names', () => {
    const content = `first=${OPENAI_KEY}\nsecond=${ANTHROPIC_KEY}`;
    const result = redactSecretLikeJson({ value: OPENAI_KEY, content });

    expect(result.redactedPaths).toEqual(['/value', '/content']);
    expect(result.value.value).toBe('[redacted secret-like content]');
    expect(result.value.content).not.toContain(OPENAI_KEY);
    expect(result.value.content).not.toContain(ANTHROPIC_KEY);
  });

  test('does not let content disable Secretlint credential detection', () => {
    const content = `<!-- secretlint-disable -->\n${OPENAI_KEY}`;

    expect(redactSecretLikeJson({ content }).value.content).toBe(
      '<!-- secretlint-disable -->\n[redacted secret-like content]',
    );
  });

  test('keeps commands, source, and design-token JSON exact when no known credential matches', () => {
    const command = "sed -i 's/token=old/token=abcdefghijklmnop/' config.ini";
    const source = 'const token = "placeholder1234";';
    const tokensFile = JSON.stringify({ ink: '#111111', tokens: { space: 8 }, secretary: { name: 'Ada' } }, null, 2);

    expect(redactSecretLikeJson({ command, source, content: tokensFile })).toEqual({
      value: { command, source, content: tokensFile },
      redactedPaths: [],
    });
  });

  test('redacts only direct string values at the serialized provider-arguments boundary', () => {
    const nestedBody = '{\n  "client_secret": "nested-ambiguous-value",\n  "safe": "keep"\n}';
    const encoded = [
      '{',
      '  "client_secret" : "9f3a2c8d5e71b04a",',
      '  "password": "s3cr3t-value-1234",',
      `  "provider_value": ${JSON.stringify(OPENAI_KEY)},`,
      '  "token_budget": 120000,',
      '  "secret": false,',
      '  "credentials": { "name": "ordinary" },',
      `  "body": ${JSON.stringify(nestedBody)}`,
      '}',
    ].join('\n');
    const redacted = redactJsonEncodedSecretValues(encoded);

    expect(redacted).toContain('"client_secret" : "[redacted]"');
    expect(redacted).toContain('"password": "[redacted]"');
    expect(redacted).toContain('"provider_value": "[redacted secret-like content]"');
    expect(redacted).toContain('"token_budget": 120000');
    expect(redacted).toContain('"secret": false');
    expect(redacted).toContain('"credentials": { "name": "ordinary" }');
    expect(redacted).toContain(JSON.stringify(nestedBody));
  });

  test('does not recursively reinterpret JSON stored inside an ordinary string field', () => {
    const body = '{\n  "client_secret": "nested-ambiguous-value",\n  "safe": "keep"\n}';
    const encoded = JSON.stringify({ body, query: 'keep' }, null, 2);

    expect(redactSecretLikeJson({ arguments: encoded })).toEqual({
      value: { arguments: encoded },
      redactedPaths: [],
    });
    expect(redactJsonEncodedSecretValues(encoded)).toBe(encoded);
  });

  test('fails open for malformed or pathologically deep serialized JSON', () => {
    const malformed = '{"password":"unterminated"';
    const depth = 100_000;
    const encoded = '['.repeat(depth)
      + '{"password":"deep-ambiguous-value"}'
      + ']'.repeat(depth);

    expect(() => JSON.parse(encoded)).not.toThrow();
    expect(redactJsonEncodedSecretValues(malformed)).toBe(malformed);
    expect(redactJsonEncodedSecretValues(encoded)).toBe(encoded);
    expect(redactSecretLikeJson({ body: encoded })).toEqual({
      value: { body: encoded },
      redactedPaths: [],
    });
  });

  test('reports a redaction path only when the persisted value changes', () => {
    expect(redactSecretLikeJson({ secret: '[redacted]', authorization: null, token: 0 })).toEqual({
      value: { secret: '[redacted]', authorization: null, token: 0 },
      redactedPaths: [],
    });
  });

  test('elideLargeBlobs collapses long base64 runs to a length note', () => {
    const blob = 'A'.repeat(400);
    expect(elideLargeBlobs(`img:${blob}`)).toBe('img:[base64 elided: 400 chars]');
    expect(elideLargeBlobs('short text')).toBe('short text');
  });
});
