---
status: draft
owner: codex-2
updated: 2026-06-13
---

# Agent File Artifact Model

**Shape: (a) ONE complete feature in one PR.**

## Goal

Make agent-created files feel like Tenon-native artifacts first, without asking
ordinary users to choose or understand a workspace folder.

When a user asks the agent to create a Markdown file, report, table, code sample,
download, or other file-like output, the result should appear in the conversation
as an inspectable file card/inline reference and be exportable on demand. It
should not silently land in a repository clone, `cwd`, Desktop, Documents, or any
other user-visible filesystem location.

At the same time, keep `file_write` a path-based filesystem tool. `file_write`
must continue to mean "write bytes/text to this `file_path`"; it should not be
changed into an id-based artifact API.

## Non-goals

- Do not add an `artifact_create` tool. It overlaps too much with `file_write` and
  would split the model's "create a file" habit across two tools.
- Do not introduce a workspace/project picker for ordinary use.
- Do not remove external filesystem support. Explicit external writes remain
  possible through path-based `file_write` and the existing permission model.
- Do not move the outliner document, asset store, agent event store, provider
  settings, secrets, or diagnostics out of `userData`.

## Current State

Outliner attachments already use the desired internal-data model:

- `pick_image_files` / `pick_attachment_files` copy selected files into the app
  asset store.
- `AssetService` writes bytes and sidecar metadata under `<userData>/assets/`.
- The outliner document stores only `assetId` and display metadata such as
  `originalFilename`, `mimeType`, and `fileSize`.
- The original source path is not a durable dependency.

Agent file tools are different:

- `agentLocalFileRoot` is resolved once at app startup.
- In development, with no `LIN_AGENT_LOCAL_ROOT`, it is `process.cwd()`, so a dev
  app launched from `~/Coding/lin-outliner` treats that clone as the allowed file
  area.
- In packaged builds, with no override, it is `<userData>/agent-local-root`.
- `file_write` creates or rewrites a real path under that root and returns a
  slim tool result with `filePath` and patch metadata.
- The tool result renderer treats this as ordinary JSON/text output. It does not
  synthesize a message attachment, file chip, preview card, or exported asset.

That explains the current bug: after `file_write` succeeds, the agent can state a
path in prose, but the conversation has no structured "this file was produced"
object. The renderer only knows about user-supplied attachments and local-file
reference markers in message text.

## Product Model

Tenon should be artifact-first, not filesystem-first.

There are three storage tiers:

| Tier | Storage | User model |
|---|---|---|
| App private state | `<userData>` | Tenon-owned document, assets, agent events, settings, credentials, diagnostics. |
| Agent-generated files | `<userData>/artifacts` or a typed extension of `<userData>/assets` | File-like outputs shown inside Tenon; exportable by user action. |
| External filesystem | User-provided absolute paths | Explicit reads/writes to real files, governed by permissions. |

The default behavior for "create a file" should be:

1. The model calls path-based `file_write`.
2. If the requested path is inside Tenon's internal file-artifact area, the write
   produces a durable artifact record.
3. The successful tool result carries structured artifact metadata.
4. The conversation renderer displays a file chip/card from that metadata.
5. The user can preview, copy, insert into the outliner, reveal internal storage
   only in diagnostics/dev surfaces, or export/save-as to an external path.

External `file_write` remains valid when the user explicitly supplies or approves
an external path. Those writes should still display a local-file chip for the
written path, but they are not Tenon-managed artifacts unless the user imports
them.

## Design

### 1. Split "local root" semantics

`agentLocalFileRoot` is currently overloaded:

- permission allowed file area;
- `bash` cwd;
- `file_*` root;
- `tmp/agent-attachments`;
- `tmp/agent-web-fetch`;
- `tmp/agent-tool-outputs`;
- project `.agents/agents` and `.agents/skills` root;
- trusted local-file preview/open boundary.

Introduce explicit runtime paths:

```ts
interface AgentFileEnvironment {
  externalFileRoot: string;
  artifactRoot: string;
  scratchRoot: string;
}
```

Initial mapping:

- `externalFileRoot`: keep today's resolved local file root for path-based
  external access and `.agents/*` compatibility.
- `artifactRoot`: `<userData>/artifacts`.
- `scratchRoot`: `<userData>/agent-scratch`.

This change is mostly naming and routing first; it prevents more hidden coupling
as artifact behavior is added.

### 2. Keep `file_write` path-based

Do not change the schema:

```ts
{
  file_path: string;
  content: string;
}
```

Instead, resolve relative/generated paths against the internal artifact root
when the user did not explicitly request an external path. The model still sees
and supplies a path, but Tenon chooses a product-appropriate default path.

The model-facing tool description should say:

- Use `file_write` to create or rewrite files.
- For generated deliverables, use a simple relative path such as `report.md` or
  `outputs/report.md`; Tenon stores these as internal artifacts.
- Use an absolute external path only when the user explicitly asks for that
  location or when editing a user-provided file.

This preserves path semantics without making normal users choose a folder.

### 3. Add artifact metadata to successful file results

Extend `FileWriteData` for writes under `artifactRoot`:

```ts
interface FileArtifactRef {
  id: string;
  name: string;
  filePath: string;
  mimeType: string;
  byteSize: number;
  createdAt: number;
  kind: 'artifact';
}
```

`file_write` still returns `filePath`. For internal artifact writes, it also
returns `artifact`.

Renderer behavior:

- tool summary: "Created `report.md`";
- collapsed row shows a file chip/card, not only JSON;
- expanded output still shows structured details for inspection;
- assistant prose that includes `[[file:report.md^<path>]]` renders as an
  inline file reference.

### 4. Teach message rendering about tool-produced files

Today file chips are mainly driven by user attachment metadata and explicit
reference markers. Add a tool-result projection path:

- Detect successful `file_write` / `file_edit` results with `data.filePath`.
- If the result has `data.artifact`, render a managed artifact chip.
- If the result is an external path inside the trusted file boundary, render a
  local-file chip.
- Expose actions: Preview, Copy path/content, Export/Save As.

This fixes the observed issue where the agent "does not know how to show the
file in the message stream." The missing piece is not model intelligence; it is a
structured render projection for file-producing tool results.

### 5. Move scratch outputs out of the user file area

Move non-user deliverables from `localRoot/tmp` to `scratchRoot`:

- `tmp/agent-attachments`;
- `tmp/agent-web-fetch`;
- `tmp/agent-tool-outputs`;
- PDF page image extraction output.

These are implementation details. They should be previewable through Tenon when
needed, but they should not pollute generated-file or external-file semantics.

### 6. Export is explicit

An internal artifact can be exported by a user action:

- `Export...` opens a save dialog.
- Default location can be Desktop or Downloads, depending on existing export
  convention.
- The external path is written only after the user confirms the save dialog.

The model should not need a separate export tool for the first implementation;
export can start as a renderer/main UI action on the artifact chip.

## Permission Model

Internal artifact writes are lower risk than external filesystem writes because
they mutate Tenon-managed private data, not arbitrary user files. They should
still be visible in the transcript and auditable.

External writes keep the current path-based file permission behavior:

- writes inside the configured allowed file area follow the configured action
  decision;
- writes outside it ask/deny according to policy;
- sensitive paths and platform hard blocks remain unchanged.

If a relative `file_path` maps to `artifactRoot`, the permission descriptor should
make that clear in the approval UI: "Create a Tenon artifact" rather than "Write
external file."

## Files Likely Touched

- `src/main/agentLocalRoot.ts` — replace single-root naming with explicit file
  environment helpers.
- `src/main/main.ts` — initialize artifact/scratch roots and pass them into the
  agent runtime and preview/export handlers.
- `src/main/agentLocalTools.ts` — route relative generated writes, return
  artifact metadata, move scratch output dirs.
- `src/main/agentTools.ts` — move web-fetch binary persistence to scratch/artifact
  handling.
- `src/main/agentAttachmentMaterialization.ts` — move staged attachment copies to
  scratch root.
- `src/main/previewSource.ts` / `src/main/localFileReferenceSecurity.ts` — allow
  preview/open of trusted artifact references without widening external file
  access.
- `src/core/types.ts` / `src/core/agentTypes.ts` — add artifact metadata DTOs if
  needed by renderer projections.
- `src/renderer/ui/agent/AgentToolCallBlock.tsx` — render file-producing tool
  results as file chips/cards.
- `src/renderer/ui/agent/AgentMarkdown.tsx` and
  `src/renderer/ui/agent/AgentInlineReferenceText.tsx` — ensure generated file
  markers and fallback chips render consistently.
- `src/renderer/ui/preview/FilePreviewPanel.tsx` — preview artifact-backed files.
- `docs/spec/agent-tool-design.md` and `docs/spec/agent-tool-permissions.md` —
  document the new semantics.

## Collision Result

Checked open PRs on 2026-06-13:

- #217 (`codex/agent-header-single-line`) touches agent dock/config UI and adds
  `docs/plans/channel-async-message-bus.md`.

This plan-only PR only adds `docs/plans/agent-file-artifact-model.md`, so there
is no file overlap. Implementation will likely touch agent tool rendering and
possibly settings/preview files; schedule that after #217 merges or re-check
before coding.

## Risks

- Relative path routing must not surprise advanced users who expect repo writes
  in development. Keep `LIN_AGENT_LOCAL_ROOT` and explicit absolute paths working.
- Internal artifacts need lifecycle rules. The first implementation can keep
  artifacts durable; later work should add garbage collection for unreferenced
  artifacts and scratch TTL cleanup.
- Export/save-as UX must avoid implying that the internal path is the user's real
  file location.
- Existing tests and specs use "workspace root" terminology. Rename carefully to
  avoid a partial semantic split.

## Acceptance Criteria

- Asking the agent to create `测试.md` produces a visible file affordance in the
  conversation without writing to the repo clone, Desktop, Documents, or
  Downloads by default.
- `file_write` remains path-based and still supports explicit absolute external
  writes.
- Tool results for successful file writes render a previewable/copyable/exportable
  file chip/card.
- Outliner attachment behavior remains unchanged: user-added files copy into the
  internal asset store and document nodes keep `assetId` metadata.
- Scratch outputs no longer live under the user-facing/generated-file area.
- Specs and tests describe the distinction between internal artifacts, scratch
  files, and external filesystem writes.
