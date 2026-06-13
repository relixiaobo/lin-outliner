# Agent File Model — paths for the agent, handles for the document

> **Supersedes the draft in PR #218** (`codex-2/agent-file-artifact-model`). That
> draft fixed only the output side and did so by adding a *parallel* internal store
> (`<userData>/artifacts`), a new `FileArtifactRef` DTO, and a relative-vs-absolute
> path-routing heuristic. This revision deletes all three. It also addresses the
> input side, which #218 left untouched: today an outliner file referenced into a
> conversation reaches the agent as a node with **no readable bytes**.

## Goal

Give agent file handling **one coherent shape**, so that a file is the same thing
on the way in, while the agent works on it, and on the way out:

- The **agent** lives entirely in a **path-addressed filesystem**. It reads,
  writes, edits, globs, and runs `bash` over paths — one namespace, input and
  output identical. It never sees an asset id.
- The **document** (outliner) lives entirely in the **handle-addressed asset
  store** — durable, id-addressed, `asset://`-rendered. It never stores a
  filesystem path.
- **Two symmetric bridges** copy bytes across that boundary: *materialize*
  (handle → path, when a document file is referenced into a conversation) and
  *ingest* (path → handle, when a conversation file is saved into the document).

The concrete user-visible payoff: when the agent creates `report.md`, it appears
in the conversation as an inspectable, previewable, exportable file — and can be
saved into the outliner as a first-class node, indistinguishable from a file the
user added themselves.

## Non-goals

- **No `artifact_create` tool.** `file_write(file_path, content)` stays the single
  "create a file" verb. A second id-based create tool would split the model's
  habit.
- **No parallel artifact store.** No `<userData>/artifacts`, no `FileArtifactRef`.
  The asset store (`AssetService`) is already the app's internal-file model; the
  document side reuses it unchanged.
- **No relative/absolute path-routing heuristic.** Where a write lands is decided
  by the agent's working directory, not by inspecting the path string.
- **No workspace / project picker** for ordinary use.
- **No migration / back-compat.** Pre-release: on any format change, wipe
  `~/.lin-outliner-*` dev userData rather than ship a reader.

## The model

### One rule

> **App-owned bytes are a path for the agent and a handle for the document. A path
> is a path only when it points at the user's own external filesystem.**

The split between the two worlds is decided by a single question — *does the app
own these bytes, or does the user?* — never by the shape of the path string.

```
        WORLD A — app owns the bytes              WORLD B — user owns the bytes
   ┌─────────────────────────────────────┐   ┌──────────────────────────────────┐
   │ one store (AssetService) + workdir   │   │ the user's real filesystem        │
   │                                      │   │                                   │
   │   agent view        document view    │   │   agent view: absolute path       │
   │   = a path          = a handle       │   │   (permission-gated)              │
   │   (workdir file)    (asset:// id)    │   │   document view: none             │
   └───────────────┬──────────────────────┘  └──────────────────────────────────┘
                   │  two bridges, both "copy bytes across the boundary"
                   │    materialize : handle → path  (reference a doc file in)
                   │    ingest      : path → handle  (save a conversation file out)
```

### Why the agent only ever sees paths

A file is something you iterate on: read line N, edit it, list the directory,
grep, re-run a build. Those are filesystem verbs over a working directory. The
agent's whole tool surface (`file_read` / `file_write` / `file_edit` /
`file_glob` / `file_grep` / `bash`) is already a POSIX-ish surface over one root
(`resolveWorkspacePath`, `agentLocalTools.ts`). Keeping the agent in one
path namespace makes input and output the **same format** by construction, and
keeps the whole tool surface consistent (no tool resolves a name differently from
its siblings).

### Why the document only ever stores handles — and why that is irreducible

The renderer is sandboxed (`sandbox: true`, `contextIsolation: true`) and the
packaged document runs under a strict CSP whose `img-src` / `media-src` allow
`asset:` but **not** `file:` (`main.ts:289-290`). A renderer therefore *cannot*
load a raw filesystem path into `<img>`/`<video>` — not in packaged builds (CSP)
and not in dev (the page is an `http://localhost` origin, which browsers forbid
from loading `file://`). The only legal way to stream app bytes into the renderer
is a registered privileged protocol addressed by an opaque id
(`registerSchemesAsPrivileged`, `main.ts:190`; `protocol.handle`,
`main.ts:2382`). The id also keeps the document free of a durable filesystem
dependency: the doc stores only the bare id and the URL is built at render time,
so storage can move without migration (`core/assets.ts`).

So `asset://` is not an alternative to "just use a path" — it is the *cleanest
form* of "load app bytes into a sandboxed renderer," and it survives exactly at
this one boundary. The agent never touches it.

### Working vs committed (two lifecycles inside World A)

- **working** — a file in the agent's working directory. Mutable, addressed by
  path, lifecycle tied to the conversation, eligible for GC.
- **committed** — bytes snapshotted into the asset store, addressed by a handle,
  referenced by an outliner node, lifecycle tied to the document.

Crossing into the document is **always a copy + freeze**. A node embedded in the
document references the snapshot, not the live working file: if the agent later
edits the working file, the document does not change. This is deliberate — the
document must be stable, and a working file can be GC'd with the conversation, so
the document can never be allowed to depend on it. Want the new version in the
doc? Save again.

### The two bridges are inverses, and they close the loop

```
   agent writes      report.md  (path, working)
        │  ingest  (path → handle, copy + freeze)
        ▼
   outliner node     assetId    (handle, committed)
        │  materialize  (handle → path, copy)
        ▼
   agent reads       report.md  (path, working)   ← when the node is referenced back in
```

`ingest` and `materialize` are the same operation in opposite directions. A file
saved from a conversation becomes the **same format** as a user-pasted image or a
picked attachment; referenced back into a conversation it becomes a workdir path
again. The agent's "read a file" and "write a file" live in one namespace across
the entire loop.

## Current state (grounded)

- **Agent root is a single overloaded value.** `resolveAgentLocalFileRoot`
  (`agentLocalRoot.ts:22-31`) returns `process.cwd()` in dev (so a dev app
  launched from a clone treats the **repo** as the file area — the source of the
  stray `测试.md`), `<userData>/agent-local-root` packaged, or
  `LIN_AGENT_LOCAL_ROOT` if set. That one root is simultaneously: bash cwd, the
  `file_*` root, the home of `tmp/agent-attachments` / `tmp/agent-web-fetch` /
  `tmp/agent-tool-outputs`, the `.agents/*` root, and the trusted preview
  boundary.
- **`file_write` returns a path-only result.** `visibleFileWrite`
  (`agentLocalTools.ts`) returns `{ type, filePath, structuredPatch }`.
- **The conversation has no file affordance.** `AgentToolCallBlock.tsx:709-731`
  renders any tool result — including `file_write` — as JSON/text in a `<pre>`.
  There is no file chip for tool outputs.
- **Referenced outliner files are lossy on input.** Image/attachment nodes hold
  `assetId` + display metadata (`types.ts:416-434`), but the node projection sent
  to the agent only carries `type` + `content.text` (`agentNodeToolProjection.ts`);
  **no `agentNodeTool*` file references `assetId`**. The agent sees "there is an
  image node," never the bytes.
- **Composer attachments already materialize to paths.** A staged attachment is
  copied under `tmp/agent-attachments` and reaches the model as a path it reads
  with `file_read` (`agentAttachmentMaterialization.ts`; `agentRuntime.ts:4968`);
  images are inlined as base64 (`agentRuntime.ts:4989`). The model-facing contract
  already says so: *"Files and folders are available at local paths; use file_read"*
  (`agentAttachments.ts:156`).
- **The asset store is already the internal-file model we want.** `AssetService`
  (`assetService.ts`) does `ingest` / `lookup` / `pathFor` / `serve`; metadata
  shape `AssetMetadata` (`types.ts:641-653`) already carries id / mimeType /
  byteSize / originalFilename / createdAt / image dims / pdf thumbnail. Preview
  already supports `local-file` (`previewSource.ts:79-104`) and `asset`
  (`:106-129`) sources. Outliner media nodes are created via `createImageNode`
  (`core.ts:465`) and `createAttachmentNode` (`core.ts:489`).

The gap is not a missing store. It is (1) no render projection for file-producing
tool results, (2) a lossy node→agent projection on input, (3) no save-to-outliner
bridge, and (4) a dev root that points at the repo.

## Design — a set of independent features

**Shape: (b) a SET of independent complete features.** Each ships its own PR, is
independently verifiable, and delivers user value alone — none is scaffold for a
later one. Recommended order is by value and dependency, but F1 does not require
F2 etc.

### F1 — Render agent file outputs in the conversation *(the reported bug)*

Make a successful `file_write` / `file_edit` show a file the user can inspect,
preview, and export — instead of raw JSON.

- In `AgentToolCallBlock.tsx`, recognize results whose tool is `file_write` /
  `file_edit` and that carry a path; render a **local-file chip** (display the
  basename, e.g. `report.md`) reusing the existing `InlineFileReference` / user
  attachment chip visuals. Keep the `structuredPatch` diff in the expandable
  detail.
- When the agent mentions the file in prose, it emits the existing reference
  marker `[[file:report.md^<path>^file]]` (`referenceMarkup.ts`), which
  `AgentMarkdown` already turns into an `InlineFileReference` chip. No new marker.
- Chip actions reuse existing machinery: **Preview** →
  `preview_resolve_source({ kind: 'local-file', path })`
  (`previewSource.ts:79-104`) → `FilePreviewPanel`; **Export / Save As** →
  `dialog.showSaveDialog` → copy out; **Copy path / content**.
- No new store, no new DTO, no `asset://`. A working file in a conversation is a
  path-addressed local-file chip.

This is the entire reported bug and is independently shippable today.

### F2 — App-owned agent working directory *(kill cwd = repo; relocate scratch)*

Stop the agent's default file area from being the repo clone, and stop scratch
from polluting the file area.

- Replace the single overloaded root with explicit roots resolved at startup:
  - `workdir` — app-owned, the agent's default cwd and `file_*` root. Default
    `<userData>/agent-workdir` in **both dev and packaged** (dev userData is
    already per-clone isolated under `$HOME/.lin-outliner-<clone>`, so the workdir
    inherits that isolation). The `cwd` default is dropped (Decision 1).
    `LIN_AGENT_LOCAL_ROOT` stays the explicit opt-in to point at a repo (for
    dogfooding).
  - `scratch` — `<userData>/agent-scratch`. Move `tmp/agent-attachments`,
    `tmp/agent-web-fetch`, `tmp/agent-tool-outputs`, and PDF page-image extraction
    here (`agentAttachmentMaterialization.ts`, `agentTools.ts`,
    `agentLocalTools.ts`).
  - External access stays as today: absolute paths under the permission model.
- Because the agent's cwd *is* `workdir`, the whole file tool surface stays
  consistent — `file_write report.md` then `file_read report.md` /
  `file_glob *.md` / `bash cat report.md` all resolve to the same real file. (No
  split-brain, which a relative-vs-absolute routing heuristic would have caused.)

### F3 — Materialize bridge: referenced outliner files become agent-readable

Fix the lossy input path so that referencing a document file actually hands the
agent its bytes.

- When an image/attachment node (or other asset-backed content) is referenced into
  a conversation, **materialize** the asset into the agent `workdir`, mirroring how
  composer attachments already work (Decision 2): at send time,
  `assetService.pathFor(assetId)` → copy into `workdir` → expose to the agent as a
  workdir-relative path read with `file_read`; images are additionally inlined as
  base64 for vision. Size-capped via the existing `MAX_MATERIALIZED_ATTACHMENT_BYTES`
  limit. No new lazy-on-read mechanism.
- The renderer keeps the handle for its own display; only the agent-facing side
  gains a path. Reuse the existing materialization + TTL machinery
  (`agentAttachmentMaterialization.ts`), now rooted at `workdir`/`scratch`.
- Result: a referenced file is the **same format** the agent sees for its own
  outputs — a workdir path — completing input/output symmetry.

### F4 — Ingest bridge: save a conversation file into the outliner

Let a file produced or held in a conversation become a first-class outliner node.

- Core operation (one implementation, trigger-agnostic):
  `assetService.ingest({ kind: 'path', path })` → `AssetMetadata` →
  `createImageNode` / `createAttachmentNode` with the resulting `assetId` +
  metadata. The node **type is derived from the sniffed mimeType** (`image/*` →
  image node, else attachment node), not chosen by the user.
- This is the `working → committed` promotion: bytes are copied into the asset
  store and frozen; the document holds a stable `assetId`.
- **Trigger (MVP): a user action** — an "Insert into outliner" button on the file
  chip (renderer/main, over existing core create functions). Explicit, matching
  "export is explicit."
- **Trigger (later, optional): an agent tool.** Today node tools are text-only
  (no `agentNodeTool*` handles `assetId`); an agent-driven insert is net-new and
  can reuse the same core operation when wanted.

## Output path format & message-stream handling (cross-cutting contract)

The agent's output is **a path string, not a new artifact object**:

- **World A (internal, the common case):** a `workdir`-relative path
  (`report.md`, `outputs/report.md`). The agent's cwd is `workdir`, so the same
  relative path it wrote is the one it re-reads/edits. Persist the **relative**
  path in the conversation log and resolve to absolute at render time (mirrors the
  asset philosophy of "store the logical reference, resolve at render"); the
  absolute `<userData>/…` path is resolved only in main and **never shown** — the
  chip displays the basename.
- **World B (external):** an absolute path, permission-gated. Same local-file chip,
  different trust domain.
- **In prose:** the existing `[[file:label^path^entryKind]]` marker.

The message stream renders an output file in two places, both reusing the
local-file chip + preview pipeline:

1. **Tool-result block** — `AgentToolCallBlock` recognizes `file_write` /
   `file_edit` + path → file chip (the one render change; today it dumps JSON).
2. **Prose** — `[[file:…]]` → `InlineFileReference` (already works).

Input and output are therefore indistinguishable in the stream: both are a
`workdir` path rendered as a local-file chip, opening the same preview.

## Outliner file format & the save flow

A file in the outliner is **a node holding a handle + display metadata**, never a
path and never bytes:

```
ImageNode      { type:'image',      assetId, mediaAlt?, imageWidth?, imageHeight? }
AttachmentNode { type:'attachment', assetId, mimeType?, originalFilename?,
                 fileSize?, thumbnailAssetId?, pdfPageCount?, audioDurationMs?, … }
```

Bytes live in the asset store (`<userData>/assets/<id>.<ext>` + `<id>.meta.json`)
and render through `asset://` (`AttachmentRow.tsx`, `ImageRow.tsx`). Saving a
conversation file in (F4) runs the ingest bridge to produce exactly this shape, so
an agent-produced file and a user-added file are the same kind of node.

## Permission model

- **Internal writes** (under `workdir`) mutate app-owned data and are lower risk
  than external writes; they remain visible/auditable in the transcript. Because
  routing is by working directory rather than a path-string heuristic, the
  approval descriptor is unambiguous.
- **External writes** keep today's behavior: inside the allowed area → configured
  action decision; outside → ask/deny; sensitive paths and platform hard blocks
  unchanged.
- `workdir` must be a dedicated leaf directory; containment checks
  (`resolveWorkspacePath`) must prevent a relative path from escaping into other
  `userData` (document, secrets, event store).

## Files likely touched

- `src/main/agentLocalRoot.ts` — explicit `workdir` / `scratch` roots (F2).
- `src/main/main.ts` — initialize roots; wire into runtime + preview/export (F2).
- `src/main/agentLocalTools.ts` — relocate scratch dirs; keep result path-based,
  preferably workdir-relative (F2, contract).
- `src/main/agentTools.ts`, `src/main/agentAttachmentMaterialization.ts` —
  scratch/materialize rooted at `scratch`/`workdir` (F2, F3).
- `src/renderer/ui/agent/AgentToolCallBlock.tsx` — file chip for `file_write` /
  `file_edit` results (F1).
- `src/renderer/ui/agent/AgentMarkdown.tsx`,
  `src/renderer/ui/agent/AgentInlineReferenceText.tsx` — ensure agent-output
  markers render consistently (F1).
- `src/renderer/ui/preview/FilePreviewPanel.tsx` — preview workdir files (F1).
- node projection (`agentNodeToolProjection.ts` and node-tool read path) +
  materialization — expose referenced asset bytes to the agent (F3).
- save-to-outliner action over `createImageNode` / `createAttachmentNode`
  (`core/core.ts`) + `assetService.ingest` (F4).
- `docs/spec/agent-tool-design.md`, `docs/spec/agent-tool-permissions.md` —
  fold in the model when each feature ships.

## Collision result

Checked open PRs on 2026-06-13:

- **#218** (`codex-2/agent-file-artifact-model`) — same topic; **superseded and
  closed.** This plan ships as #220.
- **#217** (`codex/agent-header-single-line`) — agent dock / channel config UI.
  F1 touches `AgentToolCallBlock` (tool-result rendering), a different area;
  re-check at F1 build time.
- **#219** (`cc/outline-syntax-unification`) — docs/plans + `core/textSyntax`; no
  overlap.

## Risks

- **Working-file lifetime.** A working-file chip is a live reference into
  `workdir`; once the conversation/workdir is GC'd, preview is unavailable. The
  chip must degrade gracefully ("no longer available"); durability is what
  Save-to-outliner / Export are for.
- **Materialize privacy/cost (F3).** Materializing referenced document files lets
  the agent read whatever is embedded in the doc, and copies bytes. Bounded by
  Decision 2: the user's explicit reference is the authorization, and the copy is
  size-capped at send (no eager copy of unreferenced content).
- **Dev workflow change (F2).** Dropping the dev `cwd` default (Decision 1) changes
  how dev agents edit the repo. `LIN_AGENT_LOCAL_ROOT` must remain the clean opt-in.
- **Terminology drift.** Existing tests/specs say "workspace root" / "local root";
  rename to `workdir` carefully and in one pass per feature.

## Decisions (ratified by the PM, 2026-06-13)

1. **Dev default root → internal.** Drop the dev `cwd` default; `workdir` is
   `<userData>/agent-workdir` in both dev and packaged (dev inherits per-clone
   userData isolation). `LIN_AGENT_LOCAL_ROOT` is the explicit opt-in to point at a
   repo. Removes repo pollution at the root and makes dev match packaged.
2. **Materialize = mirror composer attachments.** On reference-in, materialize at
   send time (images base64 + path, other files path), size-capped via the existing
   attachment limit; reuse the existing machinery. No lazy-on-read mechanism. The
   user's explicit reference is the authorization.
3. **Agent output stays `working` by default.** No auto-commit; promotion to a
   durable asset is an explicit user action (Insert into outliner / Export). Avoids
   polluting the durable store and matches "export is explicit." Working files are
   GC'd with the conversation.
4. **Persist a `workdir`-relative path.** Store the relative path in the
   conversation log and resolve at render. No logical handle for working files —
   that would reintroduce the dual-identity index this model deletes.

## Acceptance criteria

- **F1:** a successful `file_write` shows a previewable / copyable / exportable
  file chip in the conversation; the diff remains inspectable; no raw-JSON dump.
- **F2:** with no `LIN_AGENT_LOCAL_ROOT`, an agent-created file does **not** land
  in the repo clone, Desktop, Documents, or Downloads; scratch output no longer
  lives under the file area; `file_write` then `file_read`/`file_glob` of the same
  relative path resolve to the same file.
- **F3:** referencing an outliner image/attachment into a conversation lets the
  agent `file_read` its bytes (and see images); the referenced file is the same
  format the agent sees for its own outputs.
- **F4:** "Insert into outliner" on a conversation file creates an image/attachment
  node whose `assetId` resolves and renders via `asset://`, identical to a
  user-added file; later edits to the working file do not change the saved node.
- Outliner attachment behavior is otherwise unchanged; specs describe the
  path-for-agent / handle-for-document split and the two bridges.
