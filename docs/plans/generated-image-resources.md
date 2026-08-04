# Generated images as durable Thread resources

## Goal

`generate_image` is the only tool-artifact producer that bypasses the Thread
resource system. It writes raw bytes straight into the agent scratch root and
hands the model a path relative to a root the model is never told about. Two
consequences, both observed in a real session:

- **The model cannot act on its own output.** "Generate an image and put it in
  the Downloads folder" fails. `file_write` is text-only (`content` is a string
  and it tracks encoding/line-endings), while `file_read` and `bash` both
  resolve relative paths against the workdir (`agentLocalTools.ts:1850`,
  `:3314`), not scratch — and `agentLocalTools.ts` does not know the
  `generated-images` prefix at all. The `turnEnvironment` payload tells the
  model only `workingDirectory`; the scratch root never appears in any
  model-visible context. The model can sometimes stumble into
  `../agent-scratch/...` because the two roots happen to be siblings, but that
  breaks the moment `LIN_AGENT_LOCAL_ROOT` points the workdir elsewhere.
- **A durable reference points into a directory declared ephemeral.** What
  persists in history is a path and metadata, never bytes
  (`agentToolResultPersistence.ts:64-81`); display re-reads from disk at render
  time (`main.ts:1974`, `previewSource.ts:306`). So `pruneAgentScratch` must
  special-case `generated-images` (`agentAttachmentMaterialization.ts:97`) to
  avoid silently breaking history — even though the same file declares scratch
  to be "ephemeral, app-owned data". "Never delete" is not a policy; it is the
  absence of one.

Route generated images through the Thread resource system that already exists,
so they become content-addressed, reachability-collected, fork-safe, and
reachable by the model at a real filesystem path.

## Non-goals

- **Image generation parameters.** `size` / `aspect_ratio` / `quality` are
  silently dropped per provider, and the model-visible payload omits `modelId`
  so the model cannot self-correct. Real, evidenced, and a separate plan — the
  canonical-intent design is not settled and must not be rushed into this one.
- **Other artifact producers.** Web-fetch downloads, PDF page images, and
  tool-output overflow may deserve the same treatment. Each is an independent
  adoption of the mechanism this plan exercises; none is a prerequisite for it.
  This plan is the tool-agnostic boarding `docs/TASKS.md` asked for when it
  closed `agent-browser-control`, with generated images as the first complete
  consumer.
- **Async/job-based image providers** (Flux submit+poll, Midjourney job+grid).
  They need an execution-seam change, not a storage change.
- **A dedicated "save image" tool.** Codex deliberately rejected a destination
  argument on its built-in tool and told the model to copy the file with the
  ordinary shell instead. An absolute path plus one instruction line is enough;
  a new verb is not.

## Shape

**(a) One complete feature in one PR.** The sections below are build order
within that PR, not separate releases. Exposing an absolute path before the
storage move would mean writing against a mechanism we are about to replace,
which A7 forbids.

## Background: the mechanism already exists

`docs/spec/agent-core.md` and `ThreadResourceOps` already provide everything
this plan needs. Generated images simply do not use it:

| Need | Existing mechanism |
|---|---|
| Content-addressed durable bytes | `payloads/<thread-id>/resources/<content-hash>/<safe-display-name>` |
| Write | `ThreadService.writeThreadResourceWithStatus(threadId, bytes, mimeType, fileName)` → `ThreadResourceReference` |
| Filesystem path for a consumer | `useThreadResourcePath` / `resolveThreadResourceFile` — an "independent scratch observation", canonical paths stay private to the payload store |
| Lifecycle | Item `resourceRefs` drive reachability GC: "a newly written tool image that no terminal Item references is reclaimed at Turn finalization; startup reconciliation handles crash leftovers" |
| Fork / thread deletion | Forks copy referenced payloads with a distinct inode; resources stay "readable after its source is deleted" |
| Typed provider snapshot | Dynamic tool images already carry a `localFile` or `threadPayload` source (`protocol.ts:460`) |

`AttachmentResolver` (`main.ts:517-527`) is the existing consumer to model
against. The spec already names "managed tool images" as payload-directory
residents — generated images should have been one from the start.

## Design

### 1. Generated images become Thread resources

`writeGeneratedImage` stops calling `writeFile` into
`<scratchRoot>/generated-images/...`. It calls `writeThreadResourceWithStatus`
and returns a `ThreadResourceReference`. The tool's per-turn / per-call digest
naming is replaced by content addressing, which also makes regenerating an
identical image free.

The producing Item lists the reference in `resourceRefs`, which is what makes
reachability GC, fork copying, and post-deletion readability apply without any
new code.

`generate_image`'s own `image_paths` input resolves a reference through
`readReferencedThreadResource` rather than
`resolveGeneratedImageReadPath`; `src/main/generatedImagePaths.ts` is deleted.

### 2. The model gets an absolute, copyable path

The tool result carries an **absolute** path to a Turn-scoped resource
observation, obtained through the existing scoped-path primitive. This is the
whole fix for the placement problem: the model already has `bash`, and
`resolveWorkspacePath` already documents that "absolute paths address the host
filesystem directly". Nothing needs to be sandboxed open, and canonical
resource paths stay private.

### 3. Instructions say what to do with it

Adopt Codex's wording, which is load-bearing rather than cosmetic — it tells
the model the artifact directory is append-only and that the UI has already
shown the image:

> Generated images are saved to `<dir>` as `<path>` by default. If you need a
> generated image at another path, copy it and leave the original in place
> unless the user explicitly asks you to delete it.

Placement policy beyond that (project-bound assets belong in the workspace;
preview-only images can stay put; never overwrite an existing asset) is skill
material, not tool material.

### 4. Scratch returns to a uniform TTL

Delete the `generated-images` exemption in `pruneAgentScratch`. Every scratch
subdirectory then obeys the same TTL, because the durable copy lives in the
resource store and the scratch observation is a disposable projection. This
deletion is the plan's clearest success signal: the special case disappears
rather than being worked around.

### 5. Durable references

History stops persisting a scratch-relative filesystem path and persists the
resource reference instead. Rendering resolves through the payload store.
Deleting the local copy the user dragged to `~/Downloads` no longer affects
anything the app displays.

## Open questions

1. **A generated image referenced from an outline Node.** Resource GC keys on
   Item-graph reachability. A `file:^…` reference written into a Node is
   reachable from the *document*, which the GC does not know about, so deleting
   the Thread would break an image living in the user's outline. Nothing
   prevents this today. Three candidates: extend GC reachability to document
   references; copy into a workspace-owned location at the moment a reference
   enters a Node; or forbid raw resource references in Nodes and require an
   explicit materialization. Recommendation: the second — it keeps GC's
   reachability rule intact and makes the document own what it displays — but
   this is directional and wants a ruling before code.
2. **Turn-scoped observation lifetime.** The model-visible copy is Turn-scoped
   and reclaimed by scratch TTL. A model that tries to copy an image generated
   several turns earlier finds the path gone. Re-materialize on demand, or
   accept turn-scoped and let the model regenerate the observation? Leaning
   re-materialize: content addressing makes it cheap and it removes a failure
   mode the model cannot diagnose.
3. **Reference markup.** `formatLocalFileReferenceUrl` is path-based
   (`file:^<path>`). A resource-backed image wants a reference the payload store
   resolves. Whether that is a new scheme or a reinterpretation of the existing
   one touches `src/core/referenceMarkup.ts`, a shared surface — worth settling
   before implementation and worth announcing on the PR.

## Collision self-check

`gh pr list` shows four open PRs: #488 (`cc-2/settings-redesign`), #485
(`cc/unified-command-surface`), #483
(`codex-3/agent-canonical-tool-call-history`), #480
(`main-agent/release-pipeline`). **No overlap on the files this plan touches.**

The one to watch is #483: it changes the Agent Core tool-call protocol/codec and
context payload handling. This plan changes what a tool result *carries*
(a resource reference instead of a path), not the tool-call envelope shape, but
it should land after #483 or rebase onto it.

`docs/TASKS.md` has no active item for generated-image storage. It does carry
the ruling this plan answers: when `agent-browser-control` was closed as
`superseded`, the board recorded that "turning tool artifacts … into durable
Thread resources readable by `file_read` and pruned by the resource system" was
the one piece that never got built, is not obsolete, is not browser-specific,
and should be boarded tool-agnostically.

## Build order

1. Generated images write through `writeThreadResourceWithStatus`; the producing
   Item carries `resourceRefs`; `generatedImagePaths.ts` is deleted.
2. `image_paths` resolves references through the payload store.
3. The tool result carries an absolute Turn-scoped observation path plus the
   copy instruction.
4. Persistence and rendering move from path to resource reference.
5. The `pruneAgentScratch` exemption is deleted; scratch TTL becomes uniform.
6. Fold the design into `docs/spec/agent-core.md` (managed tool images now
   include generated images) and `docs/spec/agent-tool-design.md`.
