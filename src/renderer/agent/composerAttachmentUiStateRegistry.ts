export interface ComposerAttachmentUiState {
  readonly attachmentId: string;
  readonly previewUrl?: string;
  readonly sourceKey?: string;
  readonly textExcerpt?: string;
}

/**
 * Renderer-only attachment presentation that may outlive one visible draft.
 * Canonical retention names only an attachment part; resource handles remain
 * opaque and are managed by ComposerHistoryResourceRegistry.
 */
export class ComposerAttachmentUiStateRegistry {
  private readonly canonicalPreviewUrls = new Map<string, string>();
  private readonly draftPreviewUrls = new Map<string, string>();
  private readonly draftSourceKeys = new Map<string, string>();
  private readonly draftTextExcerpts = new Map<string, string>();

  constructor(private readonly revokePreviewUrl: (previewUrl: string) => void) {}

  get previewUrls(): ReadonlyMap<string, string> {
    return this.draftPreviewUrls;
  }

  get sourceKeys(): ReadonlyMap<string, string> {
    return this.draftSourceKeys;
  }

  get textExcerpts(): ReadonlyMap<string, string> {
    return this.draftTextExcerpts;
  }

  patch(attachmentId: string, state: Omit<ComposerAttachmentUiState, 'attachmentId'>): void {
    if (state.previewUrl) this.setDraftPreview(attachmentId, state.previewUrl);
    if (state.sourceKey) this.draftSourceKeys.set(attachmentId, state.sourceKey);
    if (state.textExcerpt) this.draftTextExcerpts.set(attachmentId, state.textExcerpt);
  }

  deleteTextExcerpt(attachmentId: string): void {
    this.draftTextExcerpts.delete(attachmentId);
  }

  capture(attachmentIds: readonly string[]): readonly ComposerAttachmentUiState[] {
    return attachmentIds.flatMap((attachmentId): ComposerAttachmentUiState[] => {
      const previewUrl = this.draftPreviewUrls.get(attachmentId);
      const sourceKey = this.draftSourceKeys.get(attachmentId);
      const textExcerpt = this.draftTextExcerpts.get(attachmentId);
      if (!previewUrl && !sourceKey && !textExcerpt) return [];
      return [{
        attachmentId,
        ...(previewUrl ? { previewUrl } : {}),
        ...(sourceKey ? { sourceKey } : {}),
        ...(textExcerpt ? { textExcerpt } : {}),
      }];
    });
  }

  mount(states: readonly ComposerAttachmentUiState[]): void {
    for (const state of states) this.patch(state.attachmentId, state);
  }

  rememberCanonicalPreview(attachmentId: string): void {
    const previewUrl = this.draftPreviewUrls.get(attachmentId);
    if (previewUrl) this.canonicalPreviewUrls.set(attachmentId, previewUrl);
    this.releaseDraft(attachmentId);
  }

  canonicalPreviewFor(attachmentId: string): string | undefined {
    return this.canonicalPreviewUrls.get(attachmentId);
  }

  releaseDraft(attachmentId: string): void {
    const previewUrl = this.draftPreviewUrls.get(attachmentId);
    this.draftPreviewUrls.delete(attachmentId);
    this.draftSourceKeys.delete(attachmentId);
    this.draftTextExcerpts.delete(attachmentId);
    if (previewUrl) this.revokeIfUnlinked(previewUrl);
  }

  reconcileCanonical(attachmentIds: ReadonlySet<string>): void {
    for (const [attachmentId, previewUrl] of this.canonicalPreviewUrls) {
      if (attachmentIds.has(attachmentId)) continue;
      this.canonicalPreviewUrls.delete(attachmentId);
      this.revokeIfUnlinked(previewUrl);
    }
  }

  clear(): void {
    const previewUrls = new Set([
      ...this.canonicalPreviewUrls.values(),
      ...this.draftPreviewUrls.values(),
    ]);
    this.canonicalPreviewUrls.clear();
    this.draftPreviewUrls.clear();
    this.draftSourceKeys.clear();
    this.draftTextExcerpts.clear();
    for (const previewUrl of previewUrls) this.revokePreviewUrl(previewUrl);
  }

  private setDraftPreview(attachmentId: string, previewUrl: string): void {
    const previous = this.draftPreviewUrls.get(attachmentId);
    this.draftPreviewUrls.set(attachmentId, previewUrl);
    if (previous && previous !== previewUrl) this.revokeIfUnlinked(previous);
  }

  private revokeIfUnlinked(previewUrl: string): void {
    if ([...this.draftPreviewUrls.values()].includes(previewUrl)) return;
    if ([...this.canonicalPreviewUrls.values()].includes(previewUrl)) return;
    this.revokePreviewUrl(previewUrl);
  }
}
