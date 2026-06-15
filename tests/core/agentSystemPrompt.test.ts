import { describe, expect, test } from 'bun:test';
import { LIN_AGENT_SYSTEM_PROMPT, LIN_AGENT_SYSTEM_PROMPT_SECTIONS, LIN_CHILD_AGENT_CORE_PROMPT } from '../../src/main/agentSystemPrompt';

describe('agent system prompt', () => {
  test('is organized as stable lightweight sections', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT_SECTIONS.map((section) => section.id)).toEqual([
      'identity',
      'system-context',
      'memory',
      'outliner',
      'local-tools',
      'web',
      'communication-and-safety',
    ]);
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('# Outliner');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('# Web');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('# Working in Lin Outliner');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Lin Outliner');
  });

  test('defines Tenon-specific behavior and tool boundaries', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Tenon Agent');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('local-first outliner');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('<system-reminder>');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('node_read');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('node_edit');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Never show %%node:id%% markers');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('[[node:Display^id]]');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('[[node:^id]]');
    // The agent surfaces a produced deliverable inline as a file chip (file-marker emit).
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('[[file:Display^/absolute/path]]');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('YYYY-MM-DDTHH:mm');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Do not use ".." for date ranges');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('file_read');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('file_edit');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('web_search');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('web_fetch');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Use recall for durable facts');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('<memory>');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('do not claim you saved, updated, or forgot memory');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Use past_chats');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Text attachments are included');
  });

  test('keeps dynamic state out of the stable prompt', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('workspace root');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Local workspace root');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('active panel id');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Today node id');
  });

  test('every section is tagged for an audience; the shared subset seeds childRuns', () => {
    // identity + memory are the main chat agent's alone; the rest are shared with
    // fresh childRuns (see [[child-run-prompt-unification]]).
    const byAudience = Object.fromEntries(
      LIN_AGENT_SYSTEM_PROMPT_SECTIONS.map((section) => [section.id, section.audience]),
    );
    expect(byAudience).toEqual({
      identity: 'main',
      'system-context': 'shared',
      memory: 'main',
      outliner: 'shared',
      'local-tools': 'shared',
      web: 'shared',
      'communication-and-safety': 'shared',
    });
  });

  test('the child run core reuses the shared capabilities but not the main-only framing', () => {
    // Same tool-convention + safety guidance the main agent carries…
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('# Outliner');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('# Web');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('# Local files and shell');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('# Communication and safety');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('node_edit');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('file_read');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('<system-reminder>');
    // …minus the user-facing identity + memory sections.
    expect(LIN_CHILD_AGENT_CORE_PROMPT).not.toContain('You are Tenon Agent');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).not.toContain('# Memory');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).not.toContain('Use recall for durable facts');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).not.toContain('<memory>');
  });
});
