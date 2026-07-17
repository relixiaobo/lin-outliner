# Persistent Preview Translation Cache

## Goal

- **OBJ-1:** Let readers reopen an unchanged webpage, prerecorded caption
  track, or reflowable EPUB and recover previously translated passages without
  waiting for or paying for the provider again.
- Preserve the current viewport-first experience: cached passages settle
  immediately, uncached passages retain their local loading/retry states, and
  prefetch remains bounded rather than expanding to the whole source.
- Treat saved translations as local, disposable derived data owned by Electron
  main, never as workspace facts or renderer-owned state.
- Ship as shape **(a)**: one complete feature in one PR, including persistence,
  all three existing translation surfaces, cache clearing, specifications, and
  verification.

The minimum acceptable outcome is that restarting Tenon and reopening the same
source under the same translation configuration restores the current viewport
from cache, while a cache miss behaves exactly like translation does today.

## Non-goals

- Translation history, search, editing, glossary management, export, sharing,
  synchronization, backup portability, or cross-device cache transfer.
- A global translation-memory system that reuses text across unrelated pages,
  books, videos, users, or source identities.
- Eager whole-page, whole-transcript, or whole-book translation.
- PDF, Markdown, HTML, plain-text, Office, local-video, OCR, or speech
  translation.
- Persisting pending work, errors, retry state, provider diagnostics, source
  text, source URLs, local paths, or provider credentials.
- Changing translation prompts, language detection, batching, concurrency,
  retry limits, automatic-translation consent, or bilingual presentation.
- A cache enable/disable switch in the translation popover. Persistence is the
  default behavior; Settings provides an explicit global clear action.

## Design

### Product Decisions And Constraints

- **DEC-1 — Automatic local persistence:** every validated successful result
  from the existing translation command is eligible for caching. This includes
  unchanged output used as a successful same-language no-op, so an undeclared
  same-language passage does not repeatedly call the provider. Failures,
  cancellations, malformed output, and pending state are never cached.
- **DEC-2 — All existing surfaces:** URL page blocks, finite prerecorded URL
  captions, and reflowable EPUB blocks use the same main-owned cache. Their
  automatic-translation preferences remain separate and default off; cache
  lookup never activates translation by itself.
- **DEC-3 — Configuration fidelity:** cache identity includes target language,
  content kind, translation-prompt revision, and the actual resolved
  provider/model. `Follow Agent` therefore follows Neva's current resolved
  model; changing that model selects a different cache namespace. An explicit
  model uses its provider-qualified identity. Switching back to a prior
  target/model may recover its prior cache.
- **DEC-4 — Local derived data:** the cache lives under the isolated Electron
  `userData` root with private file/directory modes. It is excluded from the
  workspace document, replication, portable assets, diagnostics, and exports.
  Loss or corruption degrades to an ordinary cache miss and must never block
  translation.
- **DEC-5 — Bounded retention:** retain the most recently used valid entries
  without a fixed time expiry, capped by both logical bytes and entry count.
  The implementation target is 64 MiB and 50,000 entries; crossing either
  bound evicts least-recently-used entries before the next durable flush.

Hard constraints are the existing main/renderer/preload boundary, URL Preview
isolated-world collection, bounded request validation, inert text insertion,
secret-safe diagnostics, and current provider-consent rules. The selected
brownfield design adds a cache around the existing request path rather than
creating a second translation pipeline.

### Cache Identity

Every surface supplies a bounded source scope and a stable per-block key to the
trusted renderer controller:

- URL pages use the normalized top-level URL without its fragment plus a key
  derived from normalized block text. Query parameters remain part of the
  scope, favoring correctness over reuse across tracking variants.
- Captions add the adapter/video/track identity and use cue timing plus
  normalized cue text, so track replacement or video navigation cannot attach
  old output to a new timeline.
- EPUB uses the resolved preview-source identity, size/modified fingerprint,
  section identity, semantic ordinal, and normalized source-text fingerprint.
  A replaced local file or changed section therefore misses safely.

Main canonicalizes and hashes the complete identity together with target,
resolved model, content kind, and prompt revision. The persisted key is opaque;
the store retains only that digest, validated translated text, and recency
metadata. Source text, URL, local path, and model configuration are not written
as cache metadata. All caller strings remain length-bounded and are never used
as filesystem paths.

### FLOW-1: Restore While Reading

- **Actor:** a reader who manually or automatically enables translation on a
  previously translated source.
- **Entry path:** the existing Languages control, shortcut, or automatic
  activation.
- **Mainline:** the existing scheduler selects one bounded visible or prefetch
  batch and shows its paragraph-local loading states. Main checks the batch
  against the cache before provider work. A full hit returns immediately. A
  partial hit returns the cached subset immediately; the controller applies
  those items, keeps only misses pending, and continues the same bounded work
  unit through the provider. Successful misses are validated, displayed, and
  persisted asynchronously.
- **Result:** cached paragraphs appear without a provider request and never wait
  for uncached neighbors. Misses preserve current priority, concurrency,
  preemption, retry, completion, and scroll-anchor behavior.
- **Failure/recovery:** unreadable, corrupt, unavailable, or unwritable cache
  storage behaves as an empty/best-effort cache. Translation still calls the
  provider and displays its result; a fixed, content-free diagnostic may record
  the cache failure.

The successful translation response gains an explicit partial-cache shape so a
cache hit does not wait behind a slow provider call. Controllers retain the
original block snapshots across that continuation and still reject stale
generation, source, target, model, track, and DOM identities before applying
either cached or fresh output.

### FLOW-2: Clear Saved Translations

- **Actor:** a user managing local app data.
- **Entry path:** Settings > General > Translation Data.
- **Mainline:** a `Saved translations` row provides a secondary `Clear...`
  command. A native confirmation explains that pages and books will require
  translation again and that currently visible translations and source
  documents are not removed. Confirming clears both the in-memory index and
  durable cache; canceling changes nothing.
- **Result:** Settings reports a localized success notice. Existing visible
  translations remain until their normal hide/teardown lifecycle.
- **Failure/recovery:** a clear failure leaves the prior cache usable and shows
  a localized settings error. A cache epoch prevents provider work started
  before a successful clear from repopulating deleted entries when it settles;
  work started afterward may populate the cache normally.

The translation popover receives no cache controls or status. Cache hits use
the same loading/completed/error semantics as fresh translation, avoiding a
second user-facing state model.

### Main-Owned Store And Lifecycle

A dedicated `PreviewTranslationCacheStore` owns a versioned, bounded private
directory under `userData`. Each source/configuration scope uses one opaque
digest filename, so opening a page or book loads only its small shard rather
than a global cache file. The store keeps a bounded hot-shard index, batches
recency/write updates, rewrites changed shards atomically, flushes during the
existing before-quit barrier, and evicts least-recently-used shards/entries
before persistence. Cache I/O is never on the provider result's visible-apply
critical path. Invalid entries are dropped independently; an unreadable shard
behaves as empty because every record is reproducible.

The existing main translation service remains the sole provider boundary. It
receives the cache store by dependency injection, validates cache descriptors
with the same per-block/per-batch limits, resolves the effective model, checks
for hits, and records only fully parsed responses. Renderer controllers never
receive a disk path or arbitrary cache-read API, and remote web content retains
no IPC access to either cache operation.

## Requirements And Acceptance

- **FR-1 — Immediate bounded restore.** Existing translated content can resume
  from local cache without widening the translation window.
  - **AC-1:** When Tenon restarts and the same source is translated under the
    same target, resolved model, content kind, prompt revision, and source-text
    fingerprints, cached visible blocks appear without invoking the provider.
  - **AC-2:** When a selected batch contains both hits and misses, hits are
    applied before the miss request settles, while misses retain loading and
    continue through the existing scheduler without duplicate provider calls.
  - **AC-3:** When source text, URL/video/track/book identity, target language,
    resolved model, or prompt revision changes, the mismatched entry is not
    applied; returning to a prior valid configuration can restore it.
  - **AC-4:** When a validated result equals its source text, reopening that
    unchanged block does not call the provider and does not create a visible
    translation or false completed state.
- **FR-2 — Disposable private persistence.** Cache storage is bounded and can
  fail without affecting translation correctness.
  - **AC-5:** When entry count or logical bytes crosses the configured bound,
    least-recently-used entries are evicted and the durable store remains below
    both limits after flush.
  - **AC-6:** If the store is absent, malformed, corrupt, or unwritable,
    translation proceeds as a cache miss and diagnostics contain no source or
    translated content, URL/path, model details, or provider error object.
  - **AC-7:** The persisted store uses private permissions and opaque keys and
    is absent from workspace replication, export, portable assets, and
    diagnostics payloads.
- **FR-3 — Explicit global clearing.** Users can remove saved translations from
  General settings.
  - **AC-8:** Canceling the native confirmation preserves the cache; confirming
    removes memory and disk entries, reports success, and leaves current DOM
    translations and source documents unchanged.
  - **AC-9:** A provider result whose cache epoch predates a successful clear is
    not persisted afterward; a clear failure preserves the old cache and
    reports a localized recoverable error.
- **NFR-1 — Security boundary.** Persistent caching does not widen remote or
  renderer authority.
  - **AC-10:** URL scripts cannot choose a filesystem key, query arbitrary cache
    entries, manufacture unbounded lookups, or receive cached text for a block
    that does not match the trusted source/configuration fingerprint.
- **NFR-2 — Perceived performance.** Persistence improves resume latency
  without adding main-thread stalls to normal reading.
  - **AC-11:** A hot full-batch hit completes without provider work or a durable
    write; cache writes are debounced/off-path, and a capacity-scale store probe
    verifies lookup/flush behavior before readiness.

## Files And Verification

Expected production scope:

- shared translation/cache contracts under `src/core/`
- a new main-owned cache store plus the existing translation service and main
  lifecycle wiring under `src/main/`
- preload and renderer API exposure for the bounded translation response and
  settings-only clear command
- URL guest/controller, caption identity, EPUB adapter/controller, preview
  source wiring, and translation preference UI under `src/renderer/`
- General-settings data management, English and Simplified Chinese messages,
  and current-behavior specs

Focused tests cover identity isolation, full/partial hits, no-op results,
provider bypass, cache-miss continuation, stale-response rejection, target and
resolved-model changes, URL navigation, caption track/video changes, EPUB file
replacement, restart/load, LRU byte and entry bounds, malformed/corrupt storage,
private modes, write failure degradation, clear confirmation/failure/epoch
races, and cache-safe diagnostics. Renderer tests assert that partial hits render
before a deferred provider result while misses stay loading. Electron E2E
reopens one translated URL fixture and one EPUB fixture and proves the visible
passage restores with zero additional provider requests.

Before readiness, run `bun run typecheck`, focused Core/renderer/E2E suites,
full `bun run test:core`, full `bun run test:renderer`, `bun run docs:check`,
design-system guards for the Settings row, the capacity-scale cache probe, and
`git diff --check`. Manually verify cache restore and clearing in light and dark
appearance without changing the translation popover layout.

## Open Questions

None. The PM ratified automatic persistence with a settings-only global clear
action and actual resolved-model identity for `Follow Agent` cache entries.
