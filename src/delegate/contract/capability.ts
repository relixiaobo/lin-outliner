import { createHash } from 'node:crypto';
import type { DelegateStateCommand } from './commands';
import { DELEGATE_PROTOCOL_VERSION } from './version';

const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const DELEGATE_CAPABILITY_FD = 3;
export const DELEGATE_MAX_CAPABILITY_BYTES = 64 * 1024;

export interface DelegateLaunchCapability {
  readonly version: typeof DELEGATE_PROTOCOL_VERSION;
  readonly capabilityId: string;
  readonly brokerSocketPath: string;
  readonly bearerToken: string;
  readonly expiresAt: number;
  readonly command: DelegateStateCommand;
  readonly stdin: {
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly processSha256: string;
}

export interface DelegateBrokerRequest {
  readonly version: typeof DELEGATE_PROTOCOL_VERSION;
  readonly capability: DelegateLaunchCapability;
  readonly command: DelegateStateCommand;
  readonly input: unknown;
}

export type DelegateBrokerResponse =
  | { readonly ok: true; readonly data: unknown }
  | {
    readonly ok: false;
    readonly error: {
      readonly code: 'invalid_input' | 'unauthorized' | 'unavailable' | 'internal_error';
      readonly message: string;
    };
  };

export function delegateBytesDigest(value: Uint8Array | string): {
  readonly byteLength: number;
  readonly sha256: string;
} {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function encodeDelegateLaunchCapability(capability: DelegateLaunchCapability): Buffer {
  const bytes = Buffer.from(JSON.stringify(capability), 'utf8');
  if (bytes.byteLength > DELEGATE_MAX_CAPABILITY_BYTES) {
    throw new Error('Delegate launch capability exceeds its byte limit');
  }
  return bytes;
}

export function decodeDelegateLaunchCapability(value: unknown): DelegateLaunchCapability {
  if (!isRecord(value)
    || value.version !== DELEGATE_PROTOCOL_VERSION
    || !isUuidV7(value.capabilityId)
    || typeof value.brokerSocketPath !== 'string' || value.brokerSocketPath.length === 0
    || value.brokerSocketPath.includes('\0')
    || typeof value.bearerToken !== 'string' || !TOKEN_PATTERN.test(value.bearerToken)
    || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) < 1
    || !isDelegateStateCommandValue(value.command)
    || !isRecord(value.stdin)
    || !Number.isSafeInteger(value.stdin.byteLength) || Number(value.stdin.byteLength) < 0
    || typeof value.stdin.sha256 !== 'string' || !SHA_256_PATTERN.test(value.stdin.sha256)
    || typeof value.processSha256 !== 'string' || !SHA_256_PATTERN.test(value.processSha256)
    || Object.keys(value).some((key) => ![
      'version', 'capabilityId', 'brokerSocketPath', 'bearerToken', 'expiresAt',
      'command', 'stdin', 'processSha256',
    ].includes(key))
    || Object.keys(value.stdin).some((key) => !['byteLength', 'sha256'].includes(key))) {
    throw new Error('Invalid Delegate launch capability');
  }
  return value as unknown as DelegateLaunchCapability;
}

export function decodeDelegateStateCommand(value: unknown): DelegateStateCommand {
  if (!isDelegateStateCommandValue(value)) throw new Error('Invalid Delegate state command');
  return value;
}

export function parseDelegateLaunchCapability(bytes: Uint8Array): DelegateLaunchCapability {
  if (bytes.byteLength === 0 || bytes.byteLength > DELEGATE_MAX_CAPABILITY_BYTES) {
    throw new Error('Invalid Delegate launch capability size');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid Delegate launch capability encoding');
  }
  return decodeDelegateLaunchCapability(value);
}

function isDelegateStateCommandValue(value: unknown): value is DelegateStateCommand {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.output !== 'string') return false;
  if (value.output !== 'text' && value.output !== 'json') return false;
  if (value.name === 'run') {
    return value.input === '-' && exactKeys(value, ['name', 'input', 'output']);
  }
  if (value.name === 'close') {
    return isUuidV7(value.sessionId) && exactKeys(value, ['name', 'sessionId', 'output']);
  }
  if (value.name !== 'send' || value.input !== '-' || !isRecord(value.target)
    || !exactKeys(value, ['name', 'target', 'input', 'output'])
    || !exactKeys(value.target, ['kind', 'id'])) return false;
  return (value.target.kind === 'task'
      && typeof value.target.id === 'string'
      && /^task_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.target.id))
    || (value.target.kind === 'session' && isUuidV7(value.target.id));
}

function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_PATTERN.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
