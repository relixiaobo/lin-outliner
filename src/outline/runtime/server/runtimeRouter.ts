import { Value } from 'typebox/value';
import { outlineCapability, outlineCapabilityManifest } from '../../contract/capabilities';
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
} from '../../contract/schemas';
import { OUTLINE_PROTOCOL_VERSION } from '../../contract/version';
import type { OutlineRuntimeWorkspace } from '../runtimeWorkspace';
import { applyOutlineDiff, diffOutlineChangeSet } from '../changeSet';
import { projectOutline } from '../projection';

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
      const data = await this.execute(request.command, request.input, context);
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
      return { running: true, runtime: { instanceId: this.workspace.instanceId, revision: this.workspace.revision() } };
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
    if (command === 'diff') {
      return diffOutlineChangeSet(this.workspace, (input as { changeSet: ChangeSet }).changeSet);
    }
    if (command === 'apply') {
      const value = input as { diff: Diff; acknowledgeDestructive?: boolean };
      return applyOutlineDiff(this.workspace, value.diff, context, value.acknowledgeDestructive === true);
    }
    if (command === 'log') return this.log(input as Record<string, unknown>);
    if (command === 'revert') {
      const operationId = String((input as Record<string, unknown>).operationId);
      return this.workspace.revert(operationId, context);
    }
    if (command === 'undo') return this.workspace.undo(context);
    if (command === 'redo') return this.workspace.redo(context);
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

  private async log(input: Record<string, unknown>): Promise<readonly Operation[]> {
    const limit = Math.max(1, Math.min(1_000, Number(input.limit ?? 100)));
    const operationId = typeof input.operationId === 'string' ? input.operationId : undefined;
    const nodeId = typeof input.nodeId === 'string' ? input.nodeId : undefined;
    const origin = typeof input.origin === 'string' ? input.origin : undefined;
    const operations = await this.workspace.store.operations();
    return [...operations]
      .reverse()
      .filter((operation) => !operationId || operation.operationId === operationId)
      .filter((operation) => !nodeId || operation.affectedNodeIds.includes(nodeId))
      .filter((operation) => !origin || operation.origin === origin)
      .slice(0, limit);
  }
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
