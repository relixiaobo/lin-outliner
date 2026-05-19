import { api } from '../../api/client';
import type { SlashCommandId } from '../interactions/slashCommands';
import {
  plainText,
  type CommandOutcome,
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

function removeTriggerText(text: string, trigger: TrailingInlineTrigger): RichText {
  return deleteRichTextRange(plainText(text), trigger.from, trigger.to);
}

function removeSlashTriggerText(text: string, trigger: TrailingSlashTrigger): RichText {
  return deleteRichTextRange(plainText(text), trigger.from, trigger.to);
}

function triggerOwnsWholeText(text: string, trigger: TrailingInlineTrigger): boolean {
  return text.slice(0, trigger.from).trim() === '' && text.slice(trigger.to).trim() === '';
}

async function createNodeWithContent(parentId: NodeId, content: RichText): Promise<CommandOutcome> {
  return api.createRichTextNode(parentId, null, content);
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
}): Promise<CommandOutcome> {
  if (triggerOwnsWholeText(params.text, params.trigger)) {
    return api.addReference(params.parentId, params.target.id);
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
    return api.createInlineField(params.parentId, null, 'Field', 'plain');
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
  await run(() => api.createInlineField(parentId, null, 'Field', 'plain'));
}
