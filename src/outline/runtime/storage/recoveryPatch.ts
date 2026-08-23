import type { CoreTransactionPatch } from '../../../core/core';
import type { Node } from '../../../core/types';
import { canonicalSha256 } from '../../contract/canonical';
import type { Operation } from '../../contract/schemas';
import {
  OUTLINE_RECOVERY_MINIMUM_DAYS,
  OUTLINE_STORAGE_VERSION,
} from '../../contract/version';

export const OUTLINE_RECOVERY_PATCH_VERSION = 1 as const;

export interface OutlineRecoveryNodePatch {
  readonly id: string;
  readonly before: Readonly<Node> | null;
  readonly after: Readonly<Node> | null;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
}

export interface OutlineRecoveryPatch {
  readonly kind: 'outline.recovery-patch';
  readonly storageVersion: typeof OUTLINE_STORAGE_VERSION;
  readonly patchVersion: typeof OUTLINE_RECOVERY_PATCH_VERSION;
  readonly recoveryPatchId: string;
  readonly operationId: string;
  readonly origin: Operation['origin'];
  readonly causation?: Operation['causation'];
  readonly changeSetHash: string;
  readonly diffHash: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly persistenceRevisionBefore: number;
  readonly persistenceRevisionAfter: number;
  readonly systemChanged: boolean;
  readonly nodes: readonly OutlineRecoveryNodePatch[];
  readonly affectedNodeIdsHash: string;
  readonly beforeStateHash: string;
  readonly afterStateHash: string;
  readonly protectedAssetRecordIds: readonly string[];
  readonly createdAt: string;
  readonly retainedUntilAtLeast: string;
}

export interface CreateOutlineRecoveryPatchInput {
  readonly operationId: string;
  readonly origin: Operation['origin'];
  readonly causation?: Operation['causation'];
  readonly changeSetHash: string;
  readonly diffHash: string;
  readonly corePatch: CoreTransactionPatch;
  readonly protectedAssetRecordIds?: readonly string[];
  readonly createdAt?: string;
  readonly minimumRetentionDays?: number;
}

export function createOutlineRecoveryPatch(input: CreateOutlineRecoveryPatchInput): OutlineRecoveryPatch {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const retentionDays = Math.max(0, input.minimumRetentionDays ?? OUTLINE_RECOVERY_MINIMUM_DAYS);
  const retainedUntilAtLeast = new Date(Date.parse(createdAt) + retentionDays * 86_400_000).toISOString();
  const nodes = input.corePatch.nodes.map((entry) => ({
    id: entry.id,
    before: entry.before,
    after: entry.after,
    beforeDigest: entry.before === null ? null : canonicalSha256(entry.before),
    afterDigest: entry.after === null ? null : canonicalSha256(entry.after),
  }));
  const identity = {
    operationId: input.operationId,
    changeSetHash: input.changeSetHash,
    diffHash: input.diffHash,
    revisionBefore: input.corePatch.revisionBefore,
    revisionAfter: input.corePatch.revisionAfter,
    nodes,
  };
  return deepFreeze({
    kind: 'outline.recovery-patch',
    storageVersion: OUTLINE_STORAGE_VERSION,
    patchVersion: OUTLINE_RECOVERY_PATCH_VERSION,
    recoveryPatchId: `recovery:${canonicalSha256(identity)}`,
    operationId: input.operationId,
    origin: input.origin,
    ...(input.causation ? { causation: input.causation } : {}),
    changeSetHash: input.changeSetHash,
    diffHash: input.diffHash,
    revisionBefore: input.corePatch.revisionBefore,
    revisionAfter: input.corePatch.revisionAfter,
    persistenceRevisionBefore: input.corePatch.persistenceRevisionBefore,
    persistenceRevisionAfter: input.corePatch.persistenceRevisionAfter,
    systemChanged: input.corePatch.systemChanged,
    nodes,
    affectedNodeIdsHash: canonicalSha256(nodes.map((entry) => entry.id)),
    beforeStateHash: canonicalSha256(nodes.map((entry) => [entry.id, entry.before])),
    afterStateHash: canonicalSha256(nodes.map((entry) => [entry.id, entry.after])),
    protectedAssetRecordIds: [...new Set(input.protectedAssetRecordIds ?? [])].sort(),
    createdAt,
    retainedUntilAtLeast,
  });
}

export function recoveryPatchToCorePatch(patch: OutlineRecoveryPatch): CoreTransactionPatch {
  return deepFreeze({
    revisionBefore: patch.revisionBefore,
    revisionAfter: patch.revisionAfter,
    persistenceRevisionBefore: patch.persistenceRevisionBefore,
    persistenceRevisionAfter: patch.persistenceRevisionAfter,
    systemChanged: patch.systemChanged,
    nodes: patch.nodes.map(({ id, before, after }) => ({ id, before, after })),
  });
}

export function assertOutlineRecoveryPatch(value: unknown): asserts value is OutlineRecoveryPatch {
  if (!isRecord(value)
    || value.kind !== 'outline.recovery-patch'
    || value.storageVersion !== OUTLINE_STORAGE_VERSION
    || value.patchVersion !== OUTLINE_RECOVERY_PATCH_VERSION
    || typeof value.recoveryPatchId !== 'string'
    || typeof value.operationId !== 'string'
    || typeof value.changeSetHash !== 'string'
    || typeof value.diffHash !== 'string'
    || !Number.isSafeInteger(value.revisionBefore)
    || !Number.isSafeInteger(value.revisionAfter)
    || !Number.isSafeInteger(value.persistenceRevisionBefore)
    || !Number.isSafeInteger(value.persistenceRevisionAfter)
    || typeof value.systemChanged !== 'boolean'
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isRecoveryNodePatch)
    || typeof value.affectedNodeIdsHash !== 'string'
    || typeof value.beforeStateHash !== 'string'
    || typeof value.afterStateHash !== 'string'
    || !Array.isArray(value.protectedAssetRecordIds)
    || !value.protectedAssetRecordIds.every((entry) => typeof entry === 'string')
    || typeof value.createdAt !== 'string'
    || typeof value.retainedUntilAtLeast !== 'string') {
    throw new Error('Invalid outline recovery patch');
  }
  const sortedIds = value.nodes.map((entry) => entry.id);
  if (sortedIds.some((id, index) => index > 0 && sortedIds[index - 1]! >= id)) {
    throw new Error('Outline recovery patch Nodes are not strictly sorted');
  }
  for (const entry of value.nodes) {
    if (entry.beforeDigest !== (entry.before === null ? null : canonicalSha256(entry.before))
      || entry.afterDigest !== (entry.after === null ? null : canonicalSha256(entry.after))) {
      throw new Error(`Outline recovery patch Node digest mismatch: ${entry.id}`);
    }
  }
  if (value.recoveryPatchId !== `recovery:${canonicalSha256({
    operationId: value.operationId,
    changeSetHash: value.changeSetHash,
    diffHash: value.diffHash,
    revisionBefore: value.revisionBefore,
    revisionAfter: value.revisionAfter,
    nodes: value.nodes,
  })}`
    || value.affectedNodeIdsHash !== canonicalSha256(value.nodes.map((entry) => entry.id))
    || value.beforeStateHash !== canonicalSha256(value.nodes.map((entry) => [entry.id, entry.before]))
    || value.afterStateHash !== canonicalSha256(value.nodes.map((entry) => [entry.id, entry.after]))) {
    throw new Error('Outline recovery patch aggregate digest mismatch');
  }
}

function isRecoveryNodePatch(value: unknown): value is OutlineRecoveryNodePatch {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  if (value.before !== null && !isRecord(value.before)) return false;
  if (value.after !== null && !isRecord(value.after)) return false;
  return (value.beforeDigest === null || typeof value.beforeDigest === 'string')
    && (value.afterDigest === null || typeof value.afterDigest === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
