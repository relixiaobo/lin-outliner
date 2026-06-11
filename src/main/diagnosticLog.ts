import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  diagnosticSourceLabel,
  type DiagnosticEnvironment,
  type DiagnosticExportArtifact,
  type DiagnosticLogRecord,
  type ErrorReport,
  type ErrorReportContext,
  type ErrorReportContextValue,
  type ErrorSeverity,
} from '../core/errorObservability';
import { AppendOnlySeqLog, serializeJsonl } from './appendOnlySeqLog';

const DIAGNOSTICS_DIR = 'diagnostics';
const DIAGNOSTIC_LOG_FILE = 'errors.jsonl';
const DIAGNOSTIC_LOG_KEY = 'diagnostic-errors';
const DIAGNOSTIC_RECORD_LIMIT = 200;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_CONTEXT_STRING_CHARS = 240;
const MAX_CONTEXT_ARRAY_ITEMS = 20;

const ALLOWED_CONTEXT_KEYS = new Set([
  'agentId',
  'attempt',
  'backoffMs',
  'code',
  'column',
  'commandNodeId',
  'conversationId',
  'count',
  'currentVersion',
  'delayMs',
  'domain',
  'dueAt',
  'errorName',
  'eventType',
  'expectedVersion',
  'fileKind',
  'foundVersion',
  'lastSuccessAt',
  'line',
  'modelId',
  'nodeId',
  'operation',
  'principalKey',
  'providerId',
  'rootKind',
  'runId',
  'source',
  'stackHash',
  'status',
  'statusCode',
]);

export class DiagnosticLogStore {
  private readonly log = new AppendOnlySeqLog<DiagnosticLogRecord>('diagnostic error', parseDiagnosticRecordsJsonl);

  constructor(private readonly userDataDir: string) {}

  get logPath(): string {
    return path.join(this.userDataDir, DIAGNOSTICS_DIR, DIAGNOSTIC_LOG_FILE);
  }

  async reportError(report: ErrorReport): Promise<DiagnosticLogRecord> {
    return this.log.enqueue(DIAGNOSTIC_LOG_KEY, async () => {
      const now = Date.now();
      const normalized = normalizeReport(report);
      const fingerprint = fingerprintForReport(normalized);
      const existingRecords = projectDiagnosticRecords(await this.log.readIfExists(this.logPath));
      const existing = existingRecords.find((record) => record.fingerprint === fingerprint);
      const latestSeq = await this.log.latestSeq(DIAGNOSTIC_LOG_KEY, [this.logPath]);
      const record: DiagnosticLogRecord = {
        v: 1,
        seq: latestSeq + 1,
        eventId: `diag:${randomUUID()}`,
        ts: now,
        firstAt: existing?.firstAt ?? now,
        lastAt: now,
        count: (existing?.count ?? 0) + 1,
        domain: normalized.domain,
        severity: normalized.severity,
        ...(normalized.code ? { code: normalized.code } : {}),
        fingerprint,
        message: normalized.message,
        ...(normalized.context ? { context: normalized.context } : {}),
      };
      await this.log.appendForKey(DIAGNOSTIC_LOG_KEY, this.logPath, [record]);
      await this.compact();
      return record;
    });
  }

  async readRecords(): Promise<DiagnosticLogRecord[]> {
    return projectDiagnosticRecords(await this.log.readIfExists(this.logPath))
      .sort((left, right) => right.lastAt - left.lastAt || right.seq - left.seq);
  }

  async ensureLogFile(): Promise<string> {
    await mkdir(path.dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, '', 'utf8');
    return this.logPath;
  }

  async writeExport(filePath: string, environment: DiagnosticEnvironment): Promise<string> {
    const artifact: DiagnosticExportArtifact = {
      v: 1,
      exportedAt: Date.now(),
      environment,
      records: await this.readRecords(),
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return filePath;
  }

  private async compact(): Promise<void> {
    let records = projectDiagnosticRecords(await this.log.readIfExists(this.logPath));
    if (records.length > DIAGNOSTIC_RECORD_LIMIT) {
      records = records
        .sort((left, right) => right.lastAt - left.lastAt || right.seq - left.seq)
        .slice(0, DIAGNOSTIC_RECORD_LIMIT);
    }
    records.sort((left, right) => left.seq - right.seq);
    await atomicWriteFile(this.logPath, records.length === 0 ? '' : serializeJsonl(records));
    this.log.setLatestSeq(DIAGNOSTIC_LOG_KEY, records.at(-1)?.seq ?? 0);
  }
}

export function serializeUnknownError(error: unknown): { name?: string; message?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (isRecord(error)) {
    const name = typeof error.name === 'string' ? error.name : undefined;
    const message = typeof error.message === 'string' ? error.message : undefined;
    const stack = typeof error.stack === 'string' ? error.stack : undefined;
    return {
      ...(name ? { name } : {}),
      ...(message ? { message } : {}),
      ...(stack ? { stack } : {}),
    };
  }
  if (typeof error === 'string') return { message: error };
  if (error === undefined) return {};
  return { message: String(error) };
}

function normalizeReport(report: ErrorReport): Required<Pick<ErrorReport, 'domain' | 'severity' | 'message'>> & {
  code?: string;
  context?: ErrorReportContext;
} {
  const serializedError = serializeUnknownError(report.error);
  const domain = sanitizeToken(report.domain || 'uncaught', 'uncaught');
  const severity = sanitizeSeverity(report.severity);
  const code = report.code ? sanitizeToken(report.code, '') : undefined;
  const message = truncateText(report.message || serializedError.message || 'Unknown error', MAX_MESSAGE_CHARS);
  const contextSource = {
    ...report.context,
    ...(serializedError.name ? { errorName: serializedError.name } : {}),
    ...(serializedError.stack ? { stackHash: shortHash(serializedError.stack) } : {}),
  };
  const context = sanitizeContext(contextSource);
  return {
    domain,
    severity,
    message,
    ...(code ? { code } : {}),
    ...(context ? { context } : {}),
  };
}

function sanitizeSeverity(severity: ErrorSeverity): ErrorSeverity {
  return severity === 'warn' || severity === 'error' || severity === 'fatal' ? severity : 'error';
}

function sanitizeToken(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9:._-]+/g, '-').replace(/-+/g, '-').slice(0, 80);
  return normalized || fallback;
}

function sanitizeContext(input: Record<string, unknown>): ErrorReportContext | undefined {
  const output: ErrorReportContext = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_CONTEXT_KEYS.has(key)) continue;
    const normalized = key === 'source' ? sanitizeSourceContextValue(value) : sanitizeContextValue(value);
    if (normalized !== undefined) output[key] = normalized;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeSourceContextValue(value: unknown): ErrorReportContextValue | undefined {
  const normalized = sanitizeContextValue(value);
  if (typeof normalized === 'string') return diagnosticSourceLabel(normalized);
  if (!Array.isArray(normalized) || !normalized.every((item): item is string => typeof item === 'string')) {
    return undefined;
  }
  const labels = normalized
    .map((item) => diagnosticSourceLabel(item))
    .filter((item): item is string => Boolean(item));
  return labels.length > 0 ? labels : undefined;
}

function sanitizeContextValue(value: unknown): ErrorReportContextValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return truncateText(value, MAX_CONTEXT_STRING_CHARS);
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, MAX_CONTEXT_ARRAY_ITEMS);
  if (items.every((item): item is string => typeof item === 'string')) {
    return items.map((item) => truncateText(item, MAX_CONTEXT_STRING_CHARS));
  }
  if (items.every((item): item is number => typeof item === 'number' && Number.isFinite(item))) return items;
  if (items.every((item): item is boolean => typeof item === 'boolean')) return items;
  return undefined;
}

function fingerprintForReport(report: {
  domain: string;
  severity: ErrorSeverity;
  code?: string;
  message: string;
  context?: ErrorReportContext;
}): string {
  return `err:${shortHash(JSON.stringify({
    domain: report.domain,
    severity: report.severity,
    code: report.code ?? null,
    message: normalizeFingerprintMessage(report.message),
    errorName: report.context?.errorName ?? null,
    stackHash: report.context?.stackHash ?? null,
  }))}`;
}

function normalizeFingerprintMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':uuid')
    .replace(/\b[0-9a-f]{16,}\b/gi, ':hex')
    .replace(/\b\d{4,}\b/g, ':n')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function projectDiagnosticRecords(records: readonly DiagnosticLogRecord[]): DiagnosticLogRecord[] {
  const byFingerprint = new Map<string, DiagnosticLogRecord>();
  for (const record of records) {
    if (!normalizeDiagnosticLogRecord(record)) continue;
    const existing = byFingerprint.get(record.fingerprint);
    if (!existing || record.seq > existing.seq) byFingerprint.set(record.fingerprint, record);
  }
  return [...byFingerprint.values()];
}

function parseDiagnosticRecordsJsonl(raw: string, source: string): DiagnosticLogRecord[] {
  const records: DiagnosticLogRecord[] = [];
  const lines = raw.split(/\r?\n/);
  let lastContentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim().length > 0) {
      lastContentIndex = index;
      break;
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const record = normalizeDiagnosticLogRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch (error) {
      if (index === lastContentIndex) break;
      throw new Error(`Invalid diagnostic error JSON at ${source}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

function normalizeDiagnosticLogRecord(value: unknown): DiagnosticLogRecord | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!isPositiveInteger(value.seq) || typeof value.eventId !== 'string') return null;
  if (!isFiniteNumber(value.ts) || !isFiniteNumber(value.firstAt) || !isFiniteNumber(value.lastAt)) return null;
  if (!isPositiveInteger(value.count)) return null;
  if (typeof value.domain !== 'string' || typeof value.severity !== 'string') return null;
  if (value.severity !== 'warn' && value.severity !== 'error' && value.severity !== 'fatal') return null;
  if (typeof value.fingerprint !== 'string' || typeof value.message !== 'string') return null;
  const code = typeof value.code === 'string' ? value.code : undefined;
  const context = isRecord(value.context) ? sanitizeContext(value.context) : undefined;
  return {
    v: 1,
    seq: value.seq,
    eventId: value.eventId,
    ts: value.ts,
    firstAt: value.firstAt,
    lastAt: value.lastAt,
    count: value.count,
    domain: value.domain,
    severity: value.severity,
    ...(code ? { code } : {}),
    fingerprint: value.fingerprint,
    message: value.message,
    ...(context ? { context } : {}),
  };
}

async function atomicWriteFile(filePath: string, data: string | Buffer) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
