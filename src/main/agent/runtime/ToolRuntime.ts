import { createHash } from 'node:crypto';
import { canonicalDelegateCommand } from '../../../delegate/contract';
import { decodeTaskControlInput } from '../../../core/agent/taskContinuation';
import { decodeRequestUserInputResult } from '../../../core/agent/codec';
import type { TSchema } from 'typebox';
import type { JsonValue } from '../../../core/agent/protocol';
import {
assembleModelToolRegistry,
canonicalModelToolKey,
decodeProviderToolName,
MODEL_TOOL_ACTION_KINDS,
modelToolContract,
normalizeTaskStatusToolInput,
normalizeTaskStopToolInput,
providerToolSchemaFailure,
type ModelToolContract,
type ModelToolIdentity,
type ModelToolSchemaContribution
} from '../../../core/agent/tools';
import { AgentToolFailure } from '../AgentToolFailure';
import { evaluateAgentToolCapability } from '../capabilities/agentCapabilities';
import type { AgentCapabilityConfig } from '../capabilities/agentCapabilityRules';
import type { AgentImageGenerationRuntime } from '../capabilities/agentImageGenerationTool';
import {
type AgentFileReadImageNormalizer,
type AgentLocalWorkspaceContext,
type DelegateCommandRuntime,
} from '../capabilities/agentLocalTools';
import { redactSecretLikeJsonAsync } from '../capabilities/agentSecretRedaction';
import type { AgentSkillRuntime } from '../capabilities/agentSkills';
import { agentToolResult,errorEnvelope,MAX_TENON_RESULT_DATA_BYTES,successEnvelope,type ToolEnvelope } from '../capabilities/agentToolEnvelope';
import { boundJsonString,jsonByteLength } from '../capabilities/agentToolResultBudget';
import {
delegatedBashExecutionAllowed,
delegatedToolContractAllowed,
delegatedToolExecutionAllowed,
type DelegatedToolPolicy,
} from '../delegation/delegatedToolPolicy';
import { revalidateExecutionContext } from '../tasks/ExecutionContext';
import type { ThreadService } from '../ThreadService';
import { compileToolParameters } from './kernel/exactToolArguments';
import { HostToolDenial } from './kernel/HostToolDenial';
import type { AgentTool,AgentToolResult } from './kernel/types';
import { createToolArtifactSink,type ToolArtifactSink } from './ToolArtifactSink';
import type { TurnExecutionContext } from './types';

export type DeferredToolAuthority = (toolName: string, args: unknown, signal?: AbortSignal) => Promise<void>;

export interface ToolRuntimeOptions {
  readonly localWorkspace?: AgentLocalWorkspaceContext | ((context: TurnExecutionContext) => AgentLocalWorkspaceContext);
  readonly imageNormalizer?: AgentFileReadImageNormalizer;
  readonly skillRuntime?: AgentSkillRuntime | (
    (context: TurnExecutionContext) => AgentSkillRuntime | Promise<AgentSkillRuntime>
  );
  readonly imageGeneration?: AgentImageGenerationRuntime | ((context: TurnExecutionContext) => AgentImageGenerationRuntime);
  readonly capabilityTools?: (
    context: TurnExecutionContext,
  ) => readonly AgentTool[];
  /** Test/custom host seam; production always assembles the canonical registry. */
  readonly assembleRegistry?: boolean;
  readonly dynamicTools?: (context: TurnExecutionContext, authorize: DeferredToolAuthority) => readonly AgentTool[] | Promise<readonly AgentTool[]>;
  readonly capabilityConfig?: AgentCapabilityConfig | (() => AgentCapabilityConfig | Promise<AgentCapabilityConfig>);
  readonly delegateCommandRuntime?: (
    context: TurnExecutionContext,
  ) => DelegateCommandRuntime | undefined | Promise<DelegateCommandRuntime | undefined>;
  readonly delegationPolicy?: (threadId: string) => DelegatedToolPolicy | null;
  /** Global configuration blocks applied after the Thread's capability ceiling. */
  readonly disabledTools?: () => readonly string[] | Promise<readonly string[]>;
}

export class ToolRuntime {
  private readonly publishedLocations = new WeakMap<TurnExecutionContext['turn'], string>();
  private readonly reportedUnavailableToolSchemas = new Set<string>();
  private readonly fileContextStates = new WeakMap<TurnExecutionContext['turn'], Set<AgentLocalWorkspaceContext['readFileState']>>();

  constructor(
    private readonly service: ThreadService,
    private readonly options: ToolRuntimeOptions = {},
  ) {}

  async createTools(context: TurnExecutionContext): Promise<readonly AgentTool[]> {
    const artifactSink = createToolArtifactSink(context);
    const toolTaskService = typeof this.service.toolTaskService === 'function'
      ? this.service.toolTaskService()
      : undefined;
    const delegationPolicy = context.thread.threadSource === 'delegation'
      ? this.options.delegationPolicy?.(context.thread.id) ?? null
      : null;
    if (context.thread.threadSource === 'delegation' && !delegationPolicy) {
      throw new Error(`Delegation Session ${context.thread.id} has no persisted tool policy`);
    }
    const skillRuntime = await this.skillRuntime(context);
    const configuredWorkspace = typeof this.options.localWorkspace === 'function'
      ? this.options.localWorkspace(context)
      : this.options.localWorkspace;
    let automationBoundary: AgentLocalWorkspaceContext['writeBoundary'];
    let validateAutomationIsolation: (() => Promise<void>) | undefined;
    if (context.turn.provenance.trigger.kind === 'feature' && context.turn.provenance.trigger.feature === 'automation') {
      const evidence = context.turn.items.find((item) => item.type === 'contextEvidence' && item.kind === 'automationDispatch');
      const snapshot = evidence?.type === 'contextEvidence' ? await context.readContext(evidence.payloadRef) : null;
      if (snapshot?.kind !== 'automationDispatch' || snapshot.automationRunId !== context.turn.provenance.trigger.ref) {
        throw new Error('Automation execution requires its admitted dispatch snapshot');
      }
      if (snapshot.executionContext.policy.isolation !== 'unsandboxed') {
        validateAutomationIsolation = async () => {
          await revalidateExecutionContext(snapshot.sourceContext);
          await revalidateExecutionContext(snapshot.executionContext);
        };
        automationBoundary = {
          root: snapshot.executionContext.address.cwd,
          shellWritablePaths: snapshot.executionContext.policy.writablePaths,
        };
      }
    }
    const workspace = {
      ...(configuredWorkspace ?? { root: this.service.defaultExecutionDirectory(), scratchRoot: this.service.defaultExecutionDirectory(), readFileState: new Map() }),
      threadId: context.thread.id,
      ...(context.thread.threadSource === 'user' && !context.thread.parentThreadId && !context.thread.ephemeral
        ? { resolveProjectDefault: () => this.service.projects.store.executionDefault(context.thread.id) } : {}),
      capability: delegationPolicy?.access === 'read-only' ? 'read-only' as const : 'full-access' as const,
      ...(automationBoundary ? { writeBoundary: automationBoundary } : {}),
      ...(validateAutomationIsolation ? { validateIsolation: validateAutomationIsolation } : {}),
      onTaskAdmitted: async (task: import('../tasks/toolTaskTypes').ToolTaskRecord) => {
        await context.persistContextEvidence({
          schemaVersion: 1, kind: 'taskExecutionContext', taskId: task.taskId,
          sourceTurnId: task.sourceTurnId, sourceItemId: task.sourceItemId, executionContext: task.executionContext,
        }, `Execution context: ${task.executionContext.address.cwd}`);
      },
    };
    const fileStates = this.fileContextStates.get(context.turn) ?? new Set();
    if (!fileStates.has(workspace.readFileState)) {
      workspace.readFileState.clear();
      fileStates.add(workspace.readFileState);
      this.fileContextStates.set(context.turn, fileStates);
    }
    const imageGeneration = typeof this.options.imageGeneration === 'function'
      ? this.options.imageGeneration(context)
      : this.options.imageGeneration;
    const delegateCommandRuntime = await this.options.delegateCommandRuntime?.(context);
    const capabilityTools = this.options.capabilityTools
      ? this.options.capabilityTools(context)
      : (await import('../capabilities/agentTools')).createAgentTools({
          localFileRoot: this.service.defaultExecutionDirectory(),
          ...(workspace === undefined ? {} : { localWorkspace: workspace }),
          ...(this.options.imageNormalizer === undefined ? {} : { imageNormalizer: this.options.imageNormalizer }),
          ...(skillRuntime === undefined ? {} : { skillRuntime }),
          ...(imageGeneration === undefined ? {} : { imageGeneration }),
          artifactSink,
          ...(toolTaskService === undefined ? {} : { toolTaskService }),
          turnId: context.turn.id,
          ...(delegateCommandRuntime === undefined ? {} : { delegateCommandRuntime }),
        });
    const dynamicTools = await this.options.dynamicTools?.(context, (name, args, signal) => this.authorizeDeferredTool(context, name, args, signal)) ?? [];
    const dynamicToolSet = new Set(dynamicTools);
    const tools = [
      ...capabilityTools,
      ...this.createControlTools(context, artifactSink),
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
    const disabledTools = new Set((await this.options.disabledTools?.() ?? []).map((key) => key.trim()).filter(Boolean));
    const allowed = new Set(context.configuration.tools.filter((key) => !disabledTools.has(key)));
    const enabledExtensions = new Set([...context.configuration.plugins, ...context.configuration.mcpServers]);
    const unique = new Map<string, AgentTool>();
    const enabledCanonical = new Set<string>();
    for (const tool of tools) {
      const providerIdentity = identityFromProviderName(tool.name);
      const providerCanonical = canonicalModelToolKey(providerIdentity);
      if (unavailableCanonical.has(providerCanonical)) continue;
      const schemaFailure = this.toolSchemaFailure(tool.parameters);
      if (schemaFailure !== null) {
        // Ownership decides this, not the registration channel: a host-owned
        // schema that cannot be sent is our defect and fails closed even when a
        // `dynamicTools` factory contributed it. Only third-party surface — an
        // extension contract, or a dynamic tool with no canonical contract at
        // all — degrades to a diagnostic so one bad neighbour cannot kill the Turn.
        const schemaOwner = contracts.get(providerCanonical)?.schemaOwner
          ?? modelToolContract(providerCanonical)?.schemaOwner
          ?? null;
        const degradable = schemaOwner === 'extension'
          || (schemaOwner === null && (dynamicToolSet.has(tool) || extensionOwners.has(providerCanonical)));
        if (!degradable) {
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
      if (delegationPolicy && !delegatedToolContractAllowed(contract, delegationPolicy)) continue;
      const extensionOwner = extensionOwners.get(canonical);
      const enabled = extensionOwner
        ? allowed.has(canonical) || enabledExtensions.has(extensionOwner)
        : allowed.has(canonical);
      if (!enabled) continue;
      if (contract?.scope === 'rootThread' && context.thread.parentThreadId !== null) continue;
      if (unique.has(tool.name)) throw new Error(`Duplicate runtime model tool: ${tool.name}`);
      unique.set(tool.name, this.instrumentTool(context, tool, identity, contract, delegationPolicy));
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

  invalidateFileContext(context: TurnExecutionContext): void {
    this.publishedLocations.delete(context.turn);
    // Clear the actual tool closures, not a fresh workspace returned by the Host factory.
    for (const state of this.fileContextStates.get(context.turn) ?? []) state.clear();
  }

  async prepareProviderContext(context: TurnExecutionContext): Promise<void> {
    if (context.thread.threadSource === 'user' && !context.thread.parentThreadId && !context.thread.ephemeral) {
      const view = await this.service.projects.currentContext(context.thread.id).catch(() => null);
      const text = view ? JSON.stringify({ conversation: context.thread.id, membership: view.memberships[0],
        applicationDefault: view.applicationDefault,
        project: view.projects[0] ?? null, unavailableFolders: view.unavailableFolders }) : 'Conversation location is unavailable; inspect it before relying on a default.';
      if (this.publishedLocations.get(context.turn) !== text) {
        const bounded = text.length <= 16_000 ? text : JSON.stringify({
          conversation: context.thread.id, membership: view?.memberships[0],
          project: view?.projects[0] ? { id: view.projects[0].id, revision: view.projects[0].revision, primaryFolder: view.projects[0].primaryFolder } : null,
          applicationDefault: view?.applicationDefault, projectSources: 'Inspect the Project CLI for the complete source-folder list.',
        });
        await context.persistContextEvidence({ schemaVersion: 1, kind: 'additionalContext', threadState: null,
          turnEntries: [{ key: 'conversation-location', source: 'host:conversation-settings', authority: 'application', purpose: 'observation',
            text: `Current Project and default directory (not a task execution receipt): ${bounded}` }] }, 'Conversation Project and primary folder');
        this.publishedLocations.set(context.turn, text);
      }
    }

    if (!context.configuration.tools.includes('skill') || (await this.options.disabledTools?.() ?? []).includes('skill')) return;
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

  private createControlTools(context: TurnExecutionContext, artifactSink: ToolArtifactSink): AgentTool[] {
    const threadId = context.thread.id;
    const turnId = context.turn.id;
    return [
      coreTool('request_user_input', 'Request User Input', async (itemId, params, signal) => {
        return decodeRequestUserInputResult(await this.service.requestUserInput(threadId, turnId, itemId, params, signal));
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
      coreResultTool('task_control', 'Task Control', async (itemId, params) => {
        const input = decodeTaskControlInput(params);
        const tasks = this.service.toolTaskService();
        const receipt = await tasks.control(threadId, { turnId, itemId }, input);
        return toolResult('task_control', { receipt, continuation: tasks.readOwned(input.task_id, threadId)!.continuation });
      }, decodeTaskControlInput),
      coreResultTool('task_status', 'Task Status', async (_itemId, params) => {
        const input = normalizeTaskStatusToolInput(params);
        const toolTasks = typeof this.service.toolTaskService === 'function'
          ? this.service.toolTaskService()
          : null;
        const task = toolTasks?.readOwned(input.task_id, threadId);
        if (!toolTasks || !task) {
          throw new AgentToolFailure(
            'task_not_found',
            `No Tool Task found with ID: ${input.task_id}`,
            'Use a task_id returned by a background-producing tool in this Thread.',
          );
        }
        const observation = await toolTasks.observeOutput(task.taskId, threadId);
        const output = observation ?? await toolTasks.output(task.taskId, threadId);
        const combined = [output?.stdout, output?.stderr].filter(Boolean).join('\n');
        return toolResult('task_status', {
          taskId: task.taskId,
          continuation: task.continuation,
          requestReference: this.service.taskReaderRequest?.(threadId, turnId) ?? null,
          operation: input.operation_id ? task.controlReceipts.find(({ receipt }) => receipt.operationId === input.operation_id)?.receipt ?? null : null,
          isolation: task.isolation,
          cwd: task.executionContext.address.cwd,
          capability: task.executionContext.policy.capability,
          producer: task.producer,
          description: task.description,
          state: task.state,
          progress: task.progress,
          exitCode: task.exitCode,
          signal: task.signal,
          reason: task.outcomeReason,
          error: task.error,
          output: combined || null,
          observedAt: observation?.observedAt ?? null,
          outputTruncated: Boolean(output?.stdoutTruncated || output?.stderrTruncated),
          detailState: task.detailState,
          artifacts: task.artifacts.map((artifact) => ({
            id: artifact.ref.id,
            label: artifact.label,
            fileName: artifact.ref.fileName,
            mimeType: artifact.ref.mimeType,
            byteLength: artifact.ref.byteLength,
          })),
          storagePressure: task.storagePressure,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
        });
      }, normalizeTaskStatusToolInput),
      coreResultTool('task_stop', 'Task Stop', async (_itemId, params) => {
        const input = normalizeTaskStopToolInput(params);
        const taskId = input.task_id;
        const toolTasks = typeof this.service.toolTaskService === 'function'
          ? this.service.toolTaskService()
          : null;
        const toolTask = await toolTasks?.stop(taskId, threadId, turnId, 'agent') ?? null;
        if (toolTask) {
          return toolResult('task_stop', {
            taskId: toolTask.taskId,
            taskType: toolTask.producer,
            state: toolTask.state,
            continuation: toolTask.continuation,
          });
        }
        throw new AgentToolFailure(
          'task_not_found',
          `No task found with ID: ${taskId}`,
          'Use a task ID returned by a background-producing tool in this Thread.',
        );
      }, normalizeTaskStopToolInput),
    ];
  }

  async authorizeHostCliInvocation(execution: import('../delegation/DelegateCapabilityBroker').DelegateCapabilityExecution): Promise<void> {
    const { admission, signal } = execution;
    signal.throwIfAborted();
    const source = this.service.projectInvocationContext(admission.source.rootThreadId, admission.source.sourceTurnId, admission.source.sourceItemId);
    const task = this.service.toolTaskService().store.read(admission.toolTaskId);
    if (!task) throw new Error('Host command authority is no longer available: missing source Task');
    const mismatches: readonly [string, boolean][] = [
      ['owner', task.ownerThreadId !== source.thread.id],
      ['Turn', task.sourceTurnId !== admission.source.sourceTurnId],
      ['command', task.commandDigest !== digestText(canonicalDelegateCommand(admission.command))],
      ['directory', task.cwd !== admission.cwd],
      ['Item', task.sourceItemId !== admission.source.sourceItemId],
      ['producer', task.producer !== 'bash'],
      ['nonce', task.nonce !== admission.toolTaskNonce],
      ['stop', task.stopRequestedAt !== null],
      ['state', !['queued', 'running'].includes(task.state)],
      ['Bash capability', !source.configuration.tools.includes('bash') || (await this.options.disabledTools?.() ?? []).includes('bash')],
    ];
    const mismatch = mismatches.find(([, differs]) => differs);
    if (mismatch) throw new Error(`Host command authority is no longer available: ${mismatch[0]} binding changed`);
    if (admission.command.name === 'schedule'
      && (task.executionContext.policy.capability !== 'full-access'
        || task.executionContext.policy.isolation !== 'unsandboxed')) {
      throw new Error('Scheduling management and cross-task discovery are unavailable in a scoped execution');
    }
    const decision = evaluateAgentToolCapability({ toolName: 'bash',
      args: { command: canonicalDelegateCommand(admission.command), stdin: admission.stdin, cwd: admission.cwd },
      policy: { workspaceRoot: admission.cwd, capabilityConfig: await this.capabilityConfig() } });
    if (decision.behavior === 'unavailable') throw new Error(decision.reason);
    signal.throwIfAborted();
  }

  private async authorizeDeferredTool(context: TurnExecutionContext, name: string, args: unknown, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const contract = modelToolContract(name);
    const turn = this.service.readTurnForHost(context.thread.id, context.turn.id);
    if (!contract || !context.configuration.tools.includes(name)
      || (await this.options.disabledTools?.() ?? []).includes(name)
      || (contract.scope === 'rootThread' && (context.thread.parentThreadId !== null || context.thread.threadSource !== 'user'))
      || !turn || turn.status !== 'inProgress') {
      throw new AgentToolFailure('operation_unavailable', 'This operation is no longer available in the initiating Turn.', 'Inspect the current configuration before retrying.');
    }
    const decision = evaluateAgentToolCapability({ toolName: name, args, policy: {
      workspaceRoot: this.service.defaultExecutionDirectory(), capabilityConfig: await this.capabilityConfig(),
    } });
    if (decision.behavior === 'unavailable') {
      throw new AgentToolFailure('operation_unavailable', decision.reason, 'Respect the current action blocks.');
    }
  }

  private instrumentTool(
    context: TurnExecutionContext,
    tool: AgentTool,
    identity: ModelToolIdentity,
    contract: ModelToolContract,
    delegationPolicy: DelegatedToolPolicy | null,
  ): AgentTool {
    return {
      ...tool,
      canonicalIdentity: identity,
      execute: async (itemId, params, signal, onUpdate, onExecutionStart) => {
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
            workspaceRoot: this.service.defaultExecutionDirectory(),
            capabilityConfig: await this.capabilityConfig(),
          },
        });
        const delegatedPolicyBlocked = delegationPolicy !== null && (canonicalIdentity === 'bash'
          ? !delegatedBashExecutionAllowed(
              delegationPolicy,
              capability.descriptors.map((descriptor) => descriptor.actionKind),
              capability.bashStdinConsumer ?? 'absent',
              params !== null && typeof params === 'object' && !Array.isArray(params)
                && (params as Record<string, unknown>).run_in_background === true,
            )
          : !delegatedToolExecutionAllowed(
              delegationPolicy,
              capability.descriptors.map((descriptor) => descriptor.actionKind),
            ));
        if (capability.behavior === 'unavailable' || delegatedPolicyBlocked) {
          const reason = capability.behavior === 'unavailable'
            ? capability.reason
            : 'This operation is unavailable in the delegated Session capability ceiling.';
          const code = capability.behavior === 'unavailable' ? capability.code : 'delegation_policy_restricted';
          const details: ToolEnvelope<JsonValue> & { readonly capabilityAudit: JsonValue } = {
            ok: false,
            tool: canonicalIdentity,
            version: 1,
            status: 'denied',
            error: {
              code: 'operation_unavailable',
              message: reason,
              recoverable: false,
              details: { reason: code },
            },
            instructions: 'This operation is unavailable in the current context. Continue with another available approach.',
            capabilityAudit: capabilityAudit(capability),
          };
          await this.service.notifyToolCompleted(
            context.thread.id,
            context.turn.id,
            itemId,
            identity,
            observableArgs,
            (await redactSecretLikeJsonAsync(jsonValue(details))).value,
            reason,
          );
          throw new HostToolDenial({
            code: 'operation_unavailable',
            message: reason,
            instructions: details.instructions,
            details: jsonValue(details),
          });
        }
        try {
          if (canonicalIdentity === 'skill') {
            await this.authorizeDeferredTool(context, canonicalIdentity, args, signal);
          }
          const rawResult = await tool.execute(itemId, params, signal, onUpdate, onExecutionStart);
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

function capabilityAudit(
  capability: ReturnType<typeof evaluateAgentToolCapability>,
): JsonValue {
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
    execute: async (itemId, params, signal) => executeExpectedFailure(name, async () => (
      toolResult(name, await execute(itemId, params, signal))
    )),
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
    execute: async (itemId, params, signal) => executeExpectedFailure(name, () => execute(itemId, params, signal)),
  };
}

async function executeExpectedFailure(
  tool: string,
  execute: () => AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>,
): Promise<AgentToolResult<unknown>> {
  try {
    return await execute();
  } catch (error) {
    if (!(error instanceof AgentToolFailure)) throw error;
    return agentToolResult(errorEnvelope(tool, error.code, error.message, {
      instructions: error.instructions,
    }));
  }
}

function toolResult(tool: string, value: unknown): AgentToolResult<unknown> {
  const details = jsonValue(value);
  if (tool === 'update_plan') {
    return agentToolResult(successEnvelope(tool, details));
  }
  if (tool === 'request_user_input' && isRecord(details)) {
    return agentToolResult(successEnvelope(tool, details), {
      outcome: details.outcome,
      deadlineAt: details.deadlineAt,
      hostGeneration: details.hostGeneration,
      threadId: details.threadId,
      turnId: details.turnId,
      itemId: details.itemId,
      ...(details.outcome === 'answered' || details.outcome === 'discussed'
        ? { answers: details.answers, intent: details.intent, ...(details.messageItemId ? { messageItemId: details.messageItemId } : {}) } : {}),
    });
  }
  if (tool === 'task_stop' && isRecord(details)) {
    const taskId = typeof details.task_id === 'string' ? details.task_id : details.taskId;
    const taskType = typeof details.task_type === 'string' ? details.task_type : details.taskType;
    return agentToolResult(successEnvelope(tool, details), {
      taskId,
      taskType,
      state: typeof details.state === 'string' ? details.state : 'stopped',
      ...(details.continuation ? { continuation: details.continuation } : {}),
    });
  }
  if (tool === 'task_status' && isRecord(details)) {
    const terminal = details.state !== 'running' && details.state !== 'settling';
    const visible = {
      taskId: details.taskId,
      ...(details.continuation ? { continuation: details.continuation } : {}),
      operation: details.operation ?? null,
      requestReference: details.requestReference ?? null,
      state: details.state,
      progress: details.progress && isRecord(details.progress) ? {
        phase: details.progress.phase ?? null,
        message: details.progress.message ?? null,
        fraction: details.progress.fraction ?? null,
      } : null,
      observation: !terminal && typeof details.observedAt === 'number' ? {
        observedAt: details.observedAt,
        output: null as string | null,
        outputTruncated: Boolean(details.outputTruncated),
      } : null,
      result: terminal ? {
        exitCode: details.exitCode ?? null,
        signal: details.signal ?? null,
        reason: details.reason ?? null,
        error: details.error ?? null,
        output: null as string | null,
        outputTruncated: Boolean(details.outputTruncated),
        detailState: details.detailState,
        artifacts: Array.isArray(details.artifacts) ? details.artifacts : [],
        storagePressure: details.storagePressure ?? null,
      } : null,
    };
    const capture = visible.result ?? visible.observation;
    if (capture && typeof details.output === 'string') {
      const remaining = MAX_TENON_RESULT_DATA_BYTES - jsonByteLength(visible) + 4;
      capture.output = boundJsonString(details.output, Math.max(2, remaining));
      capture.outputTruncated ||= capture.output !== details.output;
    }
    return agentToolResult(successEnvelope(tool, details, {
      instructions: details.state === 'running' || details.state === 'settling'
        ? 'This observation is not readiness proof. Verify a service with a completed endpoint, Runtime or application check, then commit task_control handoff before reporting it available. Handoff retains any explicit watch. Avoid repetitive polling.'
        : 'Use task_control acknowledge with the exact pending event before reporting a result in this Turn. An existing handler or silent disposition grants no new work. Exit facts and logs do not establish who closed a process or authorize a restart.',
    }), visible);
  }
  return agentToolResult(successEnvelope(tool, details), details);
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

function arrayOfRecords(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => record(entry, `${path}[${index}]`));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
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

function digestText(value: string): string { return createHash('sha256').update(value).digest('hex'); }
