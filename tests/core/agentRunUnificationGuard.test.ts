import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getAgentEventVisibleTranscript,
  replayAgentEvents,
  type AgentActor,
  type AgentEvent,
} from '../../src/core/agentEventLog';
import { AgentEventStore } from '../../src/main/agentEventStore';

// PR-1 guard ([[agent-debug-run-grounded]]): the run-unification refactor moves
// turn runs onto private per-stream seq and assembles the conversation transcript
// by splice. It is correct IFF the visible transcript is byte-identical to today.
// This locks the STORE round-trip — append through the split files, read back via
// `store.replay()` — against an explicit oracle id sequence, so any change to seq
// numbering / merge ordering / splice that perturbs the visible transcript fails.

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };

async function withStore<T>(fn: (store: AgentEventStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-run-unification-'));
  try {
    return await fn(new AgentEventStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function base(conversationId: string, seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `${conversationId}-event-${seq}`,
    seq,
    conversationId,
    type,
    createdAt: 1_700_000_000_000 + seq,
    actor,
  };
}

/**
 * Append events one batch at a time the way the runtime does, then return the
 * store-replayed visible transcript ids alongside the in-memory oracle ids. The
 * refactor must keep both equal to each other AND to the expected sequence.
 */
async function storeVisibleIds(
  store: AgentEventStore,
  conversationId: string,
  events: readonly AgentEvent[],
): Promise<{ store: string[]; oracle: string[] }> {
  await store.appendEvents(conversationId, events);
  const state = await store.replay(conversationId);
  const oracle = getAgentEventVisibleTranscript(replayAgentEvents(events)).map((entry) => entry.message.id);
  return { store: getAgentEventVisibleTranscript(state).map((entry) => entry.message.id), oracle };
}

describe('run-unification visible-transcript guard (PR-1 invariant)', () => {
  test('DM: a single linear turn column round-trips through the store', async () => {
    await withStore(async (store) => {
      const conversationId = 'lin-agent-dm-guard';
      const agentActor: AgentActor = { type: 'agent', agentId: 'built-in:tenon:assistant' };
      const events: AgentEvent[] = [
        { ...base(conversationId, 1, 'conversation.created'), title: 'DM' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Hello' }],
        },
        {
          ...base(conversationId, 3, 'run.started'),
          runId: 'run-dm',
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
          disposition: 'attended',
          trigger: { type: 'message', messageId: 'user-1' },
        },
        {
          ...base(conversationId, 4, 'assistant_message.started', agentActor),
          runId: 'run-dm',
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          providerId: 'anthropic',
          modelId: 'claude',
        },
        {
          ...base(conversationId, 5, 'assistant_message.completed', agentActor),
          runId: 'run-dm',
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Hi there' }],
        },
        { ...base(conversationId, 6, 'run.completed'), runId: 'run-dm' },
      ] as AgentEvent[];

      const { store: storeIds, oracle } = await storeVisibleIds(store, conversationId, events);
      expect(storeIds).toEqual(['user-1', 'assistant-1']);
      expect(storeIds).toEqual(oracle);
    });
  });

  test('delegation: a child run stream stays out of the conversation transcript', async () => {
    await withStore(async (store) => {
      const conversationId = 'lin-agent-delegation-guard';
      const agentActor: AgentActor = { type: 'agent', agentId: 'built-in:tenon:assistant' };
      const parentEvents: AgentEvent[] = [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Delegation' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Delegate this' }],
        },
        {
          ...base(conversationId, 3, 'run.started'),
          runId: 'run-parent',
          agentId: 'built-in:tenon:assistant',
          disposition: 'attended',
          trigger: { type: 'message', messageId: 'user-1' },
        },
        {
          ...base(conversationId, 4, 'assistant_message.started', agentActor),
          runId: 'run-parent',
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          providerId: 'p',
          modelId: 'm',
        },
        {
          ...base(conversationId, 5, 'assistant_message.completed', agentActor),
          runId: 'run-parent',
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Done delegating' }],
        },
        { ...base(conversationId, 6, 'run.completed'), runId: 'run-parent' },
      ] as AgentEvent[];
      await store.appendEvents(conversationId, parentEvents);

      // The delegated child run is its OWN stream (private seq from 1), appended
      // via the run-stream seam and EXCLUDED from the conversation replay join.
      const childEvents: AgentEvent[] = [
        {
          ...base(conversationId, 1, 'run.started', agentActor),
          runId: 'child-run',
          agentId: 'built-in:tenon:assistant',
          anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
          disposition: 'attended',
          trigger: { type: 'parent-run', parentRunId: 'run-parent' },
        },
        {
          ...base(conversationId, 2, 'assistant_message.started', agentActor),
          runId: 'child-run',
          messageId: 'child-assistant',
          parentMessageId: null,
          providerId: 'p',
          modelId: 'm',
        },
        {
          ...base(conversationId, 3, 'assistant_message.completed', agentActor),
          runId: 'child-run',
          messageId: 'child-assistant',
          parentMessageId: null,
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Child work' }],
        },
        { ...base(conversationId, 4, 'run.completed', agentActor), runId: 'child-run' },
      ] as AgentEvent[];
      await store.appendRunStreamEvents(conversationId, 'child-run', childEvents);

      const conversationVisible = getAgentEventVisibleTranscript(await store.replay(conversationId)).map((entry) => entry.message.id);
      expect(conversationVisible).toEqual(['user-1', 'assistant-1']);
      expect(conversationVisible).not.toContain('child-assistant');

      // The child run replays alone into its own state (the run-grounded primitive PR-2 reads).
      const childState = await store.replayRunStream('child-run');
      expect(getAgentEventVisibleTranscript(childState).map((entry) => entry.message.id)).toEqual(['child-assistant']);
    });
  });
});
