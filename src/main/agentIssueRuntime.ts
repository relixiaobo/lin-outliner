import { isActiveAgentSessionState } from '../core/agentIssue';
import type {
  AgentIssueOrigin,
  AgentIssue,
  AgentSession,
  AgentSessionSource,
  AgentSessionStartInput,
  ActorRef,
  IssueCreateInput,
  IssueRelation,
  IssueUpdateInput,
  IssueUpdateChange,
  RelatedTargetRef,
  TenonAgentToolResult,
  IssueOutputPolicy,
  IssueInputScope,
  RecurringIssueUpdateChange,
  ValidationMessage,
} from '../core/agentIssue';
import type { AgentIssueToolRuntime } from './agentIssueTools';
import type {
  AgentIssueStore,
  AgentSessionExecutionBinding,
  ChildIssueScopeAuthorizer,
  IssueInputResolver,
} from './agentIssueStore';
import type {
  IssueExecutionPreparationResult,
  IssueNodeDefinition,
} from './agentIssueExecutionPreparation';

export interface AgentIssueToolRuntimeOptions {
  store: AgentIssueStore;
  actor: ActorRef;
  executor?: AgentSessionExecutor;
  startSource?: (input: AgentSessionStartInput) => AgentSessionSource;
  origin?: () => AgentIssueOrigin | null | undefined | Promise<AgentIssueOrigin | null | undefined>;
  resolveInputScope?: IssueInputResolver;
  prepareExecution?: (
    issue: AgentIssue,
    now: number,
    mode: 'preview' | 'request',
  ) => Promise<IssueExecutionPreparationResult>;
  validateDefinition?: (
    definition: IssueNodeDefinition,
    options?: { materializedRecurring?: boolean },
  ) => ValidationMessage[];
  authorizeChildScope?: ChildIssueScopeAuthorizer;
  onIssueCreated?: () => void;
  onIssueDeliveryQueued?: () => void;
  now?: () => number;
}

export interface AgentSessionExecutor {
  start(input: {
    session: AgentSession;
    startInput: AgentSessionStartInput;
    actor: ActorRef;
    now: number;
    bindExecution(
      binding: Omit<AgentSessionExecutionBinding, 'updatedAt'>,
    ): Promise<TenonAgentToolResult>;
  }): Promise<Omit<AgentSessionExecutionBinding, 'updatedAt'>> | Omit<AgentSessionExecutionBinding, 'updatedAt'>;
  read?(
    binding: AgentSessionExecutionBinding,
    input: Parameters<AgentIssueToolRuntime['readSession']>[0],
  ): Promise<'synced' | 'unavailable'> | 'synced' | 'unavailable';
  sendMessage?(binding: AgentSessionExecutionBinding, message: string): Promise<void> | void;
  stop?(binding: AgentSessionExecutionBinding): Promise<'canceled' | 'not-canceled'> | 'canceled' | 'not-canceled';
}

const sessionControlTails = new Map<string, Promise<void>>();
const PREPARED_SCOPE_VALIDATION_CODES = new Set([
  'child_scope_broadened',
  'child_scope_unverifiable',
]);

export function createAgentIssueToolRuntime(options: AgentIssueToolRuntimeOptions): AgentIssueToolRuntime {
  const now = () => options.now?.() ?? Date.now();
  return {
    search: (input) => searchIssues(options, input),
    read: (input) => readIssue(options, input),
    create: (input) => createIssue(options, input, now()),
    update: (input) => updateIssue(options, input, now()),
    startSession: (input) => startSession(options, input, now()),
    readSession: (input) => readSession(options, input),
    sendSessionMessage: (input) => runAgentSessionControlOperation(
      options.store,
      input.agentSessionId,
      () => sendSessionMessage(options, input, now()),
    ),
    stopSession: (input) => runAgentSessionControlOperation(
      options.store,
      input.agentSessionId,
      () => stopSession(options, input, now()),
    ),
  };
}

interface IssueRuntimeCaller {
  origin?: AgentIssueOrigin;
  session?: AgentSession;
}

async function issueRuntimeCaller(options: AgentIssueToolRuntimeOptions): Promise<IssueRuntimeCaller> {
  const origin = await options.origin?.() ?? undefined;
  if (origin?.type !== 'agent-session') return { origin };
  const session = (await options.store.readSession({ agentSessionId: origin.agentSessionId }))?.agentSession;
  return { origin, ...(session ? { session } : {}) };
}

function issueOwnedByCaller(
  issue: { id: string; origin?: AgentIssueOrigin },
  caller: AgentSession,
): boolean {
  return issue.id === caller.issueId
    || (issue.origin?.type === 'agent-session' && issue.origin.agentSessionId === caller.id);
}

async function callerIssueIds(
  options: AgentIssueToolRuntimeOptions,
  caller: AgentSession,
): Promise<Set<string>> {
  const state = await options.store.state();
  return new Set(Object.values(state.issues)
    .filter((issue) => issueOwnedByCaller(issue, caller))
    .map((issue) => issue.id));
}

function callerRelationScopeValidation(
  relations: readonly IssueRelation[],
  allowedIssueIds: ReadonlySet<string>,
  path: string,
  previousRelations: readonly IssueRelation[] = [],
) {
  const externalKeys = (values: readonly IssueRelation[]) => new Set(values
    .filter((relation) => !allowedIssueIds.has(relation.issueId))
    .map((relation) => `${relation.type}:${relation.issueId}`));
  const previousExternal = externalKeys(previousRelations);
  const nextExternal = externalKeys(relations);
  const externalRelationsChanged = previousExternal.size !== nextExternal.size
    || [...previousExternal].some((key) => !nextExternal.has(key));
  return externalRelationsChanged
    ? [{
        path,
        code: 'caller_scope_denied',
        message: 'An Agent Session cannot add, remove, or rewrite Issue relations outside its direct branch.',
      }]
    : [];
}

async function searchIssues(
  options: AgentIssueToolRuntimeOptions,
  input: Parameters<AgentIssueToolRuntime['search']>[0],
) {
  const caller = await issueRuntimeCaller(options);
  if (caller.origin?.type !== 'agent-session') return options.store.search(input);
  if (!caller.session) return { rows: [] };
  const allowedIssueIds = await callerIssueIds(options, caller.session);
  return options.store.search(input, { allowedIssueIds });
}

function blockedCallerResult(
  target: RelatedTargetRef,
  message: string,
): TenonAgentToolResult {
  return {
    status: 'blocked',
    targets: [target],
    validation: [{ code: 'caller_scope_denied', message }],
  };
}

async function sessionOwnedByCaller(
  options: AgentIssueToolRuntimeOptions,
  target: AgentSession,
  caller: AgentSession,
): Promise<boolean> {
  if (target.id === caller.id) return true;
  const issue = (await options.store.read({ target: { type: 'issue', id: target.issueId } })).issue;
  return issue?.origin?.type === 'agent-session' && issue.origin.agentSessionId === caller.id;
}

async function readIssue(options: AgentIssueToolRuntimeOptions, input: Parameters<AgentIssueToolRuntime['read']>[0]) {
  const caller = await issueRuntimeCaller(options);
  if (caller.origin?.type === 'agent-session') {
    if (!caller.session || input.target.type !== 'issue') return { target: input.target };
    const target = (await options.store.read({ target: input.target })).issue;
    if (!target || !issueOwnedByCaller(target, caller.session)) return { target: input.target };
  }
  if (input.include?.includes('sessions') && options.executor?.read) {
    const current = await options.store.read({ target: input.target, include: ['sessions'] });
    const sessions = (current.sessions ?? []).filter((session) => isActiveAgentSessionState(session.state));
    await Promise.allSettled(sessions.map(async (session) => {
      const binding = await options.store.executionForSession(session.id);
      if (binding) await options.executor?.read?.(binding, { agentSessionId: session.id, include: ['latest-output'] });
    }));
  }
  const result = await options.store.read(input);
  if (caller.origin?.type !== 'agent-session' || !caller.session || !result.childIssues) return result;
  return {
    ...result,
    childIssues: result.childIssues.filter((issue) => issueOwnedByCaller(issue, caller.session!)),
  };
}

async function createIssue(
  options: AgentIssueToolRuntimeOptions,
  input: IssueCreateInput,
  now: number,
): Promise<TenonAgentToolResult> {
  const origin = await options.origin?.();
  if (!origin) {
    return {
      status: 'blocked',
      targets: [],
      validation: [{
        path: 'origin',
        code: 'invalid_origin',
        message: 'Issue creation requires a visible conversation or active parent Agent Session origin.',
      }],
    };
  }
  if (
    origin?.type === 'agent-session'
    && input.issueType === 'issue'
    && input.fields.relations?.length
  ) {
    const caller = (await options.store.readSession({ agentSessionId: origin.agentSessionId }))?.agentSession;
    if (caller) {
      const relationValidation = callerRelationScopeValidation(
        input.fields.relations,
        await callerIssueIds(options, caller),
        'fields.relations',
      );
      if (relationValidation.length > 0) {
        return { status: 'blocked', targets: [], validation: relationValidation };
      }
    }
  }
  const definitionValidation = options.validateDefinition?.(
    input.issueType === 'issue'
      ? input.fields
      : input.fields.issueTemplate,
    input.issueType === 'recurring-issue' ? { materializedRecurring: true } : undefined,
  ) ?? [];
  if (definitionValidation.length > 0) {
    return { status: 'blocked', targets: [], validation: definitionValidation };
  }
  const result = await options.store.create(input, options.actor, now, origin
    ? { origin, authorizeChildScope: options.authorizeChildScope }
    : { authorizeChildScope: options.authorizeChildScope });
  if (input.request.mode !== 'preview' && result.status === 'applied') {
    options.onIssueCreated?.();
  }
  if (input.request.mode !== 'preview'
    && result.status === 'applied'
    && input.issueType === 'issue'
    && (input.fields.trigger?.type ?? 'when-ready') === 'when-ready'
    && (input.fields.permissionMode ?? 'unattended') === 'unattended') {
    return withWarning(
      result,
      'runtime_autostart',
      'This when-ready unattended Issue is eligible for runtime autostart. Do not call agent_session_start for this newly created Issue unless retrying or continuing it later.',
    );
  }
  return result;
}

async function updateIssue(
  options: AgentIssueToolRuntimeOptions,
  input: IssueUpdateInput,
  now: number,
): Promise<TenonAgentToolResult> {
  const caller = await issueRuntimeCaller(options);
  const currentRead = input.change.type === 'patch'
    || (input.target.type === 'recurring-issue' && input.change.type === 'resume')
    ? await options.store.read({ target: input.target })
    : undefined;
  if (caller.origin?.type === 'agent-session') {
    const target: RelatedTargetRef = { type: input.target.type, id: input.target.id };
    if (!caller.session || input.target.type !== 'issue') {
      return blockedCallerResult(target, 'An Agent Session cannot update Recurring Issues or unrelated Issue branches.');
    }
    const current = (await options.store.read({ target: input.target })).issue;
    if (!current || !issueOwnedByCaller(current, caller.session)) {
      return blockedCallerResult(target, 'An Agent Session can update only its owning Issue or a direct child Issue.');
    }
    const issueChange = input.change as IssueUpdateChange;
    if (issueChange.type === 'transition' && issueChange.status.category === 'completed') {
      return blockedCallerResult(target, 'Agent Sessions cannot bypass child execution or review by directly completing an Issue.');
    }
    if (issueChange.type === 'patch' && issueChange.patch.relations !== undefined) {
      const relationValidation = callerRelationScopeValidation(
        issueChange.patch.relations,
        await callerIssueIds(options, caller.session),
        'change.patch.relations',
        current.relations,
      );
      if (relationValidation.length > 0) {
        return {
          status: 'blocked',
          targets: [target],
          validation: relationValidation,
        };
      }
    }
    if (
      issueChange.type === 'patch'
      && current.id === caller.session.issueId
      && (
        issueChange.patch.input !== undefined
        || issueChange.patch.output !== undefined
        || issueChange.patch.noteNodeIds !== undefined
      )
    ) {
      const scopeValidation = options.authorizeChildScope?.(caller.session, {
        input: issueChange.patch.input ?? current.input,
        output: issueChange.patch.output ?? current.output,
        noteNodeIds: issueChange.patch.noteNodeIds ?? current.noteNodeIds,
      }) ?? [];
      if (scopeValidation.length > 0) {
        return {
          status: 'blocked',
          targets: [target],
          validation: scopeValidation,
        };
      }
    }
  }
  const currentRevision = input.target.type === 'issue'
    ? currentRead?.issue?.revision
    : currentRead?.recurringIssue?.revision;
  if (
    input.target.expectedRevision
    && currentRevision
    && input.target.expectedRevision !== currentRevision
  ) {
    return options.store.update(input, options.actor, now, {
      authorizeChildScope: options.authorizeChildScope,
      allowHumanReviewTransition: false,
    });
  }
  if (input.change.type === 'patch' && options.validateDefinition) {
    let definition: IssueNodeDefinition | undefined;
    if (input.target.type === 'issue' && currentRead?.issue) {
      const change = input.change as IssueUpdateChange;
      if (change.type === 'patch') {
        definition = {
          input: change.patch.input ?? currentRead.issue.input,
          output: change.patch.output ?? currentRead.issue.output,
          noteNodeIds: change.patch.noteNodeIds ?? currentRead.issue.noteNodeIds,
          dueDate: change.patch.dueDate === null
            ? undefined
            : change.patch.dueDate ?? currentRead.issue.dueDate,
          trigger: change.patch.trigger ?? currentRead.issue.trigger,
          recurrence: currentRead.issue.recurrence,
        };
      }
    } else if (input.target.type === 'recurring-issue' && currentRead?.recurringIssue) {
      const change = input.change as RecurringIssueUpdateChange;
      if (change.type === 'patch') {
        definition = change.patch.issueTemplate ?? currentRead.recurringIssue.issueTemplate;
      }
    }
    if (definition) {
      const definitionValidation = options.validateDefinition(
        definition,
        input.target.type === 'recurring-issue' ? { materializedRecurring: true } : undefined,
      );
      if (definitionValidation.length > 0) {
        return {
          status: 'blocked',
          targets: [{ type: input.target.type, id: input.target.id }],
          validation: definitionValidation,
        };
      }
    }
  }
  if (
    input.target.type === 'recurring-issue'
    && input.change.type === 'resume'
    && currentRead?.recurringIssue
    && options.validateDefinition
  ) {
    const definitionValidation = options.validateDefinition(
      currentRead.recurringIssue.issueTemplate,
      { materializedRecurring: true },
    );
    if (definitionValidation.length > 0) {
      return {
        status: 'blocked',
        targets: [{ type: 'recurring-issue', id: input.target.id }],
        validation: definitionValidation,
      };
    }
  }
  const result = await options.store.update(input, options.actor, now, {
    authorizeChildScope: options.authorizeChildScope,
    allowHumanReviewTransition: false,
  });
  if (result.status === 'applied') options.onIssueDeliveryQueued?.();
  return result;
}

async function startSession(
  options: AgentIssueToolRuntimeOptions,
  input: AgentSessionStartInput,
  now: number,
): Promise<TenonAgentToolResult> {
  const caller = await issueRuntimeCaller(options);
  if (caller.origin?.type === 'agent-session') {
    const target: RelatedTargetRef = { type: 'issue', id: input.issueId };
    if (!caller.session) {
      return blockedCallerResult(target, 'The caller Agent Session is unavailable.');
    }
    const issue = (await options.store.read({ target })).issue;
    if (
      !issue
      || issue.origin?.type !== 'agent-session'
      || issue.origin.agentSessionId !== caller.session.id
    ) {
      return blockedCallerResult(target, 'An Agent Session can start execution only for its direct child Issues.');
    }
  }
  const source = options.startSource?.(input)
    ?? (caller.session
      ? { type: 'orchestration' as const, coordinatorAgentSessionId: caller.session.id }
      : { type: 'runtime-action' as const, actor: options.actor });
  const currentIssue = (await options.store.read({
    target: { type: 'issue', id: input.issueId },
  })).issue;
  const previewPreparation = currentIssue && options.prepareExecution
    ? await options.prepareExecution(currentIssue, now, 'preview')
    : undefined;
  if (currentIssue && previewPreparation && !previewPreparation.ok) {
    if (input.request.mode === 'request') {
      const failed = await options.store.recordSessionPreparationFailure(
        input,
        source,
        currentIssue.revision,
        previewPreparation.validation,
        options.actor,
        now,
      );
      options.onIssueDeliveryQueued?.();
      return failed;
    }
    return {
      status: 'blocked',
      targets: [{ type: 'issue', id: input.issueId }],
      validation: previewPreparation.validation,
      revisions: [{
        target: { type: 'issue', id: currentIssue.id },
        revision: currentIssue.revision,
      }],
    };
  }
  const previewExecution = previewPreparation?.ok ? previewPreparation.prepared : undefined;
  if (input.request.mode === 'preview') {
    return options.store.startSession(input, source, options.actor, now, {
      resolveInput: options.resolveInputScope,
      authorizeChildScope: options.authorizeChildScope,
      preparedExecution: previewExecution,
    });
  }
  if (currentIssue && options.prepareExecution && previewExecution) {
    const eligibility = await options.store.startSession({
      ...input,
      request: { mode: 'preview' },
    }, source, options.actor, now, {
      resolveInput: options.resolveInputScope,
      authorizeChildScope: options.authorizeChildScope,
      preparedExecution: previewExecution,
    });
    if (eligibility.status !== 'preview') return eligibility;
  }
  const requestPreparation = currentIssue && options.prepareExecution
    ? await options.prepareExecution(currentIssue, now, 'request')
    : undefined;
  if (requestPreparation && !requestPreparation.ok) {
    const failed = await options.store.recordSessionPreparationFailure(
      input,
      source,
      currentIssue!.revision,
      requestPreparation.validation,
      options.actor,
      now,
    );
    options.onIssueDeliveryQueued?.();
    return failed;
  }
  const preparedExecution = requestPreparation?.ok
    ? requestPreparation.prepared
    : undefined;
  const started = await options.store.startSession(input, source, options.actor, now, {
    resolveInput: options.resolveInputScope,
    authorizeChildScope: options.authorizeChildScope,
    preparedExecution,
  });
  if (started.status !== 'applied') {
    if (
      preparedExecution
      && started.status === 'blocked'
      && started.validation?.some((message) => PREPARED_SCOPE_VALIDATION_CODES.has(message.code))
    ) {
      const failed = await options.store.recordSessionPreparationFailure(
        input,
        source,
        preparedExecution.issueRevision,
        started.validation,
        options.actor,
        now,
        {
          preparedExecution,
          authorizeChildScope: options.authorizeChildScope,
          requirePreparedScopeFailure: true,
        },
      );
      options.onIssueDeliveryQueued?.();
      return failed;
    }
    return started;
  }
  const activated = await activateStartedSession(options, input, started, now);
  options.onIssueDeliveryQueued?.();
  return activated;
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
  const executor = options.executor;
  if (!executor) {
    return options.store.failSessionStart(agentSessionId, 'No Agent Session executor is configured.', options.actor, now);
  }
  let bound: TenonAgentToolResult;
  try {
    let bindingPromise: Promise<TenonAgentToolResult> | undefined;
    const bindExecution = (binding: Omit<AgentSessionExecutionBinding, 'updatedAt'>) => {
      bindingPromise ??= options.store.bindSessionExecution(agentSessionId, binding, options.actor, now);
      return bindingPromise;
    };
    const binding = await executor.start({
      session,
      startInput: input,
      actor: options.actor,
      now,
      bindExecution,
    });
    bound = await (bindingPromise ?? bindExecution(binding));
  } catch (error) {
    return options.store.failSessionStart(agentSessionId, errorMessage(error), options.actor, now);
  }
  const storedBinding = await options.store.executionForSession(agentSessionId);
  if (storedBinding && executor.read) {
    try {
      await executor.read(storedBinding, { agentSessionId });
    } catch (error) {
      return withWarning(bound, 'executor_sync_failed', errorMessage(error));
    }
  }
  return bound;
}

async function readSession(options: AgentIssueToolRuntimeOptions, input: Parameters<AgentIssueToolRuntime['readSession']>[0]) {
  const current = await options.store.readSession(input);
  if (!current) return null;
  const caller = await issueRuntimeCaller(options);
  if (
    caller.origin?.type === 'agent-session'
    && (!caller.session || !await sessionOwnedByCaller(options, current.agentSession, caller.session))
  ) return null;
  const shouldSyncExecution = input.wait === true
    || input.include?.includes('latest-output') === true
    || isActiveAgentSessionState(current.agentSession.state);
  if (shouldSyncExecution && options.executor?.read) {
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
  const caller = await issueRuntimeCaller(options);
  if (caller.origin?.type === 'agent-session') {
    const target = (await options.store.readSession({ agentSessionId: input.agentSessionId }))?.agentSession;
    if (!caller.session || !target || !await sessionOwnedByCaller(options, target, caller.session)) {
      return blockedCallerResult(
        { type: 'agent-session', id: input.agentSessionId },
        'An Agent Session can steer only itself or a direct child Issue Session.',
      );
    }
  }
  if (input.request.mode === 'preview') {
    const preview = await options.store.sendSessionMessage(input, options.actor, now);
    if (preview.status !== 'preview') return preview;
    const binding = await options.store.executionForSession(input.agentSessionId);
    if (!binding || !options.executor?.sendMessage) {
      return blockedSessionRuntimeResult(
        input.agentSessionId,
        'execution_unavailable',
        'Agent Session has no live execution binding that can receive this message.',
        preview,
      );
    }
    return preview;
  }
  const preflight = await options.store.preflightSessionMessage(input);
  if (preflight.status !== 'applied') return preflight;
  const binding = await options.store.executionForSession(input.agentSessionId);
  if (!binding || !options.executor?.sendMessage) {
    return blockedSessionRuntimeResult(
      input.agentSessionId,
      'execution_unavailable',
      'Agent Session has no live execution binding that can receive this message.',
      preflight,
    );
  }
  try {
    await options.executor.sendMessage(binding, input.message);
  } catch (error) {
    return blockedSessionRuntimeResult(
      input.agentSessionId,
      'executor_delivery_failed',
      errorMessage(error),
      preflight,
    );
  }
  const current = await options.store.readSession({ agentSessionId: input.agentSessionId });
  const commitNow = Math.max(now, (current?.agentSession.updatedAt ?? now) + 1);
  return options.store.sendSessionMessage(input, options.actor, commitNow);
}

async function stopSession(
  options: AgentIssueToolRuntimeOptions,
  input: Parameters<AgentIssueToolRuntime['stopSession']>[0],
  now: number,
): Promise<TenonAgentToolResult> {
  const caller = await issueRuntimeCaller(options);
  if (caller.origin?.type === 'agent-session') {
    const target = (await options.store.readSession({ agentSessionId: input.agentSessionId }))?.agentSession;
    if (!caller.session || !target || !await sessionOwnedByCaller(options, target, caller.session)) {
      return blockedCallerResult(
        { type: 'agent-session', id: input.agentSessionId },
        'An Agent Session can stop only itself or a direct child Issue Session.',
      );
    }
  }
  if (input.request.mode === 'preview') {
    const preview = await options.store.stopSession(input, options.actor, now);
    if (preview.status !== 'preview') return preview;
    const current = await options.store.readSession({ agentSessionId: input.agentSessionId });
    if (current?.agentSession.state === 'canceled') return preview;
    const binding = await options.store.executionForSession(input.agentSessionId);
    if (!binding) {
      if (current?.agentSession.state === 'pending') return preview;
      return blockedSessionRuntimeResult(
        input.agentSessionId,
        'execution_unavailable',
        'Agent Session has no execution binding that can be stopped.',
        preview,
      );
    }
    if (!options.executor?.stop) {
      return blockedSessionRuntimeResult(
        input.agentSessionId,
        'execution_unavailable',
        'No Agent Session executor is configured to stop this execution.',
        preview,
      );
    }
    return preview;
  }
  const reservation = await options.store.reserveSessionStop(input, now);
  const preflight = reservation.result;
  if (preflight.status !== 'applied' || !reservation.token) return preflight;
  const stopToken = reservation.token;
  const current = await options.store.readSession({ agentSessionId: input.agentSessionId });
  const binding = await options.store.executionForSession(input.agentSessionId);
  if (!binding) {
    if (current?.agentSession.state === 'pending') {
      return options.store.commitReservedSessionStop(input, stopToken, options.actor, now);
    }
    await options.store.releaseSessionStop(input.agentSessionId, stopToken);
    return blockedSessionRuntimeResult(
      input.agentSessionId,
      'execution_unavailable',
      'Agent Session has no execution binding that can be stopped.',
      preflight,
    );
  }
  if (!options.executor?.stop) {
    await options.store.releaseSessionStop(input.agentSessionId, stopToken);
    return blockedSessionRuntimeResult(
      input.agentSessionId,
      'execution_unavailable',
      'No Agent Session executor is configured to stop this execution.',
      preflight,
    );
  }
  try {
    const executorResult = await options.executor.stop(binding);
    const afterStop = await options.store.readSession({ agentSessionId: input.agentSessionId });
    if (executorResult === 'canceled' || afterStop?.agentSession.state === 'canceled') {
      const commitNow = Math.max(now, (afterStop?.agentSession.updatedAt ?? now) + 1);
      return options.store.commitReservedSessionStop(input, stopToken, options.actor, commitNow);
    }
    await options.store.releaseSessionStop(input.agentSessionId, stopToken);
    return blockedSessionRuntimeResult(
      input.agentSessionId,
      'executor_stop_not_canceled',
      'Agent Session execution reached a confirmed non-canceled state before stop completed.',
      preflight,
    );
  } catch (error) {
    let executionStateConfirmed = false;
    if (options.executor.read) {
      try {
        executionStateConfirmed = await options.executor.read(
          binding,
          { agentSessionId: input.agentSessionId },
        ) === 'synced';
      } catch {
        // Keep the durable stop reservation when executor state cannot be reconciled.
      }
    }
    const afterFailure = await options.store.readSession({ agentSessionId: input.agentSessionId });
    if (afterFailure?.agentSession.state === 'canceled') {
      const commitNow = Math.max(now, afterFailure.agentSession.updatedAt + 1);
      return options.store.commitReservedSessionStop(input, stopToken, options.actor, commitNow);
    }
    if (afterFailure && (
      executionStateConfirmed
      || !isActiveAgentSessionState(afterFailure.agentSession.state)
    )) {
      await options.store.releaseSessionStop(input.agentSessionId, stopToken);
    }
    return blockedSessionRuntimeResult(
      input.agentSessionId,
      'executor_stop_failed',
      errorMessage(error),
      preflight,
    );
  }
}

function agentSessionIdFromTargets(targets: readonly RelatedTargetRef[]): string | null {
  return targets.find((target) => target.type === 'agent-session')?.id ?? null;
}

export function runAgentSessionControlOperation<T>(
  store: AgentIssueStore,
  agentSessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${store.coordinationKey()}\u0000${agentSessionId}`;
  const previous = sessionControlTails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(() => undefined, () => undefined);
  sessionControlTails.set(key, tail);
  return run.finally(() => {
    if (sessionControlTails.get(key) === tail) sessionControlTails.delete(key);
  });
}

function withWarning(result: TenonAgentToolResult, code: string, message: string): TenonAgentToolResult {
  return {
    ...result,
    warnings: [...(result.warnings ?? []), { code, message }],
  };
}

function blockedSessionRuntimeResult(
  agentSessionId: string,
  code: string,
  message: string,
  preflight: TenonAgentToolResult,
): TenonAgentToolResult {
  return {
    status: 'blocked',
    targets: [{ type: 'agent-session', id: agentSessionId }],
    validation: [{ code, message }],
    ...(preflight.revisions ? { revisions: preflight.revisions } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
