import { api } from '../../api/client';
import {
  plainText,
  type CommandOutcome,
  type FieldType,
  type NodeId,
} from '../../api/types';
import type { EditorTrigger } from '../shared';

const LEGACY_EMPTY_FIELD_FALLBACK_NAME = 'Field';

export function triggerOwnsWholeText(text: string, trigger: Pick<EditorTrigger, 'from' | 'to'>): boolean {
  return text.slice(0, trigger.from).trim() === '' && text.slice(trigger.to).trim() === '';
}

function isEmptyFieldNameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('field name cannot be empty');
}

async function clearFallbackFieldName(outcome: CommandOutcome): Promise<CommandOutcome> {
  const fieldEntryId = outcome.focus?.nodeId;
  const fieldEntry = outcome.projection.nodes.find((node) => node.id === fieldEntryId);
  const fieldDefId = fieldEntry?.type === 'fieldEntry' ? fieldEntry.fieldDefId : undefined;
  if (!fieldDefId) return outcome;

  const fieldDef = outcome.projection.nodes.find((node) => node.id === fieldDefId);
  if (!fieldDef || fieldDef.content.text === '') return outcome;

  const cleared = await api.replaceNodeText(fieldDefId, plainText(''));
  return {
    projection: cleared.projection,
    focus: outcome.focus,
  };
}

export async function createPlaceholderInlineFieldAfterNode(
  afterNodeId: NodeId,
  fieldType: FieldType,
): Promise<CommandOutcome> {
  try {
    return await api.createInlineFieldAfterNode(afterNodeId, '', fieldType);
  } catch (error) {
    if (!isEmptyFieldNameError(error)) throw error;
    return clearFallbackFieldName(
      await api.createInlineFieldAfterNode(afterNodeId, LEGACY_EMPTY_FIELD_FALLBACK_NAME, fieldType),
    );
  }
}

// The trailing-draft variant: a `>`/`/field` trigger on a not-yet-materialized
// draft has no real node to anchor "after", so it creates the inline field as a
// fresh child of the draft's parent (`create_inline_field`) instead of
// `create_inline_field_after_node`. Same empty-name placeholder contract.
export async function createPlaceholderInlineField(
  parentId: NodeId,
  index: number | null,
  fieldType: FieldType,
): Promise<CommandOutcome> {
  try {
    return await api.createInlineField(parentId, index, '', fieldType);
  } catch (error) {
    if (!isEmptyFieldNameError(error)) throw error;
    return clearFallbackFieldName(
      await api.createInlineField(parentId, index, LEGACY_EMPTY_FIELD_FALLBACK_NAME, fieldType),
    );
  }
}
