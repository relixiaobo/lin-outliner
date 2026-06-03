---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-02
updated: 2026-06-03
---

# Agent Composer References and Attachments - Path-First Model

Scope: the **agent composer** reference and attachment pipeline
(`AgentComposer.tsx`, `AgentComposerEditor.tsx`), not the outliner
`attachment` node type (that is `file-attachments.md`, unrelated).

## Problem

The composer currently applies one 10 MB cap (`MAX_ATTACHMENT_BYTES`) to all
attachments before their transport model is known. That is wrong for native
path-backed desktop files: a Finder/picker file can be passed as an address and
read later by local tools, so a 200 MB `.dmg` or PDF should not be rejected just
because a web upload would be.

But the cap is not simply removable. There are two byte-heavy paths that still
need explicit guards:

- **Inline images**: pi-ai is pass-through for image bytes. It does not resize,
  compress, or validate provider image limits. Tenon's own
  `readInlineImageForModel` / `resizeInlineImageForModel` path is therefore
  load-bearing and must keep a raw-image pre-read guard plus the existing
  base64/model budget.
- **No-path attachments**: pasted files, web drags, and in-memory `File` objects
  have no native path. To make them available as files, the renderer must read
  their bytes and send an `ArrayBuffer` to main over IPC. That path needs its
  own staging byte cap; it is not free like a native path reference.

Current no-path behavior is also lossy:

- pathless supported images become inline image blocks;
- pathless text becomes `kind: "text"` and is truncated in the prompt;
- pathless binary/non-text files are rejected.

The deeper design problem is that the composer has drifted away from the
outliner reference model. Outliner rich text stores references as structured
`InlineRef` values over a shared `ReferenceTarget` union:

```ts
{ kind: "node", nodeId }
{ kind: "local-file", path, entryKind }
```

Composer currently keeps a parallel model: node mentions become message text and
`referencedNodes`, while file mentions become message text plus `attachments`.
Node-local inline file refs are not normalized into the same resource model as
composer-added files. This makes the model-facing context depend on where the
reference came from instead of what the reference is.

There is one existing correctness bug this plan must fix while touching the
same path model: runtime materialization can change an attachment path without
rewriting the user-visible `[[file:<label>^<path>]]` marker. Local tools reject
paths outside `localRoot`, so the model-visible marker itself must point at the
readable/materialized path before the turn is sent.

The existing hidden `<user-attachments>` JSON reminder is overgrown for this
target model. Once every file-like resource, including images, has a
`[[file:<label>^<path>]]` marker in the message text, the marker is the primary
model-visible contract. Attachment metadata is mostly internal transport state
and should not be duplicated into a large system-reminder JSON block.

## Goal

Align composer internals with the outliner reference model: the composer should
own a structured list of references equivalent to outliner `InlineRef`s, then
derive model text and resource metadata from that single source.

| Input | Today | Target |
| --- | --- | --- |
| Supported inline image (`jpeg/png/gif/webp`) | inline base64, capped at 10 MB raw | inline base64, with an image-only raw guard and existing resize/base64 budget |
| Supported inline image over raw guard | rejected for web/file input; native picker can silently degrade to `kind:"file"` | explicit image-size error, no silent downgrade |
| Native path file or directory | path -> runtime materialized, but blocked over 10 MB | path -> runtime materialized, no renderer byte cap, no content hash read |
| No-path text | truncated inline `kind:"text"` | staged to an agent-readable path, then sent as `kind:"file"` |
| No-path binary | rejected | staged to an agent-readable path, then sent as `kind:"file"` |

`kind: "text"` should remain accepted by the runtime for backward-compatible
event replay, but the composer should stop generating new text attachments.
`<user-attachments>` should also remain parseable/renderable for historical
sessions, but new normal composer turns should not emit it.

Composer files should become **local-file references first**, not attachment
objects first. `attachments` remains the runtime payload format derived from
local-file references that need model/tool visibility.

## Design

### 0. Align composer refs with outliner `InlineRef`

Introduce a composer-side reference model that mirrors the outliner shape closely
enough to share semantics:

```ts
interface ComposerReference {
  attachmentId?: string;
  displayName: string;
  mimeType?: string;
  sizeBytes?: number;
  target:
    | { kind: "node"; nodeId: string }
    | { kind: "local-file"; path: string; entryKind: "file" | "directory" };
}
```

The ProseMirror `fileReference` and `nodeReference` atoms can remain as UI
nodes, but draft extraction should produce:

- `text`: the model-facing text with `[[node:...]]` and `[[file:...]]` markers;
- `refs`: the structured references above;
- `nodeRefs`: a compatibility projection of `refs` where `target.kind === "node"`;
- `attachments`: a derived runtime payload projection of local-file refs that
  need internal transport work, such as image blocks or no-path staging.

This keeps composer behavior aligned with outliner `RichText.inlineRefs` instead
of letting `attachments` be the primary source of truth.

Important boundary: referencing a node does **not** automatically upload or
materialize every file inside that node. Node-local inline file refs should be
surfaced when the node content is actually included in context (for example via
user-view visible outline or `node_read`), and at that point they should use the
same local-file reference/resource format as composer-added files.

### 1. Separate the size guards

Replace `MAX_ATTACHMENT_BYTES` with separate constants:

- `MAX_RAW_INLINE_IMAGE_BYTES`: protects the renderer before loading a raw image
  for downscaling. Set this to 10 MB initially.
- `MAX_STAGED_ATTACHMENT_BYTES`: protects no-path `ArrayBuffer` staging over
  renderer -> main IPC. Set this to 50 MB; this is independent from local tool
  read limits such as `MAX_TEXT_FILE_BYTES` and `PDF_MAX_EXTRACT_SIZE`.
- `MAX_INLINE_IMAGE_BASE64_CHARS`: keep the existing model/provider-facing
  inline image budget. This is the real prompt payload guard.

Native path-backed non-image files do not use the byte caps above because the
renderer is not reading their contents.

### 2. Stage no-path bytes directly inside the agent file area

Add `lin:stage-attachment` following the existing preload/main IPC pattern.

- Preload: `stageAttachment(input) => ipcRenderer.invoke('lin:stage-attachment', input)`.
- Input: `{ name: string; mimeType: string; bytes: ArrayBuffer }`.
- Renderer must check `file.size <= MAX_STAGED_ATTACHMENT_BYTES` before
  `file.arrayBuffer()` so it does not allocate a known-too-large file.
- Main must re-check `bytes.byteLength <= MAX_STAGED_ATTACHMENT_BYTES`.
- Main writes to `<localRoot>/tmp/agent-attachments/<uuid>-<safe-name>`, where
  `localRoot` is the same root used by `AgentRuntime` local tools.
- The handler never accepts a renderer-supplied destination path.
- Return `{ path, name, mimeType, sizeBytes }`, where `path` is already readable
  by `file_read`.

Do not use `app.getPath('temp')` for this staging path. OS temp is outside the
agent local root in normal dev/prod runs and would preserve the path split this
task is fixing.

Implementation note: extract or share the `safeAttachmentFileName` helper shape
instead of duplicating incompatible filename sanitization.

### 3. Route renderer attachments by transport, not by one global cap

In `fileToAttachment`:

- Determine `mimeType`, supported inline image type, and `nativePath` first.
- For supported inline images:
  - reject if the raw file exceeds `MAX_RAW_INLINE_IMAGE_BYTES`;
  - keep `readInlineImageForModel` and the resize/base64 budget;
  - keep GIF oversized behavior explicit because animated GIFs cannot be safely
    downsampled by the current path.
  - also stage/materialize a readable file path when the image has no native
    path, so the composer can insert a normal `[[file:<label>^<path>]]` marker
    for the image instead of relying on hidden metadata.
- For native path non-inline files:
  - return `kind: "file"` with the native path and no byte cap;
  - do not read the file to hash or dedupe.
- For no-path non-image files:
  - reject if over `MAX_STAGED_ATTACHMENT_BYTES`;
  - read `ArrayBuffer` once;
  - call `stageAttachment`;
  - return `kind: "file"` with the staged path.

In `pickedLocalFileToAttachment`:

- If `mimeType` is a supported inline image and `imageDataBase64` is available,
  keep the inline image path.
- If it is a supported inline image but exceeds the raw image guard or main did
  not provide bytes, show an explicit image-size/unsupported-inline error rather
  than silently degrading to `kind: "file"`.
- Non-image native path files remain `kind: "file"` with no byte cap.

Unsupported image MIME types (`svg`, `avif`, `bmp`, `heic`, `tiff`) follow the
file path model unless a future plan adds provider-safe conversion.

### 4. Fix dedupe without reading large path-backed files

Do not keep the current content-hash behavior unchanged.

- Native path-backed files use `path:size:lastModified` as the duplicate key.
- No-path staged files can use `name:size:lastModified` plus an optional hash
  computed from the same `ArrayBuffer` already read for staging.
- The renderer must not call `sha256File(file)` for native path-backed files,
  because `sha256File` reads the entire file into renderer memory.
- Keep `MAX_ATTACHMENTS` and overflow handling unchanged.

### 5. Make file markers the normal model-visible resource contract

Runtime materialization must return both:

- the materialized `attachments`;
- a path rewrite map from original attachment path to materialized path.

Before building the final user message, rewrite file reference markers in the
message body so `[[file:<label>^<path>]]` points at the same materialized path
the file tools can read. Use the existing reference marker parser/formatter
helpers (`splitFileReferenceMarkers`, `formatFileReferenceMarker`) rather than
string surgery.

This is required for native path attachments outside `localRoot`, not only for
new no-path staged files.

Normal new turns should not emit `<user-attachments>` / attachment-resource JSON
as a system reminder. The message text markers are the resource index:

```text
[[file:<label>^<readable-path>]]
```

Keep the runtime `attachments` array as an internal transport mechanism for:

- sending image content blocks to pi-ai/provider adapters;
- carrying staged/materialized file paths across the renderer/main boundary;
- restoring historical `kind: "text"` or markerless attachment events.

If a compatibility reminder is still needed for a historical event shape, keep
it minimal and compatibility-only. It must not be the primary way the model
learns file paths for new composer turns.

### 6. Surface node-local file refs with the same local-file format

When node content is serialized for the model, local-file inline refs from the
outliner must not disappear. Update the node-context serializers that currently
use only `node.content.text`:

- user-view visible outline/title serialization;
- `node_read` / annotated outline serialization;
- any helper used by node search/read visible envelopes.

For node references, keep the existing node marker:

```text
[[node:<label>^<nodeId>]]
```

For local-file references inside node content, serialize:

```text
[[file:<label>^<materialized-or-readable-path>]]
```

The marker is sufficient for normal model context. Do not add matching resource
JSON just to repeat `mimeType`, `sizeBytes`, or source metadata. Dedupe repeated
local-file refs by materialized/readable path when deriving any internal
transport attachments, such as inline image blocks.

If a node contains a local-file ref outside `localRoot`, materialize/rewrite it
through the same path normalization used for composer-added files before the
model sees it. If immediate materialization for passive user-view context is too
expensive, the serializer must at least preserve the file marker and make the
limitation explicit; silently dropping the inline ref is not acceptable.

### 7. Error display (scoped consistency only)

Keep `attachmentError` near the composer because the error is about the file
being attached. Align styling with the runtime error treatment: warning icon,
`role="status"`, and danger token. A small shared `AgentInlineError` component
for `.agent-message-error` and `.agent-composer-error` is enough.

Do not introduce an app-wide toast/notification system in this plan.

### 8. Specs and reminders

Update the local-file attachment contract in:

- `docs/spec/agent-pi-mono-implementation.md`;
- `docs/spec/agent-tool-design.md`;
- `docs/spec/agent-progress.md` if it remains a current status source;
- `src/core/agentAttachments.ts`, deprecating `<user-attachments>` as the normal
  new-turn model context and keeping it only for historical/compatibility
  rendering if needed.

The new contract: new composer-generated non-image attachments are file paths.
Inline text attachments remain parseable only for historical sessions.
Composer and outliner local-file inline refs share the same model-facing
`[[file:<label>^<path>]]` marker. Resource metadata is runtime/internal unless
there is a concrete provider or compatibility need to expose it.

## Non-goals

- The outliner `attachment` node type.
- Streaming large no-path attachments over IPC. This plan uses a bounded
  `ArrayBuffer`; streaming can be a later optimization if the cap is too small.
- A full cleanup/GC policy for `<localRoot>/tmp/agent-attachments`.
- Provider-specific image conversion or model-specific image cap negotiation.
- A global toast/notification system.
- Automatically expanding all files inside every referenced node. This plan
  standardizes how node-local file refs appear when node content is included; it
  does not make `@node` eager-load all descendant resources.

## Test plan

- **Unit/core:** path marker rewrite converts original out-of-root file markers
  to materialized paths while preserving labels and surrounding text.
- **Unit/main helper:** `stageAttachment` writes under
  `<localRoot>/tmp/agent-attachments`, returns an absolute path, preserves
  `sizeBytes`, sanitizes traversal names, and rejects bytes over
  `MAX_STAGED_ATTACHMENT_BYTES`.
- **E2E (composer):** attach a >10 MB non-image native path file -> no error,
  `[data-agent-file-ref]` appears, and the sent payload is `kind:"file"` with a
  path. Do not assert an attachment chip; the current UI uses inline file refs.
- **E2E:** paste/drop a no-path text blob -> sent as `kind:"file"` with a staged
  path, not as truncated inline text.
- **E2E:** paste/drop a no-path binary -> staged and sent as `kind:"file"`, not
  rejected, as long as it is under `MAX_STAGED_ATTACHMENT_BYTES`.
- **E2E:** a supported image over `MAX_RAW_INLINE_IMAGE_BYTES` shows an explicit
  inline-image error and is not silently downgraded to a file.
- **E2E:** an accepted image inserts a normal `[[file:<label>^<path>]]` marker in
  the sent message and, when supported by the model, also sends an image content
  block through the internal `attachments` transport.
- **Integration:** native file outside `localRoot` is materialized, the body
  marker points at the materialized path, no normal `<user-attachments>` JSON is
  emitted, and `file_read` can read it.
- **Integration:** a referenced node whose content contains a local-file inline
  ref serializes that ref as `[[file:<label>^<path>]]` when node content is
  included, without requiring matching resource JSON.
- **Regression:** adding `@node` plus `@file` in one composer turn yields one
  node marker for the node reference and one local-file marker for the file; the
  node reference does not eagerly materialize unrelated node-local files unless
  node content is included.

## Decisions

- **Raw image guard value:** `MAX_RAW_INLINE_IMAGE_BYTES = 10 * 1024 * 1024`.
  This stays conservative because it protects renderer memory before image
  decode/downscale.
- **Staging byte cap value:** `MAX_STAGED_ATTACHMENT_BYTES = 50 * 1024 * 1024`.
  Native path-backed files bypass this cap because they do not cross IPC as
  bytes.
- **Small-text fast path:** do not keep one. Stage all no-path non-images so new
  composer-generated resources use the same `[[file:<label>^<path>]]` contract.
