import type { ThreadImageArtifactReference, ThreadResourceReference } from './agent/protocol';

export type PreviewEntryKind = 'file' | 'directory';

export type PreviewTarget =
  | {
      kind: 'local-file';
      path: string;
      entryKind: PreviewEntryKind;
      label?: string;
      threadId?: string;
      attachmentId?: string;
      resourceRef?: ThreadResourceReference;
      resourceIntent?: 'delivered' | 'source';
      imageArtifactRef?: ThreadImageArtifactReference;
    }
  | {
      kind: 'asset';
      assetId: string;
      label?: string;
    }
  | {
      kind: 'linked-file';
      sourceValueId: string;
      sourceText: string;
      label?: string;
    }
  | {
      kind: 'url';
      url: string;
      label?: string;
    };
