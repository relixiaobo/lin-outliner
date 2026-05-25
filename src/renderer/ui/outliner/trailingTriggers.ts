import { api } from '../../api/client';
import type { SlashCommandId } from '../interactions/slashCommands';
import {
  plainText,
  type CommandOutcome,
  type FieldType,
  type NodeId,
  type NodeProjection,
  type RichText,
} from '../../api/types';
import {
  deleteRichTextRange,
  markWholeTextAsHeading,
  replaceRichTextRangeWithInlineRef,
} from '../editor/richTextCodec';
import type { CommandRunner, EditorTrigger } from '../shared';
import { textOf } from '../shared';

export type TrailingInlineTrigger = Omit<EditorTrigger, 'kind'> & { kind: '#' | '@' };
export type TrailingSlashTrigger = Omit<EditorTrigger, 'kind'> & { kind: '/' };

const LEGACY_EMPTY_FIELD_FALLBACK_NAME = 'Field';

function removeTriggerText(text: string, trigger: TrailingInlineTrigger): RichText {
  return deleteRichTextRange(plainText(text), trigger.from, trigger.to);
}

function removeSlashTriggerText(text: string, trigger: TrailingSlashTrigger): RichText {
  return deleteRichTextRange(plainText(text), trigger.from, trigger.to);
}

export function triggerOwnsWholeText(text: string, trigger: Pick<EditorTrigger, 'from' | 'to'>): boolean {
  return text.slice(0, trigger.from).trim() === '' && text.slice(trigger.to).trim() === '';
}

async function createNodeWithContent(parentId: NodeId, content: RichText): Promise<CommandOutcome> {
  return api.createRichTextNode(parentId, null, content);
}

function isEmptyFieldNameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('field name cannot be empty');
}

async function clearFallbackFieldName(outcome: CommandOutcome): Promise<CommandOutcome> {
  const fieldEntryId = outcome.focus?.nodeId;
  const fieldEntry = outcome.projection.nodes.find((node) => node.id === fieldEntryId);
  const fieldDefId = fieldEntry?.fieldDefId;
  if (!fieldDefId) return outcome;

  const fieldDef = outcome.projection.nodes.find((node) => node.id === fieldDefId);
  if (!fieldDef || fieldDef.content.text === '') return outcome;

  const cleared = await api.replaceNodeText(fieldDefId, plainText(''));
  return {
    projection: cleared.projection,
    focus: outcome.focus,
  };
}

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

export async function applyTrailingTagTrigger(params: {
  parentId: NodeId;
  text: string;
  trigger: TrailingInlineTrigger;
  tagId: NodeId;
}): Promise<CommandOutcome> {
  const content = removeTriggerText(params.text, params.trigger);
  return api.createTaggedNode(params.parentId, content, params.tagId);
}

export async function createAndApplyTrailingTagTrigger(params: {
  parentId: NodeId;
  text: string;
  trigger: TrailingInlineTrigger;
  name: string;
}): Promise<CommandOutcome> {
  const content = removeTriggerText(params.text, params.trigger);
  return api.createTagAndTaggedNode(params.parentId, content, params.name);
}

export async function applyTrailingReferenceTrigger(params: {
  parentId: NodeId;
  text: string;
  trigger: TrailingInlineTrigger;
  target: NodeProjection;
  forceInline?: boolean;
}): Promise<CommandOutcome> {
  if (!params.forceInline && triggerOwnsWholeText(params.text, params.trigger)) {
    return api.addReferenceConversion(params.parentId, params.target.id);
  }

  const content = replaceRichTextRangeWithInlineRef(
    plainText(params.text),
    params.trigger.from,
    params.trigger.to,
    {
      targetNodeId: params.target.id,
      displayName: textOf(params.target),
    },
  );
  return createNodeWithContent(params.parentId, content);
}

export async function executeTrailingSlashTrigger(params: {
  parentId: NodeId;
  text: string;
  trigger: TrailingSlashTrigger;
  commandId: Exclude<SlashCommandId, 'reference' | 'command_palette'>;
}): Promise<CommandOutcome> {
  if (params.commandId === 'field') {
    return createPlaceholderInlineField(params.parentId, null, 'plain');
  }

  const content = removeSlashTriggerText(params.text, params.trigger);

  if (params.commandId === 'heading') {
    return createNodeWithContent(params.parentId, markWholeTextAsHeading(content));
  }

  if (params.commandId === 'checkbox') {
    const created = await createNodeWithContent(params.parentId, content);
    const nodeId = created.focus?.nodeId;
    if (!nodeId) return created;
    return api.cycleDoneState(nodeId);
  }

  if (params.commandId === 'code') {
    const created = await createNodeWithContent(params.parentId, content);
    const nodeId = created.focus?.nodeId;
    if (!nodeId) return created;
    return api.setCodeBlock(nodeId);
  }

  const exhaustive: never = params.commandId;
  throw new Error(`Unsupported trailing slash command: ${exhaustive}`);
}

interface CreateTrailingFieldParams {
  parentId: NodeId;
  run: CommandRunner;
}

export async function createTrailingField({
  parentId,
  run,
}: CreateTrailingFieldParams) {
  await run(() => createPlaceholderInlineField(parentId, null, 'plain'));
}
