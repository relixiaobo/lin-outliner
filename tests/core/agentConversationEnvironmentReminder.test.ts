import { describe, expect, test } from 'bun:test';
import { buildConversationEnvironmentReminder } from '../../src/main/agentConversationEnvironmentReminder';

describe('buildConversationEnvironmentReminder', () => {
  test('renders the single-agent 1:1 environment block', () => {
    const reminder = buildConversationEnvironmentReminder();
    expect(reminder).toContain('<conversation-environment kind="dm">');
    expect(reminder).toContain('direct 1:1 conversation with the user');
    expect(reminder).toContain('Speak as yourself');
    expect(reminder).toContain('Stay within your description and instructions');
    expect(reminder).toContain('</conversation-environment>');
  });

  test('does not carry any multi-agent channel framing', () => {
    const reminder = buildConversationEnvironmentReminder();
    expect(reminder).not.toContain('kind="channel"');
    expect(reminder).not.toContain('hand off');
    expect(reminder).not.toContain('other members');
  });
});
