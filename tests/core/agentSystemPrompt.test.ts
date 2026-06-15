import { describe, expect, test } from 'bun:test';
import { LIN_AGENT_SYSTEM_PROMPT, LIN_AGENT_SYSTEM_PROMPT_SECTIONS, LIN_CHILD_AGENT_CORE_PROMPT } from '../../src/main/agentSystemPrompt';

describe('agent system prompt', () => {
  test('is four always-on sections — identity + perception + memory + conduct, no tool manuals', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT_SECTIONS.map((section) => section.id)).toEqual([
      'identity',
      'system-context',
      'memory',
      'communication-and-safety',
    ]);
    // Tool-operating conventions ride each tool's own description, never the
    // always-on prompt — these section headers must not come back.
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('# Outliner');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('# Web');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('# Local files and shell');
  });

  test('the identity section is the Neva persona, not environment or tool conventions', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('You are Neva.');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Be still water');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Tenon Agent');
    // Environment ("what Tenon is", structure taste) is NOT identity — it rides
    // the conversation-start reminder, never the cached identity prompt.
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('second brain');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('atomic nodes');
    // Tool-call conventions have moved out to the tool descriptions.
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('node_read');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('node_edit');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('%%node:id%%');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('file_read');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('web_search');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('YYYY-MM-DD');
  });

  test('keeps perception, memory framing, and conduct that hold every turn', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('<system-reminder>');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Use recall for durable facts');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('<memory>');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('do not claim you saved, updated, or forgot memory');
    // Cross-tool behavioral rules lifted out of the deleted tool sections.
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('until the tool result confirms');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Permission-denied or out-of-boundary');
    // The produced-deliverable output convention stays (file-marker emit).
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('[[file:Display^/absolute/path]]');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Use past_chats');
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
      'communication-and-safety': 'shared',
    });
  });

  test('the child run core reuses the shared base but not the main-only framing', () => {
    // The shared perception + conduct/safety guidance the main agent carries…
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('# System context');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('# Communication and safety');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).toContain('<system-reminder>');
    // …minus the user-facing persona + memory sections.
    expect(LIN_CHILD_AGENT_CORE_PROMPT).not.toContain('You are Neva');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).not.toContain('# Memory');
    expect(LIN_CHILD_AGENT_CORE_PROMPT).not.toContain('<memory>');
  });
});
