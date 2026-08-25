import { createReadStream } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalSha256 } from '../../contract/canonical';
import { OutlineContractError, outlineError } from '../../contract/errors';
import { ChangeSetSchema, type ChangeSet } from '../../contract/schemas';
import { checkOutlineSchema } from '../../contract/validation';
import { ensurePrivateDirectory } from './runtimePaths';

export const OUTLINE_CHANGESET_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;
export const OUTLINE_CHANGESET_RECORD_LIMIT_BYTES = 8 * 1024 * 1024;

export async function readChangeSetUpload(
  root: string,
  source: AsyncIterable<Uint8Array>,
  format: 'json' | 'jsonl',
  idempotencyKey?: string,
  idempotencyKeyMode: 'exact' | 'if-missing' = 'exact',
): Promise<ChangeSet> {
  const spoolDirectory = path.join(root, 'spool');
  await ensurePrivateDirectory(spoolDirectory);
  const spoolPath = path.join(spoolDirectory, `changeset-${crypto.randomUUID()}.spool`);
  const handle = await open(spoolPath, 'wx', 0o600);
  try {
    let totalBytes = 0;
    let recordBytes = 0;
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > OUTLINE_CHANGESET_UPLOAD_LIMIT_BYTES) {
        throw invalidUpload(`ChangeSet upload exceeds ${OUTLINE_CHANGESET_UPLOAD_LIMIT_BYTES} bytes.`);
      }
      if (format === 'jsonl') {
        for (const byte of bytes) {
          if (byte === 0x0a) recordBytes = 0;
          else if (++recordBytes > OUTLINE_CHANGESET_RECORD_LIMIT_BYTES) {
            throw invalidUpload(`JSONL ChangeSet record exceeds ${OUTLINE_CHANGESET_RECORD_LIMIT_BYTES} bytes.`);
          }
        }
      }
      await writeAll(handle, bytes);
    }
    if (totalBytes === 0) throw invalidUpload('ChangeSet upload is empty.');
    await handle.sync();
    await handle.close();
    return await (format === 'jsonl'
      ? readJsonlChangeSet(spoolPath, idempotencyKey, idempotencyKeyMode)
      : readJsonChangeSet(spoolPath, idempotencyKey, idempotencyKeyMode));
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  } finally {
    await rm(spoolPath, { force: true }).catch(() => undefined);
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (written.bytesWritten <= 0) throw new Error('ChangeSet spool write made no progress.');
    offset += written.bytesWritten;
  }
}

async function readJsonChangeSet(
  filePath: string,
  idempotencyKey?: string,
  idempotencyKeyMode: 'exact' | 'if-missing' = 'exact',
): Promise<ChangeSet> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw invalidUpload('ChangeSet input is not valid JSON.', error);
  }
  return admitChangeSet(value, idempotencyKey, idempotencyKeyMode);
}

async function readJsonlChangeSet(
  filePath: string,
  idempotencyKey?: string,
  idempotencyKeyMode: 'exact' | 'if-missing' = 'exact',
): Promise<ChangeSet> {
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let header: Record<string, unknown> | undefined;
  let pending: unknown;
  const operations: unknown[] = [];
  let recordIndex = 0;
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const value = parseJsonRecord(line, recordIndex++);
    if (!header) {
      if (!isRecord(value) || 'operations' in value) {
        throw invalidUpload('JSONL ChangeSet header must be an object without operations.');
      }
      header = value;
      continue;
    }
    if (pending !== undefined) operations.push(operationRecord(pending, operations.length));
    pending = value;
    if (operations.length > 100_000) throw invalidUpload('JSONL ChangeSet exceeds 100000 operations.');
  }
  if (!header || pending === undefined || operations.length === 0) {
    throw invalidUpload('JSONL ChangeSet requires a header, operations, and trailer.');
  }
  if (!isRecord(pending)
    || !Number.isSafeInteger(pending.operationCount)
    || typeof pending.sha256 !== 'string'
    || Object.keys(pending).some((key) => key !== 'operationCount' && key !== 'sha256')) {
    throw invalidUpload('JSONL ChangeSet trailer is invalid.');
  }
  if (pending.operationCount !== operations.length) {
    throw invalidUpload('JSONL ChangeSet operation count does not match its records.');
  }
  const uploadedChangeSet = admitChangeSet({ ...header, operations });
  if (pending.sha256 !== canonicalSha256(uploadedChangeSet)) {
    throw invalidUpload('JSONL ChangeSet SHA-256 does not match its records.');
  }
  return admitChangeSet(uploadedChangeSet, idempotencyKey, idempotencyKeyMode);
}

function admitChangeSet(
  value: unknown,
  idempotencyKey?: string,
  idempotencyKeyMode: 'exact' | 'if-missing' = 'exact',
): ChangeSet {
  if (!isRecord(value)) throw invalidUpload('ChangeSet input must be an object.');
  const existingKey = value.idempotencyKey;
  if (idempotencyKey
    && idempotencyKeyMode === 'exact'
    && existingKey !== undefined
    && existingKey !== idempotencyKey) {
    throw invalidUpload('--idempotency-key does not match the ChangeSet input.');
  }
  const candidate = idempotencyKey && existingKey === undefined ? { ...value, idempotencyKey } : value;
  if (!checkOutlineSchema(ChangeSetSchema, candidate)) {
    throw invalidUpload('ChangeSet input does not match the public schema.');
  }
  return candidate;
}

function parseJsonRecord(line: string, index: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw invalidUpload(`JSONL ChangeSet record ${index + 1} is not valid JSON.`, error);
  }
}

function operationRecord(value: unknown, index: number): unknown {
  if (!isRecord(value)
    || !('operation' in value)
    || Object.keys(value).some((key) => key !== 'operation')) {
    throw invalidUpload(`JSONL ChangeSet operation record ${index + 1} is invalid.`);
  }
  return value.operation;
}

function invalidUpload(message: string, cause?: unknown): OutlineContractError {
  return new OutlineContractError(outlineError(
    'invalid_input',
    'usage',
    message,
    cause === undefined ? undefined : { details: cause instanceof Error ? cause.message : String(cause) },
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
