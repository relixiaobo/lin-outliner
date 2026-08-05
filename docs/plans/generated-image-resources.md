# Unified image artifacts with tiered renditions

## Goal

Give every image that enters Agent history one stable logical identity while
keeping source-quality bytes separate from the bounded image sent to chat
models.

The complete feature must:

- represent generated images, user image attachments, and dynamic-tool images
  with the same immutable `artifactRef`;
- create a bounded `observation` immediately when an image is admitted;
- send only the observation bytes to chat models and history reconstruction;
- prefer an available original for image editing, Preview, copy, and export;
- preserve a stable materialized path when an owned original is replaced by its
  observation;
- degrade missing renditions to an unavailable image without killing a Turn,
  fork, or inherited-context copy; and
- reclaim generated originals before observations under storage pressure,
  rather than deleting every image on a seven-day timer.

## Non-goals

- A user-facing image library or document-asset replacement.
- Mutation of persisted Thread Items when a rendition is reclaimed.
- A compatibility reader for the pre-release `promptImage` or generated-image
  scratch-path shapes.
- Provider-specific image size, quality, format, or aspect-ratio redesign.
- Lossless recovery after both renditions and an external source disappear.

## Shape

**(a) One complete feature in one PR.** The protocol, admission paths, history
projection, file materialization, retention policy, UI resolution, tests, and
current-behavior specs ship together.

## Design

### 1. One immutable reference names every image

Canonical history stores an immutable image artifact reference:

```text
ImageArtifactReference
  id
  createdAt
  retention: external | durable | tiered | observationOnly
  original: localFile | threadPayload | null
  observation: threadPayload
  geometry: source size, observation size, observation-to-source matrix
```

`id` is a SHA-256 identity derived from the immutable reference fields. A
rendition is itself an existing content-addressed `ThreadResourceReference`.
The reference never changes after admission; availability is determined by
resolving its renditions.

`geometry` uses one affine matrix to map observation pixel coordinates back to
the admitted source pixel plane. The current normalizer performs only
aspect-preserving resize, but the matrix also represents future crop, padding,
and rotation without changing the artifact contract.

The four retention classes mean:

- `external`: the original remains owned by the user or workspace. Tenon never
  deletes it and owns only the observation.
- `durable`: Tenon owns a pathless user upload and retains its original for the
  Thread lifetime.
- `tiered`: Tenon owns a generated original that storage pressure may reclaim.
- `observationOnly`: the source emitted only provider-visible pixels, such as a
  screenshot or rendered page, so the observation is the only rendition.

Image attachments retain their ordinary file source for file semantics and add
an `artifactRef`. Dynamic-tool image content stores only its `artifactRef` and
optional alt text. Paths remain access handles, never artifact identity.

### 2. Observation is created at ingress

Every image ingress normalizes an observation to the existing model boundary:
at most 2000 px on either edge and at most 4.5 MiB. Admission is complete only
after the observation is durably content-addressed.

- A local user image becomes `external`.
- A pathless managed user image becomes `durable`.
- A generated provider image stores the source bytes as a `tiered` original,
  then creates its observation from those bytes.
- A dynamic-tool image with a trusted local source becomes `external`.
- Other dynamic-tool image bytes become `observationOnly`.

Generated originals use the Thread resource store directly and are not subject
to the generic 10 MiB tool-observation limit. Source admission retains the 256
MiB decode safety boundary. If observation creation fails, the output is not
admitted as an image artifact and any newly written unreferenced resource is
reclaimed by normal Turn cleanup.

### 3. Consumers select a rendition by purpose

Chat-model projection always reads `observation`. Missing or corrupt observation
bytes produce a textual unavailable marker and projection continues.
The adjacent identity text includes source size, observation size, both derived
source-per-observation scale factors, and the full observation-to-source matrix.
The model therefore has enough information to relate positions in the bounded
observation to the admitted source-image pixel plane and diagnose scaling mistakes.
The artifact layer does not inspect, validate, convert, or rewrite later tool
arguments. Any coordinate semantics beyond this image-to-image transform belong to
the tool that consumes them.

Preview, copy, export, and image-edit input resolve the best currently available
rendition in this order:

1. original;
2. observation;
3. unavailable.

Managed images materialize outside the private payload store under a stable
Thread-and-artifact path. The path is keyed by artifact identity, not rendition
identity. Re-materializing after original reclamation therefore puts observation
bytes at the same logical path. Materializations remain disposable scratch and
can be recreated from the retained rendition.

The generated-image result returns `artifactId` as identity and a current
readable path as an access hint. Persisted slim details retain the artifact
reference and image metadata, not the path.

### 4. Missing renditions are expected runtime state

The intended lifecycle is:

```text
FULL -> OBSERVATION_ONLY -> UNAVAILABLE
```

Canonical Items and artifact references remain immutable through each state.
Resource enumeration retains references for garbage collection, but fork and
inherited-context copying treat artifact rendition bytes as optional: available
renditions are copied and missing ones are skipped. Ordinary non-image managed
resources remain required.

An externally deleted local original falls back to observation. A missing
observation means the chat model cannot inspect the image; it does not invalidate
the surrounding user message, tool result, Thread, or fork.

### 5. Pressure-based retention replaces image TTL

Artifact renditions live in durable Thread resources. Seven-day scratch cleanup
applies only to reproducible materialized copies, never to the canonical original
or observation.

Per Thread, image retention uses the existing 8 GiB hard resource budget plus
two earlier watermarks:

- below 5 GiB: retain all renditions;
- above the 6 GiB soft watermark: reclaim least-recently-used, then largest,
  `tiered` originals older than 30 days until usage returns to 5 GiB;
- when an incoming write would exceed 8 GiB: reclaim `tiered` originals regardless
  of age, then least-recently-used observations, until the write fits;
- never reclaim `external` files or `durable` originals automatically.

Artifact materialization records rendition access for LRU ordering. Hard-pressure
reclamation may remove a recent observation only to avoid making all Thread
storage unwritable. If protected durable data alone exhausts the budget, the new
write fails with the existing typed quota error.

### 6. Cleanup and ownership stay transactional

New original and observation resources join the active Turn's created-resource
set. A completed canonical Item makes them reachable; failure or cancellation
removes unreferenced writes. Rollback and startup reconciliation retain all
referenced rendition keys even when a particular file is already absent.

Thread deletion removes owned originals, observations, and disposable
materializations. External source files are never touched.

## Open questions

None.

## Collision self-check

PR #483 changes `PiTurnExecutor`, `ContextProjector`, runtime context, and Turn
lifecycle wiring. This PR lands after #483 and rebases again before final
validation. Other open PR claims do not overlap the image-artifact protocol or
retention implementation.

## Build order

1. Add the immutable artifact protocol, codec, and dependency enumeration.
2. Admit user attachments and dynamic-tool images through the common shape.
3. Store generated originals and their observations as one tiered artifact.
4. Resolve stable best-rendition paths for model tools, Preview, copy, and export.
5. Make history, fork, and inherited-context handling tolerate missing renditions.
6. Add pressure-based reclamation and focused lifecycle tests.
7. Fold shipped behavior into the Agent specs and run the full verification set.
