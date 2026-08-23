import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Socket } from 'node:net';
import path from 'node:path';
import { Value } from 'typebox/value';
import { outlineCapability } from '../../contract/capabilities';
import { outlineError } from '../../contract/errors';
import {
  OutlineRequestSchema,
  RuntimeDescriptorSchema,
  WatchRequestSchema,
  type EventFilter,
  type OutlineEvent,
  type OutlineRequest,
  type OutlineStreamRecord,
  type Projection,
  type RuntimeDescriptor,
  type WatchRequest,
} from '../../contract/schemas';
import {
  OUTLINE_CLI_VERSION,
  OUTLINE_DEFAULT_IDLE_TIMEOUT_MS,
  OUTLINE_DESCRIPTOR_VERSION,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_STORAGE_VERSION,
} from '../../contract/version';
import { OutlineRuntimeWorkspace, type OutlineRuntimeWorkspaceOptions } from '../runtimeWorkspace';
import { decodeEventCursor, encodeEventCursor } from '../eventCursor';
import { formatOutlineExport } from '../export';
import { projectOutline } from '../projection';
import { OutlineRuntimeRouter } from './runtimeRouter';
import { requestCanMutate } from './runtimeRouter';
import {
  OUTLINE_AGENT_ATTESTATION_HEADER,
  OUTLINE_ORIGIN_HEADER,
  verifyOutlineAgentAttestation,
  type VerifiedOutlineAgentAttestation,
} from '../../contract/agentAttestation';
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
  private readonly agentAttestations = new AgentAttestationRegistry();

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
      if (request.method === 'POST' && url.pathname === '/v1/assets/ingest') {
        const requestId = requiredHeader(request, 'x-outline-request-id');
        const filename = optionalBase64UrlHeader(request, 'x-outline-filename');
        const mimeType = optionalHeader(request, 'x-outline-mime-type');
        const lease = await this.workspace.assets.ingestStream(request, filename, mimeType);
        writeJson(response, 200, {
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          requestId,
          ok: true,
          command: 'asset ingest',
          revision: this.workspace.revision(),
          data: lease,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/assets/')) {
        const assetId = decodeURIComponent(url.pathname.slice('/v1/assets/'.length));
        const verified = await this.workspace.assets.verify(assetId);
        const range = parseRangeHeader(singleHeader(request.headers.range), verified.record.metadata.byteSize);
        if (range === 'invalid') {
          response.writeHead(416, {
            'accept-ranges': 'bytes',
            'content-range': `bytes */${verified.record.metadata.byteSize}`,
            connection: 'close',
          });
          response.end();
          return;
        }
        const contentLength = range
          ? range.end - range.start + 1
          : verified.record.metadata.byteSize;
        response.writeHead(range ? 206 : 200, {
          'content-type': verified.record.metadata.mimeType,
          'content-length': contentLength,
          'accept-ranges': 'bytes',
          ...(range ? {
            'content-range': `bytes ${range.start}-${range.end}/${verified.record.metadata.byteSize}`,
          } : {}),
          'x-outline-asset-id': verified.record.assetId,
          'x-outline-sha256': verified.record.metadata.sha256,
          'cache-control': 'private, max-age=31536000, immutable',
          connection: 'close',
        });
        await pipeline(createReadStream(verified.path, range ?? undefined), response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/request') {
        const body = await readJsonBody(request);
        const decoded = Value.Check(OutlineRequestSchema, body) ? body : null;
        const mutation = decoded ? requestCanMutate(decoded.command, decoded.input) : false;
        const authorization = this.authorizeRequestContext(request, mutation);
        try {
          const result = await this.router.handle(body, authorization.context);
          authorization.complete(result.ok && isOperation(result.data));
          writeJson(response, 200, result);
        } catch (error) {
          authorization.complete(false);
          throw error;
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/stream') {
        const body = await readJsonBody(request);
        if (!Value.Check(OutlineRequestSchema, body)) throw new Error('Invalid outline stream request envelope');
        const capability = outlineCapability(body.command);
        if (!capability?.streaming || !Value.Check(capability.requestSchema, body.input)) {
          throw new Error('Invalid outline streaming command or input');
        }
        if (body.command === 'watch' && Value.Check(WatchRequestSchema, body.input)) {
          await this.streamEvents(response, body.requestId, body.input);
        } else {
          await this.streamCommand(response, body);
        }
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

  private authorizeRequestContext(
    request: http.IncomingMessage,
    mutation: boolean,
  ): {
    readonly context: import('./runtimeRouter').OutlineRuntimeRequestContext;
    readonly complete: (committed: boolean) => void;
  } {
    const claimedOrigin = optionalHeader(request, OUTLINE_ORIGIN_HEADER);
    const token = optionalHeader(request, OUTLINE_AGENT_ATTESTATION_HEADER);
    if (token || claimedOrigin === 'built-in-agent') {
      const verified = token ? verifyOutlineAgentAttestation({
        token,
        descriptor: this.descriptor,
        runtimeRoot: this.paths.root,
      }) : null;
      const authorization = verified
        ? this.agentAttestations.authorize(verified, mutation)
        : null;
      return {
        context: {
          origin: 'built-in-agent',
          ...(authorization ? { causation: authorization.attestation.causation } : {}),
        },
        complete: authorization?.complete ?? (() => undefined),
      };
    }
    const origin = claimedOrigin === 'desktop' || claimedOrigin === 'local-user'
      ? claimedOrigin
      : 'external-client';
    return { context: { origin }, complete: () => undefined };
  }

  private async streamCommand(response: http.ServerResponse, request: OutlineRequest): Promise<void> {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    });
    let sequence = 0;
    const write = (record: OutlineStreamRecord) => response.write(`${JSON.stringify(record)}\n`);
    write({
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: request.requestId,
      sequence: sequence++,
      type: 'hello',
    });
    const result = await this.router.handle(request, { origin: 'external-client' });
    if (!result.ok) {
      write({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId: request.requestId,
        sequence: sequence++,
        type: 'error',
        error: result.error,
      });
      write({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId: request.requestId,
        sequence: sequence++,
        type: 'end',
      });
      response.end();
      return;
    }
    const records = request.command === 'export'
      ? formatOutlineExport(result.data as import('../../contract/schemas').ProjectionResult)
      : [result.data];
    for (const data of records) {
      write({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId: request.requestId,
        sequence: sequence++,
        type: 'data',
        data,
      });
    }
    const cursor = isRecord(result.data) && typeof result.data.cursor === 'string'
      ? result.data.cursor
      : undefined;
    write({
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: request.requestId,
      sequence: sequence++,
      type: 'end',
      ...(cursor ? { cursor } : {}),
    });
    response.end();
  }

  private async streamEvents(
    response: http.ServerResponse,
    requestId: string,
    input: WatchRequest,
  ): Promise<void> {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    let streamSequence = 0;
    const decoded = input.cursor
      ? decodeEventCursor(input.cursor, {
          instanceId: this.workspace.instanceId,
          filter: input.filter,
          projection: input.projection,
        })
      : undefined;
    let latestEventSequence = decoded?.sequence ?? this.workspace.eventBaselineSequence;
    const pendingEvents: OutlineEvent[] = [];
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    const write = (record: OutlineStreamRecord) => response.write(`${JSON.stringify(record)}\n`);
    const writeEvent = (event: OutlineEvent) => {
      if (event.sequence <= latestEventSequence) return;
      latestEventSequence = event.sequence;
      if (!matchesEventFilter(event, input.filter)) return;
      const projectedEvent = eventForWatch(event, input.filter, input.projection, this.workspace);
      write({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId,
        sequence: streamSequence++,
        type: 'event',
        event: projectedEvent,
        cursor: projectedEvent.cursor,
      });
    };
    let acceptEvent: (event: OutlineEvent) => void = (event) => { pendingEvents.push(event); };
    const unsubscribe = this.workspace.subscribe((event) => acceptEvent(event));
    response.once('close', unsubscribe);
    write({
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId,
      sequence: streamSequence++,
      type: 'hello',
      cursor: encodeEventCursor({
        instanceId: this.workspace.instanceId,
        sequence: latestEventSequence,
        revision: decoded?.revision ?? this.workspace.revision(),
        filter: input.filter,
        projection: input.projection,
      }),
    });
    const replay = (await this.workspace.store.eventsAfter(this.workspace.eventBaselineSequence))
      .filter((event) => event.instanceId === this.workspace.instanceId);
    const retainedFirstSequence = replay[0]?.sequence;
    const retainedLatestSequence = replay.at(-1)?.sequence ?? this.workspace.eventBaselineSequence;
    const cursorInvalid = input.cursor !== undefined && (
      !decoded
      || decoded.sequence < this.workspace.eventBaselineSequence
      || decoded.sequence > retainedLatestSequence
      || (retainedFirstSequence !== undefined && decoded.sequence < retainedFirstSequence - 1)
    );
    if (cursorInvalid) {
      const cursor = encodeEventCursor({
        instanceId: this.workspace.instanceId,
        sequence: retainedLatestSequence,
        revision: this.workspace.revision(),
        filter: input.filter,
        projection: input.projection,
      });
      const event: OutlineEvent = {
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        kind: 'outline.event',
        type: 'resync.required',
        instanceId: this.workspace.instanceId,
        sequence: retainedLatestSequence,
        revision: this.workspace.revision(),
        cursor,
      };
      write({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId,
        sequence: streamSequence++,
        type: 'event',
        event,
        cursor,
      });
      write({
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId,
        sequence: streamSequence++,
        type: 'end',
        cursor,
      });
      unsubscribe();
      response.end();
      return;
    }
    for (const event of replay) {
      writeEvent(event);
    }
    for (const event of pendingEvents.sort((left, right) => left.sequence - right.sequence)) writeEvent(event);
    acceptEvent = writeEvent;
    await closed;
  }

  private scheduleIdle(): void {
    if (this.stopping || this.activeRequests > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.workspace.collectAssetGarbage()
        .catch(() => undefined)
        .then(() => this.onIdle?.())
        .finally(() => this.stop());
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

class AgentAttestationRegistry {
  private readonly claimed = new Set<string>();
  private readonly consumed = new Map<string, number>();

  authorize(
    attestation: VerifiedOutlineAgentAttestation,
    mutation: boolean,
  ): {
    readonly attestation: VerifiedOutlineAgentAttestation;
    readonly complete: (committed: boolean) => void;
  } | null {
    this.prune();
    if (this.consumed.has(attestation.nonce) || (mutation && this.claimed.has(attestation.nonce))) return null;
    if (mutation) this.claimed.add(attestation.nonce);
    let completed = false;
    return {
      attestation,
      complete: (committed) => {
        if (completed) return;
        completed = true;
        if (!mutation) return;
        this.claimed.delete(attestation.nonce);
        if (committed) this.consumed.set(attestation.nonce, attestation.expiresAt);
      },
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.consumed) {
      if (expiresAt <= now) this.consumed.delete(nonce);
    }
  }
}

function isOperation(value: unknown): boolean {
  return isRecord(value) && value.kind === 'outline.operation';
}

function requiredHeader(request: http.IncomingMessage, name: string): string {
  const value = optionalHeader(request, name);
  if (!value) throw new Error(`Missing required Runtime header: ${name}`);
  return value;
}

function optionalHeader(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new Error(`Runtime header must have one value: ${name}`);
  if (value !== undefined && value.length > 8_192) throw new Error(`Runtime header is too long: ${name}`);
  return value;
}

const SINGLE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/u;

function parseRangeHeader(
  header: string | undefined,
  sizeBytes: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return 'invalid';
  const match = SINGLE_RANGE_PATTERN.exec(header.trim());
  if (!match) return 'invalid';
  const [, startText, endText] = match;
  if (!startText && !endText) return 'invalid';
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(sizeBytes - suffixLength, 0), end: sizeBytes - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : sizeBytes - 1;
  if (!Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= sizeBytes
    || requestedEnd < start) return 'invalid';
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBase64UrlHeader(request: http.IncomingMessage, name: string): string | undefined {
  const value = optionalHeader(request, name);
  if (!value) return undefined;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) throw new Error(`Invalid Runtime header: ${name}`);
  return decoded;
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function eventForWatch(
  event: OutlineEvent,
  filter: EventFilter | undefined,
  projection: Projection | undefined,
  workspace: OutlineRuntimeWorkspace,
): OutlineEvent {
  const cursor = encodeEventCursor({
    instanceId: workspace.instanceId,
    sequence: event.sequence,
    revision: event.revision,
    filter,
    projection,
  });
  return {
    ...event,
    cursor,
    ...(projection ? { projection: projectOutline(workspace.forkCore(), projection) } : {}),
  };
}

function matchesEventFilter(event: OutlineEvent, filter: EventFilter | undefined): boolean {
  if (filter?.types && !filter.types.includes(event.type)) return false;
  if (filter?.origin && event.operation?.origin !== filter.origin) return false;
  return true;
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
