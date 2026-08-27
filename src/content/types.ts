export interface ExactRevisionReference {
  readonly anchorId: string;
  readonly byteLength: number;
}

export interface ContentAdmissionLease {
  readonly leaseId: string;
  readonly byteLength: number;
  readonly expiresAt: string;
}

export interface ContentRetentionAnchor extends ExactRevisionReference {
  readonly namespace: string;
  readonly recordKey: string;
  readonly createdAt: string;
}

export interface ContentAnchorCoordinate {
  readonly namespace: string;
  readonly recordKey: string;
  readonly reference: ExactRevisionReference;
}

export interface ContentGarbageCollectionResult {
  readonly revisionCount: number;
  readonly byteLength: number;
}

export interface ContentStoreHooks {
  readonly afterPublicationClaim?: () => void | Promise<void>;
  readonly afterPublicationRename?: () => void | Promise<void>;
  readonly afterDeletionMarked?: () => void | Promise<void>;
}

export interface ContentStoreOptions {
  readonly now?: () => Date;
  readonly admissionLeaseMs?: number;
  readonly maximumBytes?: number;
  readonly publicationStaleMs?: number;
  readonly hooks?: ContentStoreHooks;
}

export class ContentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentIntegrityError';
  }
}

export class ContentStateError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'quarantined' | 'unavailable') {
    super(message);
    this.name = 'ContentStateError';
  }
}
