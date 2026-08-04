import { describe, expect, test } from 'bun:test';
import {
  MAX_MODEL_TOOL_CORRECTION_BYTES,
  MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES,
  MAX_MODEL_TOOL_PROVIDER_NAME_BYTES,
  type JsonValue,
  type ThreadContextPayloadReference,
} from '../../src/core/agent/protocol';
import {
  modelToolSchemaDigest,
  persistToolCallAdmission,
  transientToolCallAdmission,
  type ToolCallAdmissionRequest,
} from '../../src/main/agent/runtime/toolCallHistory';

const SCHEMA_DIGEST = modelToolSchemaDigest({
  type: 'object',
  additionalProperties: false,
  properties: { command: { type: 'string' } },
  required: ['command'],
});

describe('canonical model tool-call admission', () => {
  test('keeps ordinary arguments exact and persists only structure-preserving secret redactions', async () => {
    const ordinaryArguments = {
      command: 'pwd',
      description: 'Print the working directory',
      token_budget: 200_000,
      max_total_tokens: 80_000,
    } as const;
    const ordinary = await persistToolCallAdmission(
      admittedRequest(ordinaryArguments),
      async () => { throw new Error('Small arguments must stay inline.'); },
    );
    expect(ordinary).toEqual({
      modelCall: {
        disposition: 'replayable',
        identity: { namespace: null, name: 'bash' },
        providerName: 'bash',
        arguments: { storage: 'inline', value: ordinaryArguments },
        schemaDigest: SCHEMA_DIGEST,
      },
      displayArguments: ordinaryArguments,
      execute: true,
    });

    const secret = 'abcdefghijklmnop';
    const secretArguments = {
      command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
      nested: { 'secret/key~name': 'do-not-persist' },
    } as const;
    const redacted = await persistToolCallAdmission(
      admittedRequest(secretArguments),
      async () => { throw new Error('Small arguments must stay inline.'); },
    );
    expect(redacted.modelCall).toMatchObject({
      disposition: 'redactedReplay',
      redactedArguments: {
        storage: 'inline',
        value: {
          command: 'curl -H "Authorization: [redacted secret-like content]" https://example.test',
          nested: { 'secret/key~name': '[redacted]' },
        },
      },
      redactedPaths: ['/command', '/nested/secret~1key~0name'],
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).not.toContain('do-not-persist');
    expect(secretArguments.nested['secret/key~name']).toBe('do-not-persist');
  });

  test('does not rewrite ambiguous token assignments in commands or file content', async () => {
    const argumentsValue = {
      command: "sed -i 's/token=old/token=abcdefghijklmnop/' config.ini",
      content: 'const token = "placeholder1234";',
    } as const;

    const decision = await persistToolCallAdmission(
      admittedRequest(argumentsValue),
      async () => { throw new Error('Small arguments must stay inline.'); },
    );

    expect(decision).toMatchObject({
      execute: true,
      displayArguments: argumentsValue,
      modelCall: {
        disposition: 'replayable',
        arguments: { storage: 'inline', value: argumentsValue },
      },
    });
  });

  test('persists JSON-encoded request bodies with secret values redacted in place', async () => {
    const body = [
      '{',
      '  "client_secret" : "9f3a2c8d5e71b04a",',
      '  "password": "s3cr3t-value-1234",',
      '  "query": "keep spacing"',
      '}',
    ].join('\n');
    const expectedBody = body
      .replace('"9f3a2c8d5e71b04a"', '"[redacted]"')
      .replace('"s3cr3t-value-1234"', '"[redacted]"');

    const decision = await persistToolCallAdmission(
      admittedRequest({ body }),
      async () => { throw new Error('Small arguments must stay inline.'); },
    );

    expect(decision).toMatchObject({
      execute: true,
      displayArguments: { body: expectedBody },
      modelCall: {
        disposition: 'redactedReplay',
        redactedArguments: { storage: 'inline', value: { body: expectedBody } },
        redactedPaths: ['/body'],
      },
    });
    expect(JSON.stringify(decision)).not.toContain('9f3a2c8d5e71b04a');
    expect(JSON.stringify(decision)).not.toContain('s3cr3t-value-1234');
  });

  test('keeps an executed secret call as evidence when its redacted copy fails the admission schema', async () => {
    const secret = 'abcdefghijklmnop';
    const decision = await persistToolCallAdmission(
      admittedRequest({ authorization: secret }, false),
      async () => { throw new Error('Evidence-only arguments must not allocate a payload.'); },
    );

    expect(decision).toMatchObject({
      execute: true,
      displayArguments: { authorization: '[redacted]' },
      modelCall: {
        disposition: 'evidenceOnly',
        providerName: 'bash',
        reason: 'schemaIncompatible',
        redactedArgumentsSummary: { authorization: '[redacted]' },
      },
    });
    expect(JSON.stringify(decision)).not.toContain(secret);
  });

  test('stores large arguments exactly in a Thread payload and refuses transient inline overflow', async () => {
    const argumentsValue = { content: '界'.repeat(12_000), path: '/workspace/large.txt' } as const;
    let persisted: JsonValue | null = null;
    const payloadRef: ThreadContextPayloadReference = {
      id: 'a'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: 40_000,
      schemaVersion: 1,
      kind: 'toolCallArguments',
    };
    const durable = await persistToolCallAdmission(admittedRequest(argumentsValue), async (value) => {
      persisted = value;
      return payloadRef;
    });

    expect(persisted).toEqual(argumentsValue);
    expect(durable.displayArguments).toEqual(argumentsValue);
    expect(durable).toMatchObject({
      execute: true,
      modelCall: {
        disposition: 'replayable',
        arguments: { storage: 'payload', ref: payloadRef },
      },
    });

    const transient = transientToolCallAdmission(admittedRequest(argumentsValue));
    expect(transient).toMatchObject({
      execute: false,
      modelCall: {
        disposition: 'evidenceOnly',
        reason: 'argumentPersistenceUnavailable',
      },
    });
    expect(utf8Bytes(JSON.stringify(transient.modelCall.disposition === 'evidenceOnly'
      ? transient.modelCall.redactedArgumentsSummary
      : null))).toBeLessThanOrEqual(MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES);
  });

  test('bounds untrusted evidence fields by UTF-8 bytes before persistence', () => {
    const decision = transientToolCallAdmission({
      toolCallId: 'rejected',
      providerName: '工'.repeat(2_000),
      outcome: {
        type: 'rejected',
        identity: null,
        arguments: { value: '界'.repeat(20_000) },
        reason: 'invalidArguments',
        correction: '改'.repeat(8_000),
      },
    });
    if (decision.modelCall.disposition !== 'evidenceOnly') {
      throw new Error('Expected evidence-only admission.');
    }
    expect(utf8Bytes(decision.modelCall.providerName)).toBeLessThanOrEqual(
      MAX_MODEL_TOOL_PROVIDER_NAME_BYTES,
    );
    expect(utf8Bytes(decision.modelCall.correction)).toBeLessThanOrEqual(
      MAX_MODEL_TOOL_CORRECTION_BYTES,
    );
    expect(utf8Bytes(JSON.stringify(decision.modelCall.redactedArgumentsSummary))).toBeLessThanOrEqual(
      MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES,
    );
  });
});

function admittedRequest(
  argumentsValue: JsonValue,
  redactedArgumentsReplayable = true,
): ToolCallAdmissionRequest {
  return {
    toolCallId: 'call-1',
    providerName: 'bash',
    outcome: {
      type: 'admitted',
      identity: { namespace: null, name: 'bash' },
      arguments: argumentsValue,
      schemaDigest: SCHEMA_DIGEST,
      redactedArgumentsReplayable,
    },
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
