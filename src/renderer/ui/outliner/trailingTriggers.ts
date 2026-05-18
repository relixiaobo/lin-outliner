import { api } from '../../api/client';
import { plainText, type NodeId } from '../../api/types';
import type { CommandRunner, EditorTrigger } from '../shared';

export type TrailingTriggerKind = Extract<EditorTrigger['kind'], '#' | '@' | '/'>;

interface CreateTrailingTriggerNodeParams {
  parentId: NodeId;
  text: string;
  trigger: TrailingTriggerKind;
  getText?: () => string;
  run: CommandRunner;
  setTrigger: (trigger: ({ nodeId: NodeId } & EditorTrigger) | null) => void;
}

export async function createTrailingTriggerNode({
  parentId,
  getText,
  text,
  trigger,
  run,
  setTrigger,
}: CreateTrailingTriggerNodeParams) {
  const result = await run(() => api.createNode(parentId, null, text));
  const nodeId = result && 'focus' in result ? result.focus?.nodeId : null;
  if (!nodeId) return;
  const finalText = getText?.() ?? text;
  if (finalText !== text) {
    await run(() => api.replaceNodeText(nodeId, plainText(finalText)));
  }
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const from = Math.max(0, finalText.lastIndexOf(trigger));
      setTrigger({
        nodeId,
        kind: trigger,
        query: finalText.slice(from + 1),
        from,
        to: finalText.length,
      });
    });
  });
  return nodeId;
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
