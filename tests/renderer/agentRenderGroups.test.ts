import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../src/core/agentTypes';
import { getMessages } from '../../src/core/i18n';
import type { AgentTurnProcessItem } from '../../src/renderer/ui/agent/agentTurnProjection';
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

function toolItem(id: string, name: string, args: Record<string, unknown> = {}): AgentTurnProcessItem {
  return { id: `tool:${id}`, type: 'toolCall', toolCall: toolCall(id, name, args) };
}

function reasoningItem(sourceIndex: number): AgentTurnProcessItem {
  return {
    id: `process:test:reasoning:${sourceIndex}`,
    streaming: false,
    text: 'reasoning',
    type: 'reasoning',
  };
}

const noBreaks = () => false;

function member(name: string, status: ToolStatus, args: Record<string, unknown> = {}, id = `${name}-${Math.random()}`): ToolActivitySummaryMember {
  return { status, toolCall: toolCall(id, name, args) };
}

describe('splitTimelineIntoGroups', () => {
  test('folds a run of >= 2 consecutive tool calls into one activity group', () => {
    const groups = splitTimelineIntoGroups(
      [toolItem('a', 'bash'), toolItem('b', 'bash'), toolItem('c', 'node_read')],
      noBreaks,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('toolActivity');
    if (groups[0]!.kind === 'toolActivity') {
      expect(groups[0]!.members).toHaveLength(3);
      expect(groups[0]!.id).toBe('activity:a');
    }
  });

  test('a lone tool call is NOT grouped (renders as its own item)', () => {
    const groups = splitTimelineIntoGroups([toolItem('a', 'bash')], noBreaks);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('item');
  });

  test('a reasoning item breaks the run (reasoning is a hard boundary)', () => {
    const groups = splitTimelineIntoGroups(
      [toolItem('a', 'bash'), toolItem('b', 'bash'), reasoningItem(0), toolItem('c', 'bash'), toolItem('d', 'bash')],
      noBreaks,
    );
    expect(groups.map((g) => g.kind)).toEqual(['toolActivity', 'item', 'toolActivity']);
  });

  test('an Agent Session tool call folds like an ordinary tool call', () => {
    const childItem = toolItem('child', 'agent_session_start');
    const groups = splitTimelineIntoGroups(
      [toolItem('a', 'bash'), childItem, toolItem('b', 'bash')],
      noBreaks,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('toolActivity');
    if (groups[0]!.kind === 'toolActivity') {
      expect(groups[0]!.members.map((member) => member.toolCall.id)).toEqual(['a', 'child', 'b']);
    }
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
      [member('bash', 'done', {}, 'a'), member('node_read', 'done', { node_id: 'n1' }, 'b')],
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

  test('dedupes node reads by subject id (Set.size, not raw calls)', () => {
    // The model's wire args are snake_case (`node_id`), so the dedup keys must be
    // too — reading the same node twice is one distinct subject.
    const summary = summarizeToolActivity(
      [
        member('node_read', 'done', { node_id: 'n1' }, 'a'),
        member('node_read', 'done', { node_id: 'n1' }, 'b'),
      ],
      process,
    );
    expect(summary).toBe('Read a node');
  });

  test('counts distinct subjects separately', () => {
    const summary = summarizeToolActivity(
      [
        member('node_read', 'done', { node_id: 'n1' }, 'a'),
        member('node_read', 'done', { node_id: 'n2' }, 'b'),
      ],
      process,
    );
    expect(summary).toBe('Read 2 nodes');
  });

  test('summarizes restored nodes separately from deleted nodes', () => {
    expect(
      summarizeToolActivity([member('node_delete', 'done', { node_id: 'n1', restore: true }, 'a')], process),
    ).toBe('Restored a node');
    expect(
      summarizeToolActivity([member('node_delete', 'pending', { node_id: 'n1', restore: true }, 'a')], process),
    ).toBe('Restoring a node');
  });

  test('a node_ids batch counts each distinct id (one call, N subjects)', () => {
    const summary = summarizeToolActivity(
      [member('node_read', 'done', { node_ids: ['n1', 'n2', 'n3'] }, 'a')],
      process,
    );
    expect(summary).toBe('Read 3 nodes');
  });

  test('node_create counts every call — siblings under one parent are distinct creations', () => {
    const summary = summarizeToolActivity(
      [
        member('node_create', 'done', { parent_id: 'p1' }, 'a'),
        member('node_create', 'done', { parent_id: 'p1' }, 'b'),
      ],
      process,
    );
    expect(summary).toBe('Created 2 nodes');
  });

  test('summarizes local file reads separately from node reads', () => {
    const summary = summarizeToolActivity(
      [
        member('file_read', 'done', { file_path: 'notes.md' }, 'a'),
        member('node_read', 'done', { node_id: 'n1' }, 'b'),
      ],
      process,
    );
    expect(summary).toBe('Read a file · read a node');
  });

  test('summarizes Issue and Agent Session tools as first-class activity', () => {
    const summary = summarizeToolActivity(
      [
        member('issue_create', 'done', { issueType: 'issue', fields: { title: 'Write daily report' } }, 'a'),
        member('agent_session_start', 'pending', { issueId: 'issue-1' }, 'b'),
      ],
      process,
    );
    expect(summary).toBe('Managed an issue · managing an agent session');
  });
});

describe('sentenceFragment', () => {
  test('lowercases the first character only', () => {
    expect(sentenceFragment('Ran a command')).toBe('ran a command');
    expect(sentenceFragment('')).toBe('');
  });
});
