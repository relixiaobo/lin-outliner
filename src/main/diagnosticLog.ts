import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  diagnosticSourceLabel,
  serializeUnknownError,
  type DiagnosticEnvironment,
  type DiagnosticExportArtifact,
  type DiagnosticLogRecord,
  type ErrorReport,
  type ErrorReportContext,
  type ErrorReportContextValue,
  type ErrorSeverity,
} from '../core/errorObservability';
import { serializeJsonl } from './appendOnlySeqLog';
import { atomicWriteFile } from './jsonFileStore';

const DIAGNOSTICS_DIR = 'diagnostics';
const DIAGNOSTIC_LOG_FILE = 'errors.jsonl';
const DIAGNOSTIC_RECORD_LIMIT = 200;
const DIAGNOSTIC_FLUSH_DEBOUNCE_MS = 250;
const DIAGNOSTIC_DIRTY_FLUSH_THRESHOLD = 32;
const DIAGNOSTIC_LOG_BYTE_LIMIT = 2 * 1024 * 1024;
const LOGGER_OVERFLOW_FINGERPRINT = 'diagnostic-logger-overflow';
const MAX_MESSAGE_CHARS = 1_000;
const MAX_CONTEXT_STRING_CHARS = 240;
const MAX_CONTEXT_ARRAY_ITEMS = 20;

const ALLOWED_CONTEXT_KEYS = new Set([
  'agentId',
  'attempt',
  'backoffMs',
  'code',
  'column',
  'conversationId',
  'count',
  'currentVersion',
  'delayMs',
  'domain',
  'errorMessage',
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

export interface DiagnosticLogCounters {
  enqueuedReports: number;
  flushCount: number;
  droppedReports: number;
  droppedFingerprints: number;
  dirtyFingerprints: number;
  lastFlushDurationMs: number;
  lastFlushError?: string;
  lastLoadError?: string;
}

export class DiagnosticLogStore {
  private loaded = false;
  private loading: Promise<void> | null = null;
  private readonly recordsByFingerprint = new Map<string, DiagnosticLogRecord>();
  private readonly dirtySeqByFingerprint = new Map<string, number>();
  private latestSeq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<void> | null = null;
  private readonly counters: DiagnosticLogCounters = {
    enqueuedReports: 0,
    flushCount: 0,
    droppedReports: 0,
    droppedFingerprints: 0,
    dirtyFingerprints: 0,
    lastFlushDurationMs: 0,
  };

  constructor(private readonly userDataDir: string) {}

  get logPath(): string {
    return path.join(this.userDataDir, DIAGNOSTICS_DIR, DIAGNOSTIC_LOG_FILE);
  }

  async reportError(report: ErrorReport): Promise<DiagnosticLogRecord> {
    await this.ensureLoaded();
    this.counters.enqueuedReports += 1;
    const record = this.upsertReport(report, Date.now());
    this.enforceRecordLimit();
    this.scheduleFlush();
    return cloneDiagnosticLogRecord(record);
  }

  async readRecords(): Promise<DiagnosticLogRecord[]> {
    await this.ensureLoaded();
    return this.projectRecordsForRead();
  }

  async ensureLogFile(): Promise<string> {
    await this.flushNow({ reason: 'reveal' });
    return this.logPath;
  }

  async writeExport(filePath: string, environment: DiagnosticEnvironment): Promise<string> {
    await this.flushNow({ reason: 'export' }).catch((error) => {
      this.recordFlushFailure(error);
    });
    const artifact: DiagnosticExportArtifact = {
      v: 1,
      exportedAt: Date.now(),
      environment,
      records: await this.readRecords(),
    };
    await atomicWriteFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
    return filePath;
  }

  async flushNow(options: { timeoutMs?: number; reason?: string } = {}): Promise<void> {
    await this.ensureLoaded();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const flush = this.startFlush(options.reason ?? 'manual');
    if (!options.timeoutMs || options.timeoutMs <= 0) {
      await flush;
      while (this.dirtySeqByFingerprint.size > 0 && !this.counters.lastFlushError) {
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        await this.startFlush(options.reason ?? 'manual');
      }
      return;
    }
    await Promise.race([
      flush,
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, options.timeoutMs);
        timeout.unref?.();
      }),
    ]);
  }

  getCountersForTests(): DiagnosticLogCounters {
    return {
      ...this.counters,
      dirtyFingerprints: this.dirtySeqByFingerprint.size,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.loadExistingRecords().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  private async loadExistingRecords(): Promise<void> {
    try {
      const parsed = parseDiagnosticRecordsJsonl(await readFile(this.logPath, 'utf8'), this.logPath);
      const projected = projectDiagnosticRecords(parsed);
      this.recordsByFingerprint.clear();
      for (const record of projected) {
        this.recordsByFingerprint.set(record.fingerprint, cloneDiagnosticLogRecord(record));
        this.latestSeq = Math.max(this.latestSeq, record.seq);
      }
      this.enforceRecordLimit({ markOverflow: false });
    } catch (error) {
      if (!isNotFoundError(error)) {
        this.counters.lastLoadError = error instanceof Error ? error.message : String(error);
        console.error('[diagnostics] failed to load diagnostic log', error);
      }
      this.recordsByFingerprint.clear();
      this.latestSeq = 0;
    } finally {
      this.loaded = true;
    }
  }

  private upsertReport(report: ErrorReport, now: number): DiagnosticLogRecord {
    const normalized = normalizeReport(report);
    const fingerprint = fingerprintForReport(normalized);
    const existing = this.recordsByFingerprint.get(fingerprint);
    const record: DiagnosticLogRecord = {
      v: 1,
      seq: this.nextSeq(),
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
    this.recordsByFingerprint.set(fingerprint, record);
    this.markDirty(record);
    return record;
  }

  private nextSeq(): number {
    this.latestSeq += 1;
    return this.latestSeq;
  }

  private markDirty(record: DiagnosticLogRecord): void {
    this.dirtySeqByFingerprint.set(record.fingerprint, record.seq);
    this.counters.dirtyFingerprints = this.dirtySeqByFingerprint.size;
  }

  private scheduleFlush(): void {
    if (this.dirtySeqByFingerprint.size >= DIAGNOSTIC_DIRTY_FLUSH_THRESHOLD) {
      void this.flushNow({ reason: 'threshold' }).catch((error) => this.recordFlushFailure(error));
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow({ reason: 'debounce' }).catch((error) => this.recordFlushFailure(error));
    }, DIAGNOSTIC_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private startFlush(reason: string): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    const dirtyAtStart = new Map(this.dirtySeqByFingerprint);
    const startedAt = performance.now();
    const flush = this.writeCompactLog(reason)
      .then(() => {
        for (const [fingerprint, seq] of dirtyAtStart) {
          if (this.dirtySeqByFingerprint.get(fingerprint) === seq) {
            this.dirtySeqByFingerprint.delete(fingerprint);
          }
        }
        this.counters.flushCount += 1;
        this.counters.lastFlushDurationMs = performance.now() - startedAt;
        delete this.counters.lastFlushError;
      })
      .catch((error) => {
        this.recordFlushFailure(error, startedAt);
      })
      .finally(() => {
        if (this.flushInFlight === flush) this.flushInFlight = null;
        this.counters.dirtyFingerprints = this.dirtySeqByFingerprint.size;
        if (this.dirtySeqByFingerprint.size > 0 && !this.flushTimer) this.scheduleFlush();
      });
    this.flushInFlight = flush;
    return flush;
  }

  private async writeCompactLog(_reason: string): Promise<void> {
    const records = this.recordsForDisk();
    await atomicWriteFile(this.logPath, records.length === 0 ? '' : serializeJsonl(records));
  }

  private recordFlushFailure(error: unknown, startedAt = performance.now()): void {
    this.counters.lastFlushDurationMs = performance.now() - startedAt;
    this.counters.lastFlushError = error instanceof Error ? error.message : String(error);
    console.error('[diagnostics] failed to flush diagnostic log', error);
  }

  private projectRecordsForRead(): DiagnosticLogRecord[] {
    return [...this.recordsByFingerprint.values()]
      .map((record) => cloneDiagnosticLogRecord(record))
      .sort((left, right) => right.lastAt - left.lastAt || right.seq - left.seq);
  }

  private recordsForDisk(): DiagnosticLogRecord[] {
    const records = [...this.recordsByFingerprint.values()]
      .map((record) => cloneDiagnosticLogRecord(record))
      .sort((left, right) => left.seq - right.seq);
    while (records.length > 1 && serializedByteLength(records) > DIAGNOSTIC_LOG_BYTE_LIMIT) {
      const dropIndex = firstDroppableRecordIndex(records);
      if (dropIndex < 0) break;
      records.splice(dropIndex, 1);
    }
    return records;
  }

  private enforceRecordLimit(options: { markOverflow?: boolean } = {}): void {
    const markOverflow = options.markOverflow ?? true;
    const reserveOverflowSlot = markOverflow && !this.recordsByFingerprint.has(LOGGER_OVERFLOW_FINGERPRINT);
    const normalRecordLimit = reserveOverflowSlot ? DIAGNOSTIC_RECORD_LIMIT - 1 : DIAGNOSTIC_RECORD_LIMIT;
    let droppedReports = 0;
    let droppedFingerprints = 0;
    while (this.recordsByFingerprint.size > normalRecordLimit) {
      const oldest = [...this.recordsByFingerprint.values()]
        .filter((record) => record.fingerprint !== LOGGER_OVERFLOW_FINGERPRINT)
        .sort((left, right) => left.lastAt - right.lastAt || left.seq - right.seq)[0];
      if (!oldest) break;
      this.recordsByFingerprint.delete(oldest.fingerprint);
      this.dirtySeqByFingerprint.delete(oldest.fingerprint);
      droppedReports += oldest.count;
      droppedFingerprints += 1;
    }
    if (droppedReports <= 0) return;
    this.counters.droppedReports += droppedReports;
    this.counters.droppedFingerprints += droppedFingerprints;
    if (markOverflow) this.upsertOverflowRecord(droppedReports, droppedFingerprints);
  }

  private upsertOverflowRecord(droppedReports: number, droppedFingerprints: number): void {
    const now = Date.now();
    const existing = this.recordsByFingerprint.get(LOGGER_OVERFLOW_FINGERPRINT);
    const context = sanitizeContext({
      count: (typeof existing?.context?.count === 'number' ? existing.context.count : 0) + droppedReports,
      foundVersion: (typeof existing?.context?.foundVersion === 'number' ? existing.context.foundVersion : 0) + droppedFingerprints,
      operation: 'diagnostic-log-overflow',
    });
    const record: DiagnosticLogRecord = {
      v: 1,
      seq: this.nextSeq(),
      eventId: `diag:${randomUUID()}`,
      ts: now,
      firstAt: existing?.firstAt ?? now,
      lastAt: now,
      count: (existing?.count ?? 0) + droppedReports,
      domain: 'runtime',
      severity: 'warn',
      code: 'diagnostic-log-overflow',
      fingerprint: LOGGER_OVERFLOW_FINGERPRINT,
      message: 'Diagnostic log dropped reports because the retained record limit was exceeded.',
      ...(context ? { context } : {}),
    };
    this.recordsByFingerprint.set(record.fingerprint, record);
    this.markDirty(record);
  }
}

function cloneDiagnosticLogRecord(record: DiagnosticLogRecord): DiagnosticLogRecord {
  return {
    ...record,
    ...(record.context ? { context: { ...record.context } } : {}),
  };
}

function serializedByteLength(records: readonly DiagnosticLogRecord[]): number {
  return Buffer.byteLength(records.length === 0 ? '' : serializeJsonl(records));
}

function firstDroppableRecordIndex(records: readonly DiagnosticLogRecord[]): number {
  let index = -1;
  for (let candidate = 0; candidate < records.length; candidate += 1) {
    if (records[candidate]?.fingerprint === LOGGER_OVERFLOW_FINGERPRINT) continue;
    if (
      index < 0
      || records[candidate]!.lastAt < records[index]!.lastAt
      || (records[candidate]!.lastAt === records[index]!.lastAt && records[candidate]!.seq < records[index]!.seq)
    ) {
      index = candidate;
    }
  }
  return index;
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
    ...(serializedError.message ? { errorMessage: serializedError.message } : {}),
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
