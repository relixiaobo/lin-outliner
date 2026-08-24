import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Value } from 'typebox/value';
import { OutlineContractError, outlineError } from '../contract/errors';
import {
  OutlineErrorSchema,
  AssetLeaseSchema,
  OutlineResponseSchema,
  OutlineStreamRecordSchema,
  type OutlineRequest,
  type OutlineResponse,
  type OutlineStreamRecord,
  type RuntimeDescriptor,
  type AssetLease,
  type WatchRequest,
} from '../contract/schemas';
import {
  OUTLINE_DEFAULT_COMMAND_TIMEOUT_MS,
  OUTLINE_MAX_COMMAND_TIMEOUT_MS,
  OUTLINE_PROTOCOL_VERSION,
} from '../contract/version';
import {
  OUTLINE_AGENT_ATTESTATION_HEADER,
  OUTLINE_ORIGIN_HEADER,
} from '../contract/agentAttestation';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
type OutlineSuccessResponse = Extract<OutlineResponse, { ok: true }>;

export class OutlineClient {
  // A watch owns one long-lived socket. Requests and asset transfers must still
  // settle through this shared client while that stream remains open.
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  private readonly requestTimeoutMs: number;

  constructor(
    readonly descriptor: RuntimeDescriptor,
    private readonly context: {
      readonly origin?: 'desktop' | 'local-user' | 'external-client' | 'built-in-agent';
      readonly agentAttestation?: string;
      readonly requestTimeoutMs?: number;
    } = {},
  ) {
    const timeoutMs = context.requestTimeoutMs ?? OUTLINE_DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > OUTLINE_MAX_COMMAND_TIMEOUT_MS) {
      throw new RangeError(`Outline request timeout must be between 1 and ${OUTLINE_MAX_COMMAND_TIMEOUT_MS} ms.`);
    }
    this.requestTimeoutMs = timeoutMs;
  }

  async request(command: string, input: unknown, signal?: AbortSignal): Promise<OutlineSuccessResponse> {
    const value = await this.requestResponse(command, input, signal);
    if (value.ok === false) throw new OutlineContractError(value.error);
    return value;
  }

  async requestResponse(command: string, input: unknown, signal?: AbortSignal): Promise<OutlineResponse> {
    const lifetime = createRequestLifetime(signal, this.requestTimeoutMs);
    const request: OutlineRequest = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: `request:${crypto.randomUUID()}`,
      command,
      input,
    };
    try {
      const value = await this.jsonRequest('/v1/request', request, lifetime.signal);
      if (!Value.Check(OutlineResponseSchema, value)) {
        throw protocolError('Outline Runtime returned an invalid response envelope.');
      }
      if (value.requestId !== request.requestId || value.command !== command) {
        throw protocolError('Outline Runtime response identity does not match the request.');
      }
      return value;
    } catch (error) {
      throw normalizeRequestError(error, lifetime);
    } finally {
      lifetime.cleanup();
    }
  }

  watch(input: WatchRequest = {}, signal?: AbortSignal): AsyncGenerator<OutlineStreamRecord> {
    return this.stream('watch', input, signal);
  }

  async ingestAsset(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: { originalFilename?: string; mimeType?: string; signal?: AbortSignal } = {},
  ): Promise<AssetLease> {
    const lifetime = createRequestLifetime(options.signal, this.requestTimeoutMs);
    const requestId = `asset:${crypto.randomUUID()}`;
    try {
      const response = await this.openUploadRequest({
        path: '/v1/assets/ingest',
        headers: {
          'x-outline-request-id': requestId,
          ...(options.originalFilename ? {
            'x-outline-filename': Buffer.from(options.originalFilename, 'utf8').toString('base64url'),
          } : {}),
          ...(options.mimeType ? { 'x-outline-mime-type': options.mimeType } : {}),
        },
        source,
        signal: lifetime.signal,
      });
      const value = await readResponseJson(response);
      if (response.statusCode !== 200) throwDecodedHttpError(value, response.statusCode, 'asset ingest');
      if (!Value.Check(OutlineResponseSchema, value)
        || value.ok === false
        || value.requestId !== requestId
        || value.command !== 'asset ingest'
        || !Value.Check(AssetLeaseSchema, value.data)) {
        throw protocolError('Outline Runtime returned an invalid asset ingest response.');
      }
      return value.data;
    } catch (error) {
      throw normalizeRequestError(error, lifetime);
    } finally {
      lifetime.cleanup();
    }
  }

  async diffArtifact(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: {
      readonly inputFormat: 'json' | 'jsonl';
      readonly idempotencyKey?: string;
      readonly idempotencyKeyMode?: 'exact' | 'if-missing';
      readonly signal?: AbortSignal;
    },
  ): Promise<OutlineDiffArtifact> {
    const lifetime = createRequestLifetime(options.signal, this.requestTimeoutMs);
    const requestId = `diff:${crypto.randomUUID()}`;
    try {
      const response = await this.openUploadRequest({
        path: '/v1/diff',
        headers: {
          'content-type': options.inputFormat === 'jsonl'
            ? 'application/x-ndjson; charset=utf-8'
            : 'application/json; charset=utf-8',
          'x-outline-request-id': requestId,
          'x-outline-input-format': options.inputFormat,
          ...(options.idempotencyKey ? {
            'x-outline-idempotency-key-mode': options.idempotencyKeyMode ?? 'exact',
          } : {}),
          ...(options.idempotencyKey ? {
            'x-outline-idempotency-key': Buffer.from(options.idempotencyKey, 'utf8').toString('base64url'),
          } : {}),
        },
        source,
        signal: lifetime.signal,
      });
      if (response.statusCode !== 200) await throwHttpError(response, 'Diff upload');
      const expectedRequestId = response.headers['x-outline-request-id'];
      const expectedDigest = response.headers['x-outline-sha256'];
      const expectedBytes = Number(response.headers['content-length']);
      if (expectedRequestId !== requestId
        || typeof expectedDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(expectedDigest)
        || !Number.isSafeInteger(expectedBytes)
        || expectedBytes < 0) {
        response.destroy();
        throw protocolError('Outline Runtime returned invalid Diff artifact headers.');
      }
      let consumed = false;
      return {
        byteCount: expectedBytes,
        sha256: expectedDigest,
        chunks: (async function* () {
          try {
            if (consumed) throw protocolError('Outline Diff artifact stream was already consumed.');
            consumed = true;
            const hash = createHash('sha256');
            let byteCount = 0;
            for await (const chunk of response) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              byteCount += bytes.byteLength;
              hash.update(bytes);
              yield bytes;
            }
            if (byteCount !== expectedBytes || hash.digest('hex') !== expectedDigest) {
              throw protocolError('Outline Runtime Diff artifact failed integrity verification.');
            }
          } catch (error) {
            throw normalizeRequestError(error, lifetime);
          } finally {
            lifetime.cleanup();
          }
        })(),
      };
    } catch (error) {
      lifetime.cleanup();
      throw normalizeRequestError(error, lifetime);
    }
  }

  async *exportAsset(assetId: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const lifetime = createRequestLifetime(signal, this.requestTimeoutMs);
    try {
      const response = await this.openRequest({
        method: 'GET',
        path: `/v1/assets/${encodeURIComponent(assetId)}`,
        signal: lifetime.signal,
      });
      if (response.statusCode !== 200) await throwHttpError(response, 'asset export');
      const expectedDigest = response.headers['x-outline-sha256'];
      const expectedBytes = Number(response.headers['content-length']);
      if (typeof expectedDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(expectedDigest)
        || !Number.isSafeInteger(expectedBytes)
        || expectedBytes < 0) {
        throw protocolError('Outline Runtime returned invalid asset export headers.');
      }
      const hash = createHash('sha256');
      let byteCount = 0;
      for await (const chunk of response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += bytes.byteLength;
        hash.update(bytes);
        yield bytes;
      }
      if (byteCount !== expectedBytes || hash.digest('hex') !== expectedDigest) {
        throw protocolError('Outline Runtime asset export failed integrity verification.');
      }
    } catch (error) {
      throw normalizeRequestError(error, lifetime);
    } finally {
      lifetime.cleanup();
    }
  }

  async serveAsset(assetId: string, range: string | null, signal?: AbortSignal): Promise<Response> {
    const lifetime = createRequestLifetime(signal, this.requestTimeoutMs);
    let response: http.IncomingMessage;
    try {
      response = await this.openRequest({
        method: 'GET',
        path: `/v1/assets/${encodeURIComponent(assetId)}`,
        headers: range ? { range } : undefined,
        signal: lifetime.signal,
      });
      if (response.statusCode !== 200 && response.statusCode !== 206 && response.statusCode !== 416) {
        await throwHttpError(response, 'asset export');
      }
    } catch (error) {
      this.close();
      lifetime.cleanup();
      throw normalizeRequestError(error, lifetime);
    }
    const headers = new Headers();
    for (const name of [
      'accept-ranges',
      'cache-control',
      'content-length',
      'content-range',
      'content-type',
      'x-outline-asset-id',
      'x-outline-sha256',
    ]) {
      const value = response.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const iterator = response[Symbol.asyncIterator]();
    const close = () => {
      lifetime.cleanup();
      this.close();
    };
    if (response.statusCode === 416) close();
    const body = response.statusCode === 416 ? null : new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await iterator.next();
          if (next.done) {
            close();
            controller.close();
          } else {
            controller.enqueue(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
          }
        } catch (error) {
          close();
          controller.error(normalizeRequestError(error, lifetime));
        }
      },
      cancel: async () => {
        response.destroy();
        await iterator.return?.();
        close();
      },
    });
    return new Response(body, { status: response.statusCode, headers });
  }

  async *stream(command: string, input: unknown, signal?: AbortSignal): AsyncGenerator<OutlineStreamRecord> {
    const lifetime = createRequestLifetime(signal, this.requestTimeoutMs);
    const requestId = `stream:${crypto.randomUUID()}`;
    const request: OutlineRequest = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId,
      command,
      input,
    };
    const body = JSON.stringify(request);
    try {
      const response = await this.openRequest({
        method: 'POST',
        path: '/v1/stream',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        body,
        signal: lifetime.signal,
      });
      if (response.statusCode !== 200) {
        await throwHttpError(response, command);
      }
      let buffered = '';
      let expectedSequence = 0;
      let sawHello = false;
      let sawEnd = false;
      for await (const chunk of response) {
        buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (Buffer.byteLength(buffered) > MAX_RESPONSE_BYTES) {
          response.destroy();
          throw protocolError('Outline Runtime watch record exceeds the byte limit.');
        }
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line) {
            let record: unknown;
            try {
              record = JSON.parse(line) as unknown;
            } catch {
              throw protocolError('Outline Runtime returned an invalid JSONL record.');
            }
            if (!Value.Check(OutlineStreamRecordSchema, record)) {
              throw protocolError('Outline Runtime returned an invalid stream record.');
            }
            if (record.requestId !== requestId || record.sequence !== expectedSequence) {
              throw protocolError('Outline Runtime stream identity or sequence is invalid.');
            }
            if (!sawHello && record.type !== 'hello') {
              throw protocolError('Outline Runtime stream did not begin with a hello record.');
            }
            if (sawHello && record.type === 'hello') {
              throw protocolError('Outline Runtime stream returned more than one hello record.');
            }
            if (sawEnd) throw protocolError('Outline Runtime stream returned data after its end record.');
            expectedSequence += 1;
            sawHello = true;
            sawEnd = record.type === 'end';
            yield record;
          }
          newline = buffered.indexOf('\n');
        }
      }
      if (buffered.trim()) throw protocolError('Outline Runtime watch ended with a truncated record.');
      if (!sawHello) throw protocolError('Outline Runtime stream ended before its hello record.');
      if (command !== 'watch' && !sawEnd) throw protocolError('Outline Runtime stream ended before its end record.');
    } catch (error) {
      throw normalizeRequestError(error, lifetime);
    } finally {
      lifetime.cleanup();
    }
  }

  close(): void {
    this.agent.destroy();
  }

  private async jsonRequest(pathname: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const body = JSON.stringify(value);
    const response = await this.openRequest({
      method: 'POST',
      path: pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      body,
      signal,
    });
    const parsed = await readResponseJson(response);
    if (response.statusCode !== 200) {
      throwDecodedHttpError(parsed, response.statusCode, 'request');
    }
    return parsed;
  }

  private openRequest(options: {
    method: string;
    path: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
    signal?: AbortSignal;
  }): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      let response: http.IncomingMessage | undefined;
      const request = http.request({
        socketPath: this.descriptor.socketPath,
        method: options.method,
        path: options.path,
        headers: {
          authorization: `Bearer ${this.descriptor.bearerToken}`,
          ...(this.context.origin ? { [OUTLINE_ORIGIN_HEADER]: this.context.origin } : {}),
          ...(this.context.agentAttestation
            ? { [OUTLINE_AGENT_ATTESTATION_HEADER]: this.context.agentAttestation }
            : {}),
          ...options.headers,
        },
        agent: this.agent,
      }, (value) => {
        response = value;
        resolve(value);
      });
      request.once('error', reject);
      bindRequestAbort(request, () => response, reject, options.signal);
      if (options.body) request.write(options.body);
      request.end();
    });
  }

  private openUploadRequest(options: {
    path: string;
    headers?: http.OutgoingHttpHeaders;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      let response: http.IncomingMessage | undefined;
      const request = http.request({
        socketPath: this.descriptor.socketPath,
        method: 'POST',
        path: options.path,
        headers: {
          authorization: `Bearer ${this.descriptor.bearerToken}`,
          ...(this.context.origin ? { [OUTLINE_ORIGIN_HEADER]: this.context.origin } : {}),
          ...(this.context.agentAttestation
            ? { [OUTLINE_AGENT_ATTESTATION_HEADER]: this.context.agentAttestation }
            : {}),
          'content-type': 'application/octet-stream',
          ...options.headers,
        },
        agent: this.agent,
      }, (value) => {
        response = value;
        resolve(value);
      });
      request.once('error', reject);
      bindRequestAbort(request, () => response, reject, options.signal);
      void (async () => {
        try {
          for await (const chunk of options.source) {
            if (!request.write(chunk)) await once(request, 'drain');
          }
          request.end();
        } catch (error) {
          request.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
}

function bindRequestAbort(
  request: http.ClientRequest,
  response: () => http.IncomingMessage | undefined,
  reject: (reason: Error) => void,
  signal?: AbortSignal,
): void {
  if (!signal) return;
  const abort = () => {
    const error = signal.reason instanceof Error
      ? signal.reason
      : new Error(signal.reason ? String(signal.reason) : 'Outline Runtime request was aborted.');
    reject(error);
    response()?.destroy(error);
    request.destroy(error);
  };
  const cleanup = () => signal.removeEventListener('abort', abort);
  request.once('error', cleanup);
  request.once('close', () => {
    if (!response()) cleanup();
  });
  request.once('response', (value) => value.once('close', cleanup));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
}

export interface OutlineDiffArtifact {
  readonly byteCount: number;
  readonly sha256: string;
  readonly chunks: AsyncIterable<Uint8Array>;
}

interface RequestLifetime {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly timedOut: () => boolean;
  readonly cleanup: () => void;
}

function createRequestLifetime(signal: AbortSignal | undefined, timeoutMs: number): RequestLifetime {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Outline Runtime request exceeded ${timeoutMs} ms.`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function normalizeRequestError(error: unknown, lifetime: RequestLifetime): unknown {
  if (!lifetime.timedOut()) return error;
  return new OutlineContractError(outlineError(
    'runtime_unavailable',
    'unavailable',
    `Outline Runtime did not settle the request within ${lifetime.timeoutMs} ms.`,
    { retryable: true, details: { timeoutMs: lifetime.timeoutMs } },
  ));
}

async function readResponseJson(response: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw protocolError('Outline Runtime response exceeds the byte limit.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw protocolError('Outline Runtime returned invalid JSON.');
  }
}

async function throwHttpError(response: http.IncomingMessage, operation: string): Promise<never> {
  const parsed = await readResponseJson(response);
  throwDecodedHttpError(parsed, response.statusCode, operation);
}

function throwDecodedHttpError(value: unknown, statusCode: number | undefined, operation: string): never {
  if (isRecord(value) && Value.Check(OutlineErrorSchema, value.error)) {
    throw new OutlineContractError(value.error);
  }
  throw protocolError(`Outline Runtime ${operation} failed with HTTP ${statusCode ?? 0}.`);
}

function protocolError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError(
    'protocol_incompatible',
    'protocol',
    message,
    { retryable: false },
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
