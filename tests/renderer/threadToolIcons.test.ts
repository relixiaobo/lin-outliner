import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  toolGroupPresentation, toolPresentation, type ThreadToolItem,
} from '../../src/renderer/agent/components/items/toolPresentation';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

const base = {
  id: 'tool', status: 'completed' as const, outputRef: null,
  provenance: { originThreadId: 'thread', originTurnId: 'turn', originItemId: 'tool' },
  modelCall: replayableModelCall('file_write', {}),
};

function dynamic(tool: string, namespace: string | null = null): ThreadToolItem {
  return {
    ...base, type: 'dynamicToolCall', namespace, tool, arguments: {},
    contentItems: null, success: true, durationMs: 1,
  };
}

function changes(...kinds: Array<'add' | 'update' | 'delete' | 'move'>): ThreadToolItem {
  return { ...base, type: 'fileChange', changes: kinds.map((kind, index) => ({ kind, path: `/file-${index}` })) };
}

function collab(tool: 'agent' | 'agent_message' | 'task_status' | 'task_stop'): ThreadToolItem {
  return {
    ...base, type: 'collabAgentToolCall', tool, senderThreadId: 'thread',
    receiverThreadIds: ['child'], prompt: null, summary: null, model: null,
    reasoningEffort: null, agentsStates: {},
  };
}

function glyph(presentation: ReturnType<typeof toolPresentation>): string {
  return renderToStaticMarkup(createElement(presentation.Icon, { size: 'menu' }));
}

describe('tool operation presentation used by rows and groups', () => {
  test.each([
    ['file_write', 'FileWriteTool'], ['file_edit', 'FileEditTool'],
    ['file_delete', 'FileDeleteTool'], ['file_read', 'FileReadTool'],
    ['file_glob', 'FileGlobTool'], ['file_grep', 'FileGrepTool'],
    ['web_search', 'WebSearchTool'], ['web_fetch', 'WebFetchTool'],
    ['update_plan', 'PlanTool'], ['skill', 'Skill'],
    ['request_user_input', 'QuestionTool'], ['unknown', 'GenericTool'],
  ])('%s selects its reviewed semantic glyph', (tool, expected) => {
    expect(glyph(toolPresentation(dynamic(tool)))).toContain(`data-icon="${expected}"`);
  });

  test('write can overwrite, and only explicit additions show creation', () => {
    expect(glyph(toolPresentation(changes('add', 'add')))).toContain('data-icon="FileCreateTool"');
    expect(glyph(toolPresentation(dynamic('file_write')))).toContain('data-icon="FileWriteTool"');
    expect(glyph(toolGroupPresentation([changes('add'), dynamic('file_write')]))).toContain('data-icon="GenericTool"');
    expect(glyph(toolPresentation(changes('delete')))).toContain('data-icon="FileDeleteTool"');
    expect(glyph(toolPresentation(changes('move')))).toContain('data-icon="MoveTo"');
    expect(glyph(toolPresentation(changes('add', 'delete')))).toContain('data-icon="GenericTool"');
    expect(glyph(toolPresentation(changes()))).toContain('data-icon="GenericTool"');
  });

  test('homogeneous meaning survives provider item shapes and status', () => {
    expect(glyph(toolGroupPresentation([changes('update'), dynamic('edit', 'file')]))).toContain('data-icon="FileEditTool"');
    expect(glyph(toolGroupPresentation([dynamic('file_read'), { ...dynamic('file_read'), status: 'failed' }]))).toContain('data-icon="FileReadTool"');
    expect(glyph(toolGroupPresentation([]))).toContain('data-icon="GenericTool"');
  });

  test('broad search activity does not erase path/content or search/fetch meaning', () => {
    expect(glyph(toolGroupPresentation([dynamic('file_glob'), dynamic('file_grep')]))).toContain('data-icon="GenericTool"');
    expect(glyph(toolGroupPresentation([dynamic('web_search'), dynamic('web_fetch')]))).toContain('data-icon="GenericTool"');
    expect(glyph(toolGroupPresentation([dynamic('file_write'), dynamic('file_edit')]))).toContain('data-icon="GenericTool"');
  });

  test.each([
    ['agent', 'Agent'], ['agent_message', 'MessageAgent'],
    ['task_status', 'Info'], ['task_stop', 'Stop'],
  ] as const)('%s retains its verb independently of status', (tool, expected) => {
    expect(glyph(toolPresentation(collab(tool)))).toContain(`data-icon="${expected}"`);
    expect(glyph(toolPresentation({ ...collab(tool), status: 'interrupted' }))).toContain(`data-icon="${expected}"`);
  });

  test('different collaboration verbs produce a mixed group', () => {
    expect(glyph(toolGroupPresentation([collab('agent_message'), collab('task_status')]))).toContain('data-icon="GenericTool"');
  });
});
