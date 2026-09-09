import type { TSchema } from 'typebox';
import type { SkillManageRequest, SkillReview } from '../../core/agent/skillOperations';
import { SKILL_MANAGE_SCHEMA } from '../../core/agent/skillOperations';
import type { ManagedSkillView } from '../../core/types';
import { ManagedSkillService } from '../managedSkillService';
import { AgentSkillRuntime } from '../agent/capabilities/agentSkills';
import { AgentToolFailure } from '../agent/AgentToolFailure';
import { compileToolParameters } from '../agent/runtime/kernel/exactToolArguments';

export interface SkillOperationCaller {
  readonly runtime: AgentSkillRuntime;
  readonly origin: { readonly kind: 'window'; readonly windowId: number };
  readonly signal?: AbortSignal;
  readonly authorize: (name: string, input: unknown, signal?: AbortSignal) => Promise<void>;
}
export type ReviewSkillOperation = (input: {
  readonly review: SkillReview;
  readonly expiresAt: number;
  readonly caller: SkillOperationCaller;
}) => Promise<boolean>;

export function createSkillLifecycle(options: {
  readonly service: ManagedSkillService;
  readonly review: ReviewSkillOperation;
  readonly refreshProvenance: () => Promise<void>;
  readonly changed: () => void;
}) {
  const { service } = options;
  function changed(): void {
    try { options.changed(); } catch (error) { console.warn('[skills] library notification failed', error); }
  }
  async function availability(caller: SkillOperationCaller, skill: Parameters<AgentSkillRuntime['lifecycleAvailability']>[0]) {
    const result = await caller.runtime.lifecycleAvailability(skill);
    if (!result.available) return result;
    try {
      await caller.authorize('skill', { skill: skill.name }, caller.signal);
      return result;
    } catch {
      caller.signal?.throwIfAborted();
      return { available: false, reason: 'invocation_unavailable' };
    }
  }
  async function observe(caller: SkillOperationCaller, skill: ManagedSkillView) {
    const definition = await caller.runtime.getSkill(skill.name);
    const eligibility = definition?.source === 'managed'
      ? await availability(caller, definition)
      : { available: false, reason: 'integrity_compatibility_or_shadowing' };
    return { ...managedSummary(skill), ...eligibility };
  }

  async function manage(value: unknown, caller: SkillOperationCaller): Promise<unknown> {
    const request = decode<SkillManageRequest>(value, SKILL_MANAGE_SCHEMA);
    const authorize = async () => {
      caller.signal?.throwIfAborted();
      await caller.authorize('skill_manage', { request }, caller.signal);
    };
    await authorize();
    if (request.operation === 'undo_edit') {
      await caller.runtime.undoLastAgentSkillEdit(request, authorize);
      let refresh: 'applied' | 'failed' = 'applied';
      await options.refreshProvenance().catch(() => { refresh = 'failed'; });
      changed();
      return { committed: true, operation: request.operation, identity: request.identity, restoredHash: request.previousHash, runtimeRefresh: { state: refresh } };
    }
    const interaction = await service.review(request);
    if (!(await options.review({ ...interaction, caller }))) throw failure('cancelled', 'The person cancelled the Skill operation.');
    const validateCommit = async () => {
      await authorize();
      if (Date.now() >= interaction.expiresAt) throw failure('review_expired', 'The Skill review expired. Inspect it again.');
    };
    await validateCommit();
    let committed: ManagedSkillView | null;
    switch (request.operation) {
      case 'install': committed = await service.install(request, validateCommit); break;
      case 'apply_update': committed = await service.applyUpdate(request, validateCommit); break;
      case 'rollback': committed = await service.rollback(request, validateCommit); break;
      case 'uninstall': await service.uninstall(request, validateCommit); committed = null; break;
    }
    changed();
    const identity = `managed:${committed?.id ?? ('skillId' in request ? request.skillId : '')}`;
    let runtimeRefresh = service.runtimeRefresh;
    const observed = committed ? await observe(caller, committed).catch(() => {
      runtimeRefresh = { state: 'failed', message: 'Saved, but current Skill availability could not be observed.' };
      return null;
    }) : null;
    return { committed: true, operation: request.operation, identity,
      version: committed ? managedSummary(committed) : null,
      observed, runtimeRefresh: { ...runtimeRefresh,
        ...(runtimeRefresh.message ? { message: boundedText(runtimeRefresh.message) } : {}) } };
  }
  return { manage };
}

function decode<T>(input: unknown, schema: object): T {
  if (!compileToolParameters(schema as TSchema).Check(input)) throw failure('invalid_request', 'The Skill operation does not match its schema.');
  return (input as { request: T }).request;
}
function managedSummary(skill: ManagedSkillView) {
  return { identity: `managed:${skill.id}`, source: 'managed', skillId: skill.id, name: skill.name,
    revision: skill.revision, contentHash: skill.active.contentHash, commit: skill.active.commit,
    previousHash: skill.previous?.contentHash ?? null, repository: skill.repository,
    subdirectory: skill.subdirectory, status: skill.status, diagnostic: skill.diagnostic
      ? { code: skill.diagnostic.code, ...(skill.diagnostic.detail ? { detail: boundedText(skill.diagnostic.detail) } : {}) } : null };
}
function boundedText(value: string): string {
  return value.length > 1_000 ? `${value.slice(0, 1_000)} [truncated]` : value;
}
function failure(code: string, message: string): AgentToolFailure {
  return new AgentToolFailure(code, message, 'Refresh the Skill Library for current identities and supported next actions. Never edit the private lifecycle store.');
}
