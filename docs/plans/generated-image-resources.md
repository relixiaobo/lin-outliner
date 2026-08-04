# Generated images as file-backed artifacts with bounded previews

## Goal

Make every successful `generate_image` result immediately usable without making
model-input limits decide whether the original artifact survives.

The tool must:

- save the provider's original bytes before attempting model observation;
- return an absolute path that ordinary local tools can copy or edit;
- show the model a bounded preview while the Thread UI addresses the saved local
  original;
- retain file-like history semantics: a saved path may later disappear, and that
  loss degrades the image operation rather than invalidating the Thread; and
- keep large outputs, including ordinary 4K PNGs, out of the 10 MiB generic
  tool-image admission trap.

## Non-goals

- A permanent user-facing gallery or export destination. Generated files remain
  app-owned scratch artifacts until the model copies them to a requested path or
  the user ingests them into the document asset store.
- A new resource protocol. The existing dynamic-tool `localFile + promptImage`
  shape already separates a file identity from the exact bounded image shown to
  the model.
- Provider option redesign. Provider-specific `size`, `quality`, format, and
  aspect-ratio behavior remains unchanged.
- Long-term availability of a generated-file path. A path is a weak reference,
  just like any other local file reference.
- Compatibility readers for the old relative `generated-images/...` and
  `markdownImage` forms. This pre-release change keeps no legacy path channel.

## Shape

**(a) One complete feature in one PR.** Original persistence, bounded preview,
history projection, cleanup, and documentation land together.

## Design

### 1. Original bytes and model observation are separate artifacts

The provider returns base64 image data. Per output, `generate_image` performs
these operations in order:

1. validate the image MIME and base64 payload against the existing 256 MiB image
   source safety boundary;
2. decode and write the original bytes under
   `<scratchRoot>/generated-images/<turn>/...`;
3. return the absolute path and original metadata in `data.images`; and
4. independently ask the host image normalizer for a bounded model preview.

The original write is not subject to the generic 10 MiB per-image or 20 MiB
per-call tool-output limits. Those limits protect persisted provider-visible
image content, not source artifacts. A detailed 4K PNG may therefore remain at
its full resolution even when its preview must be resized or recompressed.

The existing normalizer constrains previews to at most 2000 px per edge and 4.5
MiB. At most four generated outputs are requested, so their previews also fit
the generic 20 MiB per-call tool-output budget by construction.

Original-write failure omits only that output and records a warning. Preview
failure does not remove a successfully written original: the result keeps its
path and reports that model/UI observation is unavailable. Provider indexes are
one-based and never compacted, so partial results cannot make the model select a
different image than the user named.

### 2. Existing dynamic-tool image semantics carry the preview

Each successful preview is emitted as image `extraContent`. The event normalizer
persists that bounded preview through the ordinary tool-output image admission
path and records:

```text
source      = { kind: "localFile", path: <absolute original path> }
promptImage = <Thread resource reference for the bounded preview>
```

This is the same shape used by `file_read`: the local path identifies the
operable source, while `promptImage` reproduces exactly what the provider saw.
No original image is duplicated into the Thread resource store. The Thread UI
previews and ingests the trusted local source, so adding the result to the
outline preserves the original resolution rather than the model snapshot.

Because an original may survive while its preview fails, each returned image
with a preview records its compact image-content index for normalization. The
normalizer resolves a content item to the matching original path by that index,
not by indexing the possibly sparse provider-result array.

The generic image admission remains responsible for preview count, base64,
MIME, per-image, per-call, and Thread-quota limits. A typed
`ThreadResourceQuotaError`, including filesystem `ENOSPC` and `EDQUOT`, degrades
preview persistence to `quotaExceeded`; unrelated storage failures retain their
identity.

### 3. Paths are weak history references

Persisted generated-image result text and slim details retain the absolute
original path, provider index, MIME, byte length, and dimensions. They do not
claim that the original is saved in the conversation.

Historical projection reads the bounded `promptImage` snapshot when it exists
and identifies its `localFile` source path. It does not copy the original into a
new per-Turn observation and does not publish a replacement `readable_path`.

If the original file has disappeared, a later file operation fails through the
ordinary local-file path just as it would for any deleted workspace file. If the
preview resource is missing or corrupt, projection emits an unavailable image
identity and continues; one missing image never blocks the Thread.

### 4. Scratch cleanup is uniform

Generated originals are app-owned scratch artifacts, not durable conversation
resources. The `generated-images` directory follows the existing seven-day
scratch TTL with no exemption. The absolute path remains usable across Turns
until ordinary cleanup or external deletion removes it.

The old relative-path trust channel, generated-image path resolver, Preview
fallback, and `markdownImage` value remain deleted. The model receives an
absolute path directly, so `bash`, `file_read`, and later `image_paths` calls need
no special resolver.

### 5. Instructions state the ownership boundary

The result tells the model that returned paths are local scratch files and may
expire. When the user names a destination, the model copies the original there
in the same Turn. The generated local images are already rendered by the Thread
UI, so the model does not repeat them through Markdown.

Ingesting a generated image into the outline remains a separate operation. Once
ingested, the document asset store owns its copy; subsequent scratch cleanup does
not affect the outline asset.

## Open questions

None.

## Collision self-check

PR #483 changes `PiTurnExecutor`, `ContextProjector`, runtime context, and Turn
lifecycle wiring. This PR lands after #483 and rebases before final validation.
The other open PR claims do not overlap the generated-image runtime, scratch
cleanup, or focused tests.

## Build order

1. Restore absolute original-file writes under uniformly pruned scratch.
2. Normalize and emit bounded previews independently of original persistence.
3. Associate preview content with its sparse original result by explicit index.
4. Persist weak paths and remove generated-image history rematerialization.
5. Keep missing preview resources degradable and retain typed quota handling.
6. Update focused tests and fold the final behavior into the agent specs.
