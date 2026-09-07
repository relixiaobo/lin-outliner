import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import {
  canonicalDelegateCommand,
  decodeDelegateStateCommand,
  decodeDelegateLaunchCapability,
  delegateBytesDigest,
  DELEGATE_PROTOCOL_VERSION,
  encodeDelegateLaunchCapability,
  type DelegateBrokerRequest,
  type DelegateBrokerResponse,
  type DelegateLaunchCapability,
  type DelegateStateCommand,
  type DelegateAccess,
  type DelegateTaskProfile,
} from '../../../delegate/contract';
import { uuidV7 } from '../uuid';

const MAX_BROKER_REQUEST_BYTES = 512 * 1024;
const DEFAULT_CAPABILITY_TTL_MS = 30_000;

export interface DelegateCapabilitySource {
  readonly rootThreadId: string;
  readonly sourceTurnId: string;
  readonly sourceItemId: string;
  readonly rootUserIntentRevision: number | null;
}

export interface DelegateCapabilityPolicyBinding {
  readonly configurationRevision: string;
  readonly capabilityCeilingDigest: string;
  readonly runnerId: string;
  readonly runnerVersion: string | null;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly effort: string;
  readonly profile: DelegateTaskProfile;
  readonly access: DelegateAccess;
  readonly timeoutMs: number;
  readonly schedulingPolicyDigest: string;
}

export type DelegateCapabilitySessionBinding =
  | { readonly kind: 'run'; readonly preallocatedSessionId: string }
  | {
    readonly kind: 'send';
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly minimumResumeRevision: number | null;
  }
  | { readonly kind: 'close'; readonly sessionId: string; readonly sessionRevision: number };

export interface DelegateCapabilityAdmission {
  readonly toolTaskId: string;
  readonly toolTaskNonce: string;
  readonly command: DelegateStateCommand;
  readonly stdin: string;
  readonly cwd: string;
  readonly processSha256: string;
  readonly source: DelegateCapabilitySource;
  readonly policy: DelegateCapabilityPolicyBinding;
  readonly session: DelegateCapabilitySessionBinding;
}

export interface DelegateCapabilityExecution {
  readonly admission: DelegateCapabilityAdmission;
  readonly capabilityId: string;
  readonly signal: AbortSignal;
}

export interface DelegateCapabilityBrokerOptions {
  readonly socketPath: string;
  readonly currentConfigurationRevision: () => string | Promise<string>;
  readonly execute: (execution: DelegateCapabilityExecution) => Promise<unknown>;
  readonly now?: () => number;
  readonly capabilityTtlMs?: number;
}

export class DelegateCapabilityRefusal extends Error {
  constructor(
    readonly code: 'invalid_input' | 'unauthorized' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'DelegateCapabilityRefusal';
  }
}

interface CapabilityRecord {
  readonly capability: DelegateLaunchCapability;
  readonly admission: DelegateCapabilityAdmission;
}

export class DelegateCapabilityBroker {
  private readonly server: http.Server;
  private readonly connections = new Set<Socket>();
  private readonly activeExecutionControllers = new Set<AbortController>();
  private readonly capabilities = new Map<string, CapabilityRecord>();
  private readonly now: () => number;
  private readonly capabilityTtlMs: number;
  private stopping = false;

  constructor(private readonly options: DelegateCapabilityBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });
  }

  async start(): Promise<void> {
    if (this.server.listening) return;
    if (this.stopping) throw new Error('Delegate capability broker is closed');
    await ensurePrivateSocketParent(this.options.socketPath);
    const existing = await lstat(this.options.socketPath).catch((error: unknown) => {
      if (isErrorCode(error, 'ENOENT')) return null;
      throw error;
    });
    if (existing) {
      if (!existing.isSocket()) {
        throw new Error(`Delegate capability broker path is not a socket: ${this.options.socketPath}`);
      }
      if (await unixSocketIsLive(this.options.socketPath)) {
        throw new Error(`Delegate capability broker socket already exists: ${this.options.socketPath}`);
      }
      await rm(this.options.socketPath, { force: false });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.options.socketPath);
    });
    await chmod(this.options.socketPath, 0o600);
  }

  issue(admission: DelegateCapabilityAdmission): Buffer {
    if (!this.server.listening || this.stopping) throw new Error('Delegate capability broker is unavailable');
    this.pruneExpired();
    validateAdmission(admission);
    const capability: DelegateLaunchCapability = {
      version: DELEGATE_PROTOCOL_VERSION,
      capabilityId: uuidV7(this.now()),
      brokerSocketPath: this.options.socketPath,
      bearerToken: randomBytes(32).toString('hex'),
      expiresAt: this.now() + this.capabilityTtlMs,
      command: admission.command,
      stdin: delegateBytesDigest(admission.stdin),
      processSha256: admission.processSha256,
    };
    const encoded = encodeDelegateLaunchCapability(capability);
    this.capabilities.set(capability.capabilityId, {
      capability,
      admission: freezeAdmission(admission),
    });
    return Buffer.from(encoded);
  }

  revoke(capabilityId: string): void {
    this.pruneExpired();
    this.capabilities.delete(capabilityId);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.capabilities.clear();
    for (const controller of this.activeExecutionControllers) controller.abort('delegate_broker_stopping');
    for (const connection of this.connections) connection.destroy();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    await rm(this.options.socketPath, { force: true });
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (this.stopping) {
      writeJson(response, 503, failure('unavailable', 'Delegate capability broker is stopping.'));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/execute') {
      writeJson(response, 404, failure('invalid_input', 'Unknown Delegate broker route.'));
      return;
    }
    const lifetime = requestLifetime(request, response);
    try {
      const value = await readJsonBody(request);
      const decoded = decodeBrokerRequest(value);
      const consumed = await this.consume(decoded);
      this.activeExecutionControllers.add(lifetime.controller);
      try {
        const data = await this.options.execute({
          admission: consumed.admission,
          capabilityId: consumed.capability.capabilityId,
          signal: AbortSignal.any([AbortSignal.timeout(24 * 60 * 60 * 1_000), lifetime.controller.signal]),
        });
        writeJson(response, 200, { ok: true, data });
      } catch (error) {
        if (error instanceof DelegateCapabilityRefusal) {
          writeJson(response, error.code === 'unavailable' ? 503 : 403, failure(error.code, error.message));
          return;
        }
        writeJson(response, 500, failure('internal_error', errorMessage(error)));
      } finally {
        this.activeExecutionControllers.delete(lifetime.controller);
      }
    } catch (error) {
      const brokerError = error instanceof DelegateCapabilityRefusal
        ? error
        : new DelegateCapabilityRefusal('invalid_input', errorMessage(error));
      writeJson(response, brokerError.code === 'unavailable' ? 503 : 403, failure(brokerError.code, brokerError.message));
    } finally {
      lifetime.dispose();
    }
  }

  private async consume(request: DelegateBrokerRequest): Promise<CapabilityRecord> {
    this.pruneExpired();
    const record = this.capabilities.get(request.capability.capabilityId);
    if (!record) {
      throw new DelegateCapabilityRefusal('unauthorized', 'Delegate launch capability is unknown or already consumed.');
    }
    if (!equalCapability(record.capability, request.capability)) {
      throw new DelegateCapabilityRefusal('unauthorized', 'Delegate launch capability was modified.');
    }
    if (this.now() >= record.capability.expiresAt) {
      this.capabilities.delete(record.capability.capabilityId);
      throw new DelegateCapabilityRefusal('unavailable', 'Delegate launch capability expired before use.');
    }
    if (record.admission.policy.configurationRevision !== await this.options.currentConfigurationRevision()) {
      this.capabilities.delete(record.capability.capabilityId);
      throw new DelegateCapabilityRefusal('unavailable', 'Delegation configuration changed before admission.');
    }
    if (canonicalDelegateCommand(request.command) !== canonicalDelegateCommand(record.admission.command)) {
      throw new DelegateCapabilityRefusal('unauthorized', 'Delegate command does not match its capability.');
    }
    this.capabilities.delete(record.capability.capabilityId);
    return record;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [capabilityId, record] of this.capabilities) {
      if (now >= record.capability.expiresAt) this.capabilities.delete(capabilityId);
    }
  }
}

function decodeBrokerRequest(value: unknown): DelegateBrokerRequest {
  if (!isRecord(value) || value.version !== DELEGATE_PROTOCOL_VERSION
    || !exactKeys(value, ['version', 'capability', 'command'])
    || !isRecord(value.command) || !isRecord(value.capability)) {
    throw new Error('Invalid Delegate broker request');
  }
  const capability = decodeDelegateLaunchCapability(value.capability);
  const command = decodeDelegateStateCommand(value.command);
  if (canonicalDelegateCommand(command) !== canonicalDelegateCommand(capability.command)) {
    throw new Error('Delegate broker request command is invalid');
  }
  return { version: DELEGATE_PROTOCOL_VERSION, capability, command };
}

function equalCapability(left: DelegateLaunchCapability, right: DelegateLaunchCapability): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function freezeAdmission(admission: DelegateCapabilityAdmission): DelegateCapabilityAdmission {
  return structuredClone(admission);
}

function validateAdmission(admission: DelegateCapabilityAdmission): void {
  if (!admission.cwd || admission.cwd.includes('\0') || !path.isAbsolute(admission.cwd)) {
    throw new Error('Delegate capability cwd must be absolute');
  }
  const requiredDigests = [
    admission.processSha256,
    admission.policy.capabilityCeilingDigest,
    admission.policy.schedulingPolicyDigest,
  ];
  if (requiredDigests.some((value) => !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error('Delegate capability admission contains an invalid digest');
  }
  const required = [
    admission.toolTaskId,
    admission.toolTaskNonce,
    admission.policy.configurationRevision,
    admission.policy.runnerId,
    admission.policy.modelProvider,
    admission.policy.modelId,
    admission.policy.effort,
    admission.source.rootThreadId,
    admission.source.sourceTurnId,
    admission.source.sourceItemId,
  ];
  if (required.some((value) => !value || value.includes('\0'))) {
    throw new Error('Delegate capability admission contains an invalid binding');
  }
  if (!['general', 'explore', 'plan'].includes(admission.policy.profile)
    || !['read-only', 'workspace-write'].includes(admission.policy.access)
    || !Number.isSafeInteger(admission.policy.timeoutMs)
    || admission.policy.timeoutMs < 1) {
    throw new Error('Delegate capability admission contains an invalid execution policy');
  }
  if (admission.session.kind !== admission.command.name) {
    throw new Error('Delegate capability Session binding does not match its command');
  }
  if (admission.source.rootUserIntentRevision !== null
    && (!Number.isSafeInteger(admission.source.rootUserIntentRevision)
      || admission.source.rootUserIntentRevision < 0)) {
    throw new Error('Delegate capability root user intent revision is invalid');
  }
  if (admission.session.kind === 'send'
    && (!Number.isSafeInteger(admission.session.sessionRevision) || admission.session.sessionRevision < 0
      || (admission.session.minimumResumeRevision !== null
        && (!Number.isSafeInteger(admission.session.minimumResumeRevision)
          || admission.session.minimumResumeRevision < 0)))) {
    throw new Error('Delegate capability send Session revision is invalid');
  }
  if (admission.session.kind === 'close'
    && (!Number.isSafeInteger(admission.session.sessionRevision) || admission.session.sessionRevision < 0
      || (admission.command.name === 'close' && admission.command.sessionId !== admission.session.sessionId))) {
    throw new Error('Delegate capability close Session binding is invalid');
  }
}

async function ensurePrivateSocketParent(socketPath: string): Promise<void> {
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Delegate capability broker socket path is too long');
  const parent = path.dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const value = await lstat(parent);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`Delegate capability broker parent is not a private directory: ${parent}`);
  }
  await chmod(parent, 0o700);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_BROKER_REQUEST_BYTES) throw new Error('Delegate broker request exceeds its byte limit');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function requestLifetime(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): { readonly controller: AbortController; readonly dispose: () => void } {
  const controller = new AbortController();
  const abortRequest = () => controller.abort('broker_request_aborted');
  const abortResponse = () => {
    if (!response.writableEnded) controller.abort('broker_response_closed');
  };
  request.once('aborted', abortRequest);
  response.once('close', abortResponse);
  request.socket.once('end', abortResponse);
  request.socket.once('close', abortResponse);
  return {
    controller,
    dispose: () => {
      request.off('aborted', abortRequest);
      response.off('close', abortResponse);
      request.socket.off('end', abortResponse);
      request.socket.off('close', abortResponse);
    },
  };
}

function failure(
  code: 'invalid_input' | 'unauthorized' | 'unavailable' | 'internal_error',
  message: string,
): DelegateBrokerResponse {
  return { ok: false, error: { code, message } };
}

function writeJson(response: http.ServerResponse, status: number, value: DelegateBrokerResponse): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function unixSocketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const finish = (live: boolean, error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(live);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish(false);
      else finish(false, error);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
