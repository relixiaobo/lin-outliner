import { decodeThreadItem } from '../../core/agent/codec';
import type { ThreadItem, ThreadItemDelta } from '../../core/agent/protocol';

export function applyThreadItemDelta(item: ThreadItem, delta: ThreadItemDelta): ThreadItem {
  switch (delta.type) {
    case 'agentMessageText':
      if (item.type !== 'agentMessage') throw mismatch(item, delta.type);
      return decodeThreadItem({ ...item, text: item.text + delta.delta });
    case 'planText':
      if (item.type !== 'plan') throw mismatch(item, delta.type);
      return decodeThreadItem({ ...item, text: item.text + delta.delta });
    case 'reasoningSummary':
    case 'reasoningContent': {
      if (item.type !== 'reasoning') throw mismatch(item, delta.type);
      const key = delta.type === 'reasoningSummary' ? 'summary' : 'content';
      const values = [...item[key]];
      if (values.length === 0) values.push(delta.delta);
      else values[values.length - 1] = values.at(-1)! + delta.delta;
      return decodeThreadItem({ ...item, [key]: values });
    }
    case 'commandOutput':
      if (item.type !== 'commandExecution') throw mismatch(item, delta.type);
      return decodeThreadItem({ ...item, aggregatedOutput: (item.aggregatedOutput ?? '') + delta.delta });
    case 'dynamicToolOutput':
      if (item.type !== 'dynamicToolCall') throw mismatch(item, delta.type);
      return decodeThreadItem({ ...item, contentItems: [...(item.contentItems ?? []), delta.delta] });
  }
}

function mismatch(item: ThreadItem, deltaType: ThreadItemDelta['type']): Error {
  return new Error(`Cannot apply ${deltaType} delta to ${item.type} Item`);
}
