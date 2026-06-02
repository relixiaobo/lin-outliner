---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-02
updated: 2026-06-02
---

# Agent Composer Attachments — Path-First Model

Scope: the **agent composer** attachment pipeline (`AgentComposer.tsx`), NOT the
outliner `attachment` node type (that is [`file-attachments.md`](file-attachments.md),
unrelated).

## Problem

The composer caps every attachment at 10 MB — `MAX_ATTACHMENT_BYTES`
(`src/renderer/ui/agent/AgentComposer.tsx:84`), checked uniformly *before* the
attachment kind is known (`addFiles` :314, `addPickedLocalFilesInline` :383,
`fileToAttachment` :791). But attachments reach the model two different ways
(`fileToAttachment` :790-842, `toAttachmentPayload` :878):

- **Images** embed base64 inline (`kind:'image'`, `dataBase64`) — the model sees
  them as vision input, so bytes genuinely enter the context. They are already
  downscaled by `readInlineImageForModel` to the model's image limit.
- **Every other file** is sent as a **path reference** (`kind:'file'`, `path`).
  The backend copies it into a sandbox staging dir —
  `materializeFileAttachment` → `<localRoot>/tmp/agent-attachments/`
  (`src/main/agentRuntime.ts:2919`, `AGENT_ATTACHMENT_DIR` :200) — so the agent
  reads it on demand via local tools, which enforce their *own* read limits
  (`MAX_TEXT_FILE_BYTES` 10 MB, `PDF_MAX_EXTRACT_SIZE` 100 MB, etc. in
  `agentLocalTools.ts`).

So a 10 MB cap on a path reference (e.g. a `.dmg`) is a web-upload concept that
does not fit a desktop app that passes addresses. The cap should exist **only**
for inline images.

Second gap: inputs **without** a native path (pasted text, in-memory `File`,
dragged-from-web content) can't reach the staging dir — there is no
renderer→main "write bytes to disk" IPC (`preload/index.ts` exposes only
`getFilePath` / `pickLocalFiles` / `prepareLocalFile`). The renderer therefore
falls back to embedding: image→base64, text→**truncated** inline (:827-839),
anything else→**rejected** ("not a supported image or text file", :841). Pasting
a large log truncates; pasting a binary fails.

## Goal — a path-first model

| Input | Today | Target |
|---|---|---|
| Image (any source) | inline base64 | **inline base64** (vision needs bytes); image-only size guard |
| File w/ native path (`.dmg`, …) | path → staged | unchanged, **no size cap** |
| No-path text | truncated inline | **staged to disk → path** (full content, read on demand) |
| No-path binary | rejected | **staged to disk → path** |

Net: only images carry a (model-side) size limit; everything else is a path
reference the agent reads via tools. The staging dir already exists — this plan
just routes no-path bytes into it and stops capping path references.

## Design

### 1. New IPC — stage bytes to disk
Add `lin:stage-attachment` following the existing IPC pattern
(`preload/index.ts:127-140` for the bridge, `main.ts:546-640` for
`ipcMain.handle`).

- Preload: `stageAttachment(input) => ipcRenderer.invoke('lin:stage-attachment', input)`.
- Input: `{ name: string; mimeType: string; bytes: ArrayBuffer }`. Transfer the
  bytes as an `ArrayBuffer` (structured clone), NOT base64 — base64 adds ~33%
  bloat and a large string copy over IPC.
- Main handler: write the bytes to a temp file under a dir the **main process
  controls** (recommend `app.getPath('temp')` + a `lin-attachments` subdir),
  with a sanitized name (reuse the `safeAttachmentFileName` shape,
  `agentRuntime.ts:2940`) prefixed by `randomUUID()`. Return
  `{ path, name, mimeType, sizeBytes }`.
- No change to `materializeFileAttachment`: at send time it already copies any
  out-of-sandbox `path` into `<localRoot>/tmp/agent-attachments/`, so the staged
  temp file is pulled into the sandbox automatically.
- Security (A3): the handler writes ONLY to its own temp dir; it never accepts a
  renderer-supplied destination path. Leave the permission allow-list
  (`main.ts:101-103`) untouched.

### 2. Renderer — route no-path non-images through staging
In `fileToAttachment` (`AgentComposer.tsx:790`):
- image branch (:801) — unchanged (keep inline base64 for vision).
- `nativePath` branch (:816) — unchanged.
- Replace the text-embed branch (:827-839) **and** the final `throw` (:841):
  for any no-path non-image file, read its `ArrayBuffer`, call `stageAttachment`,
  and return a `kind:'file'` attachment with the returned `path`. This drops the
  truncating text path — the agent now reads the full file via tools.

Verify `pickedLocalFileToAttachment` (:844) needs no change (picked files always
carry `file.path`).

### 3. Size limit → image-only
- Rename `MAX_ATTACHMENT_BYTES` → `MAX_INLINE_IMAGE_BYTES` (it guards reading a
  huge *raw* image into memory before downscale). Consider raising it (e.g.
  25 MB) since `readInlineImageForModel` already enforces the real model image
  limit — open question below.
- Remove the size check from `addFiles` (:314) and `addPickedLocalFilesInline`
  (:383). Apply it ONLY in the image branch of `fileToAttachment` /
  `pickedLocalFileToAttachment`.
- Keep `MAX_ATTACHMENTS` (count cap) and the dedupe/hash logic unchanged.

### 4. Error display (scoped consistency only)
Keep the inline `attachmentError` near the composer — that placement is
contextually correct (it is about what you are attaching). Align only its
STYLING with the runtime error so the dock stops showing two different error
treatments: render it with the same warning icon + `role="status"` + danger
token as `.agent-message-error` (`AgentChatPanel.tsx:1058`). Cleanest: factor a
tiny shared `AgentInlineError` used by both `.agent-message-error` and
`.agent-composer-error`.

**Out of scope — separate decision.** There is no app-wide error/toast primitive
in the renderer today, and whether to build one (and whether attachment errors
should become toasts) is a larger product decision the owner has not made. This
plan only unifies the two *agent* inline errors; a global toast/notification
system is a future plan.

## Non-goals
- The outliner `attachment` node type (`file-attachments.md`).
- GC / cleanup of the staging dir — pre-existing concern;
  `tmp/agent-attachments/` already accumulates copied path-attachments.
- Changing how images reach the model (stays inline base64 for vision).
- A global toast/notification system (see §4).

## Test plan
- **Unit (main):** `lin:stage-attachment` writes the bytes to a temp file, returns
  a real absolute path with the correct `sizeBytes`, and sanitizes the name; it
  rejects/normalizes a path-traversal name.
- **E2E (composer):** attach a >10 MB non-image local file (drag → native path) →
  no error, the attachment chip appears (today it errors). Use the existing
  `agent-composer.spec.ts` attachment harness.
- **E2E:** paste/drop a no-path text blob → staged as a `kind:'file'` ref, NOT
  truncated inline; a no-path binary → staged, NOT rejected.
- **E2E:** a >`MAX_INLINE_IMAGE_BYTES` image → still rejected, shown via the now
  icon-consistent inline error.
- **Integration:** confirm `materializeFileAttachment` pulls the staged temp file
  into `<localRoot>/tmp/agent-attachments/` at send time and the agent can read
  it with `file_read`.

## Open questions
- **Staging location:** OS temp (`app.getPath('temp')`, auto-cleaned by the OS)
  vs a dedicated dir under userData (persists). Recommend OS temp — the sandbox
  copy made by `materializeFileAttachment` is the durable one.
- **Raise the raw image guard?** Since downscaling handles the true model limit,
  the raw cap could be larger (e.g. 25 MB) or keyed off the model's declared
  image constraints.
- **Small-text fast path:** optionally keep tiny pasted text inline (untruncated)
  to avoid a temp file for trivial pastes, staging only above some length. Adds a
  branch; default is "stage all no-path non-images" for one uniform model.
