import { describe, expect, test } from 'bun:test';
import type { ToolCall, ToolResultMessage } from '../../src/core/agentTypes';
import { summarizeProcess } from '../../src/renderer/ui/agent/AgentProcessBlock';
import { groupTimelineUnits } from '../../src/renderer/ui/agent/AgentProcessTimeline';
import type { AgentProcessSegmentBlock } from '../../src/renderer/ui/agent/agentProcessTypes';
import { formatRunDuration } from '../../src/renderer/ui/agent/agentProcessTypes';
import { summarizeToolActivity } from '../../src/renderer/ui/agent/agentProcessSummary';
import { getMessages } from '../../src/core/i18n';

const { process, toolCall: toolCallLabels } = getMessages('en').agent;
const thinkingLabel = process.thinking;

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

const commandTool: ToolCall = {
  type: 'toolCall',
  id: 'tool-command',
  name: 'bash',
  arguments: { command: 'bun test' },
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

  test('live + collapsed header shows Thinking while still thinking', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Let me map the outline structure first',
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
    })).toBe('Thinking');
  });

  test('live + collapsed header shows bare Working under one second', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      thinkingCount: 0,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      liveElapsedMs: 900,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Working');
  });

  test('live + collapsed header shows Working for elapsed time after one second', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      thinkingCount: 0,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      liveElapsedMs: 2_100,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Working for 2s');
  });

  test('live + collapsed header does not show implausibly stale elapsed time', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
      thinkingCount: 0,
      pendingToolCallIds: new Set(),
      results: new Map(),
      toolCalls: [],
      turnActive: true,
      liveCollapsed: true,
      turnFailedWithoutProse: false,
      surfaceResultlessProcess: false,
      workedForMs: null,
      liveElapsedMs: 2 * 24 * 60 * 60 * 1000,
      process,
      toolCallLabels,
      thinkingLabel,
    })).toBe('Working');
  });

  test('live + collapsed header falls back to the thinking label with no thought text yet', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
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
    })).toBe('Thought · read a node · searching');
  });

  test('summarizes mixed completed process as one collapsed process row', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
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
    })).toBe('Thought · read a node · searched');
  });

  test('summarizes solo completed tool by tool status', () => {
    expect(summarizeProcess({
      firstThinkingText: null,
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
    })).toBe('Thought · read a node · searching');
  });

  test('an interrupted turn keeps its interrupted label over the duration', () => {
    expect(summarizeProcess({
      firstThinkingText: 'Identify relevant outline nodes',
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

describe('agent tool activity summary', () => {
  test('summarizes one kind with count and tense', () => {
    expect(summarizeToolActivity([
      { toolCall: commandTool, status: 'done' },
      { toolCall: { ...commandTool, id: 'tool-command-2' }, status: 'done' },
      { toolCall: { ...commandTool, id: 'tool-command-3' }, status: 'done' },
    ], process)).toBe('Ran 3 commands');

    expect(summarizeToolActivity([
      { toolCall: commandTool, status: 'pending' },
      { toolCall: { ...commandTool, id: 'tool-command-2' }, status: 'done' },
    ], process)).toBe('Running 2 commands');
  });

  test('uses running tense only for the activity kind that is still pending', () => {
    expect(summarizeToolActivity([
      { toolCall: commandTool, status: 'done' },
      { toolCall: searchTool, status: 'pending' },
    ], process)).toBe('Ran a command · searching');
  });

  test('joins up to two activity kinds and falls back past that', () => {
    expect(summarizeToolActivity([
      { toolCall: readTool, status: 'done' },
      { toolCall: { ...readTool, id: 'tool-read-2' }, status: 'done' },
      { toolCall: searchTool, status: 'done' },
    ], process)).toBe('Read 2 nodes · searched');

    expect(summarizeToolActivity([
      { toolCall: readTool, status: 'done' },
      { toolCall: searchTool, status: 'done' },
      { toolCall: commandTool, status: 'done' },
    ], process)).toBe('Used 3 tools');
  });
});

describe('agent process timeline grouping', () => {
  const readBlock: Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> = { kind: 'toolCall', toolCall: readTool };
  const searchBlock: Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> = { kind: 'toolCall', toolCall: searchTool };
  const commandBlock: Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> = { kind: 'toolCall', toolCall: commandTool };
  const thinkingBlock: AgentProcessSegmentBlock = {
    kind: 'thinking',
    sourceIndex: 0,
    streaming: false,
    text: 'Think first',
  };

  test('groups consecutive non-child tool calls into one activity unit', () => {
    expect(groupTimelineUnits([readBlock, searchBlock, commandBlock], () => false)).toEqual([{
      kind: 'toolActivity',
      id: `activity:${readTool.id}`,
      members: [readBlock, searchBlock, commandBlock],
    }]);
  });

  test('does not wrap lone tools and breaks groups at thinking or child runs', () => {
    const grouped = groupTimelineUnits(
      [readBlock, thinkingBlock, searchBlock, commandBlock],
      (block) => block.toolCall.id === searchTool.id,
    );
    expect(grouped).toEqual([
      { kind: 'block', block: readBlock },
      { kind: 'block', block: thinkingBlock },
      { kind: 'block', block: searchBlock },
      { kind: 'block', block: commandBlock },
    ]);
  });
});

describe('agent process duration formatting', () => {
  test('keeps non-zero units through hours and rolls up days', () => {
    expect(formatRunDuration(59_000)).toBe('59s');
    expect(formatRunDuration(60_000)).toBe('1m');
    expect(formatRunDuration(90_000)).toBe('1m 30s');
    expect(formatRunDuration(3_600_000)).toBe('1h');
    expect(formatRunDuration(3_661_000)).toBe('1h 1m 1s');
    expect(formatRunDuration(86_400_000)).toBe('1d');
    expect(formatRunDuration(90_061_000)).toBe('1d 1h 1m 1s');
  });
});
