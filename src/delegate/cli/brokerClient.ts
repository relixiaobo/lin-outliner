import http from 'node:http';
import {
  decodeDelegateLaunchCapability,
  DELEGATE_PROTOCOL_VERSION,
  type DelegateBrokerRequest,
  type DelegateBrokerResponse,
  type DelegateLaunchCapability,
  type DelegateStateCommand,
} from '../contract';
import type { DelegateStateExecutor } from './runner';

const MAX_BROKER_RESPONSE_BYTES = 8 * 1024 * 1024;

export class DelegateBrokerError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'unauthorized' | 'unavailable' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'DelegateBrokerError';
  }
}

export class DelegateBrokerClient implements DelegateStateExecutor {
  constructor(private readonly capability: DelegateLaunchCapability) {}

  async execute(command: DelegateStateCommand, _input: unknown, signal?: AbortSignal): Promise<unknown> {
    const request: DelegateBrokerRequest = {
      version: DELEGATE_PROTOCOL_VERSION,
      capability: this.capability,
      command,
    };
    const response = await postJson(this.capability.brokerSocketPath, request, signal);
    if (!response.ok) throw new DelegateBrokerError(response.error.code, response.error.message);
    return response.data;
  }
}

function postJson(
  socketPath: string,
  body: DelegateBrokerRequest,
  signal?: AbortSignal,
): Promise<DelegateBrokerResponse> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request({
      socketPath,
      path: '/v1/execute',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': encoded.byteLength,
      },
      signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_BROKER_RESPONSE_BYTES) {
          response.destroy(new Error('Delegate broker response exceeds its byte limit'));
          return;
        }
        chunks.push(value);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const parsed = decodeBrokerResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end(encoded);
  });
}

function decodeBrokerResponse(value: unknown): DelegateBrokerResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('Invalid Delegate broker response');
  if (value.ok === true && Object.hasOwn(value, 'data')) return { ok: true, data: value.data };
  if (value.ok === false && isRecord(value.error)
    && (value.error.code === 'invalid_input' || value.error.code === 'unauthorized'
      || value.error.code === 'unavailable' || value.error.code === 'internal_error')
    && typeof value.error.message === 'string') {
    return {
      ok: false,
      error: { code: value.error.code, message: value.error.message },
    };
  }
  throw new Error('Invalid Delegate broker response');
}

export function verifiedBrokerClient(value: unknown): DelegateBrokerClient {
  return new DelegateBrokerClient(decodeDelegateLaunchCapability(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
