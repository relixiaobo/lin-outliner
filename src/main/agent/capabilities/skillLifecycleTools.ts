import type { AgentTool } from '../runtime/kernel/types';
import type { TSchema } from 'typebox';
import { modelToolContract } from '../../../core/agent/tools';
import type { SkillLifecycle, SkillOperationCaller } from '../../hostDomain/skillLifecycle';
import { ManagedSkillServiceError, managedSkillErrorView } from '../../managedSkillService';
import { ManagedSkillNetworkError } from '../../managedSkillGitHub';
import { ManagedSkillValidationError } from '../../managedSkillValidation';
import { AgentToolFailure } from '../AgentToolFailure';
import { MAX_TENON_RESULT_DATA_BYTES, agentToolResult, errorEnvelope, successEnvelope } from './agentToolEnvelope';

export function createSkillLifecycleTools(lifecycle: SkillLifecycle, caller: (itemId: string, signal?: AbortSignal) => SkillOperationCaller): AgentTool[] {
  return (['skill_inspect', 'skill_manage'] as const).map((name): AgentTool => {
    const contract = modelToolContract(name)!;
    return {
      name, label: name === 'skill_inspect' ? 'Inspect Skills' : 'Manage Skill',
      description: contract.description, parameters: contract.inputSchema as TSchema,
      executionMode: 'sequential',
      execute: async (itemId, input, signal) => {
        signal?.throwIfAborted();
        try {
          const result = await lifecycle[name === 'skill_inspect' ? 'inspect' : 'manage'](input, caller(itemId, signal));
          if (Buffer.byteLength(JSON.stringify(result)) > MAX_TENON_RESULT_DATA_BYTES) {
            throw new AgentToolFailure('result_too_large', 'The Skill result exceeds the model output ceiling.', 'Inspect a narrower target. Do not repeat a committed operation.');
          }
          return agentToolResult(successEnvelope(name, result), result);
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof AgentToolFailure) return agentToolResult(errorEnvelope(name, error.code, error.message, { instructions: error.instructions }));
          if (error instanceof ManagedSkillServiceError || error instanceof ManagedSkillNetworkError || error instanceof ManagedSkillValidationError) {
            return agentToolResult(errorEnvelope(name, managedSkillErrorView(error).code, error.message));
          }
          throw error;
        }
      },
    };
  });
}
