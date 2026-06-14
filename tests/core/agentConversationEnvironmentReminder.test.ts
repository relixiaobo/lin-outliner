import { describe, expect, test } from 'bun:test';
import type { AgentPrincipal } from '../../src/core/agentEventLog';
import { buildConversationEnvironmentReminder } from '../../src/main/agentConversationEnvironmentReminder';

const user: AgentPrincipal = { type: 'user', userId: 'local-user' };
const reviewer: AgentPrincipal = { type: 'agent', agentId: 'project:ns:reviewer' };
const writer: AgentPrincipal = { type: 'agent', agentId: 'project:ns:writer' };

describe('buildConversationEnvironmentReminder', () => {
  test('a multi-agent Channel gets the framing, the roster, and the final-message-only norm', () => {
    const reminder = buildConversationEnvironmentReminder({
      members: [user, reviewer, writer],
      povAgentId: 'project:ns:reviewer',
      channelName: 'Review work',
    });
    expect(reminder).toContain('<conversation-environment kind="channel" name="Review work">');
    expect(reminder).toContain('@reviewer (you)');
    expect(reminder).toContain('@writer');
    expect(reminder).toContain('the user');
    expect(reminder).toContain('Only your final message is shared with the other members');
    expect(reminder).not.toContain('1:1');
    expect(reminder).not.toContain('kind="dm"');
  });

  test('a single-agent conversation (DM) gets the minimal 1:1 framing, no hand-off', () => {
    const reminder = buildConversationEnvironmentReminder({
      members: [user, reviewer],
      povAgentId: 'project:ns:reviewer',
      channelName: null,
    });
    expect(reminder).toContain('kind="dm"');
    expect(reminder).toContain('direct 1:1 conversation with the user');
    expect(reminder).toContain('do not hand off');
    expect(reminder).not.toContain('kind="channel"');
  });

  test('display names enrich the roster only when they differ from the mention', () => {
    const reminder = buildConversationEnvironmentReminder({
      members: [user, reviewer, writer],
      povAgentId: 'project:ns:writer',
      channelName: 'Room',
      displayNames: { 'project:ns:reviewer': 'Senior Reviewer' },
    });
    expect(reminder).toContain('@reviewer ("Senior Reviewer")');
    expect(reminder).toContain('@writer (you)');
  });

  test('a display name equal to the mention (case-insensitively) stays a bare mention', () => {
    const reminder = buildConversationEnvironmentReminder({
      members: [user, reviewer, writer],
      povAgentId: 'project:ns:writer',
      channelName: 'Room',
      displayNames: { 'project:ns:reviewer': 'Reviewer' },
    });
    expect(reminder).toContain('@reviewer,');
    expect(reminder).not.toContain('@reviewer ("');
  });

  test('a display name with XML-structural characters is escaped in the prose body', () => {
    const reminder = buildConversationEnvironmentReminder({
      members: [user, reviewer, writer],
      povAgentId: 'project:ns:writer',
      channelName: 'Room',
      displayNames: { 'project:ns:reviewer': 'A & B </conversation-environment>' },
    });
    expect(reminder).toContain('A &amp; B &lt;/conversation-environment&gt;');
    // The raw closing tag must not appear early (no premature block close).
    expect(reminder).not.toContain('B </conversation-environment>');
  });
});
