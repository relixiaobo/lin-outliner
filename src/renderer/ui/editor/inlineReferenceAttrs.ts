import { basenameForPath } from '../../../core/referenceMarkup';
import type { ReferenceTarget } from '../../api/types';

export function inlineRefTargetAttrs(target: ReferenceTarget): Record<string, unknown> {
  if (target.kind === 'node') {
    return {
      targetKind: 'node',
      targetNodeId: target.nodeId,
    };
  }
  if (target.kind === 'chat-source') {
    return {
      targetKind: 'chat-source',
      chatStream: target.stream,
      chatStreamId: target.streamId,
      chatFromSeqExclusive: target.range.fromSeqExclusive,
      chatThroughSeq: target.range.throughSeq,
      chatThroughEventId: target.range.throughEventId ?? '',
    };
  }
  return {
    targetKind: 'local-file',
    targetPath: target.path,
    entryKind: target.entryKind,
  };
}

export function targetFromInlineReferenceAttrs(attrs: Record<string, unknown>): ReferenceTarget | null {
  const targetKind = String(attrs.targetKind ?? 'node');
  if (targetKind === 'node') {
    const nodeId = String(attrs.targetNodeId ?? '');
    return nodeId ? { kind: 'node', nodeId } : null;
  }
  if (targetKind === 'local-file') {
    const path = String(attrs.targetPath ?? '');
    const entryKind = attrs.entryKind === 'directory' ? 'directory' : 'file';
    return path ? { kind: 'local-file', path, entryKind } : null;
  }
  if (targetKind === 'chat-source') {
    const stream = attrs.chatStream === 'conversation' || attrs.chatStream === 'run' ? attrs.chatStream : null;
    const streamId = String(attrs.chatStreamId ?? '');
    const fromSeqExclusive = Number(attrs.chatFromSeqExclusive);
    const throughSeq = Number(attrs.chatThroughSeq);
    const throughEventId = String(attrs.chatThroughEventId ?? '');
    if (!stream || !streamId || !Number.isSafeInteger(fromSeqExclusive) || !Number.isSafeInteger(throughSeq) || throughSeq <= fromSeqExclusive) return null;
    return {
      kind: 'chat-source',
      stream,
      streamId,
      range: {
        fromSeqExclusive,
        throughSeq,
        ...(throughEventId ? { throughEventId } : {}),
      },
    };
  }
  return null;
}

function numberFromDatasetValue(value: string | undefined): number {
  return value && value.trim() ? Number(value) : Number.NaN;
}

export function targetFromInlineReferenceElement(element: HTMLElement): ReferenceTarget | null {
  return targetFromInlineReferenceAttrs({
    targetKind: element.dataset.inlineRefKind ?? 'node',
    targetNodeId: element.dataset.inlineRef ?? '',
    targetPath: element.dataset.inlineRefPath ?? '',
    entryKind: element.dataset.inlineRefEntryKind ?? 'file',
    chatStream: element.dataset.inlineRefChatStream ?? '',
    chatStreamId: element.dataset.inlineRefChatStreamId ?? '',
    chatFromSeqExclusive: numberFromDatasetValue(element.dataset.inlineRefChatFromSeqExclusive),
    chatThroughSeq: numberFromDatasetValue(element.dataset.inlineRefChatThroughSeq),
    chatThroughEventId: element.dataset.inlineRefChatThroughEventId ?? '',
  });
}

export function fallbackTextForInlineReferenceAttrs(attrs: Record<string, unknown>): string {
  const displayName = String(attrs.displayName ?? '');
  if (displayName) return displayName;
  const targetKind = String(attrs.targetKind ?? 'node');
  if (targetKind === 'local-file') {
    const targetPath = String(attrs.targetPath ?? '');
    return basenameForPath(targetPath) || 'Referenced file';
  }
  if (targetKind === 'chat-source') return 'Referenced chat';
  return 'Referenced node';
}
