import { basenameForPath } from '../../../core/referenceMarkup';
import type { ReferenceTarget } from '../../api/types';

export function inlineRefTargetAttrs(target: ReferenceTarget): Record<string, unknown> {
  if (target.kind === 'node') {
    return {
      targetKind: 'node',
      targetNodeId: target.nodeId,
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
  return null;
}

export function targetFromInlineReferenceElement(element: HTMLElement): ReferenceTarget | null {
  return targetFromInlineReferenceAttrs({
    targetKind: element.dataset.inlineRefKind ?? 'node',
    targetNodeId: element.dataset.inlineRef ?? '',
    targetPath: element.dataset.inlineRefPath ?? '',
    entryKind: element.dataset.inlineRefEntryKind ?? 'file',
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
  return 'Referenced node';
}
