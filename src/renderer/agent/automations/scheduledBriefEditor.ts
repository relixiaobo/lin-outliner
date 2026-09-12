import { basenameForPath, formatFileReferenceMarker, formatNodeReferenceMarker, splitReferenceMarkers } from '../../../core/referenceMarkup';
import type { ThreadComposerDraftContent, ThreadComposerFileReference } from '../components/ThreadComposerEditor';

export function scheduledFileReference(path: string, name = basenameForPath(path), entryKind: 'file' | 'directory' = 'file'): ThreadComposerFileReference {
  return { attachmentId: path, name, path, ref: path, entryKind, mimeType: entryKind === 'directory' ? 'inode/directory' : '', sizeBytes: 0 };
}

export function scheduledBriefContent(prompt: string, title: (id: string) => string): ThreadComposerDraftContent[] {
  return splitReferenceMarkers(prompt).map((part) => part.type === 'text' ? part
    : part.target.kind === 'node' ? { type: 'nodeReference', reference: { nodeId: part.target.nodeId, title: title(part.target.nodeId) } }
    : { type: 'fileReference', reference: scheduledFileReference(part.target.path, undefined, part.target.entryKind) });
}

export function scheduledBriefText(content: readonly ThreadComposerDraftContent[]): string {
  return content.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'nodeReference') {
      const marker = formatNodeReferenceMarker(part.reference.nodeId);
      if (marker.startsWith('[[node://')) return marker;
    }
    if (part.type === 'fileReference' && part.reference.path) {
      const marker = formatFileReferenceMarker(part.reference.path, part.reference.entryKind);
      if (marker.startsWith('[[file://')) return marker;
    }
    throw new Error('This reference cannot be saved in a scheduled task. Choose an Outline item or a local file.');
  }).join('');
}
