import { describe, expect, test } from 'bun:test';
import type { AgentConversation, AgentConversationListMeta } from '../../src/core/types';
import type { AgentDefinitionView } from '../../src/core/agentTypes';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import {
  createChannelOrgTools,
  type AgentChannelToolRuntime,
} from '../../src/main/agentChannelTools';

const COORDINATOR_ID = 'built-in:tenon:assistant';
const REVIEWER_ID = 'project:workspace:reviewer';
const WRITER_ID = 'project:workspace:writer';

describe('agent channel org tools', () => {
  test('creates a Channel through the runtime path and returns slim member data', async () => {
    const runtime = fakeRuntime();
    const tool = createChannelOrgTools(runtime).find((candidate) => candidate.name === 'channel_create')!;

    const result = await tool.execute('call-create', {
      name: 'Launch working group',
      member_names: ['Reviewer', '@writer'],
      opening_message: 'Coordinate launch notes.',
    });

    expect(runtime.calls.createConversation).toEqual([{
      title: 'Launch working group',
      agentIds: [REVIEWER_ID, WRITER_ID],
      seedText: 'Coordinate launch notes.',
    }]);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      ok: true,
      data: {
        conversation_id: 'channel-2',
        name: 'Launch working group',
        members: [
          { agent_id: COORDINATOR_ID, mention: 'assistant', name: 'Neva' },
          { agent_id: REVIEWER_ID, mention: 'reviewer', name: 'Reviewer' },
          { agent_id: WRITER_ID, mention: 'writer', name: 'Writer' },
        ],
      },
      instructions: 'Announce the new Channel and its members. Do not claim any member has started work unless the user asks in that Channel.',
    });
  });

  test('updates the current Channel by rename/add/remove without guessing a target', async () => {
    const runtime = fakeRuntime();
    const tool = createChannelOrgTools(runtime).find((candidate) => candidate.name === 'channel_update')!;

    const result = await tool.execute('call-update', {
      name: 'Renamed planning',
      add_member_names: ['writer'],
      remove_member_names: ['Reviewer'],
    });

    expect(runtime.calls.renameConversation).toEqual([['channel-1', 'Renamed planning']]);
    expect(runtime.calls.addConversationMember).toEqual([['channel-1', WRITER_ID]]);
    expect(runtime.calls.removeConversationMember).toEqual([['channel-1', REVIEWER_ID]]);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: true,
      data: {
        conversation_id: 'channel-1',
        name: 'Renamed planning',
        added_member_agent_ids: [WRITER_ID],
        removed_member_agent_ids: [REVIEWER_ID],
        renamed: true,
      },
    });
  });

  test('reports recoverable errors for ambiguous or invalid updates', async () => {
    const runtime = fakeRuntime({
      currentConversationId: () => 'dm-1',
      conversations: [
        conversation(DEFAULT_GENERAL_CHANNEL_ID, '#General', [COORDINATOR_ID, REVIEWER_ID]),
        conversation('channel-a', 'Same', [COORDINATOR_ID]),
        conversation('channel-b', 'Same', [COORDINATOR_ID]),
        {
          ...conversation('dm-1', 'Reviewer', [REVIEWER_ID]),
          canonicalDmAgentId: REVIEWER_ID,
        },
      ],
    });
    const tool = createChannelOrgTools(runtime).find((candidate) => candidate.name === 'channel_update')!;

    const currentDm = await tool.execute('call-current-dm', { name: 'Nope' });
    const general = await tool.execute('call-general', { channel_name: '#General', name: 'Nope' });
    const ambiguous = await tool.execute('call-ambiguous', { channel_name: 'Same', name: 'Nope' });
    const missingAgent = await tool.execute('call-missing-agent', {
      conversation_id: 'channel-a',
      add_member_names: ['missing'],
    });
    const overlap = await tool.execute('call-overlap', {
      conversation_id: 'channel-a',
      add_member_agent_ids: [WRITER_ID],
      remove_member_names: ['writer'],
    });

    expect(JSON.parse(currentDm.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_UPDATE_FAILED', message: 'The current conversation is not an editable Channel. Pass conversation_id or channel_name.' },
    });
    expect(JSON.parse(general.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_UPDATE_FAILED', message: '#General and DMs cannot be edited.' },
    });
    expect(JSON.parse(ambiguous.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_UPDATE_FAILED', message: 'More than one Channel is named "Same". Pass conversation_id.' },
    });
    expect(JSON.parse(missingAgent.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_UPDATE_FAILED', message: 'Agent not found for add member reference: missing' },
    });
    expect(JSON.parse(overlap.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_UPDATE_FAILED', message: `Agent ${WRITER_ID} cannot be both added and removed in one update.` },
    });
  });
});

function fakeRuntime(overrides: {
  conversations?: AgentConversationListMeta[];
  currentConversationId?: () => string;
} = {}): AgentChannelToolRuntime & {
  calls: {
    createConversation: unknown[];
    renameConversation: Array<[string, string]>;
    addConversationMember: Array<[string, string]>;
    removeConversationMember: Array<[string, string]>;
  };
} {
  const calls = {
    createConversation: [] as unknown[],
    renameConversation: [] as Array<[string, string]>,
    addConversationMember: [] as Array<[string, string]>,
    removeConversationMember: [] as Array<[string, string]>,
  };
  let conversations = overrides.conversations ?? [
    conversation('channel-1', 'Planning', [COORDINATOR_ID, REVIEWER_ID]),
  ];
  const definitions = [
    definition(COORDINATOR_ID, 'assistant', 'Neva'),
    definition(REVIEWER_ID, 'reviewer', 'Reviewer'),
    definition(WRITER_ID, 'writer', 'Writer'),
  ];
  const runtime: AgentChannelToolRuntime & { calls: typeof calls } = {
    calls,
    currentConversationId: overrides.currentConversationId ?? (() => 'channel-1'),
    createConversation: async (options) => {
      calls.createConversation.push(options);
      const id = `channel-${conversations.length + 1}`;
      const members = [COORDINATOR_ID, ...(options.agentIds ?? [])];
      conversations = [...conversations, conversation(id, options.title, members)];
      return { conversationId: id, renderProjection: {} } as AgentConversation;
    },
    listConversations: async () => conversations,
    listAllAgentDefinitions: async () => definitions,
    renameConversation: async (conversationId, title) => {
      calls.renameConversation.push([conversationId, title]);
      conversations = conversations.map((item) => (
        item.id === conversationId ? { ...item, title, goal: title } : item
      ));
      return conversations.find((item) => item.id === conversationId) ?? null;
    },
    addConversationMember: async (conversationId, agentId) => {
      calls.addConversationMember.push([conversationId, agentId]);
      conversations = conversations.map((item) => (
        item.id === conversationId
          ? { ...item, members: [...item.members, { type: 'agent' as const, agentId }] }
          : item
      ));
      return { conversationId, renderProjection: {} } as AgentConversation;
    },
    removeConversationMember: async (conversationId, agentId) => {
      calls.removeConversationMember.push([conversationId, agentId]);
      conversations = conversations.map((item) => (
        item.id === conversationId
          ? { ...item, members: item.members.filter((member) => member.type !== 'agent' || member.agentId !== agentId) }
          : item
      ));
      return { conversationId, renderProjection: {} } as AgentConversation;
    },
  };
  return runtime;
}

function conversation(id: string, title: string, agentIds: string[]): AgentConversationListMeta {
  return {
    id,
    title,
    members: [
      { type: 'user', userId: 'local-user' },
      ...agentIds.map((agentId) => ({ type: 'agent' as const, agentId })),
    ],
    goal: title,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
  };
}

function definition(agentId: string, name: string, displayName: string): AgentDefinitionView {
  return {
    agentId,
    name,
    displayName,
    source: agentId.startsWith('built-in') ? 'built-in' : 'project',
    rootDir: 'root',
    agentFile: `${name}/AGENT.md`,
    description: `${displayName} agent.`,
    model: 'inherit',
    body: '',
    writable: false,
  };
}
