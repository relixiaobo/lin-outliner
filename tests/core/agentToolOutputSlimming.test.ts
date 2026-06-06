import { describe, expect, test } from 'bun:test';
import {
  collectAgentMessageToolResultBudgetSelections,
  collectToolResultBudgetSelections,
  createToolResultBudgetState,
  restoreToolResultBudgetStateFromAgentMessages,
  restoreToolResultBudgetStateFromMessages,
} from '../../src/main/agentToolOutputSlimming';
import type { AgentEventMessageRecord, AgentPayloadRef } from '../../src/core/agentEventLog';
import type { AgentMessage } from '../../src/core/agentTypes';

function assistant(id: string, toolCallIds: string[]): AgentEventMessageRecord {
  return {
    id,
    role: 'assistant',
    actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
    parentMessageId: null,
    content: toolCallIds.map((toolCallId) => ({
      type: 'toolCall',
      id: toolCallId,
      name: 'bash',
      arguments: {},
    })),
    createdAt: 1,
    updatedAt: 1,
    status: 'completed',
  };
}

function toolResult(id: string, toolCallId: string, text: string): AgentEventMessageRecord {
  return {
    id,
    role: 'toolResult',
    actor: { type: 'tool', toolName: 'bash', toolCallId },
    parentMessageId: 'assistant-1',
    content: [{ type: 'text', text }],
    createdAt: 2,
    updatedAt: 2,
    status: 'completed',
    toolCallId,
    toolName: 'bash',
    isError: false,
  };
}

function piAssistant(toolCallIds: string[]): AgentMessage {
  return {
    role: 'assistant',
    api: 'chat',
    provider: 'openai',
    model: 'gpt-4.1',
    content: toolCallIds.map((toolCallId) => ({
      type: 'toolCall',
      id: toolCallId,
      name: 'bash',
      arguments: {},
    })),
    stopReason: 'toolUse',
    timestamp: 1,
  };
}

function piToolResult(toolCallId: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 2,
  };
}

describe('agent tool output slimming', () => {
  test('selects only fresh largest tool results when a tool batch exceeds budget', () => {
    const state = createToolResultBudgetState();
    const messages = [
      assistant('assistant-1', ['tool-1', 'tool-2', 'tool-3']),
      toolResult('result-1', 'tool-1', 'a'.repeat(30)),
      toolResult('result-2', 'tool-2', 'b'.repeat(80)),
      toolResult('result-3', 'tool-3', 'c'.repeat(20)),
    ];

    const selection = collectToolResultBudgetSelections(messages, state, { limit: 70 });

    expect(selection.toPersist.map((candidate) => candidate.toolCallId)).toEqual(['tool-2']);
    expect(state.seenIds.has('tool-1')).toBe(true);
    expect(state.seenIds.has('tool-3')).toBe(true);
    expect(state.seenIds.has('tool-2')).toBe(false);
  });

  test('does not retroactively replace seen results even when the batch remains over budget', () => {
    const state = createToolResultBudgetState();
    state.seenIds.add('tool-1');
    const messages = [
      assistant('assistant-1', ['tool-1', 'tool-2']),
      toolResult('result-1', 'tool-1', 'a'.repeat(500)),
      toolResult('result-2', 'tool-2', 'b'.repeat(10)),
    ];

    const selection = collectToolResultBudgetSelections(messages, state, { limit: 20 });

    expect(selection.toPersist.map((candidate) => candidate.toolCallId)).toEqual(['tool-2']);
    expect(state.seenIds.has('tool-2')).toBe(false);
    expect(selection.toPersist.some((candidate) => candidate.toolCallId === 'tool-1')).toBe(false);
  });

  test('restores persisted-output replacement state from payload refs', () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'tool-output-tool-1',
      storage: 'file',
      mimeType: 'text/plain',
      byteLength: 100_000,
      sha256: 'sha',
      role: 'tool_output',
      summary: 'bash output',
      truncated: true,
    };
    const state = restoreToolResultBudgetStateFromMessages([
      assistant('assistant-1', ['tool-1']),
      {
        ...toolResult('result-1', 'tool-1', ''),
        content: [{
          type: 'payload_ref',
          payload,
          label: '<persisted-output>\nPreview\n</persisted-output>',
        }],
      },
    ]);

    expect(state.seenIds.has('tool-1')).toBe(true);
    expect(state.replacements.get('tool-1')).toContain('<persisted-output>');
  });

  test('does not treat incidental persisted-output text as a replacement', () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'tool-output-tool-1',
      storage: 'file',
      mimeType: 'text/plain',
      byteLength: 100_000,
      sha256: 'sha',
      role: 'tool_output',
      summary: 'bash output',
      truncated: true,
    };
    const state = restoreToolResultBudgetStateFromMessages([
      assistant('assistant-1', ['tool-1']),
      {
        ...toolResult('result-1', 'tool-1', ''),
        content: [{
          type: 'payload_ref',
          payload,
          label: 'read source containing <persisted-output> tag',
        }],
      },
    ]);

    expect(state.seenIds.has('tool-1')).toBe(true);
    expect(state.replacements.has('tool-1')).toBe(false);
  });

  test('restores persisted-output replacement state from pi sidechain messages', () => {
    const state = restoreToolResultBudgetStateFromAgentMessages([
      piAssistant(['tool-1']),
      piToolResult('tool-1', '<persisted-output>\nPreview\n</persisted-output>'),
    ]);

    expect(state.seenIds.has('tool-1')).toBe(true);
    expect(state.replacements.get('tool-1')).toContain('<persisted-output>');
  });

  test('selects fresh pi sidechain tool results without replacing restored ones', () => {
    const state = restoreToolResultBudgetStateFromAgentMessages([
      piAssistant(['tool-1']),
      piToolResult('tool-1', '<persisted-output>\nPreview\n</persisted-output>'),
    ]);
    const messages = [
      piAssistant(['tool-1', 'tool-2']),
      piToolResult('tool-1', 'a'.repeat(500)),
      piToolResult('tool-2', 'b'.repeat(80)),
    ];

    const selection = collectAgentMessageToolResultBudgetSelections(messages, state, { limit: 20 });

    expect(selection.alreadyReplaced.map((candidate) => candidate.toolCallId)).toEqual(['tool-1']);
    expect(selection.toPersist.map((candidate) => candidate.toolCallId)).toEqual(['tool-2']);
  });
});
