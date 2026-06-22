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
  arguments: { node_id: 'node-alpha' },
};

const searchTool: ToolCall = {
  type: 'toolCall',
  id: 'tool-search',
  name: 'node_search',
  arguments: { outline: 'design system' },
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
  // The live divider is the PERSISTENT "Working for {t}" clock (Codex machine C):
  // once the run clock is known it is the header whether the body is collapsed or
  // expanded. Clock-less live entries stay on bare "Working" rather than replacing
  // the divider with a thought/tool summary.
  test('live header shows the persistent "Working for {t}" clock once the run clock is known', () => {
    const live = {
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set([readTool.id]),
      results: new Map(),
      toolCalls: [readTool, searchTool],
      turnActive: true,
      liveElapsedMs: 5_000,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    };
    // Persistent: same clock collapsed AND expanded.
    expect(summarizeProcess({ ...live, liveCollapsed: true })).toBe('Working for 5s');
    expect(summarizeProcess({ ...live, liveCollapsed: false })).toBe('Working for 5s');
  });

  test('live header shows bare "Working" under one second (no flickering "0s")', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      lastThinkingText: null,
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: false,
      liveElapsedMs: 400,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Working');
  });

  test('the live clock wins over a partial wall-clock duration', () => {
    // A still-running turn never shows the (partial) workedFor duration; the live
    // clock is the header — distinct values prove which one is used.
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: true,
      liveCollapsed: false,
      liveElapsedMs: 3_000,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: 9_000,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Working for 3s');
  });

  test('clock-less live header stays on bare "Working" whether collapsed or expanded', () => {
    const live = {
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Now search the design system',
      thinkingCount: 2,
      pendingToolCallIds: new Set([searchTool.id]),
      results: new Map([[readTool.id, readResult]]),
      toolCalls: [readTool, searchTool],
      turnActive: true,
      liveElapsedMs: null,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    };
    expect(summarizeProcess({ ...live, liveCollapsed: true })).toBe('Working');
    expect(summarizeProcess({ ...live, liveCollapsed: false })).toBe('Working');
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
      liveElapsedMs: null,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Thought · read a node · searched');
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
      liveElapsedMs: null,
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
      liveElapsedMs: null,
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
      liveElapsedMs: null,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: 63_000,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Worked for 1m 3s');
  });

  test('interrupted (RED) wins over the live clock', () => {
    // A failed/cancelled turn is never a "Working" divider even with a live clock.
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
      lastThinkingText: 'Identify relevant outline nodes',
      thinkingCount: 1,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [readTool],
      turnActive: false,
      liveCollapsed: false,
      liveElapsedMs: 8_000,
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
      liveElapsedMs: null,
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
