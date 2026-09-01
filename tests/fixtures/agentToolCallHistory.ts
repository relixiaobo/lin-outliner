import { createHash } from 'node:crypto';
import type {
  JsonValue,
  ModelToolCallHistory,
  ModelToolIdentity,
  ModelProviderToolCall,
} from '../../src/core/agent/protocol';
import type { AgentEvent } from '../../src/main/agent/runtime/kernel/types';

export const TEST_TOOL_SCHEMA_DIGEST = createHash('sha256').update('test-tool-schema').digest('hex');

export function testToolIdentity(providerName: string): ModelToolIdentity {
  const separator = providerName.indexOf('__');
  return separator < 0
    ? { namespace: null, name: providerName }
    : { namespace: providerName.slice(0, separator), name: providerName.slice(separator + 2) };
}

export function replayableModelCall(
  providerName: string,
  args: JsonValue,
  providerCall: ModelProviderToolCall = testProviderCall(providerName, args),
): ModelToolCallHistory {
  return {
    disposition: 'replayable',
    identity: testToolIdentity(providerName),
    providerName,
    providerCall,
    arguments: { storage: 'inline', value: args },
    schemaDigest: TEST_TOOL_SCHEMA_DIGEST,
  };
}

export function testProviderCall(providerName: string, args: JsonValue): ModelProviderToolCall {
  const digest = createHash('sha256').update(JSON.stringify([providerName, args])).digest('hex').slice(0, 24);
  return {
    id: `call_${digest}`,
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    thoughtSignature: null,
  };
}

export function toolAdmissionEvent(
  toolCallId: string,
  toolName: string,
  args: JsonValue,
): Extract<AgentEvent, { readonly type: 'tool_call_admission' }> {
  return {
    type: 'tool_call_admission',
    toolCallId,
    providerToolCallId: toolCallId,
    toolName,
    decision: {
      modelCall: replayableModelCall(toolName, args, {
        id: toolCallId,
        api: 'openai-responses',
        provider: 'openai',
        model: 'test-model',
        thoughtSignature: null,
      }),
      displayArguments: args,
      execute: true,
    },
  };
}
