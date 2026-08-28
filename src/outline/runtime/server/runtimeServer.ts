import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Socket } from 'node:net';
import path from 'node:path';
import { outlineCapability, outlineCapabilityContractDigest } from '../../contract/capabilities';
import { canonicalJsonChunks } from '../../contract/canonical';
import { OutlineContractError, outlineError } from '../../contract/errors';
import { checkOutlineSchema } from '../../contract/validation';
import {
  ChangeSetSchema,
  OutlineRequestSchema,
  OperationUndoGroupSchema,
  RuntimeDescriptorSchema,
  WatchRequestSchema,
  type EventFilter,
  type ChangeSet,
  type OutlineEvent,
  type OutlineRequest,
  type OperationUndoGroup,
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
import { readChangeSetUpload } from './changeSetSpool';
import { commitOutlineChangeSetAccepted } from '../changeSet';
import { normalizeNodeAccessStats, type NodeAccessStats } from '../../../core/nodeAccessRanking';

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

export interface OutlineRuntimeServerOptions {
  readonly root: string;
  readonly contentRoot: string;
  readonly idleTimeoutMs?: number;
  readonly developmentSessionId?: string;
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
  private idleGeneration = 0;
  // All requests are lifecycle leases. Only finite foreground requests postpone
  // maintenance; watch streams keep Runtime alive without starving cleanup.
  private activeRequests = 0;
  private activeForegroundRequests = 0;
  private idleDrainActive = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
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
    assertDevelopmentSessionId(options.developmentSessionId);
    const paths = resolveOutlineRuntimePaths(options.root);
    const instanceId = options.workspaceOptions?.instanceId ?? `runtime:${crypto.randomUUID()}`;
    const owner = { pid: process.pid, instanceId, createdAt: new Date().toISOString() };
    const lock = await OutlineRuntimeLock.acquire(paths, owner);
    if (!lock) return null;
    let workspace: OutlineRuntimeWorkspace | undefined;
    let runtime: OutlineRuntimeServer | undefined;
    try {
      await ensurePrivateDirectory(path.dirname(paths.socketPath));
      await removeStaleSocket(paths.socketPath);
      workspace = await OutlineRuntimeWorkspace.open(paths.workspacePath, {
        ...options.workspaceOptions,
        instanceId,
        contentRoot: options.contentRoot,
      });
      const descriptor: RuntimeDescriptor = {
        descriptorVersion: OUTLINE_DESCRIPTOR_VERSION,
        transport: 'unix-http',
        socketPath: paths.socketPath,
        bearerToken: randomBytes(32).toString('hex'),
        pid: process.pid,
        instanceId,
        protocolMajors: [OUTLINE_PROTOCOL_VERSION],
        contractDigest: outlineCapabilityContractDigest(),
        runtimeVersion: OUTLINE_CLI_VERSION,
        ...(options.developmentSessionId ? { developmentSessionId: options.developmentSessionId } : {}),
        storageVersion: OUTLINE_STORAGE_VERSION,
        createdAt: owner.createdAt,
      };
      runtime = new OutlineRuntimeServer(paths, lock, workspace, descriptor, options);
      await runtime.listen();
      return runtime;
    } catch (error) {
      if (runtime) await runtime.cleanupFailedStart().catch(() => undefined);
      else {
        try {
          workspace?.close();
        } catch {
          // Startup failure remains authoritative; the writer lock must still be released.
        }
      }
      await lock.release();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopInternal();
    this.stopPromise = stopping;
    try {
      await stopping;
    } catch (error) {
      if (this.stopPromise === stopping) this.stopPromise = undefined;
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    this.clearIdleTimer();
    try {
      const targetRevision = await this.workspace.freezeMutationAdmission();
      await this.workspace.drainDurability(targetRevision);
      this.workspace.commitMutationAdmissionFreeze();
    } catch (error) {
      this.workspace.unfreezeMutationAdmission();
      this.stopping = false;
      this.scheduleIdle();
      throw error;
    }
    for (const connection of this.connections) connection.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.removeOwnedDescriptor();
    this.workspace.close();
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

  private async cleanupFailedStart(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    await this.removeOwnedDescriptor().catch(() => undefined);
    this.workspace.close();
    await removeStaleSocket(this.paths.socketPath).catch(() => undefined);
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    this.idleGeneration += 1;
    this.activeRequests += 1;
    this.activeForegroundRequests += 1;
    let foregroundActive = true;
    const releaseForegroundRequest = () => {
      if (!foregroundActive) return;
      foregroundActive = false;
      this.activeForegroundRequests -= 1;
      this.scheduleIdle();
    };
    this.clearIdleTimer();
    try {
      if (!authorized(request.headers.authorization, this.descriptor.bearerToken)) {
        writeJson(response, 401, {
          error: outlineError('unauthorized', 'protocol', 'Outline Runtime authentication failed.'),
        });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://outline.runtime');
      if (request.method === 'POST' && url.pathname === '/v1/runtime/retire') {
        const body = await readJsonBody(request);
        if (!isRecord(body)
          || body.instanceId !== this.descriptor.instanceId
          || typeof body.replacementContractDigest !== 'string'
          || !/^[a-f0-9]{64}$/.test(body.replacementContractDigest)
          || (body.replacementDevelopmentSessionId !== undefined
            && !validDevelopmentSessionId(body.replacementDevelopmentSessionId))
          || (body.replacementContractDigest === this.descriptor.contractDigest
            && (typeof body.replacementDevelopmentSessionId !== 'string'
              || body.replacementDevelopmentSessionId === this.descriptor.developmentSessionId))) {
          throw new Error('Invalid Outline Runtime retirement request.');
        }
        response.once('finish', () => {
          void this.stop();
        });
        writeJson(response, 200, {
          retiring: true,
          instanceId: this.descriptor.instanceId,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/desktop/commit') {
        if (optionalHeader(request, OUTLINE_ORIGIN_HEADER) !== 'desktop') {
          throw new OutlineContractError(outlineError(
            'unauthorized',
            'protocol',
            'The accepted mutation route is available only to the desktop host.',
          ));
        }
        const body = await readJsonBody(request);
        if (!isRecord(body)
          || body.protocolVersion !== OUTLINE_PROTOCOL_VERSION
          || typeof body.requestId !== 'string'
          || !/^[A-Za-z0-9:._-]{1,256}$/.test(body.requestId)
          || !checkOutlineSchema(ChangeSetSchema, body.changeSet)
          || (body.undoGroup !== undefined
            && !checkOutlineSchema(OperationUndoGroupSchema, body.undoGroup))) {
          throw new Error('Invalid desktop accepted-mutation request.');
        }
        const accepted = await commitOutlineChangeSetAccepted(
          this.workspace,
          body.changeSet as ChangeSet,
          { origin: 'desktop' },
          body.undoGroup ? { undoGroup: body.undoGroup as OperationUndoGroup } : {},
        );
        writeJson(response, 200, {
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          requestId: body.requestId,
          revision: this.workspace.revision(),
          data: {
            settlement: accepted.settlement,
            update: accepted.update,
            diff: accepted.diff,
          },
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/desktop/search') {
        if (optionalHeader(request, OUTLINE_ORIGIN_HEADER) !== 'desktop') {
          throw new OutlineContractError(outlineError(
            'unauthorized',
            'protocol',
            'The ranked search route is available only to the desktop host.',
          ));
        }
        const body = await readJsonBody(request);
        if (!isRecord(body)
          || body.protocolVersion !== OUTLINE_PROTOCOL_VERSION
          || typeof body.requestId !== 'string'
          || !/^[A-Za-z0-9:._-]{1,256}$/.test(body.requestId)
          || typeof body.query !== 'string'
          || body.query.length > 10_000
          || !Number.isSafeInteger(body.limit)
          || (body.limit as number) < 1
          || (body.limit as number) > 10_000) {
          throw new Error('Invalid desktop ranked-search request.');
        }
        writeJson(response, 200, {
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          requestId: body.requestId,
          revision: this.workspace.revision(),
          data: {
            hits: this.workspace.searchText(body.query, body.limit as number),
          },
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/desktop/personal-access-ranking') {
        if (optionalHeader(request, OUTLINE_ORIGIN_HEADER) !== 'desktop') {
          throw new OutlineContractError(outlineError(
            'unauthorized',
            'protocol',
            'The personal-access ranking route is available only to the desktop host.',
          ));
        }
        const body = await readJsonBody(request);
        if (!isRecord(body)
          || body.protocolVersion !== OUTLINE_PROTOCOL_VERSION
          || typeof body.requestId !== 'string'
          || !/^[A-Za-z0-9:._-]{1,256}$/.test(body.requestId)
          || !isDesktopPersonalAccessRankingUpdate(body.update)) {
          throw new Error('Invalid desktop personal-access ranking request.');
        }
        const update = body.update;
        if (update.action === 'remove') {
          this.workspace.removePersonalAccessRanking(update.nodeIds);
        } else {
          const entries = new Map<string, NodeAccessStats>(update.entries.map(([nodeId, stats]) => (
            [nodeId, normalizeNodeAccessStats(stats)!]
          )));
          if (update.action === 'replace') this.workspace.replacePersonalAccessRanking(entries);
          else this.workspace.upsertPersonalAccessRanking(entries);
        }
        writeJson(response, 200, {
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          requestId: body.requestId,
          data: { synced: true },
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/desktop/lifecycle') {
        if (optionalHeader(request, OUTLINE_ORIGIN_HEADER) !== 'desktop') {
          throw new OutlineContractError(outlineError(
            'unauthorized',
            'protocol',
            'The Runtime lifecycle route is available only to the desktop host.',
          ));
        }
        const body = await readJsonBody(request);
        if (!isDesktopLifecycleRequest(body)) {
          throw new Error('Invalid desktop Runtime lifecycle request.');
        }
        switch (body.action) {
          case 'freeze':
            await this.workspace.freezeMutationAdmission();
            break;
          case 'unfreeze':
            this.workspace.unfreezeMutationAdmission();
            break;
          case 'commit-freeze':
            this.workspace.commitMutationAdmissionFreeze();
            break;
          case 'drain':
            await this.workspace.drainDurability(body.targetRevision);
            break;
          case 'status':
            break;
        }
        writeJson(response, 200, {
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          requestId: body.requestId,
          data: this.workspace.durabilityStatus(),
        });
        return;
      }
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
      if (request.method === 'POST' && url.pathname === '/v1/diff') {
        const requestId = requiredHeader(request, 'x-outline-request-id');
        const format = requiredHeader(request, 'x-outline-input-format');
        if (format !== 'json' && format !== 'jsonl') throw new Error('Invalid ChangeSet upload format.');
        const idempotencyKey = optionalBase64UrlHeader(request, 'x-outline-idempotency-key');
        const idempotencyKeyMode = optionalHeader(request, 'x-outline-idempotency-key-mode') ?? 'exact';
        if (idempotencyKeyMode !== 'exact' && idempotencyKeyMode !== 'if-missing') {
          throw new Error('Invalid ChangeSet idempotency key mode.');
        }
        const changeSet = await readChangeSetUpload(
          this.paths.root,
          request,
          format,
          idempotencyKey,
          idempotencyKeyMode,
        );
        const authorization = this.authorizeRequestContext(request, false);
        const result = await this.router.handle({
          protocolVersion: OUTLINE_PROTOCOL_VERSION,
          requestId,
          command: 'diff',
          input: { changeSet },
        }, authorization.context);
        authorization.complete(false);
        if (!result.ok) {
          writeJson(response, 400, { error: result.error });
          return;
        }
        const hash = createHash('sha256');
        let byteCount = 0;
        for (const chunk of canonicalJsonChunks(result.data)) {
          hash.update(chunk);
          byteCount += Buffer.byteLength(chunk);
        }
        response.writeHead(200, {
          'content-type': 'application/vnd.tenon.outline-diff+json',
          'content-length': byteCount,
          'x-outline-request-id': requestId,
          'x-outline-sha256': hash.digest('hex'),
          'cache-control': 'no-store',
          connection: 'close',
        });
        for (const chunk of canonicalJsonChunks(result.data)) {
          await writeWithBackpressure(response, chunk);
        }
        response.end();
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
          'cache-control': 'private, max-age=31536000, immutable',
          connection: 'close',
        });
        await pipeline(createReadStream(verified.path, range ?? undefined), response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/request') {
        const body = await readJsonBody(request);
        const decoded = checkOutlineSchema(OutlineRequestSchema, body) ? body : null;
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
        if (!checkOutlineSchema(OutlineRequestSchema, body)) throw new Error('Invalid outline stream request envelope');
        const capability = outlineCapability(body.command);
        if (!capability?.streaming || !checkOutlineSchema(capability.requestSchema, body.input)) {
          throw new Error('Invalid outline streaming command or input');
        }
        if (body.command === 'watch' && checkOutlineSchema(WatchRequestSchema, body.input)) {
          releaseForegroundRequest();
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
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        writeJson(response, 400, { error: serverError(error) });
      }
    } finally {
      releaseForegroundRequest();
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
    let retainedLatestSequence = this.workspace.eventBaselineSequence;
    let ended = false;
    const pendingEvents: OutlineEvent[] = [];
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    const write = (record: OutlineStreamRecord) => response.write(`${JSON.stringify(record)}\n`);
    let unsubscribe: () => void = () => undefined;
    const endForResync = () => {
      if (ended) return;
      ended = true;
      const sequence = Math.max(latestEventSequence, retainedLatestSequence);
      const cursor = encodeEventCursor({
        instanceId: this.workspace.instanceId,
        sequence,
        revision: this.workspace.revision(),
        filter: input.filter,
        projection: input.projection,
      });
      const event: OutlineEvent = {
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        kind: 'outline.event',
        type: 'resync.required',
        instanceId: this.workspace.instanceId,
        sequence,
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
    };
    const writeEvent = (event: OutlineEvent) => {
      if (ended || event.sequence <= latestEventSequence) return;
      latestEventSequence = event.sequence;
      if (!matchesEventFilter(event, input.filter)) return;
      if (input.projection && event.revision !== this.workspace.revision()) {
        endForResync();
        return;
      }
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
    unsubscribe = this.workspace.subscribe((event) => acceptEvent(event));
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
    retainedLatestSequence = replay.at(-1)?.sequence ?? this.workspace.eventBaselineSequence;
    const cursorInvalid = input.cursor !== undefined && (
      !decoded
      || decoded.sequence < this.workspace.eventBaselineSequence
      || decoded.sequence > retainedLatestSequence
      || (retainedFirstSequence !== undefined && decoded.sequence < retainedFirstSequence - 1)
    );
    if (cursorInvalid) {
      endForResync();
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
    if (this.stopping || this.activeForegroundRequests > 0 || this.idleTimer || this.idleDrainActive) return;
    const generation = this.idleGeneration;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.drainIdle(generation);
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private async drainIdle(generation: number): Promise<void> {
    if (!this.canRunIdleMaintenance(generation)) return;
    this.idleDrainActive = true;
    try {
      await this.workspace.maintain({ compactIfNeeded: true }).catch(() => undefined);
      if (!this.canFinishIdleDrain(generation)) return;
      try {
        await this.onIdle?.();
      } catch {
        // Idle callback failure must not strand a Runtime that has no clients.
      }
      if (!this.canFinishIdleDrain(generation)) return;
      await this.stop();
    } finally {
      this.idleDrainActive = false;
      this.scheduleIdle();
    }
  }

  private canRunIdleMaintenance(generation: number): boolean {
    return !this.stopping
      && this.activeForegroundRequests === 0
      && this.idleGeneration === generation;
  }

  private canFinishIdleDrain(generation: number): boolean {
    return !this.stopping
      && this.activeRequests === 0
      && this.idleGeneration === generation;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async removeOwnedDescriptor(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.paths.descriptorPath, 'utf8')) as unknown;
      if (checkOutlineSchema(RuntimeDescriptorSchema, value) && value.instanceId === this.descriptor.instanceId) {
        await rm(this.paths.descriptorPath, { force: true });
      }
    } catch {
      // A missing or replaced descriptor is not owned by this Runtime instance.
    }
  }
}

function serverError(error: unknown) {
  if (error instanceof OutlineContractError) return error.outlineError;
  return outlineError(
    'invalid_input',
    'usage',
    'Outline Runtime request could not be decoded.',
    { details: error instanceof Error ? error.message : String(error) },
  );
}

function assertDevelopmentSessionId(value: string | undefined): void {
  if (value !== undefined && !validDevelopmentSessionId(value)) {
    throw new RangeError('Outline Runtime development session ID must contain between 1 and 128 characters.');
  }
}

function validDevelopmentSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
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

type DesktopLifecycleRequest = {
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly action: 'status' | 'freeze' | 'unfreeze' | 'commit-freeze';
} | {
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly action: 'drain';
  readonly targetRevision: number;
};

function isDesktopLifecycleRequest(value: unknown): value is DesktopLifecycleRequest {
  if (!isRecord(value)
    || value.protocolVersion !== OUTLINE_PROTOCOL_VERSION
    || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9:._-]{1,256}$/.test(value.requestId)
    || typeof value.action !== 'string') return false;
  if (value.action === 'drain') {
    return Number.isSafeInteger(value.targetRevision) && (value.targetRevision as number) >= 0;
  }
  return value.targetRevision === undefined
    && ['status', 'freeze', 'unfreeze', 'commit-freeze'].includes(value.action);
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
    ...(projection ? { projection: workspace.project(projection) } : {}),
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

async function writeWithBackpressure(response: http.ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) throw new Error('Outline Runtime response closed during streaming.');
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Outline Runtime response closed during streaming.'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
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

function isDesktopPersonalAccessRankingUpdate(value: unknown): value is
  | { readonly action: 'replace' | 'upsert'; readonly entries: readonly (readonly [string, NodeAccessStats])[] }
  | { readonly action: 'remove'; readonly nodeIds: readonly string[] } {
  if (!isRecord(value) || (value.action !== 'replace' && value.action !== 'upsert' && value.action !== 'remove')) {
    return false;
  }
  if (value.action === 'remove') {
    return Array.isArray(value.nodeIds)
      && value.nodeIds.length <= 5_000
      && value.nodeIds.every((nodeId) => typeof nodeId === 'string' && nodeId.length > 0);
  }
  return Array.isArray(value.entries)
    && value.entries.length <= 5_000
    && value.entries.every((entry) => {
      if (!Array.isArray(entry)
        || entry.length !== 2
        || typeof entry[0] !== 'string'
        || entry[0].length === 0) return false;
      const stats = normalizeNodeAccessStats(entry[1]);
      return stats !== null && stats.s > 0 && stats.tUpdate !== null;
    });
}
