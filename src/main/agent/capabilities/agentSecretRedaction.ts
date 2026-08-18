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
const DURABLE_SECRET_SCAN_FAILURE_WARNING = '[agent] Secret scanner worker failed; redacted all pending durable strings.';

type ScanSecretStringsOffMain = (
  jobs: readonly SecretStringScanJob[],
) => Promise<readonly string[] | null>;

// A long unbroken token run (base64 / blob / data URI) - elided to a length note
// so an inline image/blob cannot bloat a debug payload or the cache.
const LARGE_BLOB_PATTERN = /[A-Za-z0-9+/=_-]{256,}/g;

export interface SecretRedactionResult<T> {
  readonly value: T;
  /** RFC 6901 JSON pointers whose persisted values differ from the source. */
  readonly redactedPaths: readonly string[];
}

/**
 * Redact complete durable values. Large batches run on the scanner worker;
 * worker failure preserves the traversed shape while failing closed for every
 * pending string, without blocking Electron's main loop with a synchronous retry.
 */
export async function redactSecretLikeJsonAsync<T>(
  value: T,
  scanOffMain: ScanSecretStringsOffMain = scanSecretStringsOffMain,
): Promise<SecretRedactionResult<T>> {
  try {
    return await scanSecretLikeJson(value, null, scanOffMain);
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
    return await scanSecretLikeJson(value, DIAGNOSTIC_SECRET_SCAN_CHARS, scanSecretStringsOffMain);
  } catch {
    return { value: DIAGNOSTIC_SECRET_REDACTION_OMISSION, redactedPaths: [''] };
  }
}

class PendingSecretString {
  constructor(
    readonly job: SecretStringScanJob,
    readonly path: string,
    readonly order: number,
    readonly apply: (output: string) => void,
  ) {}
}

interface RedactedPath {
  readonly path: string;
  readonly order: number;
}

async function scanSecretLikeJson<T>(
  value: T,
  scanBudget: number | null,
  scanOffMain: ScanSecretStringsOffMain,
): Promise<SecretRedactionResult<T>> {
  let remainingChars = scanBudget;
  let pathOrder = 0;
  let lastYieldAt = performance.now();
  const pending: PendingSecretString[] = [];
  const redactedPaths: RedactedPath[] = [];
  const root: { value?: unknown } = {};

  const yieldIfNeeded = async () => {
    if (performance.now() - lastYieldAt < SECRET_SCAN_YIELD_INTERVAL_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastYieldAt = performance.now();
  };
  const stageString = (
    content: string,
    path: string,
    inspectEncodedJson: boolean,
    apply: (output: string) => void,
  ): void => {
    const order = pathOrder++;
    if (remainingChars !== null) {
      if (content.length > remainingChars) {
        const omission = `[diagnostic text omitted after secret-scan budget: ${content.length} chars]`;
        if (omission !== content) redactedPaths.push({ path: path || '', order });
        apply(omission);
        return;
      }
      remainingChars -= content.length;
    }
    // Establish the original container key/index order before deferred worker output arrives.
    apply(content);
    pending.push(new PendingSecretString(
      { content, inspectEncodedJson },
      path || '',
      order,
      apply,
    ));
  };
  const visit = async (
    input: unknown,
    path: string,
    inspectEncodedJson: boolean,
    apply: (output: unknown) => void,
  ): Promise<void> => {
    if (typeof input === 'string') {
      stageString(input, path, inspectEncodedJson, apply);
      return;
    }
    if (Array.isArray(input)) {
      const output: unknown[] = [];
      apply(output);
      for (const [index, entry] of input.entries()) {
        await visit(entry, `${path}/${index}`, inspectEncodedJson, (value) => { output[index] = value; });
      }
      return;
    }
    if (input === null || typeof input !== 'object') {
      apply(input);
      return;
    }
    const output: Record<string, unknown> = {};
    apply(output);
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      const childPath = `${path}/${escapeJsonPointerToken(key)}`;
      const confidence = secretStringFieldConfidence(key);
      if (typeof entry === 'string' && confidence && isCredentialCandidateString(entry, confidence)) {
        const order = pathOrder++;
        if (entry !== REDACTED_SECRET) redactedPaths.push({ path: childPath, order });
        output[key] = REDACTED_SECRET;
      } else {
        await visit(entry, childPath, isJsonEncodedArgumentField(key), (value) => { output[key] = value; });
      }
      await yieldIfNeeded();
    }
  };

  await visit(value, '', false, (output) => { root.value = output; });
  const jobs = pending.map((entry) => entry.job);
  let offMainOutputs: readonly string[] | null;
  try {
    offMainOutputs = await scanOffMain(jobs);
  } catch {
    if (scanBudget !== null) throw new Error('Diagnostic secret scanner worker failed.');
    for (const entry of pending) {
      entry.apply(REDACTED_SECRET);
      if (entry.job.content !== REDACTED_SECRET) {
        redactedPaths.push({ path: entry.path, order: entry.order });
      }
    }
    warnDurableSecretScanFailure();
    return buildSecretRedactionResult(root, redactedPaths);
  }
  const outputs = offMainOutputs ?? scanSecretStrings(jobs);
  if (outputs.length !== pending.length) throw new Error('Secret scanner returned an incomplete batch.');
  for (const [index, entry] of pending.entries()) {
    const output = outputs[index];
    if (output === undefined) throw new Error('Secret scanner omitted a string result.');
    entry.apply(output);
    if (output !== entry.job.content) redactedPaths.push({ path: entry.path, order: entry.order });
  }

  return buildSecretRedactionResult(root, redactedPaths);
}

function buildSecretRedactionResult<T>(
  root: { value?: unknown },
  redactedPaths: RedactedPath[],
): SecretRedactionResult<T> {
  return {
    value: root.value as T,
    redactedPaths: redactedPaths
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.path),
  };
}

function warnDurableSecretScanFailure(): void {
  try {
    console.warn(DURABLE_SECRET_SCAN_FAILURE_WARNING);
  } catch {
    // Logging must not turn a worker failure back into the outer fail-open path.
  }
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Elide long base64/blob runs to a length note (inline images, encoded blobs). */
export function elideLargeBlobs(content: string): string {
  LARGE_BLOB_PATTERN.lastIndex = 0;
  return content.replace(LARGE_BLOB_PATTERN, (match) => `[base64 elided: ${match.length} chars]`);
}
