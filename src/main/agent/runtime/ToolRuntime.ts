import type { AgentTool, AgentToolResult } from './kernel/types';
import type { TSchema } from 'typebox';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assembleModelToolRegistry,
  canonicalModelToolKey,
  decodeProviderToolName,
  MODEL_TOOL_ACTION_KINDS,
  modelToolContract,
  type ModelToolContract,
  type ModelToolIdentity,
  type ModelToolSchemaContribution,
} from '../../../core/agent/tools';
import type { AgentMutationCausation, JsonValue } from '../../../core/agent/protocol';
import type { DocumentProjection } from '../../../core/types';
import type { AgentImageGenerationRuntime } from '../capabilities/agentImageGenerationTool';
import { AgentImportService, visibleImportServiceResult } from '../capabilities/agentImportService';
import type {
  AgentFileReadImageNormalizer,
  AgentLocalWorkspaceContext,
} from '../capabilities/agentLocalTools';
import type { OutlinerToolHost } from '../capabilities/agentNodeTools';
import type { AgentSkillRuntime } from '../capabilities/agentSkills';
import { evaluateAgentToolCapability } from '../capabilities/agentCapabilities';
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
  readonly filterOutlinerProjection?: (
    projection: DocumentProjection,
    causation: AgentMutationCausation,
  ) => DocumentProjection;
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
          options.filterOutlinerProjection,
        )
      : undefined;
    this.importService = this.outliner ? new AgentImportService(this.outliner) : null;
  }

  async createTools(context: TurnExecutionContext): Promise<readonly AgentTool[]> {
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
      if (!identity) throw new Error(`Runtime model tool has no canonical contract: ${tool.name}`);
      const canonical = canonicalModelToolKey(identity);
      const contract = contracts.get(canonical) ?? modelToolContract(canonical);
      if (!contract) throw new Error(`Runtime model tool has no canonical contract: ${canonical}`);
      if (registry && !sameSchema(tool.parameters, contract.inputSchema)) {
        if (dynamicToolSet.has(tool) || extensionOwners.has(canonical)) {
          unavailableCanonical.add(canonical);
          this.reportUnavailableToolSchema(canonical, 'runtime schema does not match its canonical contract');
          continue;
        }
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
      if (
        !unavailableCanonical.has(canonical)
        && (allowed.has(canonical) || enabledExtensions.has(owner))
        && !enabledCanonical.has(canonical)
      ) {
        throw new Error(`Enabled extension model tool has no runtime implementation: ${canonical}`);
      }
    }
    return [...unique.values()];
  }

  async prepareProviderContext(context: TurnExecutionContext): Promise<void> {
    if (!context.configuration.tools.includes('skill')) return;
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
            observableArgs,
            (await redactSecretLikeJsonAsync(jsonValue(result.details))).value,
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
  filterProjection?: (projection: DocumentProjection, causation: AgentMutationCausation) => DocumentProjection,
): OutlinerToolHost {
  const mutationMeta = (meta: Parameters<OutlinerToolHost['handle']>[2]) => ({
    ...meta,
    ...(causation() ? { causation: causation() } : {}),
  });
  return {
    getProjection: () => {
      const current = causation();
      const projection = host.getProjection();
      return current && filterProjection ? filterProjection(projection, current) : projection;
    },
    getDocumentReadModel: host.getDocumentReadModel && !filterProjection ? () => host.getDocumentReadModel!() : undefined,
    drainTransactionProjectionChanges: host.drainTransactionProjectionChanges
      ? () => host.drainTransactionProjectionChanges!()
      : undefined,
    getTextSearchIndex: host.getTextSearchIndex && !filterProjection ? () => host.getTextSearchIndex!() : undefined,
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
