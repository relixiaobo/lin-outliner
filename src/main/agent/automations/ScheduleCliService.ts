import { AutomationRevisionConflict } from './AutomationRevisionConflict';
import { decodeScheduleInput } from '../../../schedule/schemas';
import type { Automation, AutomationRun, AutomationMethod } from '../../../core/agent/automation';
import { SCHEDULE_COMMANDS } from '../../../schedule/contract';
import type { DelegateCapabilityExecution } from '../delegation/DelegateCapabilityBroker';
import type { AutomationService } from './AutomationService';

export const SCHEDULE_CLI_CONFIGURATION_REVISION = 'schedule-host-v1';
export function scheduleCliScheduling() {
  return { scheduling: { pool: 'schedule-host', configurationRevision: SCHEDULE_CLI_CONFIGURATION_REVISION, maxConcurrentProducer: 4, maxConcurrentPool: 4 },
    schedulerLimits: { maxConcurrentGlobal: 16, maxConcurrentThread: 4, maxQueuedGlobal: 64, maxQueuedThread: 16 }, timeoutMs: 120_000 };
}

/** CLI and renderer use the same service. A capability is an invocation, never a second scheduler. */
export class ScheduleCliService {
  constructor(private readonly service: () => AutomationService,
    private readonly authorize: (execution: DelegateCapabilityExecution) => Promise<void>) {}

  async execute(execution: DelegateCapabilityExecution): Promise<unknown> {
    await this.authorize(execution);
    execution.signal.throwIfAborted();
    const command = execution.admission.command;
    if (command.name !== 'schedule') throw new Error('Not a scheduling invocation');
    const spec = SCHEDULE_COMMANDS[command.operation];
    const raw: unknown = execution.admission.stdin ? JSON.parse(execution.admission.stdin) : {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Schedule input must be a JSON object');
    const input = decodeScheduleInput(command.operation, raw);
    if (Object.hasOwn(input, 'id')) throw new Error('Use the task or run identity in the command, not in stdin');
    if (spec.mutation && (typeof input.requestId !== 'string' || !input.requestId.trim())) throw new Error('Every mutation requires requestId; preserve it when retrying a lost reply');
    if (['update', 'pause', 'resume', 'run', 'skip', 'archive', 'restore'].includes(command.operation)
      && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1)) throw new Error('Read the task and supply its expectedRevision');
    if (!spec.mutation && Object.keys(input).length) throw new Error('Read commands do not accept stdin');
    const service = this.service();
    const request = <M extends AutomationMethod>(method: M, value: unknown) => service.request(method, value, () => this.authorize(execution), {
      threadId: execution.admission.source.rootThreadId, turnId: execution.admission.source.sourceTurnId, itemId: execution.admission.source.sourceItemId,
    });
    const id = command.target;
    const execute = async () => {
    switch (command.operation) {
      case 'list': {
        const { data } = await request('list', { includeDeleted: true });
        const page = [...data].sort((left, right) => right.id.localeCompare(left.id))
          .filter((task) => !command.before || task.id < command.before).slice(0, 51);
        return { data: page.slice(0, 50).map(taskReference), nextBefore: page.length > 50 ? page[49]!.id : null };
      }
      case 'show':
        return { ...(await request('read', { id })), ...(await request('timing', { id })) };
      case 'create':
        if (Object.hasOwn(input, 'destination')) throw new Error('Results always return to the task; do not choose a conversation destination');
        if (Array.isArray(input.contextHints) && input.contextHints.length > 1) throw new Error('Choose one primary work location');
        return request('create', { ...input, destination: { kind: 'standalone' } });
      case 'update':
        if (Object.hasOwn(input, 'destination') || Object.hasOwn(input, 'id')) throw new Error('Use the command task ID; destinations are managed by the runtime');
        if (Array.isArray(input.contextHints) && input.contextHints.length > 1) throw new Error('Choose one primary work location');
        return request('update', { ...input, id });
      case 'pause': case 'resume': case 'archive': case 'restore':
        if (Object.hasOwn(input, 'id')) throw new Error('Use the command task ID');
        return request(command.operation, { ...input, id });
      case 'run':
        if (Object.hasOwn(input, 'scheduledFor')) return request('resolveMissed', { ...input, id, resolution: 'fulfilled' });
        return request('startNow', { ...input, id });
      case 'skip':
        return request('resolveMissed', { ...input, id, resolution: 'skipped' });
      case 'stop':
        return request('runStop', { ...input, id });
      case 'acknowledge':
        return request('acknowledge', { ...input, id });
      case 'runs': {
        const { data } = await request('runs', { automationId: id, limit: 51, ...(command.before ? { before: command.before } : {}) });
        return { data: data.slice(0, 50).map(runReference), nextBefore: data.length > 50 ? data[49]!.id : null };
      }
      case 'processes': return request('processes', { id });
      case 'result': return request('result', { id });
    }
    };
    try {
      const result = await execute();
      if (command.operation === 'run' && result && typeof result === 'object') {
        const runs = 'runs' in result ? result.runs as readonly AutomationRun[] : 'run' in result && result.run ? [result.run as AutomationRun] : [];
        const requested = input.scheduledFor === undefined ? `manual:${input.requestId}` : `scheduled:${input.scheduledFor}`;
        return { requestId: input.requestId, requestedRevision: input.expectedRevision,
          admission: runs.some((run) => run.occurrenceKey !== requested) ? 'alreadyRunning'
            : runs.some((run) => run.state === 'failed') ? 'blocked' : runs.some((run) => run.state === 'pending') ? 'waiting' : 'accepted',
          runs: runs.map(runReference) };
      }
      if (command.operation === 'processes' && result && typeof result === 'object' && 'data' in result) {
        return { data: (result.data as readonly import('../../../core/agent/protocol').ToolTaskProjection[]).map((task) => ({
          taskId: task.taskId, ownerThreadId: task.ownerThreadId, sourceTurnId: task.sourceTurnId, sourceItemId: task.sourceItemId,
          description: task.description, state: task.state, deliveryState: task.deliveryState, progress: task.progress,
          startedAt: task.startedAt, completedAt: task.completedAt, detailState: task.detailState,
          cwd: task.executionContext.address.cwd, isolation: task.isolation, continuation: task.continuation,
        })) };
      }
      if (['result', 'acknowledge', 'stop'].includes(command.operation) && result && typeof result === 'object') {
        const keys = new Set(['run', 'state', 'resultTurnId', 'startedAt', 'finishedAt', 'recordPath', 'issues', 'issue', 'issueKey', 'acknowledged']);
        const reference = Object.fromEntries(Object.entries(result).filter(([key]) => keys.has(key)));
        if (reference.run) reference.run = runReference(reference.run as AutomationRun);
        if (Array.isArray(reference.issues)) {
          const issues = reference.issues as readonly { acknowledged: boolean }[];
          reference.issueCount = issues.length;
          reference.unresolvedIssueCount = issues.filter((issue) => !issue.acknowledged).length;
          reference.issues = [...issues.filter((issue) => !issue.acknowledged), ...issues.filter((issue) => issue.acknowledged)].slice(0, 20);
          reference.issuesTruncated = issues.length > 20;
        }
        return { ...reference, contentAvailability: reference.recordPath ? 'available' : 'unavailable' };
      }
      return result;
    }
    catch (error) {
      if (error instanceof AutomationRevisionConflict) return { kind: 'revisionConflict', currentRevision: error.currentRevision, message: error.message };
      throw error;
    }
  }
}

function taskReference(task: Automation) {
  return { id: task.id, name: task.name, revision: task.revision, status: task.status,
    nextOccurrenceAt: task.nextOccurrenceAt, archivedAt: task.archivedAt, materialCount: task.materials.length };
}
function runReference(run: AutomationRun) {
  return { id: run.id, automationId: run.automationId, automationRevision: run.automationRevision,
    createdSequence: run.createdSequence, scheduledFor: run.scheduledFor, occurrenceKey: run.occurrenceKey,
    state: run.state, threadId: run.threadId, turnId: run.turnId, readAt: run.readAt };
}
