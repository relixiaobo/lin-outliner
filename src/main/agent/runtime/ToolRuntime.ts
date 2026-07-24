import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assembleModelToolRegistry,
  canonicalModelToolKey,
  decodeProviderToolName,
  modelToolContract,
  type ModelToolContract,
  type ModelToolIdentity,
  type ModelToolSchemaContribution,
} from '../../../core/agent/tools';
import type { AgentMutationCausation, JsonValue } from '../../../core/agent/protocol';
import type { ReasoningEffort } from '../../../core/agent/configuration';
import type { AgentImageGenerationRuntime } from '../capabilities/agentImageGenerationTool';
import { AgentImportService, visibleImportServiceResult } from '../capabilities/agentImportService';
import type { AgentLocalWorkspaceContext } from '../capabilities/agentLocalTools';
import type { OutlinerToolHost } from '../capabilities/agentNodeTools';
import { createUserSkillPrompt, type AgentSkillRuntime } from '../capabilities/agentSkills';
import { evaluateAgentToolCapability } from '../capabilities/agentCapabilities';
import type { AgentCapabilityConfig } from '../capabilities/agentCapabilityRules';
import type { ThreadService } from '../ThreadService';
import type { TurnExecutionContext } from './types';

export interface ToolRuntimeOptions {
  readonly outliner?: OutlinerToolHost;
  readonly localWorkspace?: AgentLocalWorkspaceContext | ((context: TurnExecutionContext) => AgentLocalWorkspaceContext);
  readonly skillRuntime?: AgentSkillRuntime | ((context: TurnExecutionContext) => AgentSkillRuntime);
  readonly imageGeneration?: AgentImageGenerationRuntime | ((context: TurnExecutionContext) => AgentImageGenerationRuntime);
  readonly capabilityTools?: (
    context: TurnExecutionContext,
    outliner: OutlinerToolHost | undefined,
  ) => readonly AgentTool[];
  /** Test/custom host seam; production always assembles the canonical registry. */
  readonly assembleRegistry?: boolean;
  readonly dynamicTools?: (context: TurnExecutionContext) => readonly AgentTool[] | Promise<readonly AgentTool[]>;
  readonly capabilityConfig?: AgentCapabilityConfig | (() => AgentCapabilityConfig | Promise<AgentCapabilityConfig>);
}

export class ToolRuntime {
  private readonly mutationCausation = new AsyncLocalStorage<AgentMutationCausation>();
  private readonly outliner: OutlinerToolHost | undefined;
  private readonly importService: AgentImportService | null;

  constructor(
    private readonly service: ThreadService,
    private readonly options: ToolRuntimeOptions = {},
  ) {
    this.outliner = options.outliner
      ? outlinerWithCausation(options.outliner, () => this.mutationCausation.getStore())
      : undefined;
    this.importService = this.outliner ? new AgentImportService(this.outliner) : null;
  }

  async createTools(context: TurnExecutionContext): Promise<readonly AgentTool[]> {
    const skillRuntime = this.skillRuntime(context);
    const workspace = typeof this.options.localWorkspace === 'function'
      ? this.options.localWorkspace(context)
      : this.options.localWorkspace;
    const imageGeneration = typeof this.options.imageGeneration === 'function'
      ? this.options.imageGeneration(context)
      : this.options.imageGeneration;
    const capabilityTools = this.options.capabilityTools
      ? this.options.capabilityTools(context, this.outliner)
      : (await import('../capabilities/agentTools')).createAgentTools(this.outliner, {
          localFileRoot: context.thread.cwd,
          ...(workspace === undefined ? {} : { localWorkspace: workspace }),
          ...(skillRuntime === undefined ? {} : { skillRuntime }),
          ...(imageGeneration === undefined ? {} : { imageGeneration }),
        });
    const dynamicTools = await this.options.dynamicTools?.(context) ?? [];
    const tools = [
      ...capabilityTools,
      ...(this.importService ? [this.createDataImportTool()] : []),
      ...this.createControlTools(context),
      ...dynamicTools,
    ];
    const extensionContributions = await this.service.extensionToolContributions(context.thread.id);
    const extensionContracts = extensionContributions.flatMap((contribution) => contribution.tools);
    const extensionOwners = new Map<string, string>();
    for (const contribution of extensionContributions) {
      for (const contract of contribution.tools) {
        const key = canonicalModelToolKey(contract.identity);
        if (extensionOwners.has(key)) throw new Error(`Duplicate extension runtime model tool: ${key}`);
        extensionOwners.set(key, contribution.extensionId);
      }
    }
    const shouldAssembleRegistry = this.options.assembleRegistry ?? this.options.capabilityTools === undefined;
    const registry = shouldAssembleRegistry
      ? assembleModelToolRegistry(schemaContributions(tools), extensionContracts)
      : null;
    const contracts = new Map((registry ?? extensionContracts).map((contract) => [
      canonicalModelToolKey(contract.identity),
      contract,
    ]));
    const allowed = new Set(context.configuration.tools);
    const enabledExtensions = new Set([...context.configuration.plugins, ...context.configuration.mcpServers]);
    const unique = new Map<string, AgentTool>();
    const enabledCanonical = new Set<string>();
    for (const tool of tools) {
      const identity = registry
        ? decodeProviderToolName(tool.name, 'flat', registry)
        : identityFromProviderName(tool.name);
      if (!identity) throw new Error(`Runtime model tool has no canonical contract: ${tool.name}`);
      const canonical = canonicalModelToolKey(identity);
      const contract = contracts.get(canonical) ?? modelToolContract(canonical);
      if (!contract) throw new Error(`Runtime model tool has no canonical contract: ${canonical}`);
      if (registry && !sameSchema(tool.parameters, contract.inputSchema)) {
        throw new Error(`Runtime model-tool schema does not match its contract: ${canonical}`);
      }
      const extensionOwner = extensionOwners.get(canonical);
      const enabled = extensionOwner
        ? allowed.has(canonical) || enabledExtensions.has(extensionOwner)
        : allowed.has(canonical);
      if (!enabled) continue;
      if (contract?.scope === 'rootThread' && context.thread.parentThreadId !== null) continue;
      if (unique.has(tool.name)) throw new Error(`Duplicate runtime model tool: ${tool.name}`);
      unique.set(tool.name, this.instrumentTool(context, tool, identity));
      enabledCanonical.add(canonical);
    }
    for (const contract of extensionContracts) {
      const canonical = canonicalModelToolKey(contract.identity);
      const owner = extensionOwners.get(canonical)!;
      if ((allowed.has(canonical) || enabledExtensions.has(owner)) && !enabledCanonical.has(canonical)) {
        throw new Error(`Enabled extension model tool has no runtime implementation: ${canonical}`);
      }
    }
    return [...unique.values()];
  }

  skillListing(context: TurnExecutionContext): Promise<string | null> {
    return this.skillRuntime(context)?.buildSkillListingReminderText() ?? Promise.resolve(null);
  }

  async prepareUserPrompt(context: TurnExecutionContext, prompt: UserMessage): Promise<UserMessage> {
    const input = directSkillInput(context);
    const runtime = this.skillRuntime(context);
    if (!input || !runtime) return prompt;
    const prepared = await createUserSkillPrompt(runtime, input, null, {
      onIsolatedSkillStart: async () => undefined,
    });
    if (!prepared) return prompt;
    const preparedContent = typeof prepared.content === 'string'
      ? [{ type: 'text' as const, text: prepared.content }]
      : prepared.content;
    return {
      ...prepared,
      timestamp: prompt.timestamp,
      content: [...preparedContent, ...additionalContextContent(context)],
    };
  }

  private skillRuntime(context: TurnExecutionContext): AgentSkillRuntime | undefined {
    return typeof this.options.skillRuntime === 'function'
      ? this.options.skillRuntime(context)
      : this.options.skillRuntime;
  }

  private createControlTools(context: TurnExecutionContext): AgentTool[] {
    const threadId = context.thread.id;
    const turnId = context.turn.id;
    return [
      coreTool('request_user_input', 'Request User Input', async (itemId, params, signal) => {
        return this.service.requestUserInput(threadId, turnId, itemId, params, signal);
      }),
      coreTool('update_plan', 'Update Plan', async (_itemId, params) => {
        return this.service.recordPlan(threadId, turnId, params);
      }),
      coreTool('get_goal', 'Get Goal', async () => this.service.getGoalForTurn(threadId, turnId)),
      coreTool('create_goal', 'Create Goal', async (_itemId, params) => {
        const input = record(params, 'create_goal');
        return this.service.createGoalForTurn(
          threadId,
          turnId,
          requiredString(input.objective, 'create_goal.objective'),
          optionalPositiveInteger(input.token_budget, 'create_goal.token_budget'),
        );
      }),
      coreTool('update_goal', 'Update Goal', async (_itemId, params) => {
        const input = record(params, 'update_goal');
        const status = input.status;
        if (status !== 'blocked' && status !== 'complete') {
          throw new Error('update_goal.status must be blocked or complete');
        }
        return this.service.updateGoalForTurn(threadId, turnId, status);
      }),
      collaborationTool('spawn_agent', 'Spawn Subagent', async (itemId, params) => {
        const input = record(params, 'collaboration.spawn_agent');
        const result = await this.service.spawnCollaborationAgent({
          senderThreadId: threadId,
          senderTurnId: turnId,
          parentItemId: itemId,
          taskName: requiredString(input.task_name, 'task_name'),
          message: requiredString(input.message, 'message'),
          ...(optionalString(input.agent_type) === undefined ? {} : { role: optionalString(input.agent_type) }),
          ...(optionalString(input.model) === undefined ? {} : { model: optionalString(input.model) }),
          ...(optionalReasoningEffort(input.reasoning_effort) === undefined
            ? {}
            : { reasoningEffort: optionalReasoningEffort(input.reasoning_effort) }),
          ...(optionalString(input.fork_turns) === undefined ? {} : { forkTurns: optionalString(input.fork_turns) }),
        });
        return {
          task_name: result.taskPath,
          thread_id: result.thread.id,
          nickname: result.thread.agentNickname,
        };
      }),
      collaborationTool('send_message', 'Send Subagent Message', async (_itemId, params) => {
        const input = record(params, 'collaboration.send_message');
        return this.service.sendCollaborationMessage(
          threadId,
          turnId,
          requiredString(input.target, 'target'),
          requiredString(input.message, 'message'),
        );
      }),
      collaborationTool('followup_task', 'Follow Up Subagent', async (itemId, params) => {
        const input = record(params, 'collaboration.followup_task');
        return this.service.followupCollaborationTask(
          threadId,
          turnId,
          itemId,
          requiredString(input.target, 'target'),
          requiredString(input.message, 'message'),
        );
      }),
      collaborationTool('wait_agent', 'Wait for Subagents', async (_itemId, params, signal) => {
        const input = record(params, 'collaboration.wait_agent');
        return this.service.waitForCollaborationActivity(
          threadId,
          turnId,
          optionalNonNegativeNumber(input.timeout_ms, 'timeout_ms'),
          signal,
        );
      }),
      collaborationTool('list_agents', 'List Subagents', async (_itemId, params) => {
        const input = record(params, 'collaboration.list_agents');
        return this.service.listCollaborationAgents(threadId, optionalString(input.path_prefix));
      }),
      collaborationTool('interrupt_agent', 'Interrupt Subagent', async (_itemId, params) => {
        const input = record(params, 'collaboration.interrupt_agent');
        return this.service.interruptCollaborationAgent(
          threadId,
          turnId,
          requiredString(input.target, 'target'),
        );
      }),
    ];
  }

  private createDataImportTool(): AgentTool {
    const service = this.importService!;
    return {
      name: 'data_import',
      label: 'Import Data',
      description: 'Preview or commit a validated Tenon Import Pack into the Outliner.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['operation'],
        properties: {
          operation: { type: 'string', enum: ['preview_file', 'commit_file', 'preview_content', 'commit_content'] },
          pack_file: { type: 'string' },
          pack_content: { type: 'string' },
          pack_label: { type: 'string' },
          parent_id: { type: 'string' },
          preview_id: { type: 'string' },
        },
      } as TSchema,
      executionMode: 'sequential',
      execute: async (_itemId, params) => {
        const input = record(params, 'data_import');
        const operation = requiredString(input.operation, 'data_import.operation');
        const parentId = optionalString(input.parent_id);
        const previewId = optionalString(input.preview_id);
        let result;
        if (operation === 'preview_file') {
          result = await service.previewFromFile({
            packFile: requiredString(input.pack_file, 'pack_file'),
            ...(parentId ? { parentId } : {}),
          });
        } else if (operation === 'commit_file') {
          result = await service.commitFromFile({
            packFile: requiredString(input.pack_file, 'pack_file'),
            ...(parentId ? { parentId } : {}),
            ...(previewId ? { previewId } : {}),
          });
        } else if (operation === 'preview_content') {
          result = await service.previewFromContent({
            packContent: requiredString(input.pack_content, 'pack_content'),
            ...(optionalString(input.pack_label) ? { packLabel: optionalString(input.pack_label) } : {}),
            ...(parentId ? { parentId } : {}),
          });
        } else if (operation === 'commit_content') {
          result = await service.commitFromContent({
            packContent: requiredString(input.pack_content, 'pack_content'),
            ...(optionalString(input.pack_label) ? { packLabel: optionalString(input.pack_label) } : {}),
            ...(parentId ? { parentId } : {}),
            ...(previewId ? { previewId } : {}),
          });
        } else {
          throw new Error(`Unknown data_import operation: ${operation}`);
        }
        return toolResult(visibleImportServiceResult(result));
      },
    };
  }

  private instrumentTool(
    context: TurnExecutionContext,
    tool: AgentTool,
    identity: ModelToolIdentity,
  ): AgentTool {
    return {
      ...tool,
      execute: async (itemId, params, signal, onUpdate) => {
        const args = jsonValue(params);
        await this.service.notifyToolStarted(context.thread.id, context.turn.id, itemId, identity, args);
        const canonicalIdentity = identity.namespace ? `${identity.namespace}.${identity.name}` : identity.name;
        const capability = evaluateAgentToolCapability({
          toolName: canonicalIdentity,
          args,
          policy: {
            workspaceRoot: context.thread.cwd,
            capabilityConfig: await this.capabilityConfig(),
          },
        });
        if (capability.behavior === 'unavailable') {
          const result = toolResult({
            ok: false,
            tool: canonicalIdentity,
            status: 'unavailable',
            error: {
              code: 'operation_unavailable',
              message: capability.reason,
              recoverable: false,
              details: { reason: capability.code },
            },
            instructions: 'This operation is unavailable in the current context. Continue with another available approach.',
            capabilityAudit: capabilityAudit(capability),
          });
          await this.service.notifyToolCompleted(
            context.thread.id,
            context.turn.id,
            itemId,
            identity,
            args,
            jsonValue(result.details),
            capability.reason,
          );
          return result;
        }
        try {
          const rawResult = await this.mutationCausation.run({
            threadId: context.thread.id,
            turnId: context.turn.id,
            itemId,
          }, () => tool.execute(itemId, params, signal, onUpdate));
          const result = withCapabilityAudit(rawResult, capabilityAudit(capability));
          await this.service.notifyToolCompleted(
            context.thread.id,
            context.turn.id,
            itemId,
            identity,
            args,
            jsonValue(result.details),
            null,
          );
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.service.notifyToolCompleted(
            context.thread.id,
            context.turn.id,
            itemId,
            identity,
            args,
            null,
            message,
          );
          throw error;
        }
      },
    };
  }

  private async capabilityConfig(): Promise<AgentCapabilityConfig> {
    const configured = this.options.capabilityConfig;
    if (typeof configured === 'function') return configured();
    if (configured) return configured;
    const { readAgentCapabilityConfig } = await import('../capabilities/agentCapabilityStore');
    return readAgentCapabilityConfig();
  }
}

function directSkillInput(context: TurnExecutionContext): string | null {
  const content = context.turn.items
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => item.content);
  if (content.some((part) => part.type === 'attachment')) return null;
  const text = content.flatMap((part): string[] => {
    if (part.type === 'text') return [part.text];
    if (part.type === 'nodeReference') {
      return [`[Outliner Node ${part.nodeId}]${part.note ? ` ${part.note}` : ''}`];
    }
    return [];
  }).join('\n').trim();
  return text || null;
}

function additionalContextContent(context: TurnExecutionContext): Array<{ type: 'text'; text: string }> {
  if (!context.additionalContext) return [];
  return Object.entries(context.additionalContext).map(([key, entry]) => ({
    type: 'text',
    text: `[${entry.kind} context: ${key}]\n${entry.value}`,
  }));
}

function outlinerWithCausation(
  host: OutlinerToolHost,
  causation: () => AgentMutationCausation | undefined,
): OutlinerToolHost {
  const mutationMeta = (meta: Parameters<OutlinerToolHost['handle']>[2]) => ({
    ...meta,
    ...(causation() ? { causation: causation() } : {}),
  });
  return {
    getProjection: () => host.getProjection(),
    getDocumentReadModel: host.getDocumentReadModel ? () => host.getDocumentReadModel!() : undefined,
    drainTransactionProjectionChanges: host.drainTransactionProjectionChanges
      ? () => host.drainTransactionProjectionChanges!()
      : undefined,
    getTextSearchIndex: host.getTextSearchIndex ? () => host.getTextSearchIndex!() : undefined,
    getTransientSearchOptions: host.getTransientSearchOptions ? () => host.getTransientSearchOptions!() : undefined,
    recordNodeAccess: host.recordNodeAccess
      ? (nodeIds, source) => host.recordNodeAccess!(nodeIds, source)
      : undefined,
    handle: (command, args, meta) => host.handle(command, args, mutationMeta(meta)),
    transaction: host.transaction
      ? (meta, operation) => host.transaction!(mutationMeta(meta), operation)
      : undefined,
    createNodesFromTreeYielding: host.createNodesFromTreeYielding
      ? (parentId, nodes, meta, options) => host.createNodesFromTreeYielding!(
          parentId,
          nodes,
          mutationMeta(meta),
          options,
        )
      : undefined,
    operationHistory: host.operationHistory ? (query) => host.operationHistory!(query) : undefined,
  };
}

function capabilityAudit(capability: ReturnType<typeof evaluateAgentToolCapability>): JsonValue {
  return jsonValue({
    behavior: capability.behavior,
    access: capability.access,
    source: capability.source,
    descriptors: capability.descriptors,
    ...(capability.behavior === 'unavailable' ? { code: capability.code } : {}),
  });
}

function withCapabilityAudit(result: AgentToolResult<unknown>, audit: JsonValue): AgentToolResult<JsonValue> {
  const details = isRecord(result.details)
    ? { ...result.details, capabilityAudit: audit }
    : { result: jsonValue(result.details), capabilityAudit: audit };
  return { ...result, details } as AgentToolResult<JsonValue>;
}

function coreTool(
  name: string,
  label: string,
  execute: (itemId: string, params: unknown, signal?: AbortSignal) => unknown | Promise<unknown>,
): AgentTool {
  const contract = modelToolContract(name);
  if (!contract?.inputSchema) throw new Error(`Missing Core model-tool contract: ${name}`);
  return {
    name,
    label,
    description: contract.description,
    parameters: contract.inputSchema as TSchema,
    executionMode: 'sequential',
    execute: async (itemId, params, signal) => toolResult(await execute(itemId, params, signal)),
  };
}

function collaborationTool(
  name: string,
  label: string,
  execute: (itemId: string, params: unknown, signal?: AbortSignal) => unknown | Promise<unknown>,
): AgentTool {
  const canonical = `collaboration.${name}`;
  const contract = modelToolContract(canonical);
  if (!contract?.inputSchema) throw new Error(`Missing Core model-tool contract: ${canonical}`);
  return {
    name: `collaboration__${name}`,
    label,
    description: contract.description,
    parameters: contract.inputSchema as TSchema,
    executionMode: 'sequential',
    execute: async (itemId, params, signal) => toolResult(await execute(itemId, params, signal)),
  };
}

function toolResult(value: unknown): AgentToolResult<JsonValue> {
  const details = jsonValue(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function identityFromProviderName(name: string): ModelToolIdentity {
  const separator = name.indexOf('__');
  return separator < 0
    ? { namespace: null, name }
    : { namespace: name.slice(0, separator), name: name.slice(separator + 2) };
}

function schemaContributions(tools: readonly AgentTool[]): ModelToolSchemaContribution[] {
  const contributions = new Map<string, ModelToolSchemaContribution>();
  for (const tool of tools) {
    const identity = identityFromProviderName(tool.name);
    const contract = modelToolContract(identity);
    if (!contract || contract.inputSchema !== null) continue;
    if (contract.schemaOwner !== 'capability' && contract.schemaOwner !== 'configuration') continue;
    const canonical = canonicalModelToolKey(identity);
    if (contributions.has(canonical)) throw new Error(`Duplicate runtime model-tool schema: ${canonical}`);
    contributions.set(canonical, {
      identity,
      owner: contract.schemaOwner,
      inputSchema: tool.parameters as Readonly<Record<string, unknown>>,
    });
  }
  return [...contributions.values()];
}

function sameSchema(
  runtime: unknown,
  contract: ModelToolContract['inputSchema'],
): boolean {
  return contract !== null && JSON.stringify(runtime) === JSON.stringify(contract);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`);
  return value as number;
}

function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return value;
}

function optionalReasoningEffort(value: unknown): ReasoningEffort | undefined {
  const normalized = optionalString(value);
  if (!normalized) return undefined;
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)) {
    throw new Error(`Unknown reasoning_effort: ${normalized}`);
  }
  return normalized as ReasoningEffort;
}

function jsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
