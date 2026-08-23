import { Value } from 'typebox/value';
import {
  AssetLeaseSchema,
  AssetRecordSchema,
  type AssetLease,
  type AssetRecord,
} from '../../contract/schemas';

export interface OutlineAssetStage {
  readonly record: AssetRecord;
  readonly lease: AssetLease;
}

export function assertOutlineAssetStage(value: unknown): asserts value is OutlineAssetStage {
  if (!isRecord(value)
    || !Value.Check(AssetRecordSchema, value.record)
    || !Value.Check(AssetLeaseSchema, value.lease)
    || value.record.assetId !== value.lease.assetId
    || value.record.metadata.sha256 !== value.lease.metadata.sha256
    || value.record.metadata.byteSize !== value.lease.metadata.byteSize) {
    throw new Error('Invalid outline asset stage');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
