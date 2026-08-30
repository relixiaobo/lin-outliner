import { api } from '../../api/client';
import {
  isContentBearingNode,
  plainText,
  type CommandResult,
  type FieldType,
  type NodeId,
} from '../../api/types';
import { nodeFromProjectionUpdate } from '../../state/document';
import type { EditorTrigger } from '../shared';

const LEGACY_EMPTY_FIELD_FALLBACK_NAME = 'Field';

export function triggerOwnsWholeText(text: string, trigger: Pick<EditorTrigger, 'from' | 'to'>): boolean {
  return text.slice(0, trigger.from).trim() === '' && text.slice(trigger.to).trim() === '';
}

export function referenceTriggerFromSlash(trigger: EditorTrigger): EditorTrigger {
  return {
    kind: '@',
    query: '',
    from: trigger.from,
    to: trigger.from + 1,
    anchor: trigger.anchor,
  };
}

function isEmptyFieldNameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('field name cannot be empty');
}

// Reads the field entry + its definition straight out of the create's delta. Safe
// because both are freshly created by the same `create_inline_field*` command, so
// both are in its `changedNodeIds` (a delta never omits a node it just created).
async function clearFallbackFieldName(outcome: CommandResult): Promise<CommandResult> {
  const fieldEntry = nodeFromProjectionUpdate(outcome.update, outcome.focus?.nodeId);
  const fieldDefId = fieldEntry?.type === 'fieldEntry' ? fieldEntry.fieldDefId : undefined;
  if (!fieldDefId) return outcome;

  const fieldDef = nodeFromProjectionUpdate(outcome.update, fieldDefId);
  if (!fieldDef || !isContentBearingNode(fieldDef) || fieldDef.content.text === '') return outcome;

  const cleared = await api.replaceNodeText(fieldDefId, plainText(''));
  return {
    update: cleared.update,
    focus: outcome.focus,
  };
}

export async function createPlaceholderInlineFieldAfterNode(
  afterNodeId: NodeId,
  fieldType: FieldType,
): Promise<CommandResult> {
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
  id?: NodeId,
): Promise<CommandResult> {
  try {
    return await api.createInlineField(parentId, index, '', fieldType, undefined, id);
  } catch (error) {
    if (!isEmptyFieldNameError(error)) throw error;
    return clearFallbackFieldName(
      await api.createInlineField(
        parentId,
        index,
        LEGACY_EMPTY_FIELD_FALLBACK_NAME,
        fieldType,
        undefined,
        id,
      ),
    );
  }
}

export function fieldDefinitionIdFromInlineFieldOutcome(
  outcome: CommandResult,
  entryId: NodeId,
): NodeId | null {
  const entry = nodeFromProjectionUpdate(outcome.update, entryId);
  return entry?.type === 'fieldEntry' && entry.fieldDefId ? entry.fieldDefId : null;
}
