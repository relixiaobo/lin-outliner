import { describe, expect, test } from 'bun:test';
import {
  agentMentionToken,
  channelMessageOwner,
  handOffTargets,
  isChannelConversationId,
  isMultiAgentConversation,
  parseAgentMentionTargets,
  usesChannelActivitySurface,
} from '../../src/core/agentChannel';
import {
  getAgentEventRuntimeTranscriptPath,
  replayAgentEvents,
  type AgentActor,
  type AgentEvent,
  type AgentPrincipal,
} from '../../src/core/agentEventLog';
import { buildAgentRenderProjection } from '../../src/core/agentRenderProjection';

const conversationId = 'conversation-channel-1';
const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };

const MAIN_AGENT_ID = 'built-in:tenon:assistant';
const PEER_AGENT_ID = 'project:abc123:reviewer';
const OTHER_AGENT_ID = 'project:abc123:writer';

const userMember: AgentPrincipal = { type: 'user', userId: 'user-1' };
const mainMember: AgentPrincipal = { type: 'agent', agentId: MAIN_AGENT_ID };
const peerMember: AgentPrincipal = { type: 'agent', agentId: PEER_AGENT_ID };
const otherMember: AgentPrincipal = { type: 'agent', agentId: OTHER_AGENT_ID };
const channelMembers = [userMember, mainMember, peerMember, otherMember];

function base(seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `event-${seq}`,
    seq,
    conversationId,
    type,
    createdAt: 1_700_000_000_000 + seq,
    actor,
  };
}

describe('agent channel mentions', () => {
  test('derives the mention token from the agentId name segment', () => {
    expect(agentMentionToken(PEER_AGENT_ID)).toBe('reviewer');
    expect(agentMentionToken(MAIN_AGENT_ID)).toBe('assistant');
    expect(agentMentionToken('no-colons')).toBe('no-colons');
  });

  test('single-agent collapse: a conversation is never multi-agent', () => {
    expect(isMultiAgentConversation([userMember, mainMember])).toBe(false);
    expect(isMultiAgentConversation([userMember, mainMember, peerMember])).toBe(false);
  });

  test('single-agent collapse: no conversation uses the Channel activity surface', () => {
    // The channel-id namespace is unchanged; the multi-agent activity surface it
    // used to gate is gone — every conversation streams inline.
    expect(isChannelConversationId('lin-agent-channel-solo')).toBe(true);
    expect(isChannelConversationId('lin-agent-dm-assistant')).toBe(false);
    expect(usesChannelActivitySurface('lin-agent-channel-solo', [userMember, mainMember])).toBe(false);
    expect(usesChannelActivitySurface('legacy-fixture', [userMember, mainMember, peerMember])).toBe(false);
  });

  test('parses mentions scoped to the roster, ordered by position, deduplicated', () => {
    const targets = parseAgentMentionTargets('@writer first, then @reviewer and @writer again', channelMembers);
    expect(targets.map((target) => target.agentId)).toEqual([OTHER_AGENT_ID, PEER_AGENT_ID]);
  });

  test('ignores non-member mentions, mid-word @, and token prefixes', () => {
    expect(parseAgentMentionTargets('@stranger hello', channelMembers)).toEqual([]);
    expect(parseAgentMentionTargets('email@reviewer is not a mention', channelMembers)).toEqual([]);
    expect(parseAgentMentionTargets('@reviewers is not @reviewer-bot either', channelMembers)).toEqual([]);
    expect(parseAgentMentionTargets('(@reviewer) parenthesized works', channelMembers).map((target) => target.agentId))
      .toEqual([PEER_AGENT_ID]);
  });

  test('hand-off targets are every mention that is not the speaker, in order', () => {
    expect(handOffTargets('@reviewer please handle this', channelMembers, PEER_AGENT_ID)).toEqual([]);
    expect(handOffTargets('@reviewer then @writer', channelMembers, PEER_AGENT_ID).map((target) => target.agentId))
      .toEqual([OTHER_AGENT_ID]);
    expect(handOffTargets('@writer and @reviewer, both of you', channelMembers, MAIN_AGENT_ID).map((target) => target.agentId))
      .toEqual([OTHER_AGENT_ID, PEER_AGENT_ID]);
    expect(handOffTargets('no mentions here', channelMembers, MAIN_AGENT_ID)).toEqual([]);
  });
});

describe('member events replay', () => {
  test('member.added / member.removed round-trip through replay, idempotently', () => {
    const added = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel', members: [userMember, mainMember], goal: 'Channel' },
      { ...base(2, 'member.added', userActor), member: peerMember },
      { ...base(3, 'member.added', userActor), member: peerMember },
    ] as AgentEvent[]);
    expect(added.conversation?.members).toEqual([userMember, mainMember, peerMember]);

    const removed = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel', members: [userMember, mainMember, peerMember], goal: 'Channel' },
      { ...base(2, 'member.removed', userActor), member: peerMember },
      { ...base(3, 'member.removed', userActor), member: peerMember },
    ] as AgentEvent[]);
    expect(removed.conversation?.members).toEqual([userMember, mainMember]);
  });

  test('addressedTo is written on user_message.created and read back from the record', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel', members: channelMembers, goal: 'Channel' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: '@reviewer hello' }],
        addressedTo: [peerMember],
      },
    ] as AgentEvent[]);
    expect(state.messages['user-1']?.addressedTo).toEqual([peerMember]);
  });

  test('render projection exposes member views, coordinator flag, and message actors', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel', members: [userMember, mainMember, peerMember], goal: 'Channel' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: '@reviewer hello' }],
        addressedTo: [peerMember],
      },
      {
        ...base(3, 'assistant_message.started', { type: 'agent', agentId: PEER_AGENT_ID }),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        providerId: 'p',
        modelId: 'm',
      },
      {
        ...base(4, 'assistant_message.completed', { type: 'agent', agentId: PEER_AGENT_ID }),
        messageId: 'assistant-1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Hi.' }],
      },
    ] as AgentEvent[]);

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      memberDisplayNames: { [PEER_AGENT_ID]: 'Code Reviewer' },
      coordinatorAgentId: MAIN_AGENT_ID,
    });
    expect(projection.members).toEqual([
      { principal: userMember, mention: '', displayName: 'You' },
      { principal: mainMember, mention: 'assistant', displayName: 'assistant', coordinator: true },
      { principal: peerMember, mention: 'reviewer', displayName: 'Code Reviewer', coordinator: undefined },
    ]);
    expect(projection.entities.messages['assistant-1']?.actor).toEqual({ type: 'agent', agentId: PEER_AGENT_ID });
    expect(projection.entities.messages['user-1']?.addressedTo).toEqual([peerMember]);
  });
});

describe('message ownership', () => {
  function channelTranscriptState() {
    return replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel', members: channelMembers, goal: 'Channel' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Please review the draft.' }],
      },
      { ...base(3, 'run.started'), runId: 'run-main', agentId: MAIN_AGENT_ID },
      {
        ...base(4, 'assistant_message.started', { type: 'agent', agentId: MAIN_AGENT_ID }),
        runId: 'run-main',
        messageId: 'assistant-main-tool',
        parentMessageId: 'user-1',
        providerId: 'p',
        modelId: 'm',
      },
      {
        ...base(5, 'assistant_message.completed', { type: 'agent', agentId: MAIN_AGENT_ID }),
        runId: 'run-main',
        messageId: 'assistant-main-tool',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Let me look first.' },
          { type: 'toolCall', id: 'tool-1', name: 'node_search', arguments: {} },
        ],
      },
      {
        ...base(6, 'tool_result.created', { type: 'tool', toolName: 'node_search', toolCallId: 'tool-1' }),
        runId: 'run-main',
        toolCallId: 'tool-1',
        toolName: 'node_search',
        messageId: 'tool-result-1',
        parentMessageId: 'assistant-main-tool',
        isError: false,
        content: [{ type: 'text', text: 'Found 3 nodes.' }],
        outputSummary: 'Found 3 nodes.',
      },
      {
        ...base(7, 'assistant_message.started', { type: 'agent', agentId: MAIN_AGENT_ID }),
        runId: 'run-main',
        messageId: 'assistant-main-final',
        parentMessageId: 'tool-result-1',
        providerId: 'p',
        modelId: 'm',
      },
      {
        ...base(8, 'assistant_message.completed', { type: 'agent', agentId: MAIN_AGENT_ID }),
        runId: 'run-main',
        messageId: 'assistant-main-final',
        stopReason: 'stop',
        content: [{ type: 'text', text: '@reviewer your turn.' }],
      },
      { ...base(9, 'run.completed'), runId: 'run-main' },
      { ...base(10, 'run.started'), runId: 'run-peer', agentId: PEER_AGENT_ID },
      {
        ...base(11, 'assistant_message.started', { type: 'agent', agentId: PEER_AGENT_ID }),
        runId: 'run-peer',
        messageId: 'assistant-peer',
        parentMessageId: 'assistant-main-final',
        providerId: 'p',
        modelId: 'm',
      },
      {
        ...base(12, 'assistant_message.completed', { type: 'agent', agentId: PEER_AGENT_ID }),
        runId: 'run-peer',
        messageId: 'assistant-peer',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Reviewed: looks good.' }],
      },
      { ...base(13, 'run.completed'), runId: 'run-peer' },
    ] as AgentEvent[]);
  }

  test('attributes assistant and tool records to the run executing agent', () => {
    const state = channelTranscriptState();
    const path = getAgentEventRuntimeTranscriptPath(state);
    const owners = path.map((record) => channelMessageOwner(record, state.runs, MAIN_AGENT_ID));
    expect(owners).toEqual([
      { type: 'user', userId: 'user-1' },
      { type: 'agent', agentId: MAIN_AGENT_ID },
      { type: 'agent', agentId: MAIN_AGENT_ID },
      { type: 'agent', agentId: MAIN_AGENT_ID },
      { type: 'agent', agentId: PEER_AGENT_ID },
    ]);
  });
});

