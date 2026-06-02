---
status: draft
priority: P0
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

Priority is **P0** because it is a foundation, not a leaf: it gates
`lazy-like-global-launcher` (P0 — "Launcher capture depends on this plan") and
shares its file-reference model with `agent-composer-attachment-path-model` (P1).
A foundation must not sit below its highest-priority consumer, so this plan leads
that group and should ship (or at least settle its core types and parser) first.

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

- **A file reference is an inline reference, never a node.** It lives inside rich
  text (the existing `inlineRefs` channel), like an inline node reference. It is
  NOT a `reference` node (the structural reference-field mechanism) and NOT a
  block node on `BlockNodeRow` (the way `image` nodes are). This keeps it
  lightweight and is why it unifies with the inline-reference system below, not
  with the node/structural-reference system.
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

This plan introduces ONE reference value used across the project:
`ReferenceTarget` — the pure identity of "what is referenced". It is reused by
inline refs, the agent resource table, and (later) the image/media node source.
A file reference is just `ReferenceTarget` of kind `local-file`; it is inline,
never a node, never a parallel array.

```ts
export type ReferenceTarget =
  | { kind: 'node';       nodeId: NodeId }     // backlink-counted; resolved by node tools
  | { kind: 'local-file'; path: string; entryKind: 'file' | 'directory' }; // canonical path = identity
// Only the kinds with a real consumer are defined. The union + prefix grammar
// both extend WITHOUT breaking existing refs, so new kinds are added with their
// consumer (no speculative reserved surface).
```

An inline reference is a `ReferenceTarget` at a text offset plus display
decoration. `InlineRef` replaces the old node-only shape (`targetNodeId` →
`target`), so every kind shares ONE array, one Loro mark/codec path, one
offset/cursor model, one reverse scan. There is **no** parallel `fileRefs` array.

```ts
export interface InlineRef {
  offset: number;
  target: ReferenceTarget;
  displayName?: string;        // chip label (basename / node title by default)
  // Optional display snapshots (e.g. local-file broken-state rendering without a
  // stat); never identity.
  mimeType?: string;
  sizeBytes?: number;
}

export interface RichText {
  text: string;
  marks: TextMark[];
  inlineRefs: InlineRef[];   // any ReferenceTarget kind — one channel
}
```

Per-kind handling:

- `node` — backlink-counted (`nodeLinksTo` keys off `target.kind === 'node'`),
  resolved by node tools, rendered as a node chip. NOT a resource (never in the
  agent resource table).
- `local-file` — resource-bearing: serializable to the agent resource table,
  rendered as a file chip.

Identity & dedup:

- `local-file`: the **canonical path** (realpath-normalized) — dedup is a path
  comparison; no id, no registry, no macOS bookmark.
- `node`: the `nodeId`.

Future kinds, added WITH their consumer (one-line union + parser extension, no
ref migration):

- `asset` — when **Copy into Lin** (durable import) lands, or when the
  image/media node source converges onto `ReferenceTarget` (asset-subsystem).
- `remote-url` — if inline link/bookmark chips land (embed-strategy). A plain
  text hyperlink is already a `TextMark`, so this is NOT needed for hyperlinks.

Metadata cache (optional, non-authoritative): a rebuildable path-keyed cache may
hold icon / thumbnail / mime / size for `local-file` rendering, like the existing
`localFileSearchCache`. Perf only — the `target` on the ref is the source of
truth; dropping the cache costs only a re-stat.

Not folded in: a text hyperlink stays a `TextMark { type: 'link', attrs.href }`
(a range style, not a `ReferenceTarget`). The image/media node source
(`ImageNode.assetId` / `mediaUrl`) is left as-is this round; `ReferenceTarget` is
designed so it CAN converge there later (asset-subsystem / media-url territory).

Migration: a legacy `InlineRef` with no `target` decodes as
`{ target: { kind: 'node', nodeId: <old targetNodeId> } }`, so existing
documents read unchanged.

Where a file reference appears — always the same inline mechanism:

- Outliner `@file`: a `local-file` `InlineRef` in the row's `RichText.inlineRefs`.
- Ordinary field: the field value is a node; its `RichText.inlineRefs` carries the
  `local-file` ref. Files do NOT use the structural `reference` field type /
  `ReferenceNode` — that mechanism stays node-only.
- User-opened system field: the projected rich text carries the same inline ref.
- Launcher capture: capture's source/payload rich-text fields carry the same
  inline ref (same `target`). (Detail owned by the launcher plan.)

## Parser Contract

There must be one parser for every reference marker, shared by:

- Agent composer messages.
- Outliner rich text.
- Ordinary outliner fields.
- User-visible system-field projections.
- Launcher capture outline import/export.

Merge `agentFileReferenceMarkup.ts` and `nodeReferenceMarkup.ts` into ONE
`src/core/referenceMarkup.ts`: a single `[[…]]` scan that branches by the kind
prefix, so the grammars cannot fight over overlapping matches. Do not add an
outliner-only parser, and do not keep two `[[…]]` scanners over the same text.

**Full-prefix grammar** — every kind is `[[kind:label^value]]`:

```text
[[node:label^nodeId]]   [[file:label^path]]
```

- `label` is human-readable decoration; `value` is the `ReferenceTarget`
  identity. `label` defaults to basename / node title.
- The `value` segment is percent-encoded so paths survive the `[[…]]`
  delimiters (a path may legally contain `]`, `^`, `|`, newlines); the parser
  decodes it back.
- Only `node:` and `file:` are recognized; any other prefix is left as plain
  text — this keeps a future `[[asset:…]]` / `[[url:…]]` forward-safe to add
  without reserving dead syntax now.
- **Migration:** node markers move from the old bare `[[label^nodeId]]` to
  `[[node:label^nodeId]]`. The parser keeps accepting the bare form as `node`
  (back-compat for old agent transcripts / exported text) but only emits the
  prefixed form.

Rules:

- A marker maps to an `InlineRef` whose `target` is the decoded
  `ReferenceTarget`. `file` values are self-contained (no lookup); `node`
  resolves its id against the document.
- Parser behavior must be identical in node content, field values, and system
  field projections.
- Normal outline export may omit hidden system fields, but when the user chooses
  to show/copy/export system fields they use the same field syntax and parser.

Example:

```text
- Review design notes #file
  - Source:: [[file:design-notes.pdf^/Users/me/Documents/design-notes.pdf]]
  - Related:: [[node:Q2 Roadmap^node-9f3a]]
```

Both resolve to `InlineRef`s carrying the matching `ReferenceTarget`.

## Agent Context Contract

Agent context should not contain two competing file formats. Everything
normalizes to:

1. Visible text marker: `[[file:label^path]]`. The `^path` segment is optional —
   in a transient agent turn the label-only `[[file:label]]` form is resolved
   against the resource table below (the file is read via a turn-local path
   anyway), so the marker stays short for the model. One parser handles both
   (caret optional).
2. Hidden resource table: `<user-attachments>...</user-attachments>`

**Ownership (decided — Option A).** This plan (the foundation) owns the **pure
serializer** over the unified value:

```ts
// resource-bearing targets → one <user-attachments> item; `node` → null
referenceTargetToResourceItem(target: ReferenceTarget, meta): AgentResourceItem | null
```

It maps a `local-file` target to one resource-table item; a `node` target
returns `null` (nodes go through node tools, not the resource table). Future
resource kinds (`asset`, …) map the same way. It is a pure function — no disk
staging, no IPC, no base64.

`agent-composer-attachment-path-model` owns the **production** side: turning a
dropped / pasted / picked file into a resource-bearing target (disk staging via
`lin:stage-attachment`, image inline-base64, size limits), then consuming this
serializer. Shared-interface-first: this plan lands `ReferenceTarget` + the
serializer; the composer plan rebases onto it.

Sources differ before construction but normalize to one resource item:

- Composer attachment → `local-file` target (staged path) [+ inline image bytes].
- Outliner / capture → the `local-file` target already on the inline ref.

The agent always sees one marker grammar and one resource table.

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
      "ref": "design-notes.pdf",
      "target": { "kind": "local-file", "path": "/Users/me/Documents/design-notes.pdf" },
      "name": "design-notes.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 123456,
      "readPath": "/turn-local/path/design-notes.pdf"
    }
  ]
}
</user-attachments>
```

`target` is the `ReferenceTarget` identity; `readPath` is the turn-local staged
path the agent's tools actually read (supplied by the composer/runtime
production side, not this plan).

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
- Selecting a candidate inserts an inline file chip and stores a `local-file`
  `InlineRef` (target carrying the canonical path) in the row's `inlineRefs`.
- Drag/drop and file picker insertion should go through the same insertion path.

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

- The reference lives entirely on the `local-file` `InlineRef` (target path +
  display snapshots), so it survives app restarts with the document — no separate
  identity record and no dependency on `localFileSearchCache`.
- Identity is the canonical path. There is no reference-count/GC to maintain:
  removing a chip removes that one inline ref; nothing else points at the file.
- Resolution / lifecycle (no bookmark):
  - Open / preview / reveal resolve the path directly.
  - A path that no longer resolves renders as a **broken** ref. The user can
    Relink (pick a new file → rewrite this ref's path; each reference is
    independent), Reveal, or Copy/Import.
  - For true durability against move/delete, the user chooses **Copy into Lin**,
    which copies the bytes into the asset store; the chip then points at that
    asset instead of an external path.
- Default mode is reference-only. Attachment/import mode is explicit and creates
  an asset record (a future `asset` `InlineRef`); reference-only refs are never
  silently copied.

## Implementation Sequence

1. Add `ReferenceTarget` to `src/core/types.ts`; change `InlineRef` from the
   node-only shape to `{ offset; target: ReferenceTarget; displayName?; … }`.
   Legacy `targetNodeId` decodes to `target: { kind: 'node', nodeId }`.
2. Merge `src/core/agentFileReferenceMarkup.ts` + `nodeReferenceMarkup.ts` into
   one `src/core/referenceMarkup.ts` (single `[[…]]` scan, prefix-branched):
   full-prefix grammar `[[kind:label^value]]`, value percent-encoded; emit `node`
   + `file` (any other prefix → plain text); still parse the bare legacy node
   form. Update agent + outliner imports.
3. Extend the EXISTING inline-ref Loro mark/codec in `src/core/loroDocument.ts`
   (`encodeRichText` / `richTextFromDelta`) to carry the `target` on the same
   mark — no second mark type, no parallel array. Thread `target` through
   projection, search (`nodeLinksTo` keys off `target.kind === 'node'`), and
   patching.
4. Extract local file IPC wrappers into a shared typed renderer API.
5. Add outliner `@file` candidates and chip insertion in row editor, title
   editor, trailing input, and field editor surfaces.
6. Extend outline parser/import/export to use the shared file marker parser.
7. Add the pure `referenceTargetToResourceItem` serializer (foundation,
   Option A); the `agent-composer-attachment-path-model` plan rebases its
   production pipeline onto it.
8. Add file chip commands: Preview, Open, Reveal, Relink, Ask AI with File,
   Import Text. (**Copy into Lin** is deferred — it introduces the `asset` kind,
   so it lands with that follow-up.)
9. Add broken/changed-ref handling (missing path → broken state + Relink); no
   orphan GC is needed since there is no shared identity record.

## Tests

- Parser round-trip:
  - `[[file:label^path]]` in node content, ordinary field, and user-opened
    system field.
  - `[[node:label^nodeId]]` round-trips; the legacy bare `[[label^nodeId]]` form
    still parses as a `node` target (back-compat).
  - An unrecognized prefix (e.g. `[[asset:…]]`) is left as plain text.
  - A path containing `]` / `^` / `|` / newline round-trips via
    percent-encoding.
  - A malformed marker is preserved as plain text; a well-formed marker to a
    missing path parses fine and renders as a broken ref.
- Rich text persistence:
  - Inline file refs survive save/reopen.
  - A legacy `InlineRef` (flat `targetNodeId`) decodes to
    `target = { kind: 'node', nodeId }`.
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

- Local file capture stores the file path on a `local-file` `InlineRef` (not a
  structural node, not a separate value type).
- Visible capture fields use `[[file:label^path]]` when showing local source
  fields.
- Agent commands launched from a capture use the same serializer.
