---
status: draft
priority: P2
owner: relixiaobo
created: 2026-06-02
updated: 2026-06-02
---

# Outliner Local File References

## Purpose

Support `@file` / `@本机文件` in the outliner as a first-class reference to a
local file or folder. This is the shared foundation for:

- Manual outliner authoring with local files as part of node content.
- Launcher capture of local files.
- Capture hidden system fields that point at original files or payload files.
- Agent context that includes file references without creating a second syntax.

This plan owns the file reference model, parser, editor behavior, preview/open
commands, and agent context resource contract. The launcher plan consumes this
capability instead of defining its own local file format.

## Current Baseline

Existing code already proves most of the interaction model:

- `src/renderer/ui/agent/AgentComposerEditor.tsx` recognizes
  `@file`, `@local`, `@localfile`, and `@本机文件`.
- `AgentComposerEditor` inserts local files as ProseMirror atom nodes named
  `fileReference`.
- `docToDraft` serializes file chips back into user text as
  `[[file:<ref>]]` and separately returns `draft.fileRefs[]`.
- `src/core/agentFileReferenceMarkup.ts` defines
  `formatFileReferenceMarker`, `sanitizeFileReferenceRef`, and
  `splitFileReferenceMarkers`.
- `src/core/agentAttachments.ts` serializes file metadata into a hidden
  `<user-attachments>` block for agent turns.
- `src/main/main.ts` exposes `lin:search-local-files`,
  `lin:recent-local-files`, `lin:prepare-local-file`, and
  `lin:preview-local-file`.
- `src/renderer/ui/outliner/trailingTriggers.ts` and
  `src/renderer/ui/interactions/referenceCandidates.ts` currently support
  node/date references only; they need a shared local-file candidate path.

## Product Decisions

- Selecting a local file creates a durable reference, not an import.
- File contents are not copied into Lin storage by default.
- File contents do not enter normal node text, ordinary search, or default agent
  context unless the user explicitly asks.
- The visible editor renders a chip with file icon, basename, and optionally the
  parent folder. Full absolute paths appear only in details/tooltip/system-field
  views.
- Hidden system fields are hidden by default, not private. Users can open a
  system-field/detail view and see the same file reference chip/value used by
  normal fields and inline content.
- Missing or changed files remain visible as broken/changed references and offer
  relink, open, reveal, and copy/import actions where possible.
- Directories are valid references. AI reads require explicit `file_glob` /
  `file_read`; do not recursively index directories automatically.

## Data Model

Use one canonical `LocalFileRef` per referenced local resource.

```ts
export interface LocalFileRef {
  id: string;
  path: string;
  name: string;
  entryKind: 'file' | 'directory';
  mimeType?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  contentHash?: string;
  createdAt: string;
  lastVerifiedAt?: string;
}
```

Use one `FileReferenceValue` anywhere that resource is referenced.

```ts
export interface FileReferenceValue {
  kind: 'local-file';
  fileRefId: string;
  displayName?: string;
  pathSnapshot?: string;
  nameSnapshot?: string;
  mimeType?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  contentHash?: string;
}
```

Inline rich text references add an offset container around that same value:

```ts
export interface InlineFileRef {
  offset: number;
  value: FileReferenceValue;
}

export interface RichText {
  text: string;
  marks: TextMark[];
  inlineRefs: InlineRef[];
  fileRefs?: InlineFileRef[];
}
```

Containers differ, but the value is the same:

- Outliner `@file`: `RichText.fileRefs[]`.
- Ordinary field: field value rich text containing `[[file:<ref>]]`.
- User-opened system field: system projection containing `[[file:<ref>]]`.
- Capture sidecar: `node.capture.source.original.file` or
  `node.capture.payloadRefs[].file`.

## Parser Contract

There must be one parser for `[[file:<ref>]]`, shared by:

- Agent composer messages.
- Outliner rich text.
- Ordinary outliner fields.
- User-visible system-field projections.
- Launcher capture outline import/export.

Evolve `src/core/agentFileReferenceMarkup.ts` into a shared
`src/core/fileReferenceMarkup.ts` module. Do not add an outliner-only parser.

Rules:

- `[[file:<ref>]]` maps to a `FileReferenceValue` when parser/import context can
  resolve `<ref>` to a `LocalFileRef`.
- If `<ref>` cannot be resolved, preserve the marker as plain text. Do not invent
  a path.
- Parser behavior must be identical in node content, field values, and system
  field projections.
- Normal outline export may omit hidden system fields, but when the user chooses
  to show/copy/export system fields they use the same field syntax and parser.

Example:

```text
- Review design notes #file
  - Source:: [[file:design-notes.pdf]]
  - sys:captureOriginal:: [[file:design-notes.pdf]]
```

Both field values resolve to the same `FileReferenceValue`.

## Agent Context Contract

Agent context should not contain two competing file formats. Everything
normalizes to:

1. Visible text marker: `[[file:<ref>]]`
2. Hidden resource table: `<user-attachments>...</user-attachments>`

The current `serializeAgentAttachmentMarker` contract in
`src/core/agentAttachments.ts` should become a shared resource-context builder
that accepts:

- Composer attachments.
- Outliner `LocalFileRef`s.
- Capture original file refs.
- Capture payload file refs.
- Durable assets or imported copies.

Before context construction, sources can differ:

- Composer attachment: transient attachment id and selected/uploaded file.
- Outliner/capture: durable `LocalFileRef` and `FileReferenceValue`.
- Asset/imported copy: durable asset id.

After context construction, they must normalize to the same resource table item
shape. The agent sees one marker format and one resource table format.

Example agent-visible message:

```text
Please review [[file:design-notes.pdf]]
```

Example hidden resource table:

```xml
<user-attachments>
{
  "version": 1,
  "attachments": [
    {
      "kind": "file",
      "ref": "design-notes.pdf",
      "name": "design-notes.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 123456,
      "path": "/turn-local/path/design-notes.pdf"
    }
  ]
}
</user-attachments>
```

Reading semantics:

- Inline images may be included as image content blocks.
- Inline text attachments may include bounded text.
- Ordinary files/folders require explicit `file_read` / `file_glob`.
- Persistent outliner/capture data remains reference-only unless the user chooses
  Attach, Import Text, Copy into Lin, or Keep offline.

## UI Behavior

Editor insertion:

- Typing `@file`, `@local`, `@localfile`, or `@本机文件` opens local file
  candidates.
- Candidates use recent files when the query is empty and search results when
  the query is non-empty.
- Selecting a candidate registers or reuses a durable `LocalFileRef`, inserts an
  inline file chip, and stores a `FileReferenceValue`.
- Drag/drop and file picker insertion should go through the same registration
  path.

Chip actions:

- Preview
- Open
- Reveal in Finder
- Relink
- Ask AI with File
- Import Text
- Copy into Lin / Keep offline

Rendering:

- Use native file icons or thumbnails where available.
- Use middle truncation for long filenames.
- Show full path in details, tooltip, or command menu, not in normal row text.
- Broken refs should be visually distinct and commandable.

## Storage And Lifecycle

- Store `LocalFileRef` in document-level structured metadata so references
  survive app restarts and do not depend on `localFileSearchCache`.
- Store path snapshots in `FileReferenceValue` for stale/moved-file detection,
  but use `fileRefId` as identity.
- Do not delete `LocalFileRef` when a single chip is removed. Track references
  across node content, fields, and system fields; clean up only true orphans.
- For local files, default mode is reference-only. Attachment/import mode is
  explicit and should create an asset/import record while preserving the
  original `LocalFileRef`.

## Implementation Sequence

1. Rename/extract `src/core/agentFileReferenceMarkup.ts` into shared
   `src/core/fileReferenceMarkup.ts`; update agent imports.
2. Add `LocalFileRef`, `FileReferenceValue`, and `InlineFileRef` core types.
3. Add document persistence for `LocalFileRef` and `RichText.fileRefs` in
   `src/core/loroDocument.ts`, projections, search, patching, and rich text
   codec code.
4. Extract local file IPC wrappers into a shared typed renderer API.
5. Add outliner `@file` candidates and chip insertion in row editor, title
   editor, trailing input, and field editor surfaces.
6. Extend outline parser/import/export to use the shared file marker parser.
7. Extract `serializeAgentAttachmentMarker` into a shared resource-context
   builder that normalizes composer attachments, outliner refs, capture refs,
   and assets.
8. Add file chip commands: Preview, Open, Reveal, Relink, Ask AI with File,
   Import Text, Copy into Lin.
9. Add maintenance for missing/changed/orphaned file refs.

## Tests

- Parser round-trip:
  - Node content with `[[file:<ref>]]`.
  - Ordinary field with `[[file:<ref>]]`.
  - User-opened system field with `[[file:<ref>]]`.
  - Unresolved marker preserved as plain text.
- Rich text persistence:
  - Inline file refs survive save/reopen.
  - Text edits preserve offsets correctly.
  - Copy/paste/export/import round-trips.
- Agent context:
  - Composer attachment and outliner file ref produce the same marker/table
    shape.
  - Capture original local file produces the same marker/table shape.
  - Files require `file_read`; folders require `file_glob`.
- UI:
  - `@file` search and recent files.
  - Chip insert/delete.
  - Preview/open/reveal/relink.
  - Missing file state.

## Relationship To Launcher

Launcher capture depends on this plan for all local-file behavior:

- Local file capture creates or reuses `LocalFileRef`.
- `node.capture.source.original.file` stores a `FileReferenceValue`.
- Visible capture fields use `[[file:<ref>]]` when showing local source fields.
- Agent commands launched from a capture use the same resource-context builder.
