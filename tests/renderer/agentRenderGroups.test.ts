import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../src/core/agentTypes';
import { getMessages } from '../../src/core/i18n';
import type { AgentProcessSegmentBlock } from '../../src/renderer/ui/agent/agentProcessTypes';
import type { ToolStatus } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import {
  sentenceFragment,
  splitTimelineIntoGroups,
  summarizeToolActivity,
  type ToolActivitySummaryMember,
} from '../../src/renderer/ui/agent/agentRenderGroups';

const process = getMessages('en').agent.process;

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { type: 'toolCall', id, name, arguments: args };
}

function toolBlock(id: string, name: string, args: Record<string, unknown> = {}): AgentProcessSegmentBlock {
  return { kind: 'toolCall', toolCall: toolCall(id, name, args) };
}

function thinkingBlock(sourceIndex: number): AgentProcessSegmentBlock {
  return { kind: 'thinking', sourceIndex, streaming: false, text: 'reasoning' };
}

const noChildRuns = () => false;

function member(name: string, status: ToolStatus, args: Record<string, unknown> = {}, id = `${name}-${Math.random()}`): ToolActivitySummaryMember {
  return { status, toolCall: toolCall(id, name, args) };
}

describe('splitTimelineIntoGroups', () => {
  test('folds a run of >= 2 consecutive tool calls into one activity group', () => {
    const groups = splitTimelineIntoGroups(
      [toolBlock('a', 'bash'), toolBlock('b', 'bash'), toolBlock('c', 'node_read')],
      noChildRuns,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('toolActivity');
    if (groups[0]!.kind === 'toolActivity') {
      expect(groups[0]!.members).toHaveLength(3);
      expect(groups[0]!.id).toBe('activity:a');
    }
  });

  test('a lone tool call is NOT grouped (renders as its own block)', () => {
    const groups = splitTimelineIntoGroups([toolBlock('a', 'bash')], noChildRuns);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('block');
  });

  test('a thinking block breaks the run (reasoning is a hard boundary)', () => {
    const groups = splitTimelineIntoGroups(
      [toolBlock('a', 'bash'), toolBlock('b', 'bash'), thinkingBlock(0), toolBlock('c', 'bash'), toolBlock('d', 'bash')],
      noChildRuns,
    );
    expect(groups.map((g) => g.kind)).toEqual(['toolActivity', 'block', 'toolActivity']);
  });

  test('a child-run tool call breaks the run and renders standalone', () => {
    const childBlock = toolBlock('child', 'Agent');
    const groups = splitTimelineIntoGroups(
      [toolBlock('a', 'bash'), childBlock, toolBlock('b', 'bash')],
      (block) => block.toolCall.id === 'child',
    );
    // a, [child standalone], b — none of the runs reach length 2, so all blocks.
    expect(groups.map((g) => g.kind)).toEqual(['block', 'block', 'block']);
  });
});

describe('summarizeToolActivity', () => {
  test('counts a single kind in done tense', () => {
    const summary = summarizeToolActivity(
      [member('bash', 'done', {}, 'a'), member('bash', 'done', {}, 'b')],
      process,
    );
    expect(summary).toBe('Ran 2 commands');
  });

  test('uses the running tense while a member is still pending', () => {
    expect(summarizeToolActivity([member('bash', 'pending', {}, 'a')], process)).toBe('Running a command');
  });

  test('tense is PER-KIND, not group-global (the #311 mislabel)', () => {
    // A finished command alongside a still-running web search must read "Ran a
    // command · searching the web", NOT "Running a command · …".
    const summary = summarizeToolActivity(
      [member('bash', 'done', {}, 'a'), member('web_search', 'pending', {}, 'b')],
      process,
    );
    expect(summary).toBe('Ran a command · searching the web');
  });

  test('composes mixed kinds, lowercasing non-leading fragments', () => {
    const summary = summarizeToolActivity(
      [member('bash', 'done', {}, 'a'), member('node_read', 'done', { nodeId: 'n1' }, 'b')],
      process,
    );
    expect(summary).toBe('Ran a command · read a node');
  });

  test('an unmapped tool contributes a generic fragment, never blanks the summary', () => {
    const summary = summarizeToolActivity(
      [member('bash', 'done', {}, 'a'), member('mystery_tool', 'done', {}, 'b')],
      process,
    );
    expect(summary).toBe('Ran a command · used a tool');
  });

  test('dedupes file kinds by subject path (Set.size, not raw calls)', () => {
    const summary = summarizeToolActivity(
      [
        member('node_read', 'done', { nodeId: 'n1' }, 'a'),
        member('node_read', 'done', { nodeId: 'n1' }, 'b'),
      ],
      process,
    );
    expect(summary).toBe('Read a node');
  });

  test('counts distinct subjects separately', () => {
    const summary = summarizeToolActivity(
      [
        member('node_read', 'done', { nodeId: 'n1' }, 'a'),
        member('node_read', 'done', { nodeId: 'n2' }, 'b'),
      ],
      process,
    );
    expect(summary).toBe('Read 2 nodes');
  });
});

describe('sentenceFragment', () => {
  test('lowercases the first character only', () => {
    expect(sentenceFragment('Ran a command')).toBe('ran a command');
    expect(sentenceFragment('')).toBe('');
  });
});
