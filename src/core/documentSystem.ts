import type { DocumentCommand, HostDocumentCommand } from './commands';
import type { AgentMutationCausation } from './agent/protocol';

export interface DocumentSystemReceipt {
  readonly namespace: string;
  readonly scopeId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly digest: string;
}

export interface DocumentSystemTagDefinition {
  readonly namespace: string;
  readonly tagId: string;
  readonly name: string;
}

export interface HostDocumentCommandArguments {
  readonly put_document_system_receipt: {
    readonly receipt: DocumentSystemReceipt;
  };
  readonly ensure_document_system_tag_definition: {
    readonly definition: DocumentSystemTagDefinition;
  };
}

export type HostDocumentCommandInvocation = {
  readonly [Command in HostDocumentCommand]: {
    readonly command: Command;
    readonly args: HostDocumentCommandArguments[Command];
  }
}[HostDocumentCommand];

export interface DocumentSystemTransactionContext {
  readonly namespace: string;
  readonly operationId: string;
  readonly causation?: AgentMutationCausation;
}

/**
 * A trusted transaction commits every document and system command as one Loro
 * change. Implementations exclude the transaction from user undo, expose only
 * Node deltas, and emit no projection event for a system-only commit.
 */
export interface DocumentSystemTransaction {
  /** Executes a document mutation and enforces protected system-tag ownership. */
  executeDocumentCommand(command: DocumentCommand, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  executeHostCommand<Command extends HostDocumentCommand>(
    command: Command,
    args: HostDocumentCommandArguments[Command],
  ): Promise<void>;
}

export interface DocumentSystemHost {
  transaction<Result>(
    context: DocumentSystemTransactionContext,
    operation: (transaction: DocumentSystemTransaction) => Promise<Result>,
  ): Promise<Result>;
  readDocumentSystemReceipt(namespace: string, scopeId: string): Promise<DocumentSystemReceipt | null>;
  readDocumentSystemTagDefinition(tagId: string): Promise<DocumentSystemTagDefinition | null>;
}

export type DocumentSystemTagObservedState =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'active' | 'trashed';
      readonly tagId: string;
      readonly name: string;
      readonly nodeType: string | null;
    };

export interface DocumentSystemTagEnsureState {
  readonly claim?: DocumentSystemTagDefinition;
  readonly tag: DocumentSystemTagObservedState;
}

export type DocumentSystemTagEnsureResolution =
  | { readonly action: 'create'; readonly definition: DocumentSystemTagDefinition }
  | { readonly action: 'restore'; readonly definition: DocumentSystemTagDefinition }
  | { readonly action: 'none'; readonly definition: DocumentSystemTagDefinition };

export class DocumentSystemContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentSystemContractError';
  }
}

export function validateHostDocumentCommandInvocation<Command extends HostDocumentCommand>(
  context: DocumentSystemTransactionContext,
  command: Command,
  args: HostDocumentCommandArguments[Command],
): HostDocumentCommandInvocation {
  validateNamespace(context.namespace);
  requireNonEmpty(context.operationId, 'operationId');
  if (command !== 'put_document_system_receipt' && command !== 'ensure_document_system_tag_definition') {
    throw new DocumentSystemContractError(`unknown host document command: ${String(command)}`);
  }
  if (!isRecord(args)) throw new DocumentSystemContractError('host document command arguments must be an object');
  if (command === 'put_document_system_receipt') {
    assertExactKeys(args, ['receipt'], 'host document command arguments');
    const receipt = validateDocumentSystemReceipt(
      (args as HostDocumentCommandArguments['put_document_system_receipt']).receipt,
    );
    if (receipt.namespace !== context.namespace || receipt.operationId !== context.operationId) {
      throw new DocumentSystemContractError('receipt identity must match the trusted transaction caller');
    }
    return Object.freeze({ command, args: { receipt } }) as HostDocumentCommandInvocation;
  }
  assertExactKeys(args, ['definition'], 'host document command arguments');
  const definition = validateDocumentSystemTagDefinition(
    (args as HostDocumentCommandArguments['ensure_document_system_tag_definition']).definition,
  );
  if (definition.namespace !== context.namespace) {
    throw new DocumentSystemContractError('system tag namespace must match the trusted transaction caller');
  }
  return Object.freeze({ command, args: { definition } }) as HostDocumentCommandInvocation;
}

export const PROTECTED_SYSTEM_TAG_DEFINITION_COMMANDS = [
  'create_node',
  'split_node',
  'apply_node_text_patch',
  'set_code_block',
  'set_node_image',
  'move_node',
  'batch_move_nodes',
  'indent_node',
  'outdent_node',
  'trash_node',
  'batch_trash_nodes',
  'batch_indent_nodes',
  'batch_outdent_nodes',
  'batch_duplicate_nodes',
  'batch_move_nodes_up',
  'batch_move_nodes_down',
  'delete_node',
  'merge_node_into',
  'merge_definitions',
  'replace_node_with_reference',
  'replace_node_with_reference_conversion',
  'replace_node_with_inline_reference',
  'convert_reference_to_inline_node',
  'restore_inline_reference_node_to_reference',
  'set_search_node',
] as const;

export function documentCommandMutatesProtectedSystemTagDefinition(
  command: string,
  args: Readonly<Record<string, unknown>>,
  protectedTagIds: ReadonlySet<string>,
): boolean {
  const targetIds: string[] = [];
  switch (command) {
    case 'create_node':
      if (typeof args.id === 'string') targetIds.push(args.id);
      break;
    case 'apply_node_text_patch':
    case 'split_node':
    case 'set_code_block':
    case 'set_node_image':
    case 'move_node':
    case 'indent_node':
    case 'outdent_node':
    case 'trash_node':
    case 'delete_node':
    case 'replace_node_with_reference':
    case 'replace_node_with_reference_conversion':
    case 'replace_node_with_inline_reference':
    case 'restore_inline_reference_node_to_reference':
    case 'set_search_node':
      if (typeof args.nodeId === 'string') targetIds.push(args.nodeId);
      break;
    case 'convert_reference_to_inline_node':
      if (typeof args.referenceId === 'string') targetIds.push(args.referenceId);
      break;
    case 'merge_node_into':
      for (const key of ['sourceId', 'targetId', 'nodeId', 'targetNodeId']) {
        if (typeof args[key] === 'string') targetIds.push(args[key] as string);
      }
      break;
    case 'merge_definitions':
      for (const key of ['sourceDefinitionId', 'targetDefinitionId', 'sourceId', 'targetId']) {
        if (typeof args[key] === 'string') targetIds.push(args[key] as string);
      }
      if (Array.isArray(args.sourceIds)) {
        targetIds.push(...args.sourceIds.filter((id): id is string => typeof id === 'string'));
      }
      break;
    case 'batch_move_nodes':
      if (Array.isArray(args.moves)) {
        for (const move of args.moves) {
          if (isRecord(move) && typeof move.nodeId === 'string') targetIds.push(move.nodeId);
        }
      }
      break;
    case 'batch_trash_nodes':
    case 'batch_indent_nodes':
    case 'batch_outdent_nodes':
    case 'batch_duplicate_nodes':
    case 'batch_move_nodes_up':
    case 'batch_move_nodes_down':
      if (Array.isArray(args.nodeIds)) {
        targetIds.push(...args.nodeIds.filter((id): id is string => typeof id === 'string'));
      }
      break;
    default:
      return false;
  }
  return targetIds.some((id) => protectedTagIds.has(id));
}

const NAMESPACE_PATTERN = /^[a-z][a-z0-9._-]*$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function validateDocumentSystemReceipt(value: DocumentSystemReceipt): DocumentSystemReceipt {
  if (!isRecord(value)) throw new DocumentSystemContractError('receipt must be an object');
  assertExactKeys(value, ['namespace', 'scopeId', 'operationId', 'generation', 'digest'], 'receipt');
  if (
    typeof value.namespace !== 'string'
    || typeof value.scopeId !== 'string'
    || typeof value.operationId !== 'string'
    || typeof value.generation !== 'number'
    || typeof value.digest !== 'string'
  ) {
    throw new DocumentSystemContractError('receipt contains invalid field types');
  }
  validateNamespace(value.namespace);
  requireNonEmpty(value.scopeId, 'scopeId');
  requireNonEmpty(value.operationId, 'operationId');
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new DocumentSystemContractError('generation must be a non-negative safe integer');
  }
  if (!DIGEST_PATTERN.test(value.digest)) {
    throw new DocumentSystemContractError('digest must be a lowercase SHA-256 value');
  }
  return Object.freeze({
    namespace: value.namespace,
    scopeId: value.scopeId,
    operationId: value.operationId,
    generation: value.generation,
    digest: value.digest,
  });
}

export function validateDocumentSystemTagDefinition(
  value: DocumentSystemTagDefinition,
): DocumentSystemTagDefinition {
  if (!isRecord(value)) throw new DocumentSystemContractError('system tag definition must be an object');
  assertExactKeys(value, ['namespace', 'tagId', 'name'], 'system tag definition');
  if (typeof value.namespace !== 'string' || typeof value.tagId !== 'string' || typeof value.name !== 'string') {
    throw new DocumentSystemContractError('system tag definition contains invalid field types');
  }
  validateNamespace(value.namespace);
  requireNonEmpty(value.tagId, 'tagId');
  requireNonEmpty(value.name, 'name');
  if (value.name !== value.name.trim() || value.name.startsWith('#')) {
    throw new DocumentSystemContractError('name must be canonical tag text without a leading #');
  }
  return Object.freeze({ namespace: value.namespace, tagId: value.tagId, name: value.name });
}

export function documentSystemReceiptKey(namespace: string, scopeId: string): string {
  validateNamespace(namespace);
  requireNonEmpty(scopeId, 'scopeId');
  return JSON.stringify([namespace, scopeId]);
}

export function encodeDocumentSystemReceipt(value: DocumentSystemReceipt): string {
  const receipt = validateDocumentSystemReceipt(value);
  return JSON.stringify({
    namespace: receipt.namespace,
    scopeId: receipt.scopeId,
    operationId: receipt.operationId,
    generation: receipt.generation,
    digest: receipt.digest,
  });
}

export function decodeDocumentSystemReceipt(encoded: string): DocumentSystemReceipt {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new DocumentSystemContractError('receipt must be valid JSON');
  }
  if (!isRecord(value)) throw new DocumentSystemContractError('receipt must be an object');
  assertExactKeys(value, ['namespace', 'scopeId', 'operationId', 'generation', 'digest'], 'receipt');
  if (
    typeof value.namespace !== 'string'
    || typeof value.scopeId !== 'string'
    || typeof value.operationId !== 'string'
    || typeof value.generation !== 'number'
    || typeof value.digest !== 'string'
  ) {
    throw new DocumentSystemContractError('receipt contains invalid field types');
  }
  return validateDocumentSystemReceipt({
    namespace: value.namespace,
    scopeId: value.scopeId,
    operationId: value.operationId,
    generation: value.generation,
    digest: value.digest,
  });
}

export function resolveDocumentSystemTagEnsure(
  definitionInput: DocumentSystemTagDefinition,
  state: DocumentSystemTagEnsureState,
): DocumentSystemTagEnsureResolution {
  const definition = validateDocumentSystemTagDefinition(definitionInput);
  const claim = state.claim ? validateDocumentSystemTagDefinition(state.claim) : undefined;
  if (claim && (
    claim.namespace !== definition.namespace
    || claim.tagId !== definition.tagId
    || claim.name !== definition.name
  )) {
    throw new DocumentSystemContractError('system tag ownership claim conflicts with the requested definition');
  }

  if (state.tag.kind === 'missing') return Object.freeze({ action: 'create', definition });
  if (!claim) {
    throw new DocumentSystemContractError('existing tag has no matching system ownership claim');
  }
  if (
    state.tag.tagId !== definition.tagId
    || state.tag.name !== definition.name
    || state.tag.nodeType !== 'tagDef'
  ) {
    throw new DocumentSystemContractError('existing tag identity conflicts with the requested definition');
  }
  return Object.freeze({
    action: state.tag.kind === 'trashed' ? 'restore' : 'none',
    definition,
  });
}

function validateNamespace(value: string): void {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new DocumentSystemContractError('namespace must be a canonical lowercase identifier');
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value || value !== value.trim()) {
    throw new DocumentSystemContractError(`${field} must be a non-empty canonical string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], subject: string): void {
  const expectedSet = new Set(expected);
  if (Object.keys(record).some((key) => !expectedSet.has(key))) {
    throw new DocumentSystemContractError(`${subject} contains unknown fields`);
  }
}
