import type { TSchema } from 'typebox';
import { modelToolContract } from '../../../core/agent/tools';
import type { JsonValue } from '../../../core/agent/protocol';
import type { AgentTool } from '../runtime/kernel/types';
import { agentToolResult, errorEnvelope, successEnvelope } from '../capabilities/agentToolEnvelope';
import type { ProjectService } from './ProjectService';

export function createProjectTools(service: ProjectService, threadId: string,
  authorize: (name: string, input: unknown, signal?: AbortSignal) => Promise<void>,
): AgentTool[] {
  return (['project_inspect', 'project_manage'] as const).map((name): AgentTool => {
    const contract = modelToolContract(name)!;
    return { name, label: name, description: contract.description, parameters: contract.inputSchema as TSchema,
      executionMode: 'sequential', execute: async (_itemId, input, signal) => {
        await authorize(name, input, signal);
        signal?.throwIfAborted();
        let value: unknown;
        if (name === 'project_inspect') {
          const offset = (input as { offset?: number }).offset ?? 0;
          const view = service.inspect({ threadIds: [threadId] });
          value = { projects: view.projects.slice(offset, offset + 50), memberships: view.memberships,
            totalProjects: view.projects.length, nextOffset: offset + 50 < view.projects.length ? offset + 50 : null };
        } else {
          const result = await service.manage((input as { request: unknown }).request, 'agent', signal);
          if (result.outcome === 'cancelled') return agentToolResult(errorEnvelope(name, 'cancelled', 'The Project proposal was cancelled.',
            { instructions: 'Do not repeat the proposal unless the user requests it again.' }));
          value = { outcome: result.outcome, project: result.project, affectedThreadCount: result.affectedThreadIds.length };
        }
        const data = JSON.parse(JSON.stringify(value)) as JsonValue;
        return agentToolResult(successEnvelope(name, data), data);
      } };
  });
}
