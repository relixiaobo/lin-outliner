import { createHash } from 'node:crypto';
import type {
  JsonValue,
  ModelToolCallHistory,
  ModelToolIdentity,
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
): ModelToolCallHistory {
  return {
    disposition: 'replayable',
    identity: testToolIdentity(providerName),
    arguments: { storage: 'inline', value: args },
    schemaDigest: TEST_TOOL_SCHEMA_DIGEST,
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
    historyArguments: args,
    decision: {
      modelCall: replayableModelCall(toolName, args),
      displayArguments: args,
      execute: true,
    },
  };
}
