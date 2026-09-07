import type { ManagedSkillDiscoveryCandidateView, ManagedSkillDiscoveryView, ManagedSkillUpdatePreviewView, ManagedSkillView } from '../types';
import type { ObjectJsonSchema } from './tools';

export interface SkillPageInput { readonly cursor?: string; readonly limit?: number }
export interface ManagedSkillTarget {
  readonly skillId: string;
  readonly expectedRevision: string;
  readonly expectedActiveHash: string;
}
export interface SkillUndoTarget {
  readonly identity: string;
  readonly currentHash: string;
  readonly previousHash: string;
}
export type SkillInspectRequest =
  | ({ readonly operation: 'list' | 'catalog' | 'curation' } & SkillPageInput)
  | { readonly operation: 'inspect'; readonly identity: string }
  | { readonly operation: 'discover'; readonly sourceUrl?: string; readonly catalogId?: string }
  | { readonly operation: 'check_updates'; readonly skillId?: string }
  | ({ readonly operation: 'preview_update' } & ManagedSkillTarget);
export type SkillManageRequest =
  | { readonly operation: 'install'; readonly discoveryId: string; readonly candidateId: string; readonly expectedCommit: string }
  | ({ readonly operation: 'apply_update'; readonly previewId: string; readonly expectedCandidateHash: string } & ManagedSkillTarget)
  | ({ readonly operation: 'rollback'; readonly expectedPreviousHash: string } & ManagedSkillTarget)
  | ({ readonly operation: 'uninstall' } & ManagedSkillTarget)
  | ({ readonly operation: 'undo_edit' } & SkillUndoTarget);

export type SkillReview =
  | { readonly kind: 'install'; readonly discovery: ManagedSkillDiscoveryView; readonly candidate: ManagedSkillDiscoveryCandidateView }
  | { readonly kind: 'update'; readonly preview: ManagedSkillUpdatePreviewView; readonly skillBody: string }
  | { readonly kind: 'rollback' | 'uninstall'; readonly skill: ManagedSkillView };

export const SKILL_REVIEW_GET_CHANNEL = 'lin:skill-review-get';
export const SKILL_REVIEW_DECIDE_CHANNEL = 'lin:skill-review-decide';
export const SKILL_LIBRARY_CHANGED_CHANNEL = 'lin:skill-library-changed';
export const SKILL_REVIEW_PRELOAD_ARG = '--tenon-skill-review';
export const SKILL_OPERATION_TTL_MS = 30 * 60 * 1_000;

const text = { type: 'string', minLength: 1, maxLength: 2_048 };
const hash = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const target = { skillId: text, expectedRevision: text, expectedActiveHash: hash };
const page = { cursor: text, limit: { type: 'integer', minimum: 1, maximum: 50 } };
function variant(operation: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'object', additionalProperties: false,
    properties: { operation: { type: 'string', const: operation }, ...properties },
    required: ['operation', ...required],
  };
}
export const SKILL_INSPECT_SCHEMA: ObjectJsonSchema = {
  type: 'object', additionalProperties: false, required: ['request'],
  properties: { request: { anyOf: [
    ...['list', 'catalog', 'curation'].map((operation) => variant(operation, page)),
    variant('inspect', { identity: text }, ['identity']),
    variant('discover', { sourceUrl: text }, ['sourceUrl']),
    variant('discover', { catalogId: text }, ['catalogId']),
    variant('check_updates', { skillId: text }),
    variant('preview_update', target, Object.keys(target)),
  ] } },
};
export const SKILL_MANAGE_SCHEMA: ObjectJsonSchema = {
  type: 'object', additionalProperties: false, required: ['request'],
  properties: { request: { anyOf: [
    variant('install', { discoveryId: text, candidateId: text, expectedCommit: { type: 'string', pattern: '^[0-9a-f]{40}$' } }, ['discoveryId', 'candidateId', 'expectedCommit']),
    variant('apply_update', { ...target, previewId: text, expectedCandidateHash: hash }, [...Object.keys(target), 'previewId', 'expectedCandidateHash']),
    variant('rollback', { ...target, expectedPreviousHash: hash }, [...Object.keys(target), 'expectedPreviousHash']),
    variant('uninstall', target, Object.keys(target)),
    variant('undo_edit', { identity: text, currentHash: hash, previousHash: hash }, ['identity', 'currentHash', 'previousHash']),
  ] } },
};

const outputText = { type: 'string', maxLength: 256 * 1024 };
const flag = { type: 'boolean' };
const count = { type: 'integer', minimum: 0 };
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const list = (items: unknown, maximum = 4_096) => ({ type: 'array', items, maxItems: maximum });
const object = (properties: Record<string, unknown>, required: string[] = []): ObjectJsonSchema => ({
  type: 'object', additionalProperties: false, properties, required,
});
const diagnostic = object({ code: outputText, detail: outputText }, ['code']);
const managedSummary = {
  identity: outputText, source: outputText, name: outputText, skillId: outputText,
  revision: outputText, contentHash: nullable(outputText), commit: outputText,
  previousHash: nullable(outputText), repository: outputText, subdirectory: outputText,
  status: outputText, diagnostic: nullable(diagnostic),
};
const libraryItem = object({ ...managedSummary, description: outputText, file: nullable(outputText),
  canUndo: flag, available: flag, reason: nullable(outputText) }, ['identity', 'source', 'name']);
const catalogItem = object({ id: outputText, name: outputText, description: outputText,
  repository: outputText, subdirectory: outputText, trackingRef: outputText,
  compatibilityRange: outputText, installedSkillId: outputText }, ['id', 'name']);
const curationRow = object({ name: outputText, identity: nullable(outputText), source: outputText,
  rootDir: outputText, currentHash: nullable(outputText), included: flag,
  exclusionReason: nullable(outputText), findings: list(object({ kind: outputText, severity: outputText,
    message: outputText, evidence: outputText }, ['kind', 'severity', 'message', 'evidence'])) },
['name', 'identity', 'source', 'rootDir', 'currentHash', 'included', 'exclusionReason', 'findings']);
const undoTarget = object({ identity: outputText, currentHash: outputText, previousHash: outputText }, ['identity', 'currentHash', 'previousHash']);
export const SKILL_INSPECT_OUTPUT_SCHEMA = object({
  items: list({ anyOf: [libraryItem, catalogItem, curationRow] }, 50),
  total: count, snapshot: outputText, nextCursor: nullable(outputText),
  status: outputText, error: nullable(diagnostic),
  skill: libraryItem, undo: nullable(undoTarget), nextActions: list(outputText, 8),
  discoveryId: outputText, repository: outputText, commit: outputText,
  candidates: list(object({ id: outputText, name: outputText, subdirectory: outputText,
    description: outputText, scripts: list(outputText, 20), scriptsOmitted: count,
    instructions: nullable(outputText), instructionsTruncated: flag,
  }, ['id', 'name', 'subdirectory', 'description', 'scripts', 'scriptsOmitted', 'instructions', 'instructionsTruncated'])),
  nextAction: outputText, checked: count, updates: list(object(managedSummary, ['identity', 'source', 'name'])),
  candidatesOmitted: count, updatesOmitted: count, changedPathsOmitted: count, instructions: outputText,
  previewId: outputText, skillId: outputText, expectedRevision: outputText,
  currentHash: outputText, candidateHash: outputText, changedPaths: list(outputText),
  diff: outputText, diffTruncated: flag, findingCount: count,
});
export const SKILL_MANAGE_OUTPUT_SCHEMA = object({
  committed: { type: 'boolean', const: true }, operation: outputText, identity: outputText,
  restoredHash: outputText, version: nullable(object(managedSummary, ['identity', 'source', 'name'])),
  observed: nullable(libraryItem),
  runtimeRefresh: object({ state: { type: 'string', enum: ['applied', 'failed'] }, message: outputText }, ['state']),
}, ['committed', 'operation', 'identity', 'runtimeRefresh']);
