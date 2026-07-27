import { describe, expect, test } from 'bun:test';
import {
  HOST_DOCUMENT_COMMANDS,
  DOCUMENT_COMMANDS,
  isDocumentCommand,
  isHostDocumentCommand,
  type DocumentCommand,
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
    const protectedTargetByCommand = {
      init_workspace: null,
      get_projection: null,
      search_nodes: null,
      backlinks: null,
      create_node: { parentId: definition.tagId },
      create_rich_text_node: { parentId: definition.tagId },
      create_tagged_node: { parentId: definition.tagId },
      create_tag_and_tagged_node: { parentId: definition.tagId },
      create_nodes_from_tree: { parentId: definition.tagId },
      create_capture: { input: { destinationParentId: definition.tagId } },
      paste_nodes_into_node: { nodeId: definition.tagId },
      split_node: { nodeId: definition.tagId },
      apply_node_text_patch: { nodeId: definition.tagId },
      update_node_description: { nodeId: definition.tagId },
      set_node_checkbox_visible: { nodeId: definition.tagId },
      set_code_block: { nodeId: definition.tagId },
      set_code_language: { nodeId: definition.tagId },
      create_image_node: { parentId: definition.tagId },
      create_attachment_node: { parentId: definition.tagId },
      set_node_image: { nodeId: definition.tagId },
      set_view_toolbar_visible: { nodeId: definition.tagId },
      set_view_mode: { nodeId: definition.tagId },
      add_sort_rule: { nodeId: definition.tagId },
      update_sort_rule: { ruleId: definition.tagId },
      remove_sort_rule: { ruleId: definition.tagId },
      clear_sort_rules: { nodeId: definition.tagId },
      add_filter_rule: { nodeId: definition.tagId },
      update_filter_rule: { ruleId: definition.tagId },
      remove_filter_rule: { ruleId: definition.tagId },
      clear_filter_rules: { nodeId: definition.tagId },
      set_group_field: { nodeId: definition.tagId },
      add_display_field: { nodeId: definition.tagId },
      update_display_field: { displayFieldId: definition.tagId },
      remove_display_field: { displayFieldId: definition.tagId },
      set_node_icon: { nodeId: definition.tagId },
      set_node_banner: { nodeId: definition.tagId },
      merge_node_into: { targetId: definition.tagId },
      move_node: { parentId: definition.tagId },
      batch_move_nodes: { moves: [{ nodeId: 'node:ordinary', parentId: definition.tagId }] },
      indent_node: { nodeId: definition.tagId },
      outdent_node: { nodeId: definition.tagId },
      trash_node: { nodeId: definition.tagId },
      batch_trash_nodes: { nodeIds: [definition.tagId] },
      batch_indent_nodes: { nodeIds: [definition.tagId] },
      batch_outdent_nodes: { nodeIds: [definition.tagId] },
      batch_toggle_done: { nodeIds: [definition.tagId] },
      batch_cycle_done_state: { nodeIds: [definition.tagId] },
      batch_duplicate_nodes: { nodeIds: [definition.tagId] },
      batch_move_nodes_up: { nodeIds: [definition.tagId] },
      batch_move_nodes_down: { nodeIds: [definition.tagId] },
      batch_apply_tag: { nodeIds: [definition.tagId], tagId: 'tag:ordinary' },
      restore_node: { nodeId: definition.tagId },
      delete_node: { nodeId: definition.tagId },
      toggle_done: { nodeId: definition.tagId },
      cycle_done_state: { nodeId: definition.tagId },
      create_tag: null,
      apply_tag: { nodeId: definition.tagId, tagId: 'tag:ordinary' },
      remove_tag: { nodeId: definition.tagId, tagId: 'tag:ordinary' },
      set_tag_config: { tagId: definition.tagId },
      set_field_config: { fieldId: definition.tagId },
      create_field_definition: null,
      create_field_def: { tagId: definition.tagId },
      create_inline_field_after_node: { afterNodeId: definition.tagId },
      create_inline_field: { parentId: definition.tagId },
      reuse_field_definition: { entryId: definition.tagId },
      merge_definitions: { targetId: 'tag:other', sourceIds: [definition.tagId] },
      register_collected_option: { fieldDefId: definition.tagId },
      create_collected_field_option: { fieldEntryId: definition.tagId },
      select_field_option: { fieldEntryId: definition.tagId },
      set_field_free_text_value: { fieldEntryId: definition.tagId },
      clear_field_value: { fieldEntryId: definition.tagId },
      remove_field_value: { valueId: definition.tagId },
      add_reference: { parentId: definition.tagId },
      add_reference_conversion: { parentId: definition.tagId },
      set_reference_target: { referenceId: definition.tagId },
      replace_node_with_reference: { nodeId: definition.tagId },
      replace_node_with_reference_conversion: { nodeId: definition.tagId },
      replace_node_with_inline_reference: { nodeId: definition.tagId },
      convert_reference_to_inline_node: { referenceId: definition.tagId },
      restore_inline_reference_node_to_reference: { nodeId: definition.tagId },
      ensure_date_node: null,
      ensure_tag_search: null,
      create_search_node: { parentId: definition.tagId },
      set_search_node: { nodeId: definition.tagId },
      set_search_query_outline: { nodeId: definition.tagId },
      refresh_search_node_results: { nodeId: definition.tagId },
      undo: null,
      redo: null,
    } satisfies Record<DocumentCommand, Readonly<Record<string, unknown>> | null>;

    expect(Object.keys(protectedTargetByCommand)).toEqual(DOCUMENT_COMMANDS);
    for (const command of DOCUMENT_COMMANDS) {
      const args = protectedTargetByCommand[command];
      expect(documentCommandMutatesProtectedSystemTagDefinition(
        command,
        args ?? {},
        protectedIds,
      )).toBe(args !== null);
    }

    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'create_node',
      { id: definition.tagId, parentId: 'node:ordinary' },
      protectedIds,
    )).toBe(true);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'split_node',
      { nodeId: 'node:ordinary', targetParentId: definition.tagId },
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
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'create_tagged_node',
      { parentId: 'node:ordinary', tagId: definition.tagId },
      protectedIds,
    )).toBe(false);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'batch_apply_tag',
      { nodeIds: ['node:ordinary'], tagId: definition.tagId },
      protectedIds,
    )).toBe(false);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'ensure_tag_search',
      { tagId: definition.tagId },
      protectedIds,
    )).toBe(false);
    expect(documentCommandMutatesProtectedSystemTagDefinition(
      'unknown_document_command' as never,
      {},
      protectedIds,
    )).toBe(true);
  });
});
