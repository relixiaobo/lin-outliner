import { describe, expect, test } from 'bun:test';
import type { AgentToolResultWithPayloads, ToolCall } from '../../src/core/agentTypes';
import { getToolCallStatus, summarizeToolCall } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import {
  agentToolPresentation,
  getToolIcon,
  type ToolActivityKind,
} from '../../src/renderer/ui/agent/agentToolPresentation';
import {
  type AppIcon,
  BrainIcon,
  FileDeleteToolIcon,
  FileEditToolIcon,
  FileGlobToolIcon,
  FileGrepToolIcon,
  FileReadToolIcon,
  FileWriteToolIcon,
  GenericToolIcon,
  NodeCreateToolIcon,
  NodeDeleteToolIcon,
  NodeEditToolIcon,
  NodeReadToolIcon,
  NodeSearchToolIcon,
  OperationHistoryToolIcon,
  PastChatsToolIcon,
  QuestionToolIcon,
  RestoreIcon,
  RunMessageToolIcon,
  RunSpawnToolIcon,
  RunStatusToolIcon,
  SkillAuthorToolIcon,
  SkillIcon,
  TaskStopToolIcon,
  TerminalIcon,
  WebFetchToolIcon,
  WebSearchToolIcon,
} from '../../src/renderer/ui/icons';
import { getMessages } from '../../src/core/i18n';

const labels = getMessages('en').agent.toolCall;

function recallToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-recall',
    name: 'recall',
    arguments: args,
  };
}

function dreamToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-dream',
    name: 'dream',
    arguments: args,
  };
}

function fileWriteToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-file-write',
    name: 'file_write',
    arguments: args,
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    type: 'toolCall',
    id: `tool-${name}`,
    name,
    arguments: args,
  };
}

describe('agent tool call block', () => {
  test('marks only runtime-reported tool ids as pending; a never-settled call is incomplete, not error', () => {
    expect(getToolCallStatus('tool-running', undefined, new Set(['tool-running']), true)).toBe('pending');
    // Not in the pending set and the turn is no longer bridging it: it never
    // settled, but that is `incomplete` (neutral), not a failure.
    expect(getToolCallStatus('tool-stale', undefined, new Set(['tool-running']), false)).toBe('incomplete');
    expect(getToolCallStatus('tool-finishing', undefined, new Set(), true)).toBe('pending');
    expect(getToolCallStatus('tool-idle', undefined, new Set(), false)).toBe('incomplete');
  });

  test('a settled outcome stops the spinner even with no result message', () => {
    // The bug: a tool whose `tool_call.completed` arrived but whose result message
    // never landed in the projection used to spin forever (active turn) via the
    // pending/active fallback. The settled outcome is now authoritative.
    expect(getToolCallStatus('tool-done', undefined, new Set(['tool-done']), true, 'completed')).toBe('done');
    expect(getToolCallStatus('tool-done', undefined, new Set(), false, 'completed')).toBe('done');
    expect(getToolCallStatus('tool-failed', undefined, new Set(), true, 'failed')).toBe('error');
    // A result message still wins (it carries isError), regardless of outcome.
    const okResult = {
      role: 'toolResult',
      toolCallId: 'tool-done',
      content: [],
      isError: false,
    } as AgentToolResultWithPayloads;
    expect(getToolCallStatus('tool-done', okResult, new Set(), false, 'failed')).toBe('done');
    // No outcome yet (still executing) keeps the active-turn spinner.
    expect(getToolCallStatus('tool-exec', undefined, new Set(['tool-exec']), true, undefined)).toBe('pending');
  });

  test('uses memory icon and summarizes recall', () => {
    expect(getToolIcon(recallToolCall({ query: 'preferences' }))).toBe(BrainIcon);
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'pending', labels)).toBe('Recalling memory "preferences"');
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'done', labels)).toBe('Recalled memory "preferences"');
    expect(summarizeToolCall(recallToolCall({ query: 'preferences' }), 'error', labels)).toBe('Failed to recall memory "preferences"');
  });

  test('uses memory icon and summarizes Dream', () => {
    expect(getToolIcon(dreamToolCall({}))).toBe(BrainIcon);
    expect(summarizeToolCall(dreamToolCall({}), 'pending', labels)).toBe('Dreaming memory');
    expect(summarizeToolCall(dreamToolCall({}), 'done', labels)).toBe('Dreamed memory');
    expect(summarizeToolCall(dreamToolCall({}), 'error', labels)).toBe('Failed to dream memory');
  });

  test('summarizes file_write with the path the model passed (as every tool does)', () => {
    const call = fileWriteToolCall({ file_path: 'reports/report.md', content: '...' });
    expect(getToolIcon(call)).toBe(FileWriteToolIcon);
    expect(summarizeToolCall(call, 'pending', labels)).toBe('Writing file "reports/report.md"');
    expect(summarizeToolCall(call, 'done', labels)).toBe('Wrote file "reports/report.md"');
    expect(summarizeToolCall(call, 'error', labels)).toBe('Failed to write file "reports/report.md"');
  });

  test('distinguishes outliner node tools from local file tools', () => {
    expect(getToolIcon(toolCall('node_create'))).toBe(NodeCreateToolIcon);
    expect(getToolIcon(toolCall('node_read'))).toBe(NodeReadToolIcon);
    expect(getToolIcon(toolCall('file_read', { file_path: 'notes.md' }))).toBe(FileReadToolIcon);
  });

  test('uses a neutral generic glyph for unknown tools', () => {
    expect(getToolIcon(toolCall('mystery_tool'))).toBe(GenericToolIcon);
  });

  test('maps canonical tools to semantic activity kinds and lucide icons', () => {
    const cases: Array<{
      args?: Record<string, unknown>;
      icon: AppIcon;
      kind: ToolActivityKind;
      name: string;
    }> = [
      { name: 'bash', kind: 'command', icon: TerminalIcon },
      { name: 'task_stop', kind: 'command', icon: TaskStopToolIcon },
      { name: 'file_read', kind: 'fileRead', icon: FileReadToolIcon },
      { name: 'file_glob', kind: 'fileSearch', icon: FileGlobToolIcon },
      { name: 'file_grep', kind: 'fileSearch', icon: FileGrepToolIcon },
      { name: 'file_edit', kind: 'fileEdit', icon: FileEditToolIcon },
      { name: 'file_write', kind: 'fileCreate', icon: FileWriteToolIcon },
      { name: 'file_delete', kind: 'fileDelete', icon: FileDeleteToolIcon },
      { name: 'node_create', kind: 'nodeCreate', icon: NodeCreateToolIcon },
      { name: 'node_read', kind: 'nodeRead', icon: NodeReadToolIcon },
      { name: 'node_edit', kind: 'nodeEdit', icon: NodeEditToolIcon },
      { name: 'node_delete', kind: 'nodeDelete', icon: NodeDeleteToolIcon },
      { name: 'node_delete', args: { restore: true }, kind: 'nodeDelete', icon: RestoreIcon },
      { name: 'node_search', kind: 'nodeSearch', icon: NodeSearchToolIcon },
      { name: 'operation_history', kind: 'history', icon: OperationHistoryToolIcon },
      { name: 'web_search', kind: 'web', icon: WebSearchToolIcon },
      { name: 'web_fetch', kind: 'web', icon: WebFetchToolIcon },
      { name: 'recall', kind: 'memory', icon: BrainIcon },
      { name: 'dream', kind: 'memory', icon: BrainIcon },
      { name: 'past_chats', kind: 'memory', icon: PastChatsToolIcon },
      { name: 'skill', kind: 'skill', icon: SkillIcon },
      { name: 'skillify', kind: 'skill', icon: SkillAuthorToolIcon },
      { name: 'ask_user_question', kind: 'question', icon: QuestionToolIcon },
      { name: 'spawn', kind: 'run', icon: RunSpawnToolIcon },
      { name: 'Agent', kind: 'run', icon: RunSpawnToolIcon },
      { name: 'run_status', kind: 'run', icon: RunStatusToolIcon },
      { name: 'AgentStatus', kind: 'run', icon: RunStatusToolIcon },
      { name: 'run_steer', kind: 'run', icon: RunMessageToolIcon },
      { name: 'run_amend', kind: 'run', icon: RunMessageToolIcon },
      { name: 'AgentSend', kind: 'run', icon: RunMessageToolIcon },
      { name: 'run_stop', kind: 'run', icon: TaskStopToolIcon },
      { name: 'AgentStop', kind: 'run', icon: TaskStopToolIcon },
      { name: 'mystery_tool', kind: 'other', icon: GenericToolIcon },
    ];

    for (const item of cases) {
      expect(agentToolPresentation(toolCall(item.name, item.args))).toEqual({
        activityKind: item.kind,
        icon: item.icon,
      });
    }
  });
});
