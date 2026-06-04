// Launcher capture/save model — the typed sidecar persisted on a capture node.
//
// A capture is an ordinary document node carrying a typed `capture` metadata
// sidecar (CaptureNodeMetadata) on NodeBase. The sidecar holds provenance only —
// normalized source identity (URL/title/author/kind) plus capture origin and
// warnings. Capture is basic-info only: no page body, transcript, email body, or
// PDF text is extracted (that is deferred to the future unified extension/CDP
// backend). This keeps captures first-class, searchable, undoable nodes.
//
// Calibrated to landed code (PR #80): local-file identity is the canonical path
// (ReferenceTarget local-file shape), NOT a `FileReferenceValue`/`fileRefId`,
// which does not exist. Markers are `[[file:<label>^<path>]]`.
//
// Plan: docs/plans/lazy-like-global-launcher.md.

import { plainText } from '../types';
import type { CreateNodeTree, FieldType, NodeId, RichText } from '../types';
import { parseDateFieldValue } from '../dateFieldValue';
import type {
  ContextProviderId,
  ContextWarning,
  ExternalContext,
} from './context';

/**
 * Pointer to the live original resource the user can reopen later. Distinct from
 * the captured snapshot: opening the original may show newer/changed content.
 *
 * Produced today: only `remote-url` (web captures) and an empty `app-resource`
 * (manual / unknown-app). `local-file` and `asset` are the TARGET shape for the
 * deferred preview / local-file capture (tracked in launcher-provider-expansion.md)
 * — declared now so the contract is stable (A7: settle the foundation), not yet emitted.
 */
export type OriginalResourceRef =
  | {
    kind: 'remote-url';
    url: string;
    canonicalUrl?: string;
    preview: 'web-preview' | 'external-browser';
  }
  | {
    kind: 'local-file';
    /** Canonical absolute path = identity, matching ReferenceTarget local-file. */
    path: string;
    entryKind: 'file' | 'directory';
    /** Optional capture-time snapshots for broken/changed-state rendering. */
    displayName?: string;
    mimeType?: string;
    sizeBytes?: number;
    modifiedAt?: string;
    contentHash?: string;
    preview: 'text' | 'image' | 'pdf' | 'native-open' | 'unsupported';
  }
  | {
    kind: 'asset';
    assetId: string;
    name?: string;
    mimeType?: string;
    preview: 'asset-preview' | 'native-open';
  }
  | {
    kind: 'app-resource';
    appUrl?: string;
    externalUrl?: string;
    preview: 'app-open' | 'external-browser' | 'unsupported';
  };

/**
 * Normalized, provider-agnostic description of what was captured.
 *
 * The `kind` union is the TARGET classification. Produced today: `webpage`/`article`
 * (generic), `video` (youtube), `tweet` (x-twitter), `repo`/`profile` (github), and
 * `app` (manual / unknown). `email`/`chat`/`pdf`/`music` are declared for the
 * roadmap providers (gmail/slack/pdf/spotify, …) tracked in
 * launcher-provider-expansion.md — kept in the contract (A7), not yet emitted.
 */
export interface SourceDraft {
  kind:
    | 'webpage'
    | 'article'
    | 'video'
    | 'tweet'
    | 'email'
    | 'chat'
    | 'profile'
    | 'repo'
    | 'pdf'
    | 'music'
    | 'app';
  title: string;
  original: OriginalResourceRef;
  url?: string;
  canonicalUrl?: string;
  appUrl?: string;
  author?: {
    name?: string;
    handle?: string;
    url?: string;
    avatarUrl?: string;
  };
  imageUrl?: string;
  publishedAt?: string;
  timestampSeconds?: number;
  durationSeconds?: number;
  providerId: ContextProviderId;
  metadata?: Record<string, unknown>;
}

/**
 * What the user asked the launcher to do with the source. Produced today: only
 * `'capture'`. `clip`/`read-later`/`watch-later`/`summarize`/`ask-ai` are declared
 * for the deferred destination / AI features (launcher-capture-destinations.md,
 * launcher-ai-actions.md) — part of the target contract, not yet emitted.
 */
export type CaptureIntent =
  | 'capture'
  | 'clip'
  | 'read-later'
  | 'watch-later'
  | 'summarize'
  | 'ask-ai';

/**
 * Typed JSON sidecar persisted on `NodeBase.capture`. Stores normalized PROVENANCE
 * metadata for a captured node — what it is and where it came from. Rich captured
 * content (page body, transcript, email/DM threads, …) is NOT stored here today:
 * capture is basic-info only, and the content + enrichment model returns via the
 * unified browser-extension path (docs/plans/browser-extension-integration.md).
 *
 * The sidecar is written now and consumed later: today only the outline projection
 * (tag + fields) is read back, while the sidecar's own consumers (re-open original,
 * dedupe by captureId, provider/warnings display) arrive with the preview +
 * extension phases. It is the durable provenance record those phases build on.
 */
export interface CaptureNodeMetadata {
  schemaVersion: 1;
  captureId: string;
  createdBy: 'launcher' | 'agent' | 'import';
  capturedAt: string;
  origin: 'global-hotkey' | 'manual-refresh' | 'deep-link' | 'test';
  providerId: ContextProviderId;
  app: {
    name: string;
    bundleId?: string;
    windowTitle?: string;
  };
  source: SourceDraft;
  /** `saved` = clean; `partial` = captured with degradation warnings. */
  status: 'saved' | 'partial';
  intent: CaptureIntent;
  warnings: ContextWarning[];
}

/**
 * A capture field definition with stable identity. Capture fields are seeded and
 * referenced by `id` (never matched by display name), so every capture attaches
 * to the same, correctly-typed field — renames or name collisions can't break it.
 * The def is ensured by id only when missing; an existing one (seeded earlier or
 * since edited by the user) is reused as-is, so user customization is respected.
 */
export interface CaptureFieldDef {
  /** Stable, human-readable node id under the schema (e.g. `field:url`). */
  id: NodeId;
  /** Default display name used when first seeding the def. */
  name: string;
  /** Default field type used when first seeding the def. */
  type: FieldType;
}

/**
 * The capture field registry: the canonical typed fields captures project into.
 * `url`/`published` carry rich types so links are clickable and dates parse;
 * the rest default to `plain`. Add a new entry here (never an ad-hoc name) when a
 * provider needs a new field.
 */
export const CAPTURE_FIELD = {
  // Names follow the terse, past-tense style of the system fields ("Created",
  // "Last edited"): "Published", not "Publish Date".
  url: { id: 'field:url', name: 'URL', type: 'url' },
  published: { id: 'field:published', name: 'Published', type: 'date' },
  author: { id: 'field:author', name: 'Author', type: 'plain' },
} as const satisfies Record<string, CaptureFieldDef>;

/** A field value to attach to a capture, bound to a registry field def. */
export interface CaptureFieldInput {
  /** The (stable-id) field def to attach to; ensured by id, never name-matched. */
  field: CaptureFieldDef;
  /** Plain-text value (the value child of the field entry). For a `date` field
   *  it MUST be a valid endpoint (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`). */
  value: string;
}

/**
 * Input to the atomic `create_capture` document command: one root capture node
 * (title + optional user note + typed `capture` sidecar) projected into native
 * outline shape — a `tag` (the most specific capture-kind tag, rolling up to
 * `tagExtends`) and `fields` (`Source::`, `Author::`, …) — plus bounded visible
 * child nodes. Created in a single transaction so undo/redo stays coherent. The
 * outline is the readable/searchable projection; the hidden `capture` sidecar
 * carries provider/resolver metadata only.
 */
export interface CreateCaptureInput {
  destinationParentId: NodeId;
  index?: number | null;
  title: RichText;
  /** Optional short user note (NOT the URL — the link is projected to the URL field). */
  description?: string;
  /** Tag to apply (most specific capture kind, e.g. 'article' or 'capture'). */
  tag?: string;
  /** Supertag the tag should extend (typically 'capture'); set up if missing. */
  tagExtends?: string;
  /** Native outline fields projected from the source, in display order. */
  fields?: CaptureFieldInput[];
  metadata: CaptureNodeMetadata;
  children?: CreateNodeTree[];
}

/** Map a normalized source kind to its capture tag; unknown kinds use #capture. */
const CAPTURE_TAG_BY_KIND: Partial<Record<SourceDraft['kind'], string>> = {
  article: 'article',
  video: 'video',
  tweet: 'tweet',
  email: 'email',
  pdf: 'pdf',
  chat: 'chat',
  repo: 'repo',
  profile: 'profile',
};

/**
 * Build a `CreateCaptureInput` for a manual launcher capture (no external
 * context): a plain title (+ optional note) saved under a destination, carrying
 * a minimal sidecar that records it came from the launcher. There is no
 * reopenable original resource, so `source.original` is an empty app-resource.
 * Pure + deterministic (ids/timestamps passed in) so it is unit-testable.
 */
export function buildManualCaptureInput(args: {
  destinationParentId: NodeId;
  title: string;
  note?: string;
  captureId: string;
  capturedAt: string;
}): CreateCaptureInput {
  const { destinationParentId, note, captureId, capturedAt } = args;
  const title = singleLine(args.title);
  const metadata: CaptureNodeMetadata = {
    schemaVersion: 1,
    captureId,
    createdBy: 'launcher',
    capturedAt,
    origin: 'global-hotkey',
    providerId: 'unknown-app',
    app: { name: 'Tenon Launcher' },
    source: {
      kind: 'app',
      title,
      original: { kind: 'app-resource', preview: 'unsupported' },
      providerId: 'unknown-app',
    },
    status: 'saved',
    intent: 'capture',
    warnings: [],
  };
  const note_ = note?.trim();
  // A manual note is just text the user typed — not a capture of external
  // content — so it carries no #capture tag (only context captures are tagged).
  return {
    destinationParentId,
    title: plainText(title),
    ...(note_ ? { description: note_ } : {}),
    metadata,
  };
}

/**
 * Build a `CreateCaptureInput` from a live `ExternalContext` (the "what am I
 * looking at" snapshot). Maps the normalized source straight onto the capture
 * sidecar, so the saved node carries the provider metadata, reopenable original,
 * and any capture-time warnings. Falls back to an app-resource source when the
 * context had no usable source (unknown-app). Pure + deterministic (ids passed
 * in) so it is unit-testable without spawning osascript.
 */
export function buildContextCaptureInput(args: {
  context: ExternalContext;
  destinationParentId: NodeId;
  index?: number | null;
  captureId: string;
  intent?: CaptureIntent;
  note?: string;
}): CreateCaptureInput {
  const { context, destinationParentId, index, captureId, intent, note } = args;
  // Outline nodes are single-line; captured titles (e.g. an og:title carrying a
  // multi-line tweet) must be collapsed before they become a node's content.
  const title = singleLine(context.source?.title || context.browser?.tabTitle || context.app.name || 'Capture');
  const source: SourceDraft = context.source ?? {
    kind: 'app',
    title,
    original: { kind: 'app-resource', preview: 'unsupported' },
    providerId: context.providerId,
  };
  const metadata: CaptureNodeMetadata = {
    schemaVersion: 1,
    captureId,
    createdBy: 'launcher',
    capturedAt: context.capturedAt,
    origin: context.captureOrigin,
    providerId: context.providerId,
    app: context.app,
    source,
    status: context.warnings.length > 0 ? 'partial' : 'saved',
    intent: intent ?? 'capture',
    warnings: context.warnings,
  };
  // Project the source into native outline shape: a capture-kind tag + fields,
  // rendered/searched by the existing outliner (no bespoke capture rendering).
  // `description` stays reserved for a real user note.
  const specificTag = CAPTURE_TAG_BY_KIND[source.kind];
  const tag = specificTag ?? 'capture';
  const tagExtends = specificTag ? 'capture' : undefined;

  const fields: CaptureFieldInput[] = [];
  // A remote http(s) link → the typed URL field (clickable). Non-http sources
  // (local file / app) get NO link field today — no provider emits one yet (that
  // arrives with local-file capture); the raw value always stays in the sidecar.
  const link = source.canonicalUrl ?? source.url;
  if (link && /^https?:\/\//i.test(link)) fields.push({ field: CAPTURE_FIELD.url, value: link });
  const author = source.author?.handle ?? source.author?.name;
  if (author) fields.push({ field: CAPTURE_FIELD.author, value: singleLine(author) });
  if (source.publishedAt) {
    // The date field only accepts YYYY-MM-DD[THH:MM]; if the ISO timestamp can't
    // be reduced, skip the field (the raw value stays in the sidecar).
    const dateValue = toDateFieldValue(source.publishedAt);
    if (dateValue) fields.push({ field: CAPTURE_FIELD.published, value: dateValue });
  }
  // A video's player position and total length are intentionally NOT captured at
  // all: buildContextCapture's URL (via buildYoutubeUrl) strips the `t`/`start`
  // anchor so the saved link is the clean canonical video — the resume-time was
  // judged noise (PM decision) — and the duration is trivia. Neither is stored.

  const note_ = note?.trim();
  return {
    destinationParentId,
    ...(index === undefined ? {} : { index }),
    title: plainText(title),
    ...(note_ ? { description: note_ } : {}),
    tag,
    ...(tagExtends ? { tagExtends } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    metadata,
  };
}

/**
 * Reduce an ISO date/datetime to a date-field endpoint the outliner accepts
 * (`YYYY-MM-DD`); returns null if it cannot be parsed. OG `published` is often a
 * full ISO timestamp with seconds + timezone, which the date field rejects — we
 * keep just the calendar date (in the source's own offset, no tz conversion).
 */
function toDateFieldValue(raw: string): string | null {
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  return parseDateFieldValue(match[1]!) ? match[1]! : null;
}

/**
 * Collapse a captured string to a single outline line: any run of whitespace
 * (newlines, tabs, repeated spaces) becomes one space, then trim. Outline nodes
 * are single-line, so captured titles/values must never carry hard line breaks.
 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
