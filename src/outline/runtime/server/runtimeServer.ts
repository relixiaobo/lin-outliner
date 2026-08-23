import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { Value } from 'typebox/value';
import { outlineError } from '../../contract/errors';
import {
  RuntimeDescriptorSchema,
  type OutlineEvent,
  type OutlineStreamRecord,
  type RuntimeDescriptor,
} from '../../contract/schemas';
import {
  OUTLINE_CLI_VERSION,
  OUTLINE_DEFAULT_IDLE_TIMEOUT_MS,
  OUTLINE_DESCRIPTOR_VERSION,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_STORAGE_VERSION,
} from '../../contract/version';
import { OutlineRuntimeWorkspace, type OutlineRuntimeWorkspaceOptions } from '../runtimeWorkspace';
import { OutlineRuntimeRouter } from './runtimeRouter';
import {
  OutlineRuntimeLock,
  ensurePrivateDirectory,
  resolveOutlineRuntimePaths,
  writePrivateJson,
  type OutlineRuntimePaths,
} from './runtimePaths';

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

export interface OutlineRuntimeServerOptions {
  readonly root: string;
  readonly idleTimeoutMs?: number;
  readonly workspaceOptions?: OutlineRuntimeWorkspaceOptions;
  readonly onIdle?: () => void | Promise<void>;
}

export class OutlineRuntimeServer {
  readonly paths: OutlineRuntimePaths;
  readonly workspace: OutlineRuntimeWorkspace;
  readonly router: OutlineRuntimeRouter;
  readonly descriptor: RuntimeDescriptor;
  private readonly server: http.Server;
  private readonly connections = new Set<Socket>();
  private readonly idleTimeoutMs: number;
  private readonly onIdle?: OutlineRuntimeServerOptions['onIdle'];
  private idleTimer?: ReturnType<typeof setTimeout>;
  private activeRequests = 0;
  private stopping = false;

  private constructor(
    paths: OutlineRuntimePaths,
    private readonly lock: OutlineRuntimeLock,
    workspace: OutlineRuntimeWorkspace,
    descriptor: RuntimeDescriptor,
    options: OutlineRuntimeServerOptions,
  ) {
    this.paths = paths;
    this.workspace = workspace;
    this.router = new OutlineRuntimeRouter(workspace);
    this.descriptor = descriptor;
    this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? OUTLINE_DEFAULT_IDLE_TIMEOUT_MS);
    this.onIdle = options.onIdle;
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => {
        this.connections.delete(socket);
      });
    });
  }

  static async start(options: OutlineRuntimeServerOptions): Promise<OutlineRuntimeServer | null> {
    const paths = resolveOutlineRuntimePaths(options.root);
    const instanceId = options.workspaceOptions?.instanceId ?? `runtime:${crypto.randomUUID()}`;
    const owner = { pid: process.pid, instanceId, createdAt: new Date().toISOString() };
    const lock = await OutlineRuntimeLock.acquire(paths, owner);
    if (!lock) return null;
    try {
      await ensurePrivateDirectory(path.dirname(paths.socketPath));
      await removeStaleSocket(paths.socketPath);
      const workspace = await OutlineRuntimeWorkspace.open(paths.workspacePath, {
        ...options.workspaceOptions,
        instanceId,
      });
      const descriptor: RuntimeDescriptor = {
        descriptorVersion: OUTLINE_DESCRIPTOR_VERSION,
        transport: 'unix-http',
        socketPath: paths.socketPath,
        bearerToken: randomBytes(32).toString('hex'),
        pid: process.pid,
        instanceId,
        protocolMajors: [OUTLINE_PROTOCOL_VERSION],
        runtimeVersion: OUTLINE_CLI_VERSION,
        storageVersion: OUTLINE_STORAGE_VERSION,
        createdAt: owner.createdAt,
      };
      const runtime = new OutlineRuntimeServer(paths, lock, workspace, descriptor, options);
      await runtime.listen();
      return runtime;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearIdleTimer();
    for (const connection of this.connections) connection.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.removeOwnedDescriptor();
    await removeStaleSocket(this.paths.socketPath);
    await this.lock.release();
  }

  private async listen(): Promise<void> {
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
      this.server.listen(this.paths.socketPath);
    });
    await chmod(this.paths.socketPath, 0o600);
    await writePrivateJson(this.paths.descriptorPath, this.descriptor);
    this.scheduleIdle();
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    this.activeRequests += 1;
    this.clearIdleTimer();
    try {
      if (!authorized(request.headers.authorization, this.descriptor.bearerToken)) {
        writeJson(response, 401, {
          error: outlineError('unauthorized', 'protocol', 'Outline Runtime authentication failed.'),
        });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://outline.runtime');
      if (request.method === 'POST' && url.pathname === '/v1/request') {
        const body = await readJsonBody(request);
        const result = await this.router.handle(body, { origin: 'external-client' });
        writeJson(response, 200, result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        const after = parseEventSequence(url.searchParams.get('after'));
        const requestId = parseRequestId(url.searchParams.get('requestId'));
        await this.streamEvents(response, after, requestId);
        return;
      }
      writeJson(response, 404, {
        error: outlineError('not_found', 'selection', 'Outline Runtime route not found.'),
      });
    } catch (error) {
      writeJson(response, 400, {
        error: outlineError(
          'invalid_input',
          'usage',
          'Outline Runtime request could not be decoded.',
          { details: error instanceof Error ? error.message : String(error) },
        ),
      });
    } finally {
      this.activeRequests -= 1;
      this.scheduleIdle();
    }
  }

  private async streamEvents(response: http.ServerResponse, after: number, requestId: string): Promise<void> {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    let streamSequence = 0;
    let latestEventSequence = after;
    let replaying = true;
    const pendingEvents: OutlineEvent[] = [];
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    const write = (record: OutlineStreamRecord) => response.write(`${JSON.stringify(record)}\n`);
    const writeEvent = (event: OutlineEvent) => {
      if (event.sequence <= latestEventSequence) return;
      latestEventSequence = event.sequence;
      write({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId,
        sequence: streamSequence++,
        type: 'event',
        event,
        cursor: event.cursor,
      });
    };
    const unsubscribe = this.workspace.subscribe((event) => {
      if (replaying) {
        pendingEvents.push(event);
        return;
      }
      writeEvent(event);
    });
    response.once('close', unsubscribe);
    write({
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId,
      sequence: streamSequence++,
      type: 'hello',
      cursor: `event:${Math.max(0, after)}`,
    });
    for (const event of await this.workspace.store.eventsAfter(Math.max(0, after))) {
      writeEvent(event);
    }
    for (const event of pendingEvents.sort((left, right) => left.sequence - right.sequence)) writeEvent(event);
    replaying = false;
    await closed;
  }

  private scheduleIdle(): void {
    if (this.stopping || this.activeRequests > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void Promise.resolve(this.onIdle?.()).finally(() => this.stop());
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async removeOwnedDescriptor(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.paths.descriptorPath, 'utf8')) as unknown;
      if (Value.Check(RuntimeDescriptorSchema, value) && value.instanceId === this.descriptor.instanceId) {
        await rm(this.paths.descriptorPath, { force: true });
      }
    } catch {
      // A missing or replaced descriptor is not owned by this Runtime instance.
    }
  }
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseEventSequence(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) throw new Error('Outline Runtime event sequence is invalid');
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) throw new Error('Outline Runtime event sequence is invalid');
  return sequence;
}

function parseRequestId(value: string | null): string {
  if (value === null) return 'watch';
  if (value.length < 1 || value.length > 256) throw new Error('Outline Runtime stream request ID is invalid');
  return value;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Outline Runtime request exceeds the byte limit');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function writeJson(response: http.ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(body);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  const value = await lstat(socketPath).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!value) return;
  if (!value.isSocket()) throw new Error(`Outline Runtime socket path is not a socket: ${socketPath}`);
  await rm(socketPath, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
