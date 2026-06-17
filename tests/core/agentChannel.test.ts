import { describe, expect, test } from 'bun:test';
import {
  agentMentionToken,
  channelMessageOwner,
  cutChannelPathForRun,
  deriveAgentPovProjection,
  flattenAgentPathForPov,
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

describe('§8 POV flatten', () => {
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

  test("peer POV: own turn verbatim; user and other agents coalesce into one user block with identity preambles; others' execution detail is dropped", () => {
    const state = channelTranscriptState();
    const projection = deriveAgentPovProjection(state, PEER_AGENT_ID, {
      mainAgentId: MAIN_AGENT_ID,
      displayNameByAgentId: { [MAIN_AGENT_ID]: 'Neva' },
    });
    const steps = projection.steps;

    expect(steps).toHaveLength(2);
    expect(projection.addressedByMessageId).toBeNull();
    const [foreign, own] = steps;
    if (foreign!.kind !== 'flattened' || own!.kind !== 'verbatim') {
      throw new Error(`Unexpected step shapes: ${steps.map((step) => step.kind).join(', ')}`);
    }
    // One coalesced user block: the human's turn + main's visible reply. The
    // toolUse assistant message and the tool result never cross the POV boundary.
    expect(foreign.parts.map((part) => part.record.id)).toEqual(['user-1', 'assistant-main-final']);
    expect(foreign.parts[0]!.preamble).toBe('@user (the human user) said:');
    expect(foreign.parts[1]!.preamble).toBe('@assistant (agent "Neva") said:');
    expect(own.record.id).toBe('assistant-peer');
  });

  test('shared POV projection is the same derivation the direct flatten uses', () => {
    const state = channelTranscriptState();
    const options = { mainAgentId: MAIN_AGENT_ID, displayNameByAgentId: { [MAIN_AGENT_ID]: 'Neva' } };
    expect(deriveAgentPovProjection(state, PEER_AGENT_ID, options).steps).toEqual(
      flattenAgentPathForPov(
        getAgentEventRuntimeTranscriptPath(state),
        state.runs,
        PEER_AGENT_ID,
        options,
      ),
    );
  });

  test('main POV: own execution verbatim including tool pairing; the peer reply flattens', () => {
    const state = channelTranscriptState();
    const steps = flattenAgentPathForPov(
      getAgentEventRuntimeTranscriptPath(state),
      state.runs,
      MAIN_AGENT_ID,
      { mainAgentId: MAIN_AGENT_ID },
    );

    expect(steps.map((step) => step.kind)).toEqual(['flattened', 'verbatim', 'verbatim', 'verbatim', 'flattened']);
    const tail = steps.at(-1)!;
    if (tail.kind !== 'flattened') throw new Error('Expected a flattened tail.');
    expect(tail.parts[0]!.preamble).toBe('@reviewer (agent) said:');
    expect(tail.parts[0]!.record.id).toBe('assistant-peer');
  });

  test('system substrate user records flatten without an identity preamble', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel', members: channelMembers, goal: 'Channel' },
      {
        ...base(2, 'user_message.created'),
        messageId: 'seed-1',
        parentMessageId: null,
        content: [{ type: 'text', text: '<system-reminder>Channel seed.</system-reminder>' }],
      },
    ] as AgentEvent[]);
    const steps = flattenAgentPathForPov(
      getAgentEventRuntimeTranscriptPath(state),
      state.runs,
      PEER_AGENT_ID,
      { mainAgentId: MAIN_AGENT_ID },
    );
    expect(steps).toHaveLength(1);
    if (steps[0]!.kind !== 'flattened') throw new Error('Expected a flattened step.');
    expect(steps[0]!.parts[0]!.preamble).toBeNull();
  });
});

describe('independence cut', () => {
  // One round: the user @s reviewer and writer; reviewer answers first, then
  // writer's run starts — addressed BY the same user message, so reviewer's
  // reply must not leak into writer's context.
  function roundState() {
    return replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel', members: channelMembers, goal: 'Channel' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: '@reviewer @writer independent takes please' }],
        addressedTo: [peerMember, otherMember],
      },
      { ...base(3, 'run.started'), runId: 'run-peer', agentId: PEER_AGENT_ID, addressedByMessageId: 'user-1' },
      {
        ...base(4, 'assistant_message.started', { type: 'agent', agentId: PEER_AGENT_ID }),
        runId: 'run-peer',
        messageId: 'assistant-peer',
        parentMessageId: 'user-1',
        providerId: 'p',
        modelId: 'm',
      },
      {
        ...base(5, 'assistant_message.completed', { type: 'agent', agentId: PEER_AGENT_ID }),
        runId: 'run-peer',
        messageId: 'assistant-peer',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Reviewer take.' }],
      },
      { ...base(6, 'run.completed'), runId: 'run-peer' },
      { ...base(7, 'run.started'), runId: 'run-writer', agentId: OTHER_AGENT_ID, addressedByMessageId: 'user-1' },
      {
        ...base(8, 'assistant_message.started', { type: 'agent', agentId: OTHER_AGENT_ID }),
        runId: 'run-writer',
        messageId: 'assistant-writer',
        parentMessageId: 'assistant-peer',
        providerId: 'p',
        modelId: 'm',
      },
      {
        ...base(9, 'assistant_message.completed', { type: 'agent', agentId: OTHER_AGENT_ID }),
        runId: 'run-writer',
        messageId: 'assistant-writer',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Writer take.' }],
      },
      { ...base(10, 'run.completed'), runId: 'run-writer' },
    ] as AgentEvent[]);
  }

  test('a co-addressee cuts at the addressing message and keeps only its own later records', () => {
    const state = roundState();
    const path = getAgentEventRuntimeTranscriptPath(state);
    const cut = cutChannelPathForRun(path, state.runs, OTHER_AGENT_ID, 'user-1', MAIN_AGENT_ID);
    // The sibling's reply (assistant-peer) is invisible; writer's own turn survives.
    expect(cut.map((record) => record.id)).toEqual(['user-1', 'assistant-writer']);
    const projection = deriveAgentPovProjection(state, OTHER_AGENT_ID, { mainAgentId: MAIN_AGENT_ID });
    expect(projection.addressedByMessageId).toBe('user-1');
    expect(projection.steps.flatMap((step) => (
      step.kind === 'verbatim'
        ? [step.record.id]
        : step.parts.map((part) => part.record.id)
    ))).toEqual(['user-1', 'assistant-writer']);
  });

  test('explicit null boundary means full path instead of inspector latest-run fallback', () => {
    const state = roundState();
    const explicitFullPath = deriveAgentPovProjection(state, OTHER_AGENT_ID, {
      addressedByMessageId: null,
      mainAgentId: MAIN_AGENT_ID,
    });
    const inspectorFallback = deriveAgentPovProjection(state, OTHER_AGENT_ID, {
      mainAgentId: MAIN_AGENT_ID,
    });

    expect(explicitFullPath.addressedByMessageId).toBeNull();
    expect(explicitFullPath.steps.flatMap((step) => (
      step.kind === 'verbatim'
        ? [step.record.id]
        : step.parts.map((part) => part.record.id)
    ))).toEqual(['user-1', 'assistant-peer', 'assistant-writer']);
    expect(inspectorFallback.addressedByMessageId).toBe('user-1');
  });

  test('a hand-off target addressed by a reply sees that reply and everything before it', () => {
    const state = roundState();
    const path = getAgentEventRuntimeTranscriptPath(state);
    const cut = cutChannelPathForRun(path, state.runs, OTHER_AGENT_ID, 'assistant-peer', MAIN_AGENT_ID);
    expect(cut.map((record) => record.id)).toEqual(['user-1', 'assistant-peer', 'assistant-writer']);
  });

  test('no boundary or a vanished boundary fails open to the full path', () => {
    const state = roundState();
    const path = getAgentEventRuntimeTranscriptPath(state);
    expect(cutChannelPathForRun(path, state.runs, PEER_AGENT_ID, null, MAIN_AGENT_ID).map((record) => record.id))
      .toEqual(path.map((record) => record.id));
    // Compaction rewrote history mid-round: the boundary id is gone — never truncate.
    expect(cutChannelPathForRun(path, state.runs, PEER_AGENT_ID, 'compacted-away', MAIN_AGENT_ID).map((record) => record.id))
      .toEqual(path.map((record) => record.id));
  });
});
