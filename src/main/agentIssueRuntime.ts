import type {
  AgentOperationScope,
  AgentSession,
  AgentSessionSource,
  AgentSessionStartInput,
  ActorRef,
  IssueCreateInput,
  IssueUpdateInput,
  RelatedTargetRef,
  RuntimeAuthorizationCapability,
  TenonAgentToolResult,
} from '../core/agentIssue';
import type { AgentIssueToolRuntime } from './agentIssueTools';
import type { AgentIssueStore, AgentSessionExecutionBinding, IssueInputResolver } from './agentIssueStore';
import {
  agentIssueOperationMatches,
  issueUpdateRequiresRuntimeAuthorization,
} from './agentIssueRuntimeAuthorization';

export interface AgentIssueToolRuntimeOptions {
  store: AgentIssueStore;
  actor: ActorRef;
  authorization?: RuntimeAuthorizationCapability;
  authorizationProvider?: (scope: AgentOperationScope) => RuntimeAuthorizationCapability | undefined;
  executor?: AgentSessionExecutor;
  startSource?: (input: AgentSessionStartInput) => AgentSessionSource;
  resolveInputScope?: IssueInputResolver;
  now?: () => number;
}

export interface AgentSessionExecutor {
  start(input: {
    session: AgentSession;
    startInput: AgentSessionStartInput;
    actor: ActorRef;
    now: number;
  }): Promise<Omit<AgentSessionExecutionBinding, 'updatedAt'>> | Omit<AgentSessionExecutionBinding, 'updatedAt'>;
  read?(binding: AgentSessionExecutionBinding, input: Parameters<AgentIssueToolRuntime['readSession']>[0]): Promise<void> | void;
  sendMessage?(binding: AgentSessionExecutionBinding, message: string): Promise<void> | void;
  stop?(binding: AgentSessionExecutionBinding): Promise<void> | void;
}

export function createAgentIssueToolRuntime(options: AgentIssueToolRuntimeOptions): AgentIssueToolRuntime {
  const now = () => options.now?.() ?? Date.now();
  return {
    search: (input) => options.store.search(input),
    read: (input) => options.store.read(input),
    create: (input) => createIssue(options, input, now()),
    update: (input) => updateIssue(options, input, now()),
    startSession: (input) => startSession(options, input, now()),
    readSession: (input) => readSession(options, input),
    sendSessionMessage: (input) => (
      hasAuthorization(options, { type: 'agent-session-message', agentSessionId: input.agentSessionId }, now())
        ? sendSessionMessage(options, input, now())
        : needsConfirmation('Message Agent Session', 'Send this message to the running Agent Session.', { type: 'agent-session-message', agentSessionId: input.agentSessionId }, [{ type: 'agent-session', id: input.agentSessionId }])
    ),
    stopSession: (input) => (
      hasAuthorization(options, { type: 'agent-session-stop', agentSessionId: input.agentSessionId }, now())
        ? stopSession(options, input, now())
        : needsConfirmation('Stop Agent Session', 'Stop this Agent Session and mark it canceled.', { type: 'agent-session-stop', agentSessionId: input.agentSessionId }, [{ type: 'agent-session', id: input.agentSessionId }])
    ),
  };
}

async function createIssue(
  options: AgentIssueToolRuntimeOptions,
  input: IssueCreateInput,
  now: number,
): Promise<TenonAgentToolResult> {
  return options.store.create(input, options.actor, now);
}

async function updateIssue(
  options: AgentIssueToolRuntimeOptions,
  input: IssueUpdateInput,
  now: number,
): Promise<TenonAgentToolResult> {
  if (input.request.mode === 'preview') return options.store.update(input, options.actor, now);
  const scope: AgentOperationScope = input.target.type === 'issue'
    ? { type: 'issue-update', issueId: input.target.id }
    : { type: 'recurring-issue-update', recurringIssueId: input.target.id };
  if (issueUpdateRequiresRuntimeAuthorization(input.change) && !hasAuthorization(options, scope, now)) {
    return needsConfirmation(
      'Confirm Issue change',
      'Apply this execution-enabling or lifecycle Issue change.',
      scope,
      [input.target.type === 'issue' ? { type: 'issue', id: input.target.id } : { type: 'recurring-issue', id: input.target.id }],
    );
  }
  return options.store.update(input, options.actor, now);
}

async function startSession(
  options: AgentIssueToolRuntimeOptions,
  input: AgentSessionStartInput,
  now: number,
): Promise<TenonAgentToolResult> {
  if (input.request.mode === 'preview') {
    return options.store.startSession(input, options.startSource?.(input) ?? { type: 'runtime-authorized-action', actor: options.actor }, options.actor, now, {
      resolveInput: options.resolveInputScope,
    });
  }
  const scope: AgentOperationScope = { type: 'agent-session-start', issueId: input.issueId };
  if (!hasAuthorization(options, scope, now)) {
    return needsConfirmation(
      'Start Agent Session',
      'Start one Agent Session for this Issue.',
      scope,
      [{ type: 'issue', id: input.issueId }],
    );
  }
  const started = await options.store.startSession(input, options.startSource?.(input) ?? { type: 'runtime-authorized-action', actor: options.actor }, options.actor, now, {
    resolveInput: options.resolveInputScope,
  });
  if (started.status !== 'applied') return started;
  return activateStartedSession(options, input, started, now);
}

async function activateStartedSession(
  options: AgentIssueToolRuntimeOptions,
  input: AgentSessionStartInput,
  result: TenonAgentToolResult,
  now: number,
): Promise<TenonAgentToolResult> {
  const agentSessionId = agentSessionIdFromTargets(result.targets);
  if (!agentSessionId) return result;
  const read = await options.store.readSession({ agentSessionId });
  const session = read?.agentSession;
  if (!session) return result;
  if (!options.executor) {
    return options.store.failSessionStart(agentSessionId, 'No Agent Session executor is configured.', options.actor, now);
  }
  try {
    const binding = await options.executor.start({ session, startInput: input, actor: options.actor, now });
    const bound = await options.store.bindSessionExecution(agentSessionId, binding, options.actor, now);
    const storedBinding = await options.store.executionForSession(agentSessionId);
    if (storedBinding && options.executor.read) {
      await options.executor.read(storedBinding, { agentSessionId });
    }
    return bound;
  } catch (error) {
    return options.store.failSessionStart(agentSessionId, errorMessage(error), options.actor, now);
  }
}

async function readSession(options: AgentIssueToolRuntimeOptions, input: Parameters<AgentIssueToolRuntime['readSession']>[0]) {
  const current = await options.store.readSession(input);
  if (!current) return null;
  if (input.wait && options.executor?.read) {
    const binding = await options.store.executionForSession(input.agentSessionId);
    if (binding) await options.executor.read(binding, input);
  }
  return options.store.readSession(input);
}

async function sendSessionMessage(
  options: AgentIssueToolRuntimeOptions,
  input: Parameters<AgentIssueToolRuntime['sendSessionMessage']>[0],
  now: number,
): Promise<TenonAgentToolResult> {
  const result = await options.store.sendSessionMessage(input, options.actor, now);
  if (result.status !== 'applied') return result;
  const binding = await options.store.executionForSession(input.agentSessionId);
  if (!binding || !options.executor?.sendMessage) return result;
  try {
    await options.executor.sendMessage(binding, input.message);
    return result;
  } catch (error) {
    return withWarning(result, 'executor_delivery_failed', errorMessage(error));
  }
}

async function stopSession(
  options: AgentIssueToolRuntimeOptions,
  input: Parameters<AgentIssueToolRuntime['stopSession']>[0],
  now: number,
): Promise<TenonAgentToolResult> {
  const binding = await options.store.executionForSession(input.agentSessionId);
  let warning: string | undefined;
  if (binding && options.executor?.stop) {
    try {
      await options.executor.stop(binding);
    } catch (error) {
      warning = errorMessage(error);
    }
  }
  const result = await options.store.stopSession(input, options.actor, now);
  return warning ? withWarning(result, 'executor_stop_failed', warning) : result;
}

function hasAuthorization(
  options: AgentIssueToolRuntimeOptions,
  required: AgentOperationScope,
  now: number,
): boolean {
  const authorization = options.authorizationProvider?.(required) ?? options.authorization;
  if (!authorization || authorization.expiresAt < now) return false;
  return authorization.allowedOperations.some((operation) => agentIssueOperationMatches(operation, required));
}

function needsConfirmation(
  title: string,
  body: string,
  operation: AgentOperationScope,
  targets: TenonAgentToolResult['targets'],
): TenonAgentToolResult {
  return {
    status: 'needs-confirmation',
    targets,
    confirmation: {
      title,
      body,
      operation,
      targets,
    },
  };
}

function agentSessionIdFromTargets(targets: readonly RelatedTargetRef[]): string | null {
  return targets.find((target) => target.type === 'agent-session')?.id ?? null;
}

function withWarning(result: TenonAgentToolResult, code: string, message: string): TenonAgentToolResult {
  return {
    ...result,
    warnings: [...(result.warnings ?? []), { code, message }],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
