import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { CommandRunner, EditorTrigger } from '../shared';

export type TrailingTriggerKind = Extract<EditorTrigger['kind'], '#' | '@' | '/'>;

interface CreateTrailingTriggerNodeParams {
  parentId: NodeId;
  text: string;
  trigger: TrailingTriggerKind;
  run: CommandRunner;
  setTrigger: (trigger: ({ nodeId: NodeId } & EditorTrigger) | null) => void;
}

export async function createTrailingTriggerNode({
  parentId,
  text,
  trigger,
  run,
  setTrigger,
}: CreateTrailingTriggerNodeParams) {
  const result = await run(() => api.createNode(parentId, null, text));
  const nodeId = result && 'focus' in result ? result.focus?.nodeId : null;
  if (!nodeId) return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const from = Math.max(0, text.length - 1);
      setTrigger({
        nodeId,
        kind: trigger,
        query: '',
        from,
        to: text.length,
      });
    });
  });
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
