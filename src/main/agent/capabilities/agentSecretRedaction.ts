import {
  containsSecretLikeContent,
  isCredentialCandidateString,
  isJsonEncodedArgumentField,
  REDACTED_SECRET,
  redactSecretLikeContent,
  scanSecretStrings,
  secretStringFieldConfidence,
  type SecretStringScanJob,
} from './agentSecretStringScanner';
import { scanSecretStringsOffMain } from './agentSecretRedactionWorkerClient';

export { containsSecretLikeContent, redactSecretLikeContent };

export const DIAGNOSTIC_SECRET_REDACTION_OMISSION = '[diagnostic payload omitted after redaction failure]';
const DIAGNOSTIC_SECRET_SCAN_CHARS = 64_000;
const SECRET_SCAN_YIELD_INTERVAL_MS = 8;

// A long unbroken token run (base64 / blob / data URI) - elided to a length note
// so an inline image/blob cannot bloat a debug payload or the cache.
const LARGE_BLOB_PATTERN = /[A-Za-z0-9+/=_-]{256,}/g;

export interface SecretRedactionResult<T> {
  readonly value: T;
  /** RFC 6901 JSON pointers whose persisted values differ from the source. */
  readonly redactedPaths: readonly string[];
}

/**
 * Redact complete durable values. Large batches run on the scanner worker; a
 * worker failure falls back to the same complete scanner on the main thread.
 */
export async function redactSecretLikeJsonAsync<T>(value: T): Promise<SecretRedactionResult<T>> {
  try {
    return await scanSecretLikeJson(value, null);
  } catch {
    return { value, redactedPaths: [] };
  }
}

/**
 * Redact a diagnostic-only copy with bounded scanner work. Text beyond the budget is
 * omitted from diagnostics, never from execution, replay, or the provider request.
 */
export async function redactSecretLikeJsonForDiagnostics<T>(
  value: T,
): Promise<SecretRedactionResult<T | typeof DIAGNOSTIC_SECRET_REDACTION_OMISSION>> {
  try {
    return await scanSecretLikeJson(value, DIAGNOSTIC_SECRET_SCAN_CHARS);
  } catch {
    return { value: DIAGNOSTIC_SECRET_REDACTION_OMISSION, redactedPaths: [''] };
  }
}

class PendingSecretString {
  output: string | null = null;

  constructor(
    readonly job: SecretStringScanJob,
    readonly path: string,
    readonly order: number,
  ) {}
}

interface RedactedPath {
  readonly path: string;
  readonly order: number;
}

async function scanSecretLikeJson<T>(
  value: T,
  scanBudget: number | null,
): Promise<SecretRedactionResult<T>> {
  let remainingChars = scanBudget;
  let pathOrder = 0;
  let lastYieldAt = performance.now();
  const pending: PendingSecretString[] = [];
  const redactedPaths: RedactedPath[] = [];

  const yieldIfNeeded = async () => {
    if (performance.now() - lastYieldAt < SECRET_SCAN_YIELD_INTERVAL_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastYieldAt = performance.now();
  };
  const stageString = (
    content: string,
    path: string,
    inspectEncodedJson: boolean,
  ): string | PendingSecretString => {
    const order = pathOrder++;
    if (remainingChars !== null) {
      if (content.length > remainingChars) {
        const omission = `[diagnostic text omitted after secret-scan budget: ${content.length} chars]`;
        if (omission !== content) redactedPaths.push({ path: path || '', order });
        return omission;
      }
      remainingChars -= content.length;
    }
    const entry = new PendingSecretString({ content, inspectEncodedJson }, path || '', order);
    pending.push(entry);
    return entry;
  };
  const visit = async (input: unknown, path: string, inspectEncodedJson = false): Promise<unknown> => {
    if (typeof input === 'string') return stageString(input, path, inspectEncodedJson);
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      for (const [index, entry] of input.entries()) {
        output.push(await visit(entry, `${path}/${index}`, inspectEncodedJson));
      }
      return output;
    }
    if (input === null || typeof input !== 'object') return input;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      const childPath = `${path}/${escapeJsonPointerToken(key)}`;
      const confidence = secretStringFieldConfidence(key);
      if (typeof entry === 'string' && confidence && isCredentialCandidateString(entry, confidence)) {
        const order = pathOrder++;
        if (entry !== REDACTED_SECRET) redactedPaths.push({ path: childPath, order });
        output[key] = REDACTED_SECRET;
      } else {
        output[key] = await visit(entry, childPath, isJsonEncodedArgumentField(key));
      }
      await yieldIfNeeded();
    }
    return output;
  };

  const staged = await visit(value, '');
  const jobs = pending.map((entry) => entry.job);
  let outputs: readonly string[];
  try {
    outputs = await scanSecretStringsOffMain(jobs);
  } catch {
    outputs = scanSecretStrings(jobs);
  }
  if (outputs.length !== pending.length) throw new Error('Secret scanner returned an incomplete batch.');
  for (const [index, entry] of pending.entries()) {
    const output = outputs[index];
    if (output === undefined) throw new Error('Secret scanner omitted a string result.');
    entry.output = output;
    if (output !== entry.job.content) redactedPaths.push({ path: entry.path, order: entry.order });
  }

  return {
    value: materializeStagedValue(staged) as T,
    redactedPaths: redactedPaths
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.path),
  };
}

function materializeStagedValue(value: unknown): unknown {
  if (value instanceof PendingSecretString) {
    if (value.output === null) throw new Error('Secret scanner result was not materialized.');
    return value.output;
  }
  if (Array.isArray(value)) return value.map(materializeStagedValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, materializeStagedValue(entry)]),
  );
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Elide long base64/blob runs to a length note (inline images, encoded blobs). */
export function elideLargeBlobs(content: string): string {
  LARGE_BLOB_PATTERN.lastIndex = 0;
  return content.replace(LARGE_BLOB_PATTERN, (match) => `[base64 elided: ${match.length} chars]`);
}
