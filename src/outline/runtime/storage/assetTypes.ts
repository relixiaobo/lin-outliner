import { Value } from 'typebox/value';
import {
  AssetLeaseSchema,
  AssetRecordSchema,
  type AssetLease,
  type AssetRecord,
} from '../../contract/schemas';
import type { ExactRevisionReference } from '../../../content';

export interface OutlineStoredAssetRecord {
  readonly record: AssetRecord;
  readonly exactRevision: ExactRevisionReference;
}

export interface OutlineAssetRetentionCoordinate {
  readonly record: Readonly<Record<string, unknown>> & { readonly assetId: string };
  readonly exactRevision: ExactRevisionReference;
}

export interface OutlineAssetStage extends OutlineStoredAssetRecord {
  readonly lease: AssetLease;
}

export interface OutlineAssetStageCoordinate extends OutlineAssetRetentionCoordinate {
  readonly lease: Readonly<Record<string, unknown>> & {
    readonly leaseId: string;
    readonly assetId: string;
  };
}

export function assertOutlineAssetStage(value: unknown): asserts value is OutlineAssetStage {
  if (!isRecord(value)
    || !Value.Check(AssetRecordSchema, value.record)
    || !Value.Check(AssetLeaseSchema, value.lease)
    || value.record.assetId !== value.lease.assetId
    || value.record.metadata.byteSize !== value.lease.metadata.byteSize
    || !isExactRevisionReference(value.exactRevision)
    || value.exactRevision.byteLength !== value.record.metadata.byteSize) {
    throw new Error('Invalid outline asset stage');
  }
}

export function assertOutlineStoredAssetRecord(value: unknown): asserts value is OutlineStoredAssetRecord {
  if (!isRecord(value)
    || !Value.Check(AssetRecordSchema, value.record)
    || !isExactRevisionReference(value.exactRevision)
    || value.exactRevision.byteLength !== value.record.metadata.byteSize) {
    throw new Error('Invalid stored outline AssetRecord');
  }
}

export function assertOutlineAssetRetentionCoordinate(
  value: unknown,
): asserts value is OutlineAssetRetentionCoordinate {
  if (!isRecord(value)
    || !isRecord(value.record)
    || typeof value.record.assetId !== 'string'
    || !value.record.assetId.trim()
    || !isExactRevisionReference(value.exactRevision)) {
    throw new Error('Invalid outline asset retention coordinate');
  }
}

export function assertOutlineAssetStageCoordinate(value: unknown): asserts value is OutlineAssetStageCoordinate {
  assertOutlineAssetRetentionCoordinate(value);
  const lease = (value as unknown as Record<string, unknown>).lease;
  if (!isRecord(lease)
    || typeof lease.leaseId !== 'string'
    || !lease.leaseId.trim()
    || lease.assetId !== value.record.assetId) {
    throw new Error('Invalid outline asset-stage identity');
  }
}

function isExactRevisionReference(value: unknown): value is ExactRevisionReference {
  return isRecord(value)
    && typeof value.anchorId === 'string'
    && Boolean(value.anchorId.trim())
    && Number.isSafeInteger(value.byteLength)
    && (value.byteLength as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
