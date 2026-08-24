import { Value } from 'typebox/value';
import {
  outlineCapability,
  outlineCapabilityContractDigest,
  outlineCapabilityManifest,
} from '../../contract/capabilities';
import { OutlineContractError, outlineError } from '../../contract/errors';
import {
  type ChangeSet,
  type Diff,
  OutlineRequestSchema,
  type Projection,
  type Selector,
  type TargetSpec,
  type OutlineRequest,
  type OutlineResponse,
  type Operation,
  type OperationLogPage,
} from '../../contract/schemas';
import { canonicalSha256 } from '../../contract/canonical';
import {
  OUTLINE_CLI_VERSION,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_STORAGE_VERSION,
} from '../../contract/version';
import type { OutlineRuntimeWorkspace } from '../runtimeWorkspace';
import { applyOutlineDiff, diffOutlineChangeSet } from '../changeSet';
import { projectOutline } from '../projection';
import { decodeOperationLogCursor, encodeOperationLogCursor } from '../operationLogCursor';

export interface OutlineRuntimeRequestContext {
  readonly origin: Operation['origin'];
  readonly causation?: Operation['causation'];
}

export type OutlineRuntimeCommandHandler = (
  input: unknown,
  context: OutlineRuntimeRequestContext,
) => unknown | Promise<unknown>;

export class OutlineRuntimeRouter {
  private handlers = new Map<string, OutlineRuntimeCommandHandler>();

  constructor(private readonly workspace: OutlineRuntimeWorkspace) {}

  register(command: string, handler: OutlineRuntimeCommandHandler): void {
    if (this.handlers.has(command)) throw new Error(`Outline Runtime handler is already registered: ${command}`);
    this.handlers.set(command, handler);
  }

  async handle(value: unknown, context: OutlineRuntimeRequestContext): Promise<OutlineResponse> {
    const request = decodeRequest(value);
    try {
      const capability = outlineCapability(request.command);
      if (!capability) {
        throw new OutlineContractError(outlineError(
          'invalid_input',
          'usage',
          `Unknown outline command: ${request.command}`,
        ));
      }
      if (!Value.Check(capability.requestSchema, request.input)) {
        throw new OutlineContractError(outlineError(
          'invalid_input',
          'usage',
          `Input does not match the public schema for command: ${request.command}`,
        ));
      }
      if (context.origin === 'built-in-agent'
        && !context.causation
        && requestCanMutate(request.command, request.input)) {
        throw new OutlineContractError(outlineError(
          'agent_attestation_required',
          'protocol',
          'Built-in Agent mutations require a valid causation attestation for the current shell Item.',
        ));
      }
      const data = await this.execute(request.command, request.input, context);
      if (!Value.Check(capability.resultSchema, data)) {
        throw new OutlineContractError(outlineError(
          'internal_error',
          'internal',
          `Outline Runtime result does not match the public schema for command: ${request.command}`,
        ));
      }
      return {
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        command: request.command,
        revision: this.workspace.revision(),
        data,
      };
    } catch (error) {
      const contractError = publicError(error);
      return {
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        command: request.command,
        error: contractError,
      } as OutlineResponse;
    }
  }

  private async execute(command: string, input: unknown, context: OutlineRuntimeRequestContext): Promise<unknown> {
    const handler = this.handlers.get(command);
    if (handler) return handler(input, context);
    if (command === 'status') {
      return {
        running: true,
        runtime: {
          instanceId: this.workspace.instanceId,
          contractDigest: outlineCapabilityContractDigest(),
          runtimeVersion: OUTLINE_CLI_VERSION,
          storageVersion: OUTLINE_STORAGE_VERSION,
          ...await this.workspace.status(),
        },
      };
    }
    if (command === 'capabilities') return outlineCapabilityManifest();
    if (command === 'find') {
      const value = input as { target: TargetSpec; projection?: Projection };
      return projectOutline(this.workspace.forkCore(), value.projection ?? {
        kind: 'summary',
        targets: { target: value.target },
        page: { limit: value.target.max ?? 100 },
      });
    }
    if (command === 'show') {
      const value = input as { selector: Selector; projection?: Projection };
      return projectOutline(this.workspace.forkCore(), value.projection ?? {
        kind: 'node',
        targets: { target: { selector: value.selector, cardinality: 'one' } },
        include: ['description', 'children', 'tags', 'fields', 'references', 'media', 'view', 'trash'],
      });
    }
    if (command === 'export') {
      const value = input as { selector: Selector; projection?: Projection };
      const many = value.selector.by === 'query';
      const max = value.selector.by === 'query' ? value.selector.limit : undefined;
      return projectOutline(this.workspace.forkCore(), value.projection ?? {
        kind: 'export',
        targets: {
          target: {
            selector: value.selector,
            cardinality: many ? 'many' : 'one',
            ...(max !== undefined ? { max } : {}),
          },
        },
        depth: 1_024,
        include: ['description', 'children', 'tags', 'fields', 'references', 'media', 'view', 'trash'],
        page: { limit: 10_000 },
        format: 'json',
      });
    }
    if (command === 'asset ingest') {
      const value = input as {
        source: 'path' | 'stdin' | 'bytes';
        path?: string;
        data?: string;
        mimeType?: string;
        originalFilename?: string;
      };
      if (value.source === 'path' && value.path) return this.workspace.assets.ingestPath(value.path);
      if (value.source === 'bytes' && value.data) {
        const bytes = Buffer.from(value.data, 'base64');
        if (bytes.length === 0 || bytes.toString('base64') !== value.data) {
          throw new OutlineContractError(outlineError('invalid_input', 'usage', 'Asset bytes are not canonical base64.'));
        }
        return this.workspace.assets.ingestBytes(bytes, value.originalFilename, value.mimeType);
      }
      if (value.source === 'stdin') {
        throw new OutlineContractError(outlineError(
          'invalid_input',
          'usage',
          'Asset stdin ingestion requires the binary upload transport.',
        ));
      }
      throw new OutlineContractError(outlineError('invalid_input', 'usage', 'Asset ingest input is incomplete.'));
    }
    if (command === 'asset show') {
      return this.workspace.assets.show(String((input as { assetId: string }).assetId));
    }
    if (command === 'asset export') {
      const { record, bytes } = await this.workspace.assets.readVerified(String((input as { assetId: string }).assetId));
      return { asset: record, data: Buffer.from(bytes).toString('base64') };
    }
    if (command === 'diff') {
      return diffOutlineChangeSet(this.workspace, (input as { changeSet: ChangeSet }).changeSet);
    }
    if (command === 'apply') {
      const value = input as { diff: Diff; acknowledgeDestructive?: boolean };
      return applyOutlineDiff(this.workspace, value.diff, context, value.acknowledgeDestructive === true);
    }
    if (command === 'log') return this.log(input as Record<string, unknown>);
    if (command === 'revert') {
      const value = input as Record<string, unknown>;
      const operationId = String(value.operationId);
      return this.workspace.revert(operationId, historyMutationOptions(command, value, context));
    }
    if (command === 'undo') {
      return this.workspace.undo(historyMutationOptions(command, input as Record<string, unknown>, context));
    }
    if (command === 'redo') {
      return this.workspace.redo(historyMutationOptions(command, input as Record<string, unknown>, context));
    }
    const capability = outlineCapability(command);
    if (capability?.kind === 'mutate') {
      const value = input as {
        changeSet: ChangeSet;
        preview?: boolean;
        expectDiff?: string;
        acknowledgeDestructive?: boolean;
      };
      const diff = await diffOutlineChangeSet(this.workspace, value.changeSet);
      if (value.preview) return diff;
      if (value.expectDiff && value.expectDiff !== diff.diffHash) {
        throw new OutlineContractError(outlineError(
          'diff_mismatch',
          'conflict',
          'The current normalized Diff does not match --expect-diff.',
          { details: { expected: value.expectDiff, actual: diff.diffHash } },
        ));
      }
      return applyOutlineDiff(this.workspace, diff, context, value.acknowledgeDestructive === true);
    }
    throw new OutlineContractError(outlineError(
      'protocol_incompatible',
      'protocol',
      `Runtime capability is registered but has no handler: ${command}`,
    ));
  }

  private async log(input: Record<string, unknown>): Promise<OperationLogPage> {
    const limit = Math.max(1, Math.min(1_000, Number(input.limit ?? 100)));
    const operationId = typeof input.operationId === 'string' ? input.operationId : undefined;
    const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined;
    if (operationId) {
      const operation = await this.workspace.store.operation(operationId);
      if (!operation || (idempotencyKey && (await this.workspace.store.operationForIdempotencyKey(idempotencyKey))?.operationId !== operationId)) {
        return { operations: [] };
      }
      const filterHash = canonicalSha256(logFilterIdentity(input));
      if (!(await this.matchesLogFilters(operation, input))) return { operations: [] };
      const cursor = typeof input.cursor === 'string' ? decodeOperationLogCursor(input.cursor) : undefined;
      if (cursor && (cursor.kind !== 'affected'
        || cursor.operationId !== operationId
        || cursor.filterHash !== filterHash)) {
        throw staleLogCursor();
      }
      const offset = cursor?.kind === 'affected' ? cursor.offset : 0;
      const nodeIds = await this.completeAffectedNodeIds(operation);
      if (offset > nodeIds.length) throw staleLogCursor();
      const page = nodeIds.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        operations: [operation],
        affectedNodeIds: {
          operationId,
          nodeIds: page,
          offset,
          totalCount: nodeIds.length,
          fullSetHash: operation.affectedNodeIdsHash,
        },
        ...(nextOffset < nodeIds.length ? {
          cursor: encodeOperationLogCursor({ kind: 'affected', filterHash, operationId, offset: nextOffset }),
        } : {}),
      };
    }
    const exactOperation = idempotencyKey
      ? await this.workspace.store.operationForIdempotencyKey(idempotencyKey)
      : undefined;
    if (idempotencyKey && !exactOperation) return { operations: [] };
    const operations = await this.workspace.store.operations();
    const filtered: Operation[] = [];
    for (const operation of [...operations].reverse()) {
      if (exactOperation && operation.operationId !== exactOperation.operationId) continue;
      if (await this.matchesLogFilters(operation, input)) filtered.push(operation);
    }
    const filterHash = canonicalSha256(logFilterIdentity(input));
    const cursor = typeof input.cursor === 'string' ? decodeOperationLogCursor(input.cursor) : undefined;
    if (cursor && (cursor.kind !== 'history' || cursor.filterHash !== filterHash)) throw staleLogCursor();
    const offset = cursor?.kind === 'history'
      ? filtered.findIndex((operation) => operation.operationId === cursor.afterOperationId) + 1
      : 0;
    if (cursor && offset === 0) throw staleLogCursor();
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      operations: page,
      ...(nextOffset < filtered.length && page.length > 0 ? {
        cursor: encodeOperationLogCursor({
          kind: 'history',
          filterHash,
          afterOperationId: page.at(-1)!.operationId,
        }),
      } : {}),
    };
  }

  private async matchesLogFilters(operation: Operation, input: Record<string, unknown>): Promise<boolean> {
    if (typeof input.origin === 'string' && operation.origin !== input.origin) return false;
    if (typeof input.threadId === 'string' && operation.causation?.threadId !== input.threadId) return false;
    if (typeof input.turnId === 'string' && operation.causation?.turnId !== input.turnId) return false;
    if (typeof input.itemId === 'string' && operation.causation?.itemId !== input.itemId) return false;
    if (typeof input.nodeId === 'string') {
      if (operation.affectedNodeIds.includes(input.nodeId)) return true;
      if (!operation.affectedNodeIdsTruncated) return false;
      return (await this.completeAffectedNodeIds(operation)).includes(input.nodeId);
    }
    return true;
  }

  private async completeAffectedNodeIds(operation: Operation): Promise<readonly string[]> {
    if (!operation.affectedNodeIdsTruncated) return operation.affectedNodeIds;
    const recovery = await this.workspace.store.recoveryPatch(operation.operationId);
    const nodeIds = recovery.nodes.map((entry) => entry.id);
    if (nodeIds.length !== operation.affectedNodeCount
      || canonicalSha256(nodeIds) !== operation.affectedNodeIdsHash) {
      throw new OutlineContractError(outlineError(
        'recovery_inconsistent',
        'durability',
        `Affected Node index does not match Operation: ${operation.operationId}`,
      ));
    }
    return nodeIds;
  }
}

function historyMutationOptions(
  command: 'revert' | 'undo' | 'redo',
  input: Record<string, unknown>,
  context: OutlineRuntimeRequestContext,
): OutlineRuntimeRequestContext & { readonly idempotencyKey?: string; readonly idempotencyPayloadHash?: string } {
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined;
  return {
    ...context,
    ...(idempotencyKey ? {
      idempotencyKey,
      idempotencyPayloadHash: canonicalSha256({
        kind: 'outline.history-mutation',
        command,
        ...(command === 'revert' ? { operationId: input.operationId } : {}),
      }),
    } : {}),
  };
}

function logFilterIdentity(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ['operationId', 'idempotencyKey', 'nodeId', 'origin', 'threadId', 'turnId', 'itemId']
      .flatMap((key) => input[key] === undefined ? [] : [[key, input[key]]]),
  );
}

function staleLogCursor(): OutlineContractError {
  return new OutlineContractError(outlineError(
    'stale_revision',
    'conflict',
    'Operation log cursor does not match the requested filters or retained history.',
  ));
}

export function requestCanMutate(command: string, input: unknown): boolean {
  if (command === 'diff') return false;
  if (command === 'revert' || command === 'undo' || command === 'redo') return true;
  const capability = outlineCapability(command);
  return capability?.kind === 'mutate' && !(isRecord(input) && input.preview === true);
}

function decodeRequest(value: unknown): OutlineRequest {
  if (!Value.Check(OutlineRequestSchema, value)) {
    throw new OutlineContractError(outlineError('invalid_input', 'usage', 'Invalid outline request envelope.'));
  }
  return value;
}

function publicError(error: unknown) {
  if (error instanceof OutlineContractError) return error.outlineError;
  return outlineError(
    'internal_error',
    'internal',
    'The Outline Runtime could not complete the request.',
    { details: error instanceof Error ? error.message : String(error) },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
