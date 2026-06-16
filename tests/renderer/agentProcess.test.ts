import { describe, expect, test } from 'bun:test';
import type { ToolCall, ToolResultMessage } from '../../src/core/agentTypes';
import { summarizeProcess } from '../../src/renderer/ui/agent/AgentProcessBlock';
import { getMessages } from '../../src/core/i18n';

const { process, toolCall: toolCallLabels, thinking } = getMessages('en').agent;
const thinkingLabel = thinking.thinking;

const readTool: ToolCall = {
  type: 'toolCall',
  id: 'tool-read',
  name: 'node_read',
  arguments: { nodeId: 'node-alpha' },
};

const searchTool: ToolCall = {
  type: 'toolCall',
  id: 'tool-search',
  name: 'node_search',
  arguments: { query: 'design system' },
};

const readResult: ToolResultMessage = {
  role: 'toolResult',
  toolCallId: 'tool-read',
  toolName: 'node_read',
  content: [{ type: 'text', text: 'Alpha' }],
  isError: false,
  timestamp: 0,
};

describe('agent process summary', () => {
  test('live + collapsed header shows the currently running tool', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set([readTool.id]),
      results: new Map(),
      toolCalls: [readTool],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Reading node "node-alpha"');
  });

  test('live + collapsed header ignores resultless tool calls that are no longer pending', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Now search the design system',
      thinkingCount: 2,
      pendingToolCallIds: new Set([searchTool.id]),
      results: new Map(),
      toolCalls: [readTool, searchTool],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Searching nodes "design system"');
  });

  test('live + collapsed header previews the latest thought while still thinking', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Let me map the outline structure first',
      lastThinkingText: 'Let me map the outline structure first',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Let me map the outline structure first');
  });

  test('live + collapsed header falls back to the thinking label with no thought text yet', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      lastThinkingText: null,
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe(thinkingLabel);
  });

  test('live + expanded header shows the static group summary, not the live tool', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: true,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Thought · used 2 tools');
  });

  test('summarizes mixed completed process as one collapsed process row', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Thought · used 2 tools');
  });

  test('summarizes solo completed tool by tool status', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      lastThinkingText: null,
      thinkingCount: 0,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Read node "node-alpha"');
  });

  test('keeps interrupted process distinct from completed prose', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [readTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: true,
      surfaceResultlessProcess: true,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Interrupted after thinking');
  });

  test('sealed turn collapses to "Worked for {duration}" when the run wall-clock is known', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: 63_000,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Worked for 1m 3s');
  });

  test('a known duration never overrides the live status line while collapsed and running', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set([readTool.id]),
      results: new Map(),
      toolCalls: [readTool],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: 5_000,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Reading node "node-alpha"');
  });

  test('an expanded, still-running turn shows the descriptive summary, never a partial duration', () => {
    // turnActive gates the workedFor branch INSIDE summarizeProcess, so even with a
    // non-null (partial) duration a live turn keeps its descriptive header.
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: true,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: 5_000,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Thought · used 2 tools');
  });

  test('an interrupted turn keeps its interrupted label over the duration', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [readTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: true,
      surfaceResultlessProcess: true,
      workedForMs: 8_000,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Interrupted after thinking');
  });

  test('a surfaced resultless turn shows its descriptive summary, never "Worked for" (DM #240)', () => {
    // Same sealed, non-interrupted turn with a known wall-clock — the ONLY
    // difference is whether we are surfacing its resultless process. A folded
    // turn (a completed-with-result turn, or a cleanly-completed resultless
    // Channel turn) rests on "Worked for …"; a surfaced resultless DM turn skips
    // that so the duration never reads as a clean unit of work with no answer.
    const base = {
      firstThinkingText: null,
      lastThinkingText: null,
      thinkingCount: 0,
      pendingToolCallIds: new Set<string>(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool],
      turnActive: false,
      liveCollapsed: false,
      turnFailedWithoutProse: false,
      workedForMs: 5_000,
      process,
      toolCallLabels,
      thinkingLabel,
    };
    expect(summarizeProcess({ ...base, surfaceResultlessProcess: false })).toBe('Worked for 5s');
    expect(summarizeProcess({ ...base, surfaceResultlessProcess: true })).toBe('Read node "node-alpha"');
  });
});
