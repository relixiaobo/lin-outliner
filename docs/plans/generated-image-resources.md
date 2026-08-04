# Generated images as durable Thread resources

## Goal

`generate_image` writes its bytes straight into the agent scratch root and hands
the model a path relative to a root the model is never told about. One cause,
three observed consequences:

- **The model never sees its own output.** The tool returns only JSON. Unlike
  `file_read`, which passes the decoded image as tool-result `extraContent`
  (`agentLocalTools.ts:922-926`), `generate_image` passes none — every
  `agentToolResult` call in `agentImageGenerationTool.ts` stops at two arguments.
  A real session's persisted Item carries `contentItems: [text, json]` and no
  image. The model reasons about a picture it cannot look at.
- **The model cannot act on its own output.** "Generate an image and put it in
  the Downloads folder" fails. `file_write` is text-only; `file_read` and `bash`
  both resolve relative paths against the workdir (`agentLocalTools.ts:1850`,
  `:3314`), not scratch, and `agentLocalTools.ts` does not know the
  `generated-images` prefix at all. `turnEnvironment` tells the model only
  `workingDirectory`. It can sometimes stumble into `../agent-scratch/…` because
  the two roots happen to be siblings — worse than failing, because that dies
  silently the moment `LIN_AGENT_LOCAL_ROOT` moves the workdir.
- **A durable reference points into a directory declared ephemeral.** History
  persists a path and metadata, never bytes (`persistedGeneratedImage`,
  `agentToolResultPersistence.ts:64-81`); display re-reads from disk
  (`main.ts:1974`, `previewSource.ts:306`). So `pruneAgentScratch` must
  special-case `generated-images` (`agentAttachmentMaterialization.ts:97`) to
  avoid silently breaking it — even though that same file declares scratch to be
  "ephemeral, app-owned data". "Never delete" is the absence of a policy.

All three dissolve by routing the image through the tool-output image path the
executor already runs for every other producer.

## Non-goals

- **Image generation parameters.** `size` / `aspect_ratio` / `quality` are
  silently dropped per provider and the model-visible payload omits `modelId`,
  so the model cannot self-correct. Real and evidenced, but the canonical-intent
  design is not settled; folding it in here would produce a worse version of
  both.
- **A general per-Turn output root.** `docs/TASKS.md` asked for durable Thread
  resources "plus a per-Turn output root". This plan delivers the first half and
  a turn-scoped *observation* (§2), not a general output root for arbitrary tool
  artifacts. **The narrowing is deliberate**: the observation is an existing
  primitive with an existing consumer, while an output root is a new concept
  that no producer currently needs.
- **Other artifact producers.** Web-fetch downloads and PDF page images may
  deserve review; each is an independent adoption, none is a prerequisite.
- **Async/job-based providers** (Flux submit+poll, Midjourney job+grid) — an
  execution-seam change, not a storage change.
- **A dedicated "save image" tool.** Codex deliberately rejected a destination
  argument and told the model to copy the file with the ordinary shell. An
  absolute path plus one instruction line is enough.

## Shape

**(a) One complete feature in one PR.** The build order below is internal.

## Background: which mechanism, and what is actually missing

The executor already persists every tool-output image and already records the
dependency — for producers that emit an image content item:

| Need | Existing mechanism |
|---|---|
| Durable content-addressed bytes | `context.persistOutputImage(data, mimeType)` inside the `part.type === 'image'` branch (`PiTurnExecutor.ts:~1418`) |
| Dependency tracking | `itemResourceReferences` walks `dynamicToolCall.contentItems` and takes `promptImage` or `content.source.ref` (`contextDependencies.ts:28-36`) |
| Typed source | `ThreadFileSource` = `localFile \| threadPayload` (`protocol.ts:458-460`) |
| Turn-scoped filesystem path | `resolveResourceObservationPath` (`runtime/types.ts:45`), wired from the turn observation at `TurnLifecycle.ts:982` |
| Rendering | The thread UI filters `contentItems` for `type === 'image'` and renders them (`ThreadItemView.tsx:885-887`) |
| Copy into the outline | `ingestThreadResourceAsset` (`threadResourceAssetIngest.ts:18`, wired `main.ts:2663`), reached from `ingestPreviewTargetToAsset` when a target carries a `resourceRef` |

**None of it runs for `generate_image`, because there is no image part to
trigger it.** The bytes are *not* in the payload store today. `toolImagePath`
has a `generate_image` branch (`PiTurnExecutor.ts:1490-1493`) that reads
`details.data.images[i].path`, but it is only consulted from inside the
`part.type === 'image'` branch — so it is **unreachable**. It reads as evidence
that images were once meant to flow as content items and the tool never started
doing so.

So this plan adds no storage mechanism and no protocol field. It makes one
producer emit what every other producer emits.

## Design

### 1. The producer emits an image content item, and stops writing scratch

`generate_image` passes the decoded bytes as `extraContent`, exactly as
`file_read` does. The executor's existing branch then persists them via
`persistOutputImage` and records `{ kind: 'threadPayload', ref }`.

Two deletions make that the outcome rather than a second copy:

- `writeGeneratedImage`'s `writeFile` into `<scratchRoot>/generated-images/…`,
  and with it `src/main/generatedImagePaths.ts`.
- `toolImagePath`'s dead `generate_image` branch. Left in place *and* fed a path,
  it would select `localFile` and re-persist the very split this plan removes.

Consequences worth stating because they are free: dependency tracking flows
through `contentItems`, so **no `resourceRefs` on tool items and no
`protocol.ts` / `codec.ts` change** — `resourceRefs` exists only on
`ContextEvidenceThreadItem` (`protocol.ts:994`) and
`ContextCompactionThreadItem` (`:1013`), and adding it to tool items would
collide with #483 for no benefit. Reachability GC, fork copying, and
post-deletion readability all apply because they key on the same walk.

`image_paths` resolves an input reference through the payload store instead of
`resolveGeneratedImageReadPath`.

### 2. The model gets an absolute, copyable path

The tool result carries an absolute path from
`resolveResourceObservationPath` — the turn-scoped observation, not a canonical
payload path, which stays private to the store.

This is a shipped pattern, not a new one: `ContextProjector.ts:595-604` resolves
document assets through the same call and emits `readable_path=<path>` into the
context block. Generated images get the same treatment.

Two neighbouring primitives are deliberately **not** used:
`resolveThreadResourceFile` (`ThreadResourceOps.ts:247-251`) and
`readReferencedThreadResource` (`:169-174`) both gate on the ref already being
referenced by a committed Item, which during the producing call it is not — they
return `null`. `useThreadResourcePath` is callback-scoped, so the path carries no
guarantee once `use` returns, which is the one property the model needs.

### 3. Instructions say what to do with it

> Generated images are saved to `<dir>` as `<path>` by default. If you need a
> generated image at another path, copy it and leave the original in place
> unless the user explicitly asks you to delete it. The image is already shown
> to the user; there is no need to render it again in the final answer.

The last sentence is now true rather than aspirational: the UI renders the image
content item.

Placement policy beyond that — project-bound assets belong in the workspace,
preview-only images can stay put, never overwrite an existing asset — is skill
material, not tool material.

### 4. Admission caps fail closed

An image can exceed `MAX_PERSISTED_TOOL_OUTPUT_IMAGES`, the per-call byte cap, or
the thread resource quota (`PiTurnExecutor.ts:1399-1424`). Today it is dropped
from `contentItems` while the scratch copy and its path survive, so the user
still sees something. Delete the scratch write and that consolation disappears:
an over-quota image would have no durable copy and no path.

**The tool call fails with a typed error naming the cap that was hit**, carrying
the same `instructions` shape the tool already uses for provider errors. Not a
scratch fallback — that reinstates the dual-store split this plan exists to
delete, and "the image exists, but only at a path scheduled for TTL deletion" is
precisely the failure mode being removed. Not a silent drop either.

This is A12-consistent: resource admission is a write boundary, and fail-closed
is what A12 reserves those for. The cost is real — a failed call discards a
generation that took ~56s in the observed session — so the error must say which
cap was hit and what to change (fewer images per call, or thread cleanup), so the
next attempt is informed rather than a retry in the dark.

### 5. Scratch returns to a uniform TTL

Delete the `generated-images` exemption in `pruneAgentScratch`. Every scratch
subdirectory then obeys one rule, because the durable copy lives in the payload
store and the observation is a disposable projection. **The special case
disappearing is the plan's clearest success signal.**

### 6. `markdownImage` is retired, and reference markup is untouched

The tool currently returns
`markdownImage: ![…](file:^generated-images/…)` and instructs the model to place
it verbatim. That URL resolves only through the relative-path trust channel
(`localFileReferenceSecurity.ts:69-76`, `main.ts:1966-1969`), which
resource-backed storage retires.

Nothing replaces it. The image is a content item, so the UI already renders it;
re-rendering it through a markdown link would mean inventing a resource-backed
scheme in the shared `src/core/referenceMarkup.ts` purely to display something
already displayed. Dropping `markdownImage` keeps that file out of this change
entirely.

Putting a generated image into the outline is a different act with a different
owner, and it already works: a `resourceRef`-backed target reaches
`ingestThreadResourceAsset`, which copies the bytes into the **asset store** and
creates the node. The document ends up owning what it displays, so deleting the
Thread cannot break an image living in the user's outline — the concern is
answered by inheritance, not by new code.

## Open question

**Observation lifetime across turns.** The model-visible path is turn-scoped
(`TurnLifecycle.ts:982`, disposed at `:1057`). A model copying an image
generated several turns earlier finds the path gone.

Recommendation: re-materialize on demand.
`detachedResourceObservationPath` (`ThreadResourceOps.ts:273-289`) is already
shaped as rebuild-if-missing, and content addressing makes rebuilding cheap. The
alternative — accept turn-scoped — leaves the model with a failure it cannot
diagnose, which is the class of defect this plan is removing.

## Collision self-check

`gh pr list`: #488 (`cc-2/settings-redesign`), #485
(`cc/unified-command-surface`), #483
(`codex-3/agent-canonical-tool-call-history`), #480
(`main-agent/release-pipeline`). **No overlap.**

#483 changes the tool-call protocol/codec. Routing through `contentItems` means
this plan touches neither `protocol.ts` nor `codec.ts`, and §6 keeps
`src/core/referenceMarkup.ts` out as well — so the only shared-surface contact is
`PiTurnExecutor`'s tool-output image branch. Land after #483 or rebase onto it.

`docs/TASKS.md` has no active item for generated-image storage. It carries the
ruling this answers: closing `agent-browser-control` as `superseded` recorded
that "turning tool artifacts … into durable Thread resources readable by
`file_read` and pruned by the resource system" was the one piece that never got
built, is not obsolete, is not browser-specific, and should be boarded
tool-agnostically.

## Build order

1. `generate_image` emits the image as `extraContent`; delete the scratch write
   and `generatedImagePaths.ts`; delete `toolImagePath`'s `generate_image`
   branch.
2. `image_paths` resolves inputs through the payload store.
3. The tool result carries the `resolveResourceObservationPath` absolute path and
   the copy instruction; `markdownImage` is removed.
4. Typed admission-cap failure replaces the silent drop.
5. Delete the `pruneAgentScratch` exemption.
6. Fold into `docs/spec/agent-core.md` (generated images join managed tool
   images) and `docs/spec/agent-tool-design.md`.
