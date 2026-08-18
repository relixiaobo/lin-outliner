import type { AgentTool, AgentToolResult } from './kernel/types';
import type { TSchema } from 'typebox';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assembleModelToolRegistry,
  canonicalModelToolKey,
  decodeProviderToolName,
  MODEL_TOOL_CATALOG,
  MODEL_TOOL_ACTION_KINDS,
  modelToolContract,
  normalizeTaskStopToolInput,
  providerToolSchemaFailure,
  type ModelToolContract,
  type ModelToolIdentity,
  type ModelToolSchemaContribution,
} from '../../../core/agent/tools';
import type { AgentMutationCausation, JsonValue } from '../../../core/agent/protocol';
import type { AgentImageGenerationRuntime } from '../capabilities/agentImageGenerationTool';
import { AgentImportService, visibleImportServiceResult } from '../capabilities/agentImportService';
import {
  hasBackgroundShellTask,
  stopBackgroundShellTaskResult,
  type AgentFileReadImageNormalizer,
  type AgentLocalWorkspaceContext,
} from '../capabilities/agentLocalTools';
import type { OutlinerToolHost } from '../capabilities/agentNodeTools';
import type { OutlinerProjectionFilter } from '../capabilities/agentNodeToolTypes';
import type { AgentSkillRuntime } from '../capabilities/agentSkills';
import { evaluateAgentToolCapability } from '../capabilities/agentCapabilities';
import {
  resolveSubagentToolRequest,
  subagentBashExecutionAllowed,
  subagentToolExecutionAllowed,
  subagentToolAllowed,
  type PersistedSubagentToolPolicy,
} from '../capabilities/subagentToolPolicy';
import { redactSecretLikeJsonAsync } from '../capabilities/agentSecretRedaction';
import type { AgentCapabilityConfig } from '../capabilities/agentCapabilityRules';
import type { ThreadService } from '../ThreadService';
import type { TurnExecutionContext } from './types';
import { compileToolParameters } from './kernel/exactToolArguments';

const DATA_IMPORT_PARAMETERS = {
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
} as TSchema;

export interface ToolRuntimeOptions {
  readonly outliner?: OutlinerToolHost;
  readonly localWorkspace?: AgentLocalWorkspaceContext | ((context: TurnExecutionContext) => AgentLocalWorkspaceContext);
  readonly imageNormalizer?: AgentFileReadImageNormalizer;
  readonly skillRuntime?: AgentSkillRuntime | (
    (context: TurnExecutionContext) => AgentSkillRuntime | Promise<AgentSkillRuntime>
  );
  readonly imageGeneration?: AgentImageGenerationRuntime | ((context: TurnExecutionContext) => AgentImageGenerationRuntime);
  readonly capabilityTools?: (
    context: TurnExecutionContext,
    outliner: OutlinerToolHost | undefined,
  ) => readonly AgentTool[];
  /** Test/custom host seam; production always assembles the canonical registry. */
  readonly assembleRegistry?: boolean;
  readonly dynamicTools?: (context: TurnExecutionContext) => readonly AgentTool[] | Promise<readonly AgentTool[]>;
  readonly capabilityConfig?: AgentCapabilityConfig | (() => AgentCapabilityConfig | Promise<AgentCapabilityConfig>);
  readonly outlinerProjectionFilter?: OutlinerProjectionFilter;
}

export class ToolRuntime {
  private readonly mutationCausation = new AsyncLocalStorage<AgentMutationCausation>();
  private readonly reportedUnavailableToolSchemas = new Set<string>();
  private readonly outliner: OutlinerToolHost | undefined;
  private readonly importService: AgentImportService | null;

  constructor(
    private readonly service: ThreadService,
    private readonly options: ToolRuntimeOptions = {},
  ) {
    this.outliner = options.outliner
      ? outlinerWithCausation(
          options.outliner,
          () => this.mutationCausation.getStore(),
          options.outlinerProjectionFilter,
        )
      : undefined;
    this.importService = this.outliner ? new AgentImportService(this.outliner) : null;
  }

  async createTools(context: TurnExecutionContext): Promise<readonly AgentTool[]> {
    const subagentPolicy = this.subagentPolicy(context);
    const skillRuntime = await this.skillRuntime(context);
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
          ...(this.options.imageNormalizer === undefined ? {} : { imageNormalizer: this.options.imageNormalizer }),
          ...(skillRuntime === undefined ? {} : { skillRuntime }),
          ...(imageGeneration === undefined ? {} : { imageGeneration }),
        });
    const dynamicTools = await this.options.dynamicTools?.(context) ?? [];
    const collaborationTools = await this.service.collaborationToolContributions({
      threadId: context.thread.id,
      turnId: context.turn.id,
    });
    const dynamicToolSet = new Set(dynamicTools);
    const tools = [
      ...capabilityTools,
      ...(this.importService ? [this.createDataImportTool()] : []),
      ...this.createControlTools(context),
      ...collaborationTools,
      ...dynamicTools,
    ];
    const extensionContributions = await this.service.extensionToolContributions(context.thread.id);
    const extensionOwners = new Map<string, string>();
    for (const contribution of extensionContributions) {
      for (const contract of contribution.tools) {
        const key = assertExtensionContractStructure(contract);
        if (extensionOwners.has(key)) throw new Error(`Duplicate extension runtime model tool: ${key}`);
        extensionOwners.set(key, contribution.extensionId);
      }
    }
    const unavailableCanonical = new Set<string>();
    const extensionContracts = extensionContributions.flatMap((contribution) => (
      contribution.tools.filter((contract) => {
        const canonical = canonicalModelToolKey(contract.identity);
        const schemaFailure = this.toolSchemaFailure(contract.inputSchema);
        if (schemaFailure === null) return true;
        unavailableCanonical.add(canonical);
        this.reportUnavailableToolSchema(canonical, schemaFailure);
        return false;
      })
    ));
    const shouldAssembleRegistry = this.options.assembleRegistry ?? this.options.capabilityTools === undefined;
    const registry = shouldAssembleRegistry
      ? assembleModelToolRegistry(schemaContributions(tools), extensionContracts)
      : null;
    const contracts = new Map((registry ?? extensionContracts).map((contract) => [
      canonicalModelToolKey(contract.identity),
      contract,
    ]));
    const policyRegistry = registry ?? [...MODEL_TOOL_CATALOG, ...extensionContracts];
    const requestedTools = subagentPolicy
      ? resolveSubagentToolRequest(subagentPolicy.requestedTools, policyRegistry)
      : null;
    const requestedSet = requestedTools?.requestedTools === null
      ? null
      : requestedTools
        ? new Set(requestedTools.recognizedTools)
        : null;
    if (subagentPolicy && requestedTools && requestedTools.unrecognizedTools.length > 0) {
      this.reportSubagentToolDiagnostic(
        context,
        `Ignoring unrecognized Role tools: [${requestedTools.unrecognizedTools.join(', ')}]`,
      );
    }
    const allowed = new Set(context.configuration.tools);
    const enabledExtensions = new Set([...context.configuration.plugins, ...context.configuration.mcpServers]);
    const unique = new Map<string, AgentTool>();
    const enabledCanonical = new Set<string>();
    for (const tool of tools) {
      const providerIdentity = identityFromProviderName(tool.name);
      const providerCanonical = canonicalModelToolKey(providerIdentity);
      if (unavailableCanonical.has(providerCanonical)) continue;
      const schemaFailure = this.toolSchemaFailure(tool.parameters);
      if (schemaFailure !== null) {
        if (!dynamicToolSet.has(tool) && !extensionOwners.has(providerCanonical)) {
          throw new Error(`Runtime model-tool schema is invalid: ${providerCanonical}: ${schemaFailure}`);
        }
        unavailableCanonical.add(providerCanonical);
        this.reportUnavailableToolSchema(providerCanonical, schemaFailure);
        continue;
      }
      const identity = registry
        ? decodeProviderToolName(tool.name, 'flat', registry)
        : providerIdentity;
      if (!identity) {
        if (subagentPolicy && dynamicToolSet.has(tool)) {
          this.reportSubagentToolDiagnostic(
            context,
            `Skipping dynamic model tool without a canonical contract: ${tool.name}`,
          );
          continue;
        }
        throw new Error(`Runtime model tool has no canonical contract: ${tool.name}`);
      }
      const canonical = canonicalModelToolKey(identity);
      const contract = contracts.get(canonical) ?? modelToolContract(canonical);
      if (!contract) {
        if (subagentPolicy && dynamicToolSet.has(tool)) {
          this.reportSubagentToolDiagnostic(
            context,
            `Skipping dynamic model tool without a canonical contract: ${canonical}`,
          );
          continue;
        }
        throw new Error(`Runtime model tool has no canonical contract: ${canonical}`);
      }
      if (registry && !sameSchema(tool.parameters, contract.inputSchema)) {
        if (dynamicToolSet.has(tool) || extensionOwners.has(canonical)) {
          unavailableCanonical.add(canonical);
          this.reportUnavailableToolSchema(canonical, 'runtime schema does not match its canonical contract');
          continue;
        }
        throw new Error(`Runtime model-tool schema does not match its contract: ${canonical}`);
      }
      if (subagentPolicy && !subagentToolAllowed(contract, subagentPolicy)) continue;
      if (requestedSet !== null && !requestedSet.has(canonical)) continue;
      const extensionOwner = extensionOwners.get(canonical);
      const enabled = extensionOwner
        ? allowed.has(canonical) || enabledExtensions.has(extensionOwner)
        : allowed.has(canonical);
      if (!enabled) continue;
      if (contract?.scope === 'rootThread' && context.thread.parentThreadId !== null) continue;
      if (unique.has(tool.name)) throw new Error(`Duplicate runtime model tool: ${tool.name}`);
      unique.set(tool.name, this.instrumentTool(context, tool, identity, contract));
      enabledCanonical.add(canonical);
    }
    for (const contract of extensionContracts) {
      const canonical = canonicalModelToolKey(contract.identity);
      const owner = extensionOwners.get(canonical)!;
      if (
        !unavailableCanonical.has(canonical)
        && (!subagentPolicy || subagentToolAllowed(contract, subagentPolicy))
        && (requestedSet === null || requestedSet.has(canonical))
        && (allowed.has(canonical) || enabledExtensions.has(owner))
        && !enabledCanonical.has(canonical)
      ) {
        if (subagentPolicy) {
          // A child must not lose its whole turn because an optional extension
          // failed to contribute its runtime handler. The requested-tool
          // admission check below still rejects a Role that resolves to zero.
          this.reportSubagentToolDiagnostic(
            context,
            `Skipping extension model tool without a runtime implementation: ${canonical}`,
          );
          continue;
        }
        throw new Error(`Enabled extension model tool has no runtime implementation: ${canonical}`);
      }
    }
    if (
      subagentPolicy
      && requestedTools
      && requestedTools.requestedTools !== null
      // An isolated Skill with an empty requested ceiling intentionally runs
      // tool-free. Authoring omission is normalized to this empty array before
      // spawn; every model-addressable Agent Role must instead admit a real tool.
      && (requestedTools.requestedTools.length > 0 || this.subagentType(context) !== 'isolated-skill')
    ) {
      const admittedRequested = requestedTools.recognizedTools.filter((key) => enabledCanonical.has(key));
      if (admittedRequested.length === 0) {
        const canonicalType = this.subagentType(context);
        const unavailableRecognized = requestedTools.recognizedTools.filter((key) => !enabledCanonical.has(key));
        const reasons = [
          ...(requestedTools.unrecognizedTools.length === 0
            ? []
            : [`unrecognized [${requestedTools.unrecognizedTools.join(', ')}]`]),
          ...(unavailableRecognized.length === 0
            ? []
            : [`not available under this Agent policy [${unavailableRecognized.join(', ')}]`]),
        ];
        throw new Error(
          `Agent '${canonicalType}' would be spawned with zero tools — refusing. `
          + `Its tools list resolved to nothing: ${reasons.join('; ') || 'no admitted tools'}. `
          + `Fix the Role's tools configuration or pass a different subagent_type.`,
        );
      }
    }
    return [...unique.values()];
  }

  async prepareProviderContext(context: TurnExecutionContext): Promise<void> {
    const subagentPolicy = this.subagentPolicy(context);
    if (!context.configuration.tools.includes('skill')) return;
    if (subagentPolicy && (subagentPolicy.kind === 'explore' || subagentPolicy.kind === 'plan')) {
      // Specialized children intentionally have no Skill catalog in either
      // their startup evidence or later provider-context refreshes.
      return;
    }
    const runtime = await this.skillRuntime(context);
    const checkpoint = runtime?.catalogRefreshCheckpoint() ?? null;
    if (!runtime || checkpoint === null) return;
    const snapshot = await runtime.buildSkillCatalogSnapshot();
    await context.persistSkillCatalog(snapshot);
    runtime.acknowledgeCatalogRefresh(checkpoint);
  }

  private async skillRuntime(context: TurnExecutionContext): Promise<AgentSkillRuntime | undefined> {
    return typeof this.options.skillRuntime === 'function'
      ? this.options.skillRuntime(context)
      : this.options.skillRuntime;
  }

  private subagentPolicy(context: TurnExecutionContext): PersistedSubagentToolPolicy | null {
    if (context.thread.parentThreadId === null) return null;
    const execution = this.service.subagentExecution(context.thread.id);
    if (!execution) {
      throw new Error(`Delegated Agent ${context.thread.id} has no execution record`);
    }
    if (execution.initialAdmissionState !== 'committed') {
      throw new Error(`Delegated Agent ${context.thread.id} initial admission is not committed`);
    }
    if (!execution.toolPolicy) {
      throw new Error(`Delegated Agent ${context.thread.id} has no persisted tool policy`);
    }
    return execution.toolPolicy;
  }

  private subagentType(context: TurnExecutionContext): string {
    const host = this.service as unknown as {
      subagentExecution?: (threadId: string) => { readonly agentType?: string } | null;
    };
    return host.subagentExecution?.(context.thread.id)?.agentType
      ?? context.thread.agentRole
      ?? 'general-purpose';
  }

  private reportSubagentToolDiagnostic(context: TurnExecutionContext, message: string): void {
    const key = `${context.thread.id}:${message}`;
    if (this.reportedUnavailableToolSchemas.has(key)) return;
    this.reportedUnavailableToolSchemas.add(key);
    console.warn(`[agent] ${message}.`);
  }

  private createControlTools(context: TurnExecutionContext): AgentTool[] {
    const threadId = context.thread.id;
    const turnId = context.turn.id;
    return [
      coreTool('request_user_input', 'Request User Input', async (itemId, params, signal) => {
        return this.service.requestUserInput(threadId, turnId, itemId, params, signal);
      }),
      coreTool('update_plan', 'Update Plan', async (_itemId, params) => {
        return this.service.updateTurnPlan(threadId, turnId, params);
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
      coreResultTool('task_stop', 'Task Stop', async (_itemId, params) => {
        const input = normalizeTaskStopToolInput(params);
        const taskId = input.task_id!;
        const shellOwnsTask = hasBackgroundShellTask(taskId, threadId);
        const agentOwnsTask = this.service.hasAgentTask(threadId, taskId);
        if (agentOwnsTask && shellOwnsTask) {
          throw new Error(`Task ID is ambiguous between an Agent and shell task: ${taskId}`);
        }
        const agent = await this.service.stopAgentTask(threadId, turnId, taskId);
        if (agent !== null) return toolResult(agent);
        const shell = await stopBackgroundShellTaskResult(taskId, threadId);
        if (shell !== null) return shell;
        throw new Error(`No task found with ID: ${taskId}`);
      }, normalizeTaskStopToolInput),
    ];
  }

  private createDataImportTool(): AgentTool {
    const service = this.importService!;
    return {
      name: 'data_import',
      label: 'Import Data',
      description: 'Preview or commit a validated Tenon Import Pack into the Outliner.',
      parameters: DATA_IMPORT_PARAMETERS,
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
    contract: ModelToolContract,
  ): AgentTool {
    return {
      ...tool,
      canonicalIdentity: identity,
      execute: async (itemId, params, signal, onUpdate) => {
        const args = jsonValue(params);
        const observableArgs = (await redactSecretLikeJsonAsync(args)).value;
        await this.service.notifyToolStarted(
          context.thread.id,
          context.turn.id,
          itemId,
          identity,
          observableArgs,
        );
        const canonicalIdentity = identity.namespace ? `${identity.namespace}.${identity.name}` : identity.name;
        const capability = evaluateAgentToolCapability({
          toolName: canonicalIdentity,
          args,
          ...(contract.schemaOwner === 'extension' ? { actionKinds: contract.actionKinds } : {}),
          policy: {
            workspaceRoot: context.thread.cwd,
            capabilityConfig: await this.capabilityConfig(),
          },
        });
        let activeSubagentPolicy: PersistedSubagentToolPolicy;
        if (context.thread.parentThreadId === null) {
          activeSubagentPolicy = ROOT_SUBAGENT_POLICY;
        } else {
          const persistedPolicy = this.subagentPolicy(context);
          if (!persistedPolicy) {
            throw new Error(`Delegated Agent ${context.thread.id} has no persisted tool policy`);
          }
          activeSubagentPolicy = persistedPolicy;
        }
        const specializedBashBlocked = canonicalIdentity === 'bash'
          && !subagentBashExecutionAllowed(
            activeSubagentPolicy,
            capability.descriptors.map((descriptor) => descriptor.actionKind),
          );
        const specializedMutationBlocked = contract.schemaOwner === 'extension'
          && !subagentToolExecutionAllowed(
            activeSubagentPolicy,
            capability.descriptors.map((descriptor) => descriptor.actionKind),
          );
        const worktreeImportCommitBlocked = canonicalIdentity === 'data_import'
          && activeSubagentPolicy.worktree
          && isDataImportCommit(args);
        const specializedPolicyBlocked = specializedBashBlocked || specializedMutationBlocked || worktreeImportCommitBlocked;
        if (capability.behavior === 'unavailable' || specializedPolicyBlocked) {
          const reason = capability.behavior === 'unavailable'
            ? capability.reason
            : specializedBashBlocked
              ? 'Explore and Plan Agents may use Bash only for repository inspection.'
              : worktreeImportCommitBlocked
                ? 'Worktree Agents may preview import packs but cannot commit them to the live outline.'
                : 'Explore and Plan Agents cannot execute repository mutations.';
          const code = capability.behavior === 'unavailable'
            ? capability.code
            : 'subagent_repository_mutation_restricted';
          const result = toolResult({
            ok: false,
            tool: canonicalIdentity,
            status: 'unavailable',
            error: {
              code: 'operation_unavailable',
              message: reason,
              recoverable: false,
              details: { reason: code },
            },
            instructions: 'This operation is unavailable in the current context. Continue with another available approach.',
            capabilityAudit: capabilityAudit(capability, specializedPolicyBlocked),
          });
          await this.service.notifyToolCompleted(
            context.thread.id,
            context.turn.id,
            itemId,
            identity,
            observableArgs,
            (await redactSecretLikeJsonAsync(jsonValue(result.details))).value,
            reason,
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
            observableArgs,
            (await redactSecretLikeJsonAsync(jsonValue(result.details))).value,
            null,
          );
          return result;
        } catch (error) {
          const message = (await redactSecretLikeJsonAsync(
            error instanceof Error ? error.message : String(error),
          )).value;
          await this.service.notifyToolCompleted(
            context.thread.id,
            context.turn.id,
            itemId,
            identity,
            observableArgs,
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

  private toolSchemaFailure(schema: unknown): string | null {
    const unsendable = providerToolSchemaFailure(schema);
    if (unsendable !== null) return `invalid schema (${boundedDiagnostic(unsendable, 240)})`;
    try {
      compileToolParameters(schema as TSchema);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `invalid schema (${boundedDiagnostic(message, 240)})`;
    }
  }

  private reportUnavailableToolSchema(canonical: string, reason: string): void {
    if (this.reportedUnavailableToolSchemas.has(canonical)) return;
    this.reportedUnavailableToolSchemas.add(canonical);
    console.warn(
      `[agent] Skipping model tool "${boundedDiagnostic(canonical, 120)}": ${boundedDiagnostic(reason, 240)}.`,
    );
  }
}

function outlinerWithCausation(
  host: OutlinerToolHost,
  causation: () => AgentMutationCausation | undefined,
  projectionFilter?: OutlinerProjectionFilter,
): OutlinerToolHost {
  const mutationMeta = (meta: Parameters<OutlinerToolHost['handle']>[2]) => ({
    ...meta,
    ...(causation() ? { causation: causation() } : {}),
  });
  return {
    getProjection: () => {
      const current = causation();
      const projection = host.getProjection();
      return current && projectionFilter
        ? projectionFilter.filterProjection(projection, current)
        : projection;
    },
    getDocumentReadModel: host.getDocumentReadModel ? () => {
      const current = causation();
      const readModel = host.getDocumentReadModel!();
      if (!current || !projectionFilter) return readModel;
      return {
        asProjectionIndex: () => projectionFilter.filterProjectionIndex(readModel.asProjectionIndex(), current),
      };
    } : undefined,
    drainTransactionProjectionChanges: host.drainTransactionProjectionChanges
      ? () => host.drainTransactionProjectionChanges!()
      : undefined,
    getTextSearchIndex: host.getTextSearchIndex ? () => {
      const current = causation();
      const index = host.getTextSearchIndex!();
      return current && projectionFilter
        ? projectionFilter.filterTextSearchIndex(index, current)
        : index;
    } : undefined,
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
    operationHistory: host.operationHistory
      ? (query, meta) => host.operationHistory!(query, mutationMeta(meta))
      : undefined,
  };
}

const ROOT_SUBAGENT_POLICY: PersistedSubagentToolPolicy = {
  kind: 'general-purpose',
  runInBackground: false,
  worktree: false,
  allowNesting: true,
  requestedTools: null,
};

function capabilityAudit(
  capability: ReturnType<typeof evaluateAgentToolCapability>,
  specializedPolicyBlocked = false,
): JsonValue {
  return jsonValue({
    behavior: specializedPolicyBlocked ? 'unavailable' : capability.behavior,
    access: capability.access,
    source: specializedPolicyBlocked ? 'subagent_policy' : capability.source,
    descriptors: capability.descriptors,
    ...(specializedPolicyBlocked
      ? { code: 'subagent_repository_mutation_restricted' }
      : capability.behavior === 'unavailable'
        ? { code: capability.code }
        : {}),
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
  prepareArguments?: (value: unknown) => unknown,
): AgentTool {
  const contract = modelToolContract(name);
  if (!contract?.inputSchema) throw new Error(`Missing Core model-tool contract: ${name}`);
  return {
    name,
    label,
    description: contract.description,
    parameters: contract.inputSchema as TSchema,
    ...(prepareArguments === undefined ? {} : { prepareArguments }),
    executionMode: 'sequential',
    execute: async (itemId, params, signal) => toolResult(await execute(itemId, params, signal)),
  };
}

function coreResultTool(
  name: string,
  label: string,
  execute: (itemId: string, params: unknown, signal?: AbortSignal) => AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>,
  prepareArguments?: (value: unknown) => unknown,
): AgentTool {
  const contract = modelToolContract(name);
  if (!contract?.inputSchema) throw new Error(`Missing Core model-tool contract: ${name}`);
  return {
    name,
    label,
    description: contract.description,
    parameters: contract.inputSchema as TSchema,
    ...(prepareArguments === undefined ? {} : { prepareArguments }),
    executionMode: 'sequential',
    execute: async (itemId, params, signal) => await execute(itemId, params, signal),
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

function isDataImportCommit(args: JsonValue): boolean {
  if (!isRecord(args)) return false;
  return args.operation === 'commit_file' || args.operation === 'commit_content';
}

function assertExtensionContractStructure(contract: ModelToolContract): string {
  const canonical = canonicalModelToolKey(contract.identity);
  if (contract.schemaOwner !== 'extension') {
    throw new Error(`Extension model tool must be owned by extension: ${canonical}`);
  }
  if (modelToolContract(canonical)) throw new Error(`Duplicate canonical model tool: ${canonical}`);
  for (const kind of contract.actionKinds) {
    if (!(MODEL_TOOL_ACTION_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Unsupported action kind for ${canonical}: ${kind}`);
    }
  }
  return canonical;
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

function boundedDiagnostic(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 3)}...`;
}
