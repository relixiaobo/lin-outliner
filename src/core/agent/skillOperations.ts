import type { ManagedSkillDiscoveryCandidateView, ManagedSkillDiscoveryView, ManagedSkillUpdatePreviewView, ManagedSkillView } from '../types';
import type { ObjectJsonSchema } from './tools';

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
function variant(operation: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'object', additionalProperties: false,
    properties: { operation: { type: 'string', const: operation }, ...properties },
    required: ['operation', ...required],
  };
}
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
