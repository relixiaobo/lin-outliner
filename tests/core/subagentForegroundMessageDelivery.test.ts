import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SubagentExecutionLedger } from '../../src/main/agent/persistence/SubagentExecutionLedger';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { SubagentCollaboration } from '../../src/main/agent/thread/SubagentCollaboration';

const PARENT_ID = 'parent-thread';
const FIRST_AGENT_ID = 'first-agent';
const SECOND_AGENT_ID = 'second-agent';

interface DeliverySeam {
  deliverParentMessages(
    parentThreadId: string,
    foreground?: { readonly senderAgentId: string; readonly generation: number },
  ): Promise<void>;
}

describe('foreground Agent main-message delivery', () => {
  test('drains only the completing sender generation', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    createExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    const activeAgents = new Set<string>();
    const deliveredIds: string[] = [];
    let parentActive = true;
    const turnLifecycle = {
      hasActiveTurn: (threadId: string) => activeAgents.has(threadId),
      activeTurnId: (threadId: string) => threadId === PARENT_ID && parentActive ? 'parent-turn' : null,
      steerTurn: async (request: { readonly clientUserMessageId?: string }) => {
        deliveredIds.push(request.clientUserMessageId ?? '');
      },
    };
    const collaboration = new SubagentCollaboration(
      {} as never,
      {} as never,
      {} as never,
      turnLifecycle as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      (message) => new Error(message),
      {} as never,
    );
    const delivery = collaboration as unknown as DeliverySeam;

    enqueue(ledger, 'first-generation-1', FIRST_AGENT_ID, 1, 'foreground');
    enqueue(ledger, 'first-generation-2', FIRST_AGENT_ID, 2, 'foreground');
    enqueue(ledger, 'second-generation-1', SECOND_AGENT_ID, 1, 'foreground');
    enqueue(ledger, 'background-message', SECOND_AGENT_ID, 1, 'background');

    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: FIRST_AGENT_ID,
      generation: 1,
    });

    expect(deliveredIds).toEqual(['first-generation-1']);
    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual([
      'background-message',
      'second-generation-1',
      'first-generation-2',
    ]);

    activeAgents.add(SECOND_AGENT_ID);
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: SECOND_AGENT_ID,
      generation: 1,
    });
    expect(deliveredIds).toEqual(['first-generation-1']);

    activeAgents.delete(SECOND_AGENT_ID);
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: SECOND_AGENT_ID,
      generation: 1,
    });
    parentActive = false;
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: FIRST_AGENT_ID,
      generation: 2,
    });
    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
    ]);
    parentActive = true;
    await delivery.deliverParentMessages(PARENT_ID);

    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
      'background-message',
    ]);
    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual([
      'first-generation-2',
    ]);

    database.close();
  });
});

function enqueue(
  ledger: SubagentExecutionLedger,
  id: string,
  senderAgentId: string,
  generation: number,
  deliveryMode: 'foreground' | 'background',
): void {
  ledger.enqueueParentMessage({
    id,
    senderAgentId,
    parentThreadId: PARENT_ID,
    generation,
    content: id,
    deliveryMode,
    createdAt: generation,
  });
}

function createExecution(
  ledger: SubagentExecutionLedger,
  agentId: string,
  turnId: string,
  toolUseId: string,
): void {
  ledger.create({
    agentId,
    parentThreadId: PARENT_ID,
    description: agentId,
    agentType: 'general-purpose',
    runMode: 'foreground',
    currentTurnId: turnId,
    toolUseId,
    worktree: null,
    toolPolicy: {
      kind: 'general-purpose',
      runInBackground: false,
      worktree: false,
      allowNesting: true,
      requestedTools: null,
    },
    startupContext: null,
    createdAt: 1,
    updatedAt: 1,
  });
}
