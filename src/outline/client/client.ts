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
import { OUTLINE_PROTOCOL_VERSION } from '../contract/version';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
type OutlineSuccessResponse = Extract<OutlineResponse, { ok: true }>;

export class OutlineClient {
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  constructor(readonly descriptor: RuntimeDescriptor) {}

  async request(command: string, input: unknown): Promise<OutlineSuccessResponse> {
    const request: OutlineRequest = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: `request:${crypto.randomUUID()}`,
      command,
      input,
    };
    const value = await this.jsonRequest('/v1/request', request);
    if (!Value.Check(OutlineResponseSchema, value)) {
      throw protocolError('Outline Runtime returned an invalid response envelope.');
    }
    if (value.requestId !== request.requestId || value.command !== command) {
      throw protocolError('Outline Runtime response identity does not match the request.');
    }
    if (value.ok === false) throw new OutlineContractError(value.error);
    return value;
  }

  watch(input: WatchRequest = {}, signal?: AbortSignal): AsyncGenerator<OutlineStreamRecord> {
    return this.stream('watch', input, signal);
  }

  async ingestAsset(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: { originalFilename?: string; mimeType?: string; signal?: AbortSignal } = {},
  ): Promise<AssetLease> {
    const requestId = `asset:${crypto.randomUUID()}`;
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
      signal: options.signal,
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
  }

  async *exportAsset(assetId: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const response = await this.openRequest({
      method: 'GET',
      path: `/v1/assets/${encodeURIComponent(assetId)}`,
      signal,
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
  }

  async *stream(command: string, input: unknown, signal?: AbortSignal): AsyncGenerator<OutlineStreamRecord> {
    const requestId = `stream:${crypto.randomUUID()}`;
    const request: OutlineRequest = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId,
      command,
      input,
    };
    const body = JSON.stringify(request);
    const response = await this.openRequest({
      method: 'POST',
      path: '/v1/stream',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      body,
      signal,
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
  }

  close(): void {
    this.agent.destroy();
  }

  private async jsonRequest(pathname: string, value: unknown): Promise<unknown> {
    const body = JSON.stringify(value);
    const response = await this.openRequest({
      method: 'POST',
      path: pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      body,
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
      const request = http.request({
        socketPath: this.descriptor.socketPath,
        method: options.method,
        path: options.path,
        headers: {
          authorization: `Bearer ${this.descriptor.bearerToken}`,
          ...options.headers,
        },
        agent: this.agent,
        signal: options.signal,
      }, resolve);
      request.once('error', reject);
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
      const request = http.request({
        socketPath: this.descriptor.socketPath,
        method: 'POST',
        path: options.path,
        headers: {
          authorization: `Bearer ${this.descriptor.bearerToken}`,
          'content-type': 'application/octet-stream',
          ...options.headers,
        },
        agent: this.agent,
        signal: options.signal,
      }, resolve);
      request.once('error', reject);
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
