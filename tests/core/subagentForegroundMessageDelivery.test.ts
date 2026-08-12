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
  test('recreates the pre-generation parent-message ledger shape', () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    database.exec(`
      CREATE TABLE subagent_parent_messages (
        id TEXT PRIMARY KEY,
        sender_agent_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        content TEXT NOT NULL,
        delivery_mode TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      ) STRICT;
      INSERT INTO subagent_parent_messages
        (id, sender_agent_id, parent_thread_id, content, delivery_mode, state, created_at)
      VALUES ('legacy', 'agent', 'parent-thread', 'stale', 'foreground', 'pending', 1);
    `);

    const ledger = new SubagentExecutionLedger(database);
    const columns = database.prepare("PRAGMA table_info('subagent_parent_messages')")
      .all() as unknown as Array<{ name?: unknown }>;
    expect(columns.map((column) => column.name)).toContain('generation');
    expect(ledger.pendingParentMessages(PARENT_ID)).toEqual([]);
    database.close();
  });

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
    enqueue(ledger, 'first-generation-1-after-resume', FIRST_AGENT_ID, 1, 'foreground');
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: SECOND_AGENT_ID,
      generation: 1,
    });
    ledger.beginNextGeneration({
      agentId: FIRST_AGENT_ID,
      turnId: 'first-turn-2',
      toolUseId: 'first-tool-2',
      runMode: 'foreground',
      updatedAt: 2,
    });
    activeAgents.add(FIRST_AGENT_ID);
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: FIRST_AGENT_ID,
      generation: 1,
    });
    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
      'first-generation-1-after-resume',
    ]);
    activeAgents.delete(FIRST_AGENT_ID);
    parentActive = false;
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: FIRST_AGENT_ID,
      generation: 2,
    });
    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
      'first-generation-1-after-resume',
    ]);
    parentActive = true;
    await delivery.deliverParentMessages(PARENT_ID);

    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
      'first-generation-1-after-resume',
      'background-message',
    ]);
    // A foreground envelope is bound to the invoking parent Turn. Once that
    // Turn has settled, it is discarded rather than replayed into a later
    // unsolicited root admission.
    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual([]);

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
