import { createHash } from 'node:crypto';
import type { TSchema } from 'typebox';
import type { SkillInspectRequest, SkillManageRequest, SkillPageInput, SkillReview } from '../../core/agent/skillOperations';
import { SKILL_INSPECT_SCHEMA, SKILL_MANAGE_SCHEMA } from '../../core/agent/skillOperations';
import type { ManagedSkillView } from '../../core/types';
import { ManagedSkillService } from '../managedSkillService';
import { AgentSkillRuntime, skillLifecycleIdentity } from '../agent/capabilities/agentSkills';
import { analyzeAgentSkills } from '../agent/capabilities/agentSkillCuration';
import { AgentToolFailure } from '../agent/AgentToolFailure';
import { compileToolParameters } from '../agent/runtime/kernel/exactToolArguments';
import type { DeferredToolAuthority } from '../agent/runtime/ToolRuntime';

export interface SkillOperationCaller {
  readonly key: string;
  readonly runtime: AgentSkillRuntime;
  readonly origin: { readonly kind: 'window'; readonly windowId: number } | {
    readonly kind: 'agent'; readonly threadId: string; readonly turnId: string; readonly itemId: string;
  };
  readonly signal?: AbortSignal;
  readonly authorize: DeferredToolAuthority;
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
  async function library(caller: SkillOperationCaller) {
    const installed = await service.list();
    const local = (await caller.runtime.listAllSkills()).filter((skill) => skill.source !== 'managed');
    const managed = await Promise.all(installed.map(async (skill) => {
      const definition = await caller.runtime.getSkill(skill.name);
      const eligibility = definition?.source === 'managed'
        ? await availability(caller, definition)
        : { available: false, reason: 'integrity_compatibility_or_shadowing' };
      return { ...managedSummary(skill), ...eligibility };
    }));
    const mutable = await Promise.all(local.map(async (skill) => ({
      identity: skillLifecycleIdentity(skill), name: skill.name, source: skill.source,
      description: skill.description.slice(0, 1_000), contentHash: skill.contentHash ?? null,
      file: skill.source === 'built-in' ? null : skill.skillFile,
      canUndo: skill.canUndoLastAgentEdit ?? false,
      ...await availability(caller, skill),
    })));
    return [...managed, ...mutable].sort((a, b) => a.identity.localeCompare(b.identity));
  }

  async function inspect(value: unknown, caller: SkillOperationCaller): Promise<unknown> {
    const request = decode<SkillInspectRequest>(value, SKILL_INSPECT_SCHEMA);
    await caller.authorize('skill_inspect', { request }, caller.signal);
    switch (request.operation) {
      case 'list': return page(await library(caller), request, caller.key, 'list');
      case 'inspect': {
        const row = (await library(caller)).find((entry) => entry.identity === request.identity);
        if (!row) throw failure('target_unavailable', 'The Skill identity is unavailable in this context.');
        const undo = row.source === 'user' || row.source === 'project'
          ? await caller.runtime.inspectUndoTarget(row.identity).catch(() => null) : null;
        return { skill: row, undo, nextActions: row.source === 'managed'
          ? ['check_updates', 'preview_update', ...('previousHash' in row && row.previousHash ? ['rollback'] : []), 'uninstall']
          : row.source === 'built-in' ? [] : undo ? ['undo_edit', 'file_edit'] : ['file_edit'] };
      }
      case 'catalog': {
        const catalog = await service.loadCatalog();
        return { status: catalog.status, error: catalog.error ?? null, ...page(catalog.entries, request, caller.key, 'catalog') };
      }
      case 'discover': {
        const found = await service.discover(request);
        const candidates = boundedRows(found.candidates.map((candidate) => ({
          id: candidate.id, name: candidate.name, subdirectory: candidate.subdirectory,
          description: candidate.description.slice(0, 1_000), scripts: candidate.scripts.slice(0, 20),
          scriptsOmitted: Math.max(0, candidate.scripts.length - 20),
          instructions: candidate.skillBody?.slice(0, 1_000) ?? null,
          instructionsTruncated: candidate.skillBodyTruncated === true || (candidate.skillBody?.length ?? 0) > 1_000,
        })));
        return {
          discoveryId: found.id, repository: found.repository, commit: found.resolvedCommit,
          candidates: candidates.items, candidatesOmitted: candidates.omitted,
          ...(candidates.omitted ? { instructions: 'Discover a specific repository subdirectory to inspect omitted candidates.' } : {}),
          nextAction: 'install',
        };
      }
      case 'check_updates': {
        const skills = await service.checkUpdates(request.skillId);
        changed();
        const updates = boundedRows(skills.filter((skill) => skill.updateCommit).map(managedSummary));
        return { checked: skills.length, updates: updates.items, updatesOmitted: updates.omitted,
          ...(updates.omitted ? { instructions: 'Use list and check_updates with a skillId to inspect omitted updates.' } : {}) };
      }
      case 'preview_update': {
        const skill = (await service.list()).find((entry) => entry.id === request.skillId);
        if (skill?.revision !== request.expectedRevision) throw failure('stale_target', 'Inspect the current installed Skill again.');
        const preview = await service.previewUpdate(request);
        const paths = boundedRows(preview.changedPaths);
        return { previewId: preview.id, skillId: preview.skillId, expectedRevision: skill.revision,
          currentHash: preview.current.contentHash, candidateHash: preview.candidate.contentHash,
          commit: preview.candidate.commit, changedPaths: paths.items, changedPathsOmitted: paths.omitted,
          diff: preview.skillDiff, diffTruncated: preview.diffTruncated, nextAction: 'apply_update' };
      }
      case 'curation': {
        const report = await analyzeAgentSkills(await caller.runtime.listCurationCandidates());
        return { findingCount: report.findingCount, ...page(report.rows, request, caller.key, 'curation') };
      }
    }
  }

  async function manage(value: unknown, caller: SkillOperationCaller): Promise<unknown> {
    const request = decode<SkillManageRequest>(value, SKILL_MANAGE_SCHEMA);
    const authorize = async (fileWritePath?: string) => {
      caller.signal?.throwIfAborted();
      await caller.authorize('skill_manage', { request }, caller.signal, fileWritePath);
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
    const observed = await library(caller).then((rows) => rows.find((row) => row.identity === identity) ?? null).catch(() => {
      runtimeRefresh = { state: 'failed', message: 'Saved, but current Skill availability could not be observed.' };
      return null;
    });
    return { committed: true, operation: request.operation, identity,
      version: committed ? managedSummary(committed) : null,
      observed, runtimeRefresh: { ...runtimeRefresh,
        ...(runtimeRefresh.message ? { message: boundedText(runtimeRefresh.message) } : {}) } };
  }
  return { inspect, manage };
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
function boundedRows<T>(rows: readonly T[]) {
  const items: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > 64_000) break;
    items.push(row);
    bytes += size;
  }
  return { items, omitted: rows.length - items.length };
}
function page<T>(rows: readonly T[], input: SkillPageInput, caller: string, kind: string) {
  const snapshot = hash(JSON.stringify(rows));
  const view = hash(`${caller}:${kind}`);
  let offset = 0;
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (decoded.snapshot !== snapshot || decoded.view !== view || !Number.isSafeInteger(decoded.offset)
        || decoded.offset < 0 || decoded.offset >= rows.length) throw new Error('stale');
      offset = decoded.offset;
    } catch { throw failure('stale_cursor', 'The library view changed. Start a fresh query.'); }
  }
  const items: T[] = [];
  let bytes = 0;
  for (const row of rows.slice(offset, offset + (input.limit ?? 20))) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > 100_000) break;
    items.push(row);
    bytes += size;
  }
  if (items.length === 0 && offset < rows.length) throw failure('result_too_large', 'This report entry exceeds the bounded result limit.');
  const next = offset + items.length;
  return { items, total: rows.length, snapshot, nextCursor: next < rows.length
    ? Buffer.from(JSON.stringify({ snapshot, view, offset: next })).toString('base64url') : null };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function failure(code: string, message: string): AgentToolFailure {
  return new AgentToolFailure(code, message, 'Use skill_inspect for current identities and supported next actions. Never edit the private lifecycle store.');
}

export type SkillLifecycle = ReturnType<typeof createSkillLifecycle>;
