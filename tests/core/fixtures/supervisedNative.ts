import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../../src/main/agent/persistence/sqlite';
import { ToolTaskStore } from '../../../src/main/agent/tasks/ToolTaskStore';
import { ToolTaskService } from '../../../src/main/agent/tasks/ToolTaskService';
import { pendingExecutionContext, resolveExecutionAddress } from '../../../src/main/agent/tasks/ExecutionContext';
import { nativeAgentProcessExecutor } from '../../../src/main/agent/delegation/NativeAgentProcess';

export function supervisedNativeProcess(root: string) {
  return async (input: Parameters<ReturnType<typeof nativeAgentProcessExecutor>>[0]) => {
    const database = new Database(':memory:');
    const service = new ToolTaskService(new ToolTaskStore(database as unknown as SqliteDatabase), join(root, 'tasks'));
    service.bindHost({ ownerExists: () => true, canInheritExecution: () => true,
      readDeliveryAdmission: async () => null, startCompletionTurn: async () => false, taskChanged: () => undefined });
    await service.initialize();
    const signal = new AbortController().signal;
    const executionContext = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root }), {
      capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
    });
    let owner: Parameters<typeof nativeAgentProcessExecutor>[1];
    try {
      return await service.runHostOperation({
        ownerThreadId: '01bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', sourceTurnId: '01dddddd-dddd-7ddd-8ddd-dddddddddddd',
        sourceItemId: 'native-test', producer: 'delegate_execution', executionContext,
        onAdmitted: async (task) => { owner = task; },
        execute: async () => {
          const result = await nativeAgentProcessExecutor(service, owner!, signal, async () => undefined)(input);
          return { result, success: result.outcome === 'succeeded' };
        },
      });
    } finally {
      await service.close(2_000);
      database.close(false);
    }
  };
}
