import { describe, expect, test } from 'bun:test';
import {
  containsSecretLikeContent,
  DIAGNOSTIC_SECRET_REDACTION_OMISSION,
  elideLargeBlobs,
  redactSecretLikeContent,
  redactSecretLikeJsonAsync,
  redactSecretLikeJsonForDiagnostics,
} from '../../src/main/agent/capabilities/agentSecretRedaction';

const OPENAI_KEY = `sk-proj-${'A'.repeat(74)}T3BlbkFJ${'B'.repeat(74)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${'C'.repeat(93)}AA`;
const CREDENTIAL_VALUE = 'credential-value-0123456789';
const SHORT_PRIVATE_KEY = [
  '-----BEGIN EC PRIVATE KEY-----',
  'secret material',
  '-----END EC PRIVATE KEY-----',
].join('\n');

const REDACTION_CONTRACT = {
  mustRedact: [
    ...[
      'x-api-key',
      'X-Api-Key',
      'credentials',
      'api_key',
      'apikey',
      'APIKEY',
      'APIKey',
      'openai_api_key',
      'anthropic_api_key',
      'OPENAI_API_KEY',
      'aws_secret_access_key',
      'secret_key',
      'secretKey',
      'session_token',
      'bot_token',
      'authtoken',
      'accesstoken',
      'gh_token',
      'npm_token',
      'jwt_secret',
      'webhook_secret',
      'app_secret',
      'shared_secret',
      'oauth_secret',
      'user_password',
      'db_password',
      'admin_password',
      'basic_auth_password',
      'password_hash',
      'root_passwd',
      'smtp_pwd',
      'private_key',
      'ssh_private_key',
      'privateKeyPem',
      'proxy_authorization',
      'X-Authorization',
    ].map((key) => ({ name: `field:${key}`, value: { [key]: CREDENTIAL_VALUE } })),
    { name: 'short EC private key', value: { content: SHORT_PRIVATE_KEY } },
    { name: 'short RSA private key', value: { content: SHORT_PRIVATE_KEY.replaceAll('EC', 'RSA') } },
    { name: 'legacy sk-24', value: { content: `sk-${'A'.repeat(24)}` } },
    { name: 'legacy sk-48', value: { content: `sk-${'B'.repeat(48)}` } },
    { name: 'short GitHub token', value: { content: `ghp_${'c'.repeat(20)}` } },
    {
      name: 'JWT',
      value: { content: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2' },
    },
    { name: 'Bearer token', value: { content: `Bearer ${'d'.repeat(24)}` } },
    {
      name: 'environment credential assignment',
      value: { command: 'PGPASSWORD=hunter2hunter2hunter2 psql' },
    },
    {
      name: 'JSON-encoded credentials',
      value: {
        body: JSON.stringify({
          client_secret: 'client-secret-0123456789',
          password: 'password-value-0123456789',
        }),
      },
    },
  ],
  mustPreserve: [
    ...[
      ['token_budget', 8_192],
      ['max_total_tokens', 8_192],
      ['max_new_tokens', 512],
      ['budget_tokens', 4_096],
      ['tokens', 4_096],
      ['maxTokens', 2_048],
      ['totalTokens', 1_024],
      ['usedTokens', 128],
      ['tokenCount', 64],
      ['cacheReadInputTokens', 32],
      ['cache_creation_input_tokens', 16],
      ['authorization_url', 'https://example.test/oauth/authorize'],
      ['passwordPolicy', 'at least twelve characters'],
      ['password_policy_enabled', true],
      ['passwordless', true],
      ['secretary', { name: 'Ada' }],
      ['secretName', 'release-signing'],
      ['credentials', 'include'],
      ['credentials', 'same-origin'],
      ['credentials', 'browser-default'],
      ['credentials', 'same-origin-with-fallback'],
      ['pageToken', 'CAESB0FCQ0RFRkc'],
      ['token', 'hello'],
      ['token', 'abcdefghijklmnopqrstuvwx'],
      ['tokenizerEnabled', true],
      ['password', 12_345],
      ['authorization', false],
    ].map(([key, value]) => ({ name: `field:${String(key)}`, value: { [String(key)]: value } })),
    {
      name: 'design-token JSON',
      value: {
        content: JSON.stringify({
          ink: '#111111',
          tokens: { spacing: 8, color: 'rose' },
          secretary: { name: 'Ada' },
        }, null, 2),
      },
    },
    {
      name: 'benign environment assignments',
      value: {
        command: 'MAX_NEW_TOKENS=512 BUDGET_TOKENS=4096 TOKENIZER_ENABLED=true SECRETARY=release-coordinator npm test',
      },
    },
  ],
} as const;

describe('agent secret redaction', () => {
  test('detects truncated private key headers for skill write rejection', () => {
    const content = '-----BEGIN OPENSSH PRIVATE KEY-----\ntruncated';

    expect(containsSecretLikeContent(content)).toBe(true);
    expect(redactSecretLikeContent(content)).toBe(content);
  });

  test('does not hard-block ambiguous credential-like prose', () => {
    for (const content of ['token=abcdefghijklmnop', 'password=not-a-real-credential']) {
      expect(containsSecretLikeContent(content)).toBe(false);
      expect(redactSecretLikeContent(content)).toBe(content);
    }
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

  test('redacts explicit bearer, JWT, and environment credential assignments in memory text', () => {
    expect(redactSecretLikeContent("curl -H 'Authorization: Bearer ghp_0123456789abcdefghij'"))
      .not.toContain('ghp_0123456789abcdefghij');
    const environmentAssignment = 'PGPASSWORD=hunter2hunter2hunter2 psql';
    expect(containsSecretLikeContent(environmentAssignment)).toBe(true);
    expect(redactSecretLikeContent(environmentAssignment)).toBe('[redacted secret-like content] psql');
    expect(redactSecretLikeContent('token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2'))
      .toContain('[redacted secret-like content]');
  });

  test('enforces the independent bidirectional redaction contract on the durable scanner', async () => {
    for (const fixture of REDACTION_CONTRACT.mustRedact) {
      const result = await redactSecretLikeJsonAsync(fixture.value);
      expect(result.redactedPaths.length, fixture.name).toBeGreaterThan(0);
      expect(JSON.stringify(result.value), fixture.name).not.toBe(JSON.stringify(fixture.value));
    }
    for (const fixture of REDACTION_CONTRACT.mustPreserve) {
      expect(await redactSecretLikeJsonAsync(fixture.value), fixture.name).toEqual({
        value: fixture.value,
        redactedPaths: [],
      });
    }
  });

  test('uses Secretlint value signatures even under neutral field names', async () => {
    const content = `first=${OPENAI_KEY}\nsecond=${ANTHROPIC_KEY}`;
    const result = await redactSecretLikeJsonAsync({ value: OPENAI_KEY, content });

    expect(result.redactedPaths).toEqual(['/value', '/content']);
    expect(result.value.value).toBe('[redacted secret-like content]');
    expect(result.value.content).not.toContain(OPENAI_KEY);
    expect(result.value.content).not.toContain(ANTHROPIC_KEY);
  });

  test('does not let content disable Secretlint credential detection', async () => {
    const content = `<!-- secretlint-disable -->\n${OPENAI_KEY}`;

    expect((await redactSecretLikeJsonAsync({ content })).value.content).toBe(
      '<!-- secretlint-disable -->\n[redacted secret-like content]',
    );
  });

  test('keeps commands, source, and design-token JSON exact when no known credential matches', async () => {
    const command = "sed -i 's/token=old/token=abcdefghijklmnop/' config.ini";
    const source = 'const token = "placeholder1234";';
    const tokensFile = JSON.stringify({
      ink: '#111111',
      tokens: { space: 8 },
      secretary: { name: 'Ada' },
      password: 'not-a-real-credential',
    }, null, 2);

    expect(await redactSecretLikeJsonAsync({ command, source, content: tokensFile })).toEqual({
      value: { command, source, content: tokensFile },
      redactedPaths: [],
    });
  });

  test('redacts only direct string values at the serialized provider-arguments boundary', async () => {
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
    const result = await redactSecretLikeJsonAsync({ arguments: encoded });
    const redacted = result.value.arguments;

    expect(result.redactedPaths).toEqual(['/arguments']);
    expect(redacted).toContain('"client_secret" : "[redacted]"');
    expect(redacted).toContain('"password": "[redacted]"');
    expect(redacted).toContain('"provider_value": "[redacted secret-like content]"');
    expect(redacted).toContain('"token_budget": 120000');
    expect(redacted).toContain('"secret": false');
    expect(redacted).toContain('"credentials": { "name": "ordinary" }');
    expect(redacted).toContain(JSON.stringify(nestedBody));
  });

  test('does not recursively reinterpret JSON stored inside an ordinary string field', async () => {
    const body = '{\n  "client_secret": "nested-ambiguous-value",\n  "safe": "keep"\n}';
    const encoded = JSON.stringify({ body, query: 'keep' }, null, 2);

    expect(await redactSecretLikeJsonAsync({ arguments: encoded })).toEqual({
      value: { arguments: encoded },
      redactedPaths: [],
    });
  });

  test('fails open for malformed or pathologically deep serialized JSON', async () => {
    const malformed = '{"password":"unterminated"';
    const depth = 100_000;
    const encoded = '['.repeat(depth)
      + '{"password":"deep-ambiguous-value"}'
      + ']'.repeat(depth);

    expect(() => JSON.parse(encoded)).not.toThrow();
    expect(await redactSecretLikeJsonAsync({ body: malformed })).toEqual({
      value: { body: malformed },
      redactedPaths: [],
    });
    expect(await redactSecretLikeJsonAsync({ body: encoded })).toEqual({
      value: { body: encoded },
      redactedPaths: [],
    });
  });

  test('keeps durable scans fail-open and types diagnostic whole-payload omission explicitly', async () => {
    const unscannable = new Proxy<Record<string, unknown>>({}, {
      ownKeys: () => { throw new Error('unscannable'); },
    });

    const durable = await redactSecretLikeJsonAsync(unscannable);
    expect(durable.value).toBe(unscannable);
    expect(durable.redactedPaths).toEqual([]);
    expect(await redactSecretLikeJsonForDiagnostics(unscannable)).toEqual({
      value: DIAGNOSTIC_SECRET_REDACTION_OMISSION,
      redactedPaths: [''],
    });
  });

  test('applies the diagnostic scan budget before parsing serialized JSON arguments', async () => {
    const encoded = JSON.stringify({ password: 'x'.repeat(70_000) });
    const result = await redactSecretLikeJsonForDiagnostics({ arguments: encoded });

    expect(result).toEqual({
      value: {
        arguments: `[diagnostic text omitted after secret-scan budget: ${encoded.length} chars]`,
      },
      redactedPaths: ['/arguments'],
    });
  });

  test('keeps one ordered diagnostic budget across a batched scan', async () => {
    const first = 'ordinary first text '.repeat(1_500);
    const second = `credential=${OPENAI_KEY}`;
    const third = 'ordinary overflow text '.repeat(1_600);
    const result = await redactSecretLikeJsonForDiagnostics({ first, second, third });

    expect(result.value).toEqual({
      first,
      second: 'credential=[redacted secret-like content]',
      third: `[diagnostic text omitted after secret-scan budget: ${third.length} chars]`,
    });
    expect(result.redactedPaths).toEqual(['/second', '/third']);
  });

  test('keeps arbitrary-span private-key redaction byte-identical in a large batch', async () => {
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'ordinary key material words '.repeat(10_000),
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const expected = redactSecretLikeContent(privateKey);
    const result = await redactSecretLikeJsonAsync({ content: privateKey });

    expect(result).toEqual({ value: { content: expected }, redactedPaths: ['/content'] });
    expect(expected).toBe('[redacted secret-like content]');
  });

  test('reports a redaction path only when the persisted value changes', async () => {
    expect(await redactSecretLikeJsonAsync({ secret: '[redacted]', authorization: null, token: 0 })).toEqual({
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
