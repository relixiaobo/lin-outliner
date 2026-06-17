import { describe, expect, test } from 'bun:test';
import type { AgentConversation, AgentConversationListMeta } from '../../src/core/types';
import type { AgentDefinitionView } from '../../src/core/agentTypes';
import { DEFAULT_GENERAL_CHANNEL_ID, agentMentionToken } from '../../src/core/agentChannel';
import {
  createChannelOrgTools,
  type AgentChannelToolRuntime,
  type AgentChannelUpdateOptions,
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

    expect(runtime.calls.updateConversation).toEqual([[
      'channel-1',
      {
        title: 'Renamed planning',
        addAgentIds: [WRITER_ID],
        removeAgentIds: [REVIEWER_ID],
      },
    ]]);
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

  test('reports only the Channel changes that actually applied', async () => {
    const runtime = fakeRuntime();
    const tool = createChannelOrgTools(runtime).find((candidate) => candidate.name === 'channel_update')!;

    const result = await tool.execute('call-noop', {
      name: 'Planning',
      add_member_names: ['Reviewer'],
      remove_member_names: ['writer'],
    });

    expect(runtime.calls.updateConversation).toEqual([[
      'channel-1',
      {
        title: 'Planning',
        addAgentIds: [REVIEWER_ID],
        removeAgentIds: [WRITER_ID],
      },
    ]]);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: true,
      data: {
        conversation_id: 'channel-1',
        name: 'Planning',
        members: [
          { agent_id: COORDINATOR_ID, mention: 'assistant', name: 'Neva' },
          { agent_id: REVIEWER_ID, mention: 'reviewer', name: 'Reviewer' },
        ],
      },
    });
    expect(JSON.parse(result.content[0]!.text).data).not.toHaveProperty('added_member_agent_ids');
    expect(JSON.parse(result.content[0]!.text).data).not.toHaveProperty('removed_member_agent_ids');
    expect(JSON.parse(result.content[0]!.text).data).not.toHaveProperty('renamed');
  });

  test('resolves explicit @mentions by routing token and rejects bare name/token ambiguity', async () => {
    const displayNameWriterId = 'project:workspace:alpha';
    const runtime = fakeRuntime({
      definitions: [
        definition(COORDINATOR_ID, 'assistant', 'Neva'),
        definition(displayNameWriterId, 'alpha', 'writer'),
        definition(WRITER_ID, 'scribe', 'Scribe'),
      ],
    });
    const createTool = createChannelOrgTools(runtime).find((candidate) => candidate.name === 'channel_create')!;
    const updateTool = createChannelOrgTools(runtime).find((candidate) => candidate.name === 'channel_update')!;

    const created = await createTool.execute('call-explicit-mention', {
      name: 'Mention routing',
      member_names: ['@writer'],
    });
    const ambiguous = await updateTool.execute('call-ambiguous-bare-ref', {
      add_member_names: ['writer'],
    });

    expect(runtime.calls.createConversation).toEqual([{
      title: 'Mention routing',
      agentIds: [WRITER_ID],
    }]);
    expect(JSON.parse(created.content[0]!.text)).toMatchObject({
      ok: true,
      data: {
        members: expect.arrayContaining([
          { agent_id: WRITER_ID, mention: 'writer', name: 'Scribe' },
        ]),
      },
    });
    expect(JSON.parse(ambiguous.content[0]!.text)).toMatchObject({
      ok: false,
      error: {
        code: 'CHANNEL_UPDATE_FAILED',
        message: 'Agent reference "writer" is ambiguous. Pass an exact agent_id or @mention.',
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
    const directGeneral = await tool.execute('call-direct-general', { conversation_id: DEFAULT_GENERAL_CHANNEL_ID, name: 'Nope' });
    const missingChannel = await tool.execute('call-missing-channel', { conversation_id: 'missing-channel', name: 'Nope' });
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
    expect(JSON.parse(directGeneral.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_UPDATE_FAILED', message: '#General and DMs cannot be edited.' },
    });
    expect(JSON.parse(missingChannel.content[0]!.text)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_UPDATE_FAILED', message: 'No Channel with conversation_id "missing-channel" was found.' },
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
  definitions?: AgentDefinitionView[];
} = {}): AgentChannelToolRuntime & {
  calls: {
    createConversation: unknown[];
    updateConversation: Array<[string, AgentChannelUpdateOptions]>;
  };
} {
  const calls = {
    createConversation: [] as unknown[],
    updateConversation: [] as Array<[string, AgentChannelUpdateOptions]>,
  };
  let conversations = overrides.conversations ?? [
    conversation('channel-1', 'Planning', [COORDINATOR_ID, REVIEWER_ID]),
  ];
  const definitions = overrides.definitions ?? [
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
      return {
        conversationId: id,
        renderProjection: {
          conversationTitle: options.title,
          members: renderMembers(members, definitions),
        } as AgentConversation['renderProjection'],
      };
    },
    listConversations: async () => conversations,
    listAllAgentDefinitions: async () => definitions,
    updateConversation: async (conversationId, options) => {
      calls.updateConversation.push([conversationId, options]);
      const before = conversations.find((item) => item.id === conversationId);
      if (!before) throw new Error(`No Channel with conversation_id "${conversationId}" was found.`);
      const beforeAgentIds = before.members.flatMap((member) => member.type === 'agent' ? [member.agentId] : []);
      const addedAgentIds = (options.addAgentIds ?? []).filter((agentId) => !beforeAgentIds.includes(agentId));
      const removedAgentIds = (options.removeAgentIds ?? []).filter((agentId) => beforeAgentIds.includes(agentId));
      const renamed = options.title !== undefined && options.title !== before.title;
      conversations = conversations.map((item) => (
        item.id === conversationId
          ? {
              ...item,
              ...(options.title ? { title: options.title, goal: options.title } : {}),
              members: [
                ...item.members.filter((member) => member.type !== 'agent' || !(options.removeAgentIds ?? []).includes(member.agentId)),
                ...addedAgentIds.map((agentId) => ({ type: 'agent' as const, agentId })),
              ],
            }
          : item
      ));
      return {
        conversation: conversations.find((item) => item.id === conversationId)!,
        addedAgentIds,
        removedAgentIds,
        renamed,
      };
    },
  };
  return runtime;
}

function renderMembers(agentIds: readonly string[], definitions: readonly AgentDefinitionView[]): AgentConversation['renderProjection']['members'] {
  return agentIds.map((agentId) => {
    const match = definitions.find((candidate) => candidate.agentId === agentId);
    return {
      principal: { type: 'agent' as const, agentId },
      mention: agentMentionToken(agentId),
      displayName: match?.displayName?.trim() || match?.name || agentMentionToken(agentId),
      ...(agentId === COORDINATOR_ID ? { coordinator: true } : {}),
    };
  });
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
