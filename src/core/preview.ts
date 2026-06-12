export type PreviewEntryKind = 'file' | 'directory';

export type PreviewTarget =
  | {
      kind: 'local-file';
      path: string;
      entryKind: PreviewEntryKind;
      label?: string;
    }
  | {
      kind: 'asset';
      assetId: string;
      label?: string;
    }
  | {
      kind: 'agent-payload';
      conversationId: string;
      runId?: string;
      payloadId: string;
      label?: string;
    }
  | {
      kind: 'url';
      url: string;
      label?: string;
    };

export function previewTargetKey(target: PreviewTarget): string {
  switch (target.kind) {
    case 'local-file':
      return `local-file:${target.entryKind}:${target.path}`;
    case 'asset':
      return `asset:${target.assetId}`;
    case 'agent-payload':
      return `agent-payload:${target.conversationId}:${target.runId ?? ''}:${target.payloadId}`;
    case 'url':
      return `url:${target.url}`;
  }
}

export function previewTargetFromUnknown(value: unknown): PreviewTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  const label = typeof value.label === 'string' && value.label.trim() ? value.label : undefined;
  if (value.kind === 'local-file') {
    if (typeof value.path !== 'string' || !value.path) return null;
    return {
      kind: 'local-file',
      path: value.path,
      entryKind: value.entryKind === 'directory' ? 'directory' : 'file',
      ...(label ? { label } : {}),
    };
  }
  if (value.kind === 'asset') {
    if (typeof value.assetId !== 'string' || !value.assetId) return null;
    return { kind: 'asset', assetId: value.assetId, ...(label ? { label } : {}) };
  }
  if (value.kind === 'agent-payload') {
    if (typeof value.conversationId !== 'string' || !value.conversationId) return null;
    if (typeof value.payloadId !== 'string' || !value.payloadId) return null;
    return {
      kind: 'agent-payload',
      conversationId: value.conversationId,
      ...(typeof value.runId === 'string' && value.runId ? { runId: value.runId } : {}),
      payloadId: value.payloadId,
      ...(label ? { label } : {}),
    };
  }
  if (value.kind === 'url') {
    if (typeof value.url !== 'string' || !value.url) return null;
    return { kind: 'url', url: value.url, ...(label ? { label } : {}) };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
