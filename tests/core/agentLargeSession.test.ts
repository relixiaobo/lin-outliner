import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent, AgentPayloadRef } from '../../src/core/agentEventLog';
import { buildAgentRenderProjection } from '../../src/core/agentRenderProjection';
import { AgentEventStore } from '../../src/main/agentEventStore';

const sessionId = 'large-session-1';
const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'pi-mono' };
const toolActor = (toolCallId: string): AgentActor => ({ type: 'tool', toolName: 'file_read', toolCallId });

async function withStore<T>(fn: (store: AgentEventStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-large-session-'));
  try {
    return await fn(new AgentEventStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function usage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createEventBuilder() {
  let seq = 0;
  return (type: AgentEvent['type'], actor: AgentActor = systemActor) => ({
    v: 1 as const,
    eventId: `large-event-${++seq}`,
    seq,
    sessionId,
    type,
    createdAt: 1_800_000_000_000 + seq,
    actor,
  });
}

async function appendTurns(input: {
  buildBase: ReturnType<typeof createEventBuilder>;
  count: number;
  firstIndex: number;
  initialLeaf: string | null;
  store: AgentEventStore;
}): Promise<{ events: AgentEvent[]; leaf: string | null; largePayloadNeedle: string }> {
  const events: AgentEvent[] = [];
  let leaf = input.initialLeaf;
  let largePayloadNeedle = '';

  for (let turn = input.firstIndex; turn < input.firstIndex + input.count; turn += 1) {
    const userId = `user-${turn}`;
    const assistantId = `assistant-${turn}`;
    const runId = `run-${turn}`;
    events.push(
      { ...input.buildBase('user_message.created', userActor), messageId: userId, parentMessageId: leaf, content: [{ type: 'text', text: `User asks for marker ${turn}` }] },
      { ...input.buildBase('run.started'), runId },
      {
        ...input.buildBase('assistant_message.started', agentActor),
        runId,
        messageId: assistantId,
        parentMessageId: userId,
        providerId: 'openai',
        modelId: 'gpt-test',
        apiId: 'responses',
      },
      {
        ...input.buildBase('assistant_message.completed', agentActor),
        runId,
        messageId: assistantId,
        stopReason: 'stop',
        content: [{ type: 'text', text: `Assistant answer for marker ${turn}` }],
        usage: usage(),
      },
      { ...input.buildBase('run.completed'), runId },
    );
    leaf = assistantId;

    if (turn % 30 === 0) {
      const toolCallId = `tool-${turn}`;
      const toolResultId = `tool-result-${turn}`;
      largePayloadNeedle = `large-payload-${turn}-${'x'.repeat(4096)}`;
      const payload = await input.store.writePayload(sessionId, {
        id: `tool-output-${turn}`,
        data: `${largePayloadNeedle}\n${'payload-body\n'.repeat(8000)}`,
        mimeType: 'text/plain',
        role: 'tool_output',
        summary: `Large output ${turn}`,
      });
      events.push(
        { ...input.buildBase('payload.created', toolActor(toolCallId)), payload },
        {
          ...input.buildBase('tool_result.created', toolActor(toolCallId)),
          toolCallId,
          toolName: 'file_read',
          messageId: toolResultId,
          parentMessageId: leaf,
          isError: false,
          content: [payloadRefContent(payload, `Large output ${turn}`)],
          outputSummary: `Large output marker ${turn}`,
          outputRef: payload,
        },
      );
      leaf = toolResultId;
    }
  }

  return { events, leaf, largePayloadNeedle };
}

function payloadRefContent(payload: AgentPayloadRef, label: string) {
  return {
    type: 'payload_ref' as const,
    payload,
    label,
  };
}

describe('large agent sessions', () => {
  test('restore, indexes, render projection, and payload refs stay bounded for a large session', async () => {
    await withStore(async (store) => {
      const buildBase = createEventBuilder();
      const firstBatch: AgentEvent[] = [{ ...buildBase('session.created'), title: 'Large session' }];
      const firstTurns = await appendTurns({
        buildBase,
        count: 180,
        firstIndex: 0,
        initialLeaf: null,
        store,
      });
      firstBatch.push(...firstTurns.events);
      await store.appendEvents(sessionId, firstBatch);

      const checkpoint = await store.writeCheckpoint(sessionId, await store.replay(sessionId));
      expect(checkpoint?.seq).toBe(firstBatch.at(-1)?.seq);

      const tailTurns = await appendTurns({
        buildBase,
        count: 15,
        firstIndex: 180,
        initialLeaf: firstTurns.leaf,
        store,
      });
      await store.appendEvents(sessionId, tailTurns.events);

      const restored = await store.replay(sessionId);
      expect(restored.latestSeq).toBe(tailTurns.events.at(-1)?.seq);
      expect(Object.keys(restored.messages).length).toBe(397);

      const projection = buildAgentRenderProjection(restored, {
        revision: 1,
        model: { id: 'gpt-test', provider: 'openai' },
      });
      expect(projection.rows.length).toBe(397);
      expect(projection.rows.at(-1)?.messageId).toBe('assistant-194');

      const sessions = await store.listConversationIndexEntries();
      expect(sessions[0]).toMatchObject({
        id: sessionId,
        messageCount: 397,
        latestSeq: restored.latestSeq,
      });
      expect(await store.listUserMessageIndexEntries(sessionId)).toHaveLength(195);
      expect((await store.searchMessages('marker 194', { sessionId })).map((entry) => entry.messageId)).toContain('assistant-194');

      const rawEventLog = await readFile(store.paths(sessionId).conversationEventsPath, 'utf8');
      expect(rawEventLog).not.toContain(firstTurns.largePayloadNeedle);
      expect(rawEventLog).not.toContain(tailTurns.largePayloadNeedle);
    });
  });
});
