import { describe, expect, test } from 'bun:test';
import {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  agentToolNamesForActionKindScope,
  agentToolActionKindProfile,
  decideAgentOperationEffect,
  isReadOnlyActionKind,
  readOnlyAgentToolNames,
  type AgentOperationEffect,
} from '../../src/core/agentPermissionModel';

describe('agent permission model', () => {
  test('decides from operation consequence only', () => {
    const base: AgentOperationEffect = {
      reach: 'local',
      reversible: true,
      touchesCredentials: false,
      label: 'local work',
    };

    expect(decideAgentOperationEffect(base)).toBe('allow');
    expect(decideAgentOperationEffect({ ...base, reach: 'network_read' })).toBe('allow');
    expect(decideAgentOperationEffect({ ...base, reversible: false })).toBe('allow');
    expect(decideAgentOperationEffect({ ...base, reach: 'outside_scope' })).toBe('allow');
    expect(decideAgentOperationEffect({ ...base, reach: 'network_write' })).toBe('allow');
    expect(decideAgentOperationEffect({ ...base, touchesCredentials: true })).toBe('allow');
    expect(decideAgentOperationEffect({ ...base, floor: 'exfiltration' })).toBe('deny');
  });

  test('keeps action kinds as audit labels and read-only catalog input', () => {
    for (const actionKind of SUPPORTED_AGENT_TOOL_ACTION_KINDS) {
      expect(typeof isReadOnlyActionKind(actionKind)).toBe('boolean');
    }

    expect(isReadOnlyActionKind('file.read.allowed_file_area')).toBe(true);
    expect(isReadOnlyActionKind('web.search')).toBe(true);
    expect(isReadOnlyActionKind('agent.session.read')).toBe(true);
    expect(isReadOnlyActionKind('file.edit.allowed_file_area')).toBe(false);
    expect(isReadOnlyActionKind('agent.skill.invoke')).toBe(false);
    expect(isReadOnlyActionKind('agent.image.generate')).toBe(false);
    expect(isReadOnlyActionKind('agent.session.start')).toBe(false);

    const tools = readOnlyAgentToolNames();
    expect(tools).toEqual(expect.arrayContaining([
      'file_read',
      'file_glob',
      'file_grep',
      'node_read',
      'node_search',
      'web_search',
      'web_fetch',
      'past_chats',
      'issue_search',
      'issue_read',
      'agent_session_read',
    ]));
    expect(tools).not.toContain('file_write');
    expect(tools).not.toContain('file_edit');
    expect(tools).not.toContain('node_edit');
    expect(tools).not.toContain('outline_undo_stack');
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('skill');
    expect(tools).not.toContain('generate_image');
    expect(tools).not.toContain('spawn_run');
    expect(tools).not.toContain('run_status');
    expect(tools).not.toContain('recall');
    expect(tools).not.toContain('dream');

    expect(readOnlyAgentToolNames(['file_read', 'file_write', 'agent_session_read'])).toEqual([
      'file_read',
      'agent_session_read',
    ]);
    expect(agentToolActionKindProfile('outline_undo_stack', { action: 'list' })).toEqual(['outline.read']);
    expect(agentToolActionKindProfile('outline_undo_stack', { action: 'undo' })).toEqual(['outline.edit']);
    expect(agentToolActionKindProfile('generate_image')).toEqual(['agent.image.generate']);
    expect(agentToolActionKindProfile('data_import')).toBeNull();
    expect(readOnlyAgentToolNames()).not.toContain('data_import');
  });

  test('maps action-kind scope to the visible tool catalog', () => {
    expect(agentToolNamesForActionKindScope(['agent.session.read'], ['*'])).toEqual(expect.arrayContaining([
      'agent_session_read',
    ]));
    expect(agentToolNamesForActionKindScope(['agent.session.read'], ['*'])).not.toContain('spawn_run');
    expect(agentToolNamesForActionKindScope(['agent.session.read'], ['*'])).not.toContain('run_amend');
    expect(agentToolNamesForActionKindScope(['file.read.allowed_file_area'], ['file_read', 'file_write'])).toEqual(['file_read']);
  });
});
