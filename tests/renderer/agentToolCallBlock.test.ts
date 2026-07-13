import { describe, expect, test } from 'bun:test';
import type { AgentToolResultWithPayloads, ToolCall } from '../../src/core/agentTypes';
import type { AgentRenderRunEntity } from '../../src/core/agentRenderProjection';
import { getToolCallStatus, runToolStatus, summarizeToolCall } from '../../src/renderer/ui/agent/AgentToolCallBlock';
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
  OutlineUndoStackToolIcon,
  PastChatsToolIcon,
  PlayIcon,
  QuestionToolIcon,
  RestoreIcon,
  RunStatusToolIcon,
  SearchIcon,
  SendIcon,
  SkillAuthorToolIcon,
  SkillIcon,
  BashStopToolIcon,
  TerminalIcon,
  WebFetchToolIcon,
  WebSearchToolIcon,
} from '../../src/renderer/ui/icons';
import { getMessages } from '../../src/core/i18n';

const labels = getMessages('en').agent.toolCall;

function runEntity(overrides: Partial<AgentRenderRunEntity> = {}): AgentRenderRunEntity {
  return {
    id: 'run-1',
    agentId: 'built-in:tenon:assistant',
    anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId: 'conversation-1' },
    conversationId: 'conversation-1',
    title: 'Child run',
    runProfile: 'default',
    runProfileLabel: 'Default',
    status: 'completed',
    context: 'brief',
    startedAt: 1000,
    updatedAt: 2000,
    completedAt: 2000,
    ...overrides,
  };
}

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

  test('maps child run process status through the same display status as run rows', () => {
    expect(runToolStatus(runEntity({ status: 'running' }))).toBe('pending');
    expect(runToolStatus(runEntity({ objectiveStatus: 'verifying' }))).toBe('pending');
    expect(runToolStatus(runEntity({ objectiveStatus: 'verified' }))).toBe('done');
    expect(runToolStatus(runEntity({ objectiveStatus: 'blocked' }))).toBe('error');
    expect(runToolStatus(runEntity({ objectiveStatus: 'budget_exhausted' }))).toBe('error');
    expect(runToolStatus(runEntity({ status: 'failed' }))).toBe('error');
    expect(runToolStatus(runEntity({ status: 'stopped' }))).toBe('error');
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

  test('summarizes canonical tools with readable labels instead of raw tool ids', () => {
    const cases: Array<{
      args?: Record<string, unknown>;
      done: string;
      name: string;
      pending: string;
    }> = [
      { name: 'bash', args: { command: 'git status\npwd' }, pending: 'Running command "git status"', done: 'Ran command "git status"' },
      { name: 'bash_stop', args: { task_id: 'task-1' }, pending: 'Stopping bash task "task-1"', done: 'Stopped bash task "task-1"' },
      { name: 'file_read', args: { file_path: 'notes.md' }, pending: 'Reading file "notes.md"', done: 'Read file "notes.md"' },
      { name: 'file_glob', args: { pattern: '**/*.ts' }, pending: 'Finding files "**/*.ts"', done: 'Found files "**/*.ts"' },
      { name: 'file_grep', args: { pattern: 'needle' }, pending: 'Searching file contents "needle"', done: 'Searched file contents "needle"' },
      { name: 'file_edit', args: { file_path: 'src/app.ts' }, pending: 'Editing file "src/app.ts"', done: 'Edited file "src/app.ts"' },
      { name: 'file_write', args: { file_path: 'reports/report.md' }, pending: 'Writing file "reports/report.md"', done: 'Wrote file "reports/report.md"' },
      { name: 'file_delete', args: { file_path: 'old.log' }, pending: 'Deleting file "old.log"', done: 'Deleted file "old.log"' },
      { name: 'node_create', args: { parent_id: 'parent' }, pending: 'Creating node under "parent"', done: 'Created node under "parent"' },
      { name: 'node_read', args: { node_id: 'node-1' }, pending: 'Reading node "node-1"', done: 'Read node "node-1"' },
      { name: 'node_edit', args: { node_id: 'node-1' }, pending: 'Editing node "node-1"', done: 'Edited node "node-1"' },
      { name: 'node_delete', args: { node_id: 'node-1' }, pending: 'Deleting node "node-1"', done: 'Deleted node "node-1"' },
      { name: 'node_delete', args: { node_id: 'node-1', restore: true }, pending: 'Restoring node "node-1"', done: 'Restored node "node-1"' },
      { name: 'node_search', args: { outline: 'status' }, pending: 'Searching nodes "status"', done: 'Searched nodes "status"' },
      { name: 'outline_undo_stack', args: { action: 'list' }, pending: 'Checking outline undo stack', done: 'Checked outline undo stack' },
      { name: 'outline_undo_stack', args: { action: 'undo' }, pending: 'Undoing operation', done: 'Undid operation' },
      { name: 'outline_undo_stack', args: { action: 'redo' }, pending: 'Redoing operation', done: 'Redid operation' },
      { name: 'web_search', args: { query: 'lucide icons' }, pending: 'Searching the web "lucide icons"', done: 'Searched the web "lucide icons"' },
      { name: 'web_fetch', args: { url: 'https://example.com/docs' }, pending: 'Fetching web page https://example.com/docs', done: 'Fetched web page https://example.com/docs' },
      { name: 'recall', args: { query: 'preferences' }, pending: 'Recalling memory "preferences"', done: 'Recalled memory "preferences"' },
      { name: 'dream', pending: 'Dreaming memory', done: 'Dreamed memory' },
      { name: 'past_chats', args: { query: 'prior decision' }, pending: 'Searching past chats "prior decision"', done: 'Searched past chats "prior decision"' },
      { name: 'past_chats', args: { recent: true }, pending: 'Checking recent chats', done: 'Checked recent chats' },
      { name: 'past_chats', args: { message_id: 'msg-1' }, pending: 'Reading past chat "msg-1"', done: 'Read past chat "msg-1"' },
      { name: 'skill', args: { skill: 'review-pr' }, pending: 'Using skill "review-pr"', done: 'Used skill "review-pr"' },
      { name: 'skillify', args: { skill: 'workflow' }, pending: 'Authoring skill "workflow"', done: 'Authored skill "workflow"' },
      { name: 'issue_search', args: { text: 'daily report' }, pending: 'Searching issues "daily report"', done: 'Searched issues "daily report"' },
      { name: 'issue_read', args: { target: { type: 'issue', id: 'issue-1' } }, pending: 'Reading issue "issue-1"', done: 'Read issue "issue-1"' },
      { name: 'issue_create', args: { issueType: 'issue', fields: { title: 'Write daily report' } }, pending: 'Creating issue "Write daily report"', done: 'Created issue "Write daily report"' },
      { name: 'issue_update', args: { target: { type: 'issue', id: 'issue-1' } }, pending: 'Updating issue "issue-1"', done: 'Updated issue "issue-1"' },
      { name: 'agent_session_start', args: { issueId: 'issue-1' }, pending: 'Starting agent session "issue-1"', done: 'Started agent session "issue-1"' },
      { name: 'agent_session_read', args: { agentSessionId: 'session-1' }, pending: 'Reading agent session "session-1"', done: 'Read agent session "session-1"' },
      { name: 'agent_session_send_message', args: { agentSessionId: 'session-1' }, pending: 'Messaging agent session "session-1"', done: 'Messaged agent session "session-1"' },
      { name: 'agent_session_stop', args: { agentSessionId: 'session-1' }, pending: 'Stopping agent session "session-1"', done: 'Stopped agent session "session-1"' },
      {
        name: 'ask_user_question',
        args: { questions: [{ id: 'scope', type: 'single_choice', question: 'Which scope should I use?' }] },
        pending: 'Asking user "Which scope should I use?"',
        done: 'Asked user "Which scope should I use?"',
      },
    ];

    for (const item of cases) {
      const call = toolCall(item.name, item.args);
      expect(summarizeToolCall(call, 'pending', labels)).toBe(item.pending);
      expect(summarizeToolCall(call, 'done', labels)).toBe(item.done);
      expect(summarizeToolCall(call, 'done', labels)).not.toBe(item.name);
      expect(summarizeToolCall(call, 'pending', labels)).not.toBe(`${item.name}...`);
    }
  });

  test('unknown tool summaries are the only raw tool-name fallback', () => {
    const call = toolCall('mystery_tool');
    expect(summarizeToolCall(call, 'pending', labels)).toBe('mystery_tool...');
    expect(summarizeToolCall(call, 'done', labels)).toBe('mystery_tool');
    expect(summarizeToolCall(call, 'error', labels)).toBe('Failed to mystery_tool');
  });

  test('maps canonical tools to semantic activity kinds and lucide icons', () => {
    const cases: Array<{
      args?: Record<string, unknown>;
      icon: AppIcon;
      kind: ToolActivityKind;
      name: string;
    }> = [
      { name: 'bash', kind: 'command', icon: TerminalIcon },
      { name: 'bash_stop', kind: 'command', icon: BashStopToolIcon },
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
      { name: 'node_delete', args: { restore: true }, kind: 'nodeRestore', icon: RestoreIcon },
      { name: 'node_search', kind: 'nodeSearch', icon: NodeSearchToolIcon },
      { name: 'outline_undo_stack', kind: 'history', icon: OutlineUndoStackToolIcon },
      { name: 'web_search', kind: 'web', icon: WebSearchToolIcon },
      { name: 'web_fetch', kind: 'web', icon: WebFetchToolIcon },
      { name: 'recall', kind: 'memory', icon: BrainIcon },
      { name: 'dream', kind: 'memory', icon: BrainIcon },
      { name: 'past_chats', kind: 'memory', icon: PastChatsToolIcon },
      { name: 'skill', kind: 'skill', icon: SkillIcon },
      { name: 'skillify', kind: 'skill', icon: SkillAuthorToolIcon },
      { name: 'ask_user_question', kind: 'question', icon: QuestionToolIcon },
      { name: 'issue_search', kind: 'issue', icon: SearchIcon },
      { name: 'issue_read', kind: 'issue', icon: NodeReadToolIcon },
      { name: 'issue_create', kind: 'issue', icon: NodeCreateToolIcon },
      { name: 'issue_update', kind: 'issue', icon: NodeEditToolIcon },
      { name: 'agent_session_start', kind: 'session', icon: PlayIcon },
      { name: 'agent_session_read', kind: 'session', icon: RunStatusToolIcon },
      { name: 'agent_session_send_message', kind: 'session', icon: SendIcon },
      { name: 'agent_session_stop', kind: 'session', icon: BashStopToolIcon },
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
