import { describe, expect, test } from 'bun:test';
import {
  MAX_MODEL_TOOL_CORRECTION_BYTES,
  MAX_MODEL_TOOL_EVIDENCE_SUMMARY_BYTES,
  MAX_MODEL_TOOL_PROVIDER_NAME_BYTES,
  MAX_MODEL_PROVIDER_THOUGHT_SIGNATURE_BYTES,
  type JsonValue,
  type ThreadContextPayloadReference,
} from '../../src/core/agent/protocol';
import {
  modelToolSchemaDigest,
  persistToolCallAdmission,
  prepareToolCallArguments,
  transientToolCallAdmission,
  type ToolCallAdmissionRequest,
} from '../../src/main/agent/runtime/toolCallHistory';
import type { AgentToolLargeTextArguments } from '../../src/main/agent/runtime/kernel/types';

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
      await admittedRequest(ordinaryArguments),
      async () => { throw new Error('Small arguments must stay inline.'); },
    );
    expect(ordinary).toEqual({
      modelCall: {
        disposition: 'replayable',
        identity: { namespace: null, name: 'bash' },
        providerName: 'bash',
        providerCall: {
          id: 'call-1',
          api: 'openai-responses',
          provider: 'openai',
          model: 'test-model',
          thoughtSignature: null,
        },
        arguments: { storage: 'inline', value: ordinaryArguments },
        schemaDigest: SCHEMA_DIGEST,
      },
      displayArguments: ordinaryArguments,
      execute: true,
    });

    const secret = 'abcdefghijklmnop';
    const secretArguments = {
      command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
      nested: { 'secret/key~': 'do-not-persist' },
    } as const;
    const redacted = await persistToolCallAdmission(
      await admittedRequest(secretArguments),
      async () => { throw new Error('Small arguments must stay inline.'); },
    );
    expect(redacted.modelCall).toMatchObject({
      disposition: 'redactedReplay',
      redactedArguments: {
        storage: 'inline',
        value: {
          command: 'curl -H "Authorization: [redacted secret-like content]" https://example.test',
          nested: { 'secret/key~': '[redacted]' },
        },
      },
      redactedPaths: ['/command', '/nested/secret~1key~0'],
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).not.toContain('do-not-persist');
    expect(secretArguments.nested['secret/key~']).toBe('do-not-persist');
  });

  test('does not rewrite ambiguous token assignments in commands or file content', async () => {
    const argumentsValue = {
      command: "sed -i 's/token=old/token=abcdefghijklmnop/' config.ini",
      content: 'const token = "placeholder1234";',
    } as const;

    const decision = await persistToolCallAdmission(
      await admittedRequest(argumentsValue),
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

  test('redacts direct credentials in a JSON-shaped argument string', async () => {
    const body = [
      '{',
      '  "client_secret" : "9f3a2c8d5e71b04a",',
      '  "password": "s3cr3t-value-1234",',
      '  "query": "keep spacing"',
      '}',
    ].join('\n');
    const decision = await persistToolCallAdmission(
      await admittedRequest({ body }),
      async () => { throw new Error('Small arguments must stay inline.'); },
    );

    const redactedBody = body
      .replace('9f3a2c8d5e71b04a', '[redacted]')
      .replace('s3cr3t-value-1234', '[redacted]');
    expect(decision).toMatchObject({
      execute: true,
      displayArguments: { body: redactedBody },
      modelCall: {
        disposition: 'redactedReplay',
        redactedArguments: { storage: 'inline', value: { body: redactedBody } },
        redactedPaths: ['/body'],
      },
    });
    expect(JSON.stringify(decision)).not.toContain('9f3a2c8d5e71b04a');
    expect(JSON.stringify(decision)).not.toContain('s3cr3t-value-1234');
  });

  test('scans selected large text standalone and persists only its redacted durable value', async () => {
    const secret = 'abcdefghijklmnop';
    const stdin = `Authorization: Bearer ${secret}\n${'x'.repeat(40_000)}`;
    const contract: AgentToolLargeTextArguments = {
      maxBindings: 1,
      maxAggregateBytes: 64 * 1024 * 1024,
      select: () => [{
        kind: 'internalText',
        path: '/stdin',
        maxBytes: 64 * 1024 * 1024,
        historyPolicy: 'secretScanText',
      }],
    };
    const request = await admittedRequest({ command: 'capture-input', stdin }, true, contract);
    let persistedText = '';
    const payloadRef: ThreadContextPayloadReference = {
      id: 'b'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json',
      byteLength: 128,
      schemaVersion: 1,
      kind: 'toolCallArguments',
    };
    const decision = await persistToolCallAdmission(request, async (_value, selected) => {
      persistedText = selected[0]?.value ?? '';
      return { storage: 'payload', ref: payloadRef, internalTextRefs: [] };
    });

    expect(request.outcome).toMatchObject({
      type: 'admitted',
      arguments: { stdin },
      redactedPaths: ['/stdin'],
    });
    expect(persistedText).toContain('[redacted secret-like content]');
    expect(persistedText).not.toContain(secret);
    expect(decision).toMatchObject({
      execute: true,
      modelCall: { disposition: 'redactedReplay' },
    });
  });

  test('keeps an executed secret call as evidence when its redacted copy fails the admission schema', async () => {
    const secret = 'abcdefghijklmnop';
    const decision = await persistToolCallAdmission(
      await admittedRequest({ authorization: secret }, false),
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
    const request = await admittedRequest(argumentsValue);
    const durable = await persistToolCallAdmission(request, async (value) => {
      persisted = value;
      return { storage: 'payload', ref: payloadRef, internalTextRefs: [] };
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

    const transient = transientToolCallAdmission(request);
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
      providerCall: {
        id: 'rejected',
        api: 'openai-responses',
        provider: 'openai',
        model: 'test-model',
        thoughtSignature: null,
      },
      outcome: {
        type: 'rejected',
        identity: null,
        redactedArguments: { value: '界'.repeat(20_000) },
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

  test('executes a call whose provider replay metadata exceeds the durable budget', async () => {
    const request = await admittedRequest({ command: 'pwd' });
    const oversizedSignature = 'x'.repeat(MAX_MODEL_PROVIDER_THOUGHT_SIGNATURE_BYTES + 1);
    const decision = await persistToolCallAdmission({
      ...request,
      providerCall: { ...request.providerCall, thoughtSignature: oversizedSignature },
    }, async () => { throw new Error('Small arguments must stay inline.'); });

    expect(decision).toMatchObject({
      execute: true,
      modelCall: {
        disposition: 'evidenceOnly',
        reason: 'providerReplayUnavailable',
      },
    });
    expect(JSON.stringify(decision)).not.toContain(oversizedSignature);
  });

  test('does not persist payload-sized arguments when provider replay metadata is unavailable', async () => {
    const argumentsValue = { content: 'x'.repeat(40_000) } as const;
    const request = await admittedRequest(argumentsValue);
    const oversizedSignature = 'x'.repeat(MAX_MODEL_PROVIDER_THOUGHT_SIGNATURE_BYTES + 1);
    const replayUnavailableRequest = {
      ...request,
      providerCall: { ...request.providerCall, thoughtSignature: oversizedSignature },
    };
    let persistenceAttempted = false;

    const durable = await persistToolCallAdmission(replayUnavailableRequest, async () => {
      persistenceAttempted = true;
      throw new Error('Provider-ineligible history must not allocate an argument payload.');
    });
    const transient = transientToolCallAdmission(replayUnavailableRequest);

    expect(persistenceAttempted).toBe(false);
    for (const decision of [durable, transient]) {
      expect(decision).toMatchObject({
        execute: true,
        modelCall: {
          disposition: 'evidenceOnly',
          reason: 'providerReplayUnavailable',
        },
      });
      expect(JSON.stringify(decision)).not.toContain(oversizedSignature);
    }
  });
});

async function admittedRequest(
  argumentsValue: JsonValue,
  redactedArgumentsReplayable = true,
  largeTextArguments?: AgentToolLargeTextArguments,
): Promise<ToolCallAdmissionRequest> {
  const redacted = await prepareToolCallArguments(argumentsValue, largeTextArguments);
  return {
    toolCallId: 'call-1',
    providerName: 'bash',
    providerCall: {
      id: 'call-1',
      api: 'openai-responses',
      provider: 'openai',
      model: 'test-model',
      thoughtSignature: null,
    },
    outcome: {
      type: 'admitted',
      identity: { namespace: null, name: 'bash' },
      arguments: redacted.arguments,
      redactedArguments: redacted.redactedArguments,
      redactedPaths: redacted.redactedPaths,
      displayArguments: redacted.redactedArguments,
      schemaDigest: SCHEMA_DIGEST,
      redactedArgumentsReplayable,
      ...(largeTextArguments ? { largeTextArguments } : {}),
    },
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
