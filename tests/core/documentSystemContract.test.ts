import { describe, expect, test } from 'bun:test';
import {
  HOST_DOCUMENT_COMMANDS,
  DOCUMENT_COMMANDS,
  isDocumentCommand,
  isHostDocumentCommand,
} from '../../src/core/commands';
import {
  DocumentSystemContractError,
  decodeDocumentSystemReceipt,
  documentSystemReceiptKey,
  encodeDocumentSystemReceipt,
  documentCommandMutatesProtectedSystemTagDefinition,
  resolveDocumentSystemTagEnsure,
  validateHostDocumentCommandInvocation,
  validateDocumentSystemReceipt,
  type DocumentSystemTagDefinition,
} from '../../src/core/documentSystem';

const DIGEST = 'a'.repeat(64);
const definition: DocumentSystemTagDefinition = {
  namespace: 'agent.memory',
  tagId: 'tag:d-memory',
  name: 'd-memory',
};

describe('projection-neutral document system contract', () => {
  test('keeps trusted commands out of the public document command surface', () => {
    expect(HOST_DOCUMENT_COMMANDS).toEqual([
      'put_document_system_receipt',
      'ensure_document_system_tag_definition',
    ]);
    for (const command of HOST_DOCUMENT_COMMANDS) {
      expect(DOCUMENT_COMMANDS).not.toContain(command as never);
      expect(isDocumentCommand(command)).toBe(false);
      expect(isHostDocumentCommand(command)).toBe(true);
    }
  });

  test('uses deterministic keys and canonical receipt encoding', () => {
    const receipt = {
      namespace: 'agent.memory',
      scopeId: 'daily-notes',
      operationId: 'publication-1',
      generation: 2,
      digest: DIGEST,
    } as const;
    expect(documentSystemReceiptKey(receipt.namespace, receipt.scopeId)).toBe('["agent.memory","daily-notes"]');
    const encoded = encodeDocumentSystemReceipt(receipt);
    expect(encoded).toBe(
      `{"namespace":"agent.memory","scopeId":"daily-notes","operationId":"publication-1","generation":2,"digest":"${DIGEST}"}`,
    );
    expect(decodeDocumentSystemReceipt(encoded)).toEqual(receipt);
    expect(Object.isFrozen(decodeDocumentSystemReceipt(encoded))).toBe(true);
    expect(validateHostDocumentCommandInvocation(
      { namespace: 'agent.memory', operationId: 'publication-1' },
      'put_document_system_receipt',
      { receipt },
    ).command).toBe('put_document_system_receipt');
  });

  test('rejects feature payloads and noncanonical digests', () => {
    expect(() => validateDocumentSystemReceipt({
      namespace: 'agent.memory',
      scopeId: 'daily-notes',
      operationId: 'publication-1',
      generation: 1,
      digest: 'ABC',
    })).toThrow('lowercase SHA-256');
    expect(() => decodeDocumentSystemReceipt(JSON.stringify({
      namespace: 'agent.memory',
      scopeId: 'daily-notes',
      operationId: 'publication-1',
      generation: 1,
      digest: DIGEST,
      payload: { memory: 'forbidden' },
    }))).toThrow('unknown fields');
    expect(() => validateDocumentSystemReceipt({
      namespace: 'agent.memory',
      scopeId: 'daily-notes',
      operationId: 'publication-1',
      generation: 1,
      digest: DIGEST,
      payload: { memory: 'forbidden' },
    } as never)).toThrow('unknown fields');
    expect(() => validateHostDocumentCommandInvocation(
      { namespace: 'other.feature', operationId: 'publication-1' },
      'put_document_system_receipt',
      {
        receipt: {
          namespace: 'agent.memory',
          scopeId: 'daily-notes',
          operationId: 'publication-1',
          generation: 1,
          digest: DIGEST,
        },
      },
    )).toThrow('receipt identity must match');
    expect(() => validateHostDocumentCommandInvocation(
      { namespace: 'agent.memory', operationId: 'publication-2' },
      'put_document_system_receipt',
      {
        receipt: {
          namespace: 'agent.memory',
          scopeId: 'daily-notes',
          operationId: 'publication-1',
          generation: 1,
          digest: DIGEST,
        },
      },
    )).toThrow('receipt identity must match');
    expect(() => validateHostDocumentCommandInvocation(
      { namespace: 'agent.memory', operationId: 'publication-1' },
      'unknown_host_command' as never,
      {} as never,
    )).toThrow('unknown host document command');
    expect(() => validateHostDocumentCommandInvocation(
      { namespace: 'agent.memory', operationId: 'publication-1' },
      'put_document_system_receipt',
      {
        receipt: {
          namespace: 'agent.memory',
          scopeId: 'daily-notes',
          operationId: 'publication-1',
          generation: 1,
          digest: DIGEST,
        },
        payload: { memory: 'forbidden' },
      } as never,
    )).toThrow('host document command arguments contains unknown fields');
  });

  test('resolves create, same-id restore, and idempotent ensure', () => {
    expect(resolveDocumentSystemTagEnsure(definition, { tag: { kind: 'missing' } }).action).toBe('create');
    expect(resolveDocumentSystemTagEnsure(definition, {
      claim: definition,
      tag: { kind: 'trashed', tagId: definition.tagId, name: definition.name, nodeType: 'tagDef' },
    }).action).toBe('restore');
    expect(resolveDocumentSystemTagEnsure(definition, {
      claim: definition,
      tag: { kind: 'active', tagId: definition.tagId, name: definition.name, nodeType: 'tagDef' },
    }).action).toBe('none');
  });

  test('fails closed on ownership, name, type, or identity conflicts', () => {
    expect(() => resolveDocumentSystemTagEnsure(definition, {
      tag: { kind: 'active', tagId: definition.tagId, name: definition.name, nodeType: 'tagDef' },
    })).toThrow('no matching system ownership claim');
    expect(() => resolveDocumentSystemTagEnsure(definition, {
      claim: { ...definition, namespace: 'other.feature' },
      tag: { kind: 'active', tagId: definition.tagId, name: definition.name, nodeType: 'tagDef' },
    })).toThrow(DocumentSystemContractError);
    expect(() => resolveDocumentSystemTagEnsure(definition, {
      claim: definition,
      tag: { kind: 'active', tagId: definition.tagId, name: 'renamed', nodeType: 'tagDef' },
    })).toThrow('existing tag identity conflicts');
    expect(() => resolveDocumentSystemTagEnsure(definition, {
      claim: definition,
      tag: { kind: 'active', tagId: definition.tagId, name: definition.name, nodeType: 'fieldDef' },
    })).toThrow('existing tag identity conflicts');
    expect(() => validateHostDocumentCommandInvocation(
      { namespace: 'other.feature', operationId: 'publication-1' },
      'ensure_document_system_tag_definition',
      { definition },
    )).toThrow('namespace must match');
  });

  test('locks definition identity mutations while allowing ordinary tag use', () => {
    const protectedIds = new Set([definition.tagId]);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'apply_node_text_patch',
      { nodeId: definition.tagId, patch: {} },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'batch_move_nodes',
      { moves: [{ nodeId: definition.tagId, parentId: 'trash' }] },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'split_node',
      { nodeId: definition.tagId },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'batch_move_nodes_up',
      { nodeIds: [definition.tagId] },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'set_node_image',
      { nodeId: definition.tagId },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'convert_reference_to_inline_node',
      { referenceId: definition.tagId },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'set_search_node',
      { nodeId: definition.tagId },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'merge_definitions',
      { targetId: 'tag:other', sourceIds: [definition.tagId] },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'apply_tag',
      { nodeId: 'note-1', tagId: definition.tagId },
      protectedIds,
    )).toBe(false);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'remove_tag',
      { nodeId: 'note-1', tagId: definition.tagId },
      protectedIds,
    )).toBe(false);
  });
});
