import { describe, expect, test } from 'bun:test';
import { LIN_AGENT_SYSTEM_PROMPT } from '../../src/main/agentSystemPrompt';

describe('agent system prompt', () => {
  test('defines Lin-specific behavior and tool boundaries', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('Lin Agent');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('local-first outliner');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('<system-reminder>');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('node_read');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('node_edit');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('file_read');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('file_edit');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('web_search');
    expect(LIN_AGENT_SYSTEM_PROMPT).toContain('web_fetch');
  });

  test('keeps dynamic state out of the stable prompt', () => {
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('workspace root');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Local workspace root');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('active panel id');
    expect(LIN_AGENT_SYSTEM_PROMPT).not.toContain('Today node id');
  });
});
