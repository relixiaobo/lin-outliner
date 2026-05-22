export class AwaitTimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'AwaitTimeoutError';
  }
}

export interface AwaitWithAbortOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function awaitWithAbort<T>(
  promise: Promise<T>,
  { signal, timeoutMs }: AwaitWithAbortOptions = {},
): Promise<T> {
  throwIfAborted(signal);
  if (!signal && !timeoutMs) return promise;

  let abortListener: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await new Promise<T>((resolve, reject) => {
      promise.then(resolve, reject);

      if (signal) {
        abortListener = () => reject(abortReason(signal));
        signal.addEventListener('abort', abortListener, { once: true });
      }

      if (timeoutMs && timeoutMs > 0) {
        timeoutId = setTimeout(() => reject(new AwaitTimeoutError(`Operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }
    });
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted && (error === signal.reason || error === abortReason(signal))) return true;
  if (error instanceof DOMException) return error.name === 'AbortError';
  if (error instanceof Error) return error.name === 'AbortError';
  return false;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}
