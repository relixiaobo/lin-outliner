# EPUB Bilingual Translation

This is shape **(a): one complete feature in one PR**. The PR extends the
existing preview translation workflow to reflowable EPUB books without making
the whole book eager or broadening website auto-translation consent to local
files.

## Goal

- Translate readable EPUB text in the existing file preview with the shared
  target language, translation model, loading/retry interaction, and scoped
  `Option+A` / `Alt+A` shortcut.
- Keep source text visible and insert an inert plain-text translation directly
  after each eligible semantic block.
- Translate the current reading viewport first, prefetch a bounded window in
  both directions, and never submit an entire book eagerly.
- Keep normal sequential reading ahead of the user's eyes with the same
  deadline-driven coverage, batching, concurrency, and recovery policy in EPUB
  and URL preview translation.
- Preserve the reader's position while injected translations change section
  and iframe heights.
- Let image-heavy EPUBs use the existing trusted preview stream instead of
  failing at the generic 20 MiB binary IPC limit.
- Skip blocks whose declared EPUB, section, or nearest element language already
  matches the target language.
- Send local book text to a configured provider only after manual translation
  or a separately remembered, explicit EPUB auto-translation opt-in.

## Non-goals

- Fixed-layout, comic, scanned, DRM-protected, or otherwise non-reflowable
  publications.
- PDF, HTML, Markdown, Office, audio, or video translation.
- OCR, speech recognition, translation editing, annotations, glossary
  management, manual source-language selection, export, usage accounting, or a
  persistent cross-session translation cache.
- A translation control in the compact inline outliner preview. Translation is
  available from the EPUB file panel and dedicated reader, where the existing
  header control has a stable home.
- Executing model-produced markup or weakening the EPUB iframe sandbox/CSP.
- Unbounded EPUB package loading or changing limits for other preview formats.

## Design

### Unified controls and privacy boundary

An eligible EPUB file panel exposes the existing `Languages` header control in
both the file-node page and dedicated reader. It reuses the globally remembered
target language and `Follow Agent` or explicit translation model. The command
remains Translate / Show original, and the stable header glyph uses the same
off, starting, idle, completed, and partial-error presentation as URL preview
translation.

EPUB automatic translation is a distinct, globally remembered opt-in that
defaults off. Enabling automatic website translation must not silently send
local book text to a model. When EPUB auto-translation is enabled, a valid book
metadata language or loaded section language that differs from the target
activates translation. Missing, invalid, or same-target metadata remains manual.
Turning the preference off does not hide translations already visible in the
current book.

`Option+A` on macOS and `Alt+A` elsewhere toggles translation only for the
active supported preview. It works while focus is in host chrome or inside an
EPUB section iframe. Show original hides injected translations, removes
transient loading/error controls, cancels queued work, and retains completed
translations for the mounted book session. Re-enabling restores cached results
without another provider call.

### Book package loading

Asset and trusted-local EPUBs load from a main-validated internal stream URL
rather than copying the whole package through `preview_read_bytes`. Stable
`asset://` ids remain unavailable to cross-origin Fetch; EPUB assets receive an
opaque, bounded-registry `preview-local://` UUID token registered only in the
app's default session, while the remote URL-preview partition has no handler.
The renderer requests a bounded range, validates response and Blob size against
a 128 MiB compressed-package limit, and aborts the fetch when the preview
changes or unmounts. `foliate-js` still receives the complete `File` its ZIP
loader requires; its lazy section mounting continues to bound live document
work after the package opens. Sources without a stream URL retain the generic
bounded byte-read fallback. The foliate module and package transfer start in
parallel, and a book that finishes parsing after unmount is destroyed
immediately.

### EPUB document adapter

The renderer owns a private EPUB translation adapter over the existing
same-origin, sandboxed `blob:` section documents. Each loaded section registers
its document and frame with a book-scoped controller. The adapter discovers
headings, paragraphs, list items, quotations, captions, table cells, definition
items, and necessary leaf-most block containers while excluding scripts,
styles, navigation, code/preformatted content, form/editable content, hidden
subtrees, and Tenon-owned nodes.

Records use stable book-session ids derived from section identity, semantic DOM
position, and normalized source text. A lazy section unload/remount therefore
reattaches cached translation state, while changed text receives a fresh id and
cannot accept an old response. The nearest valid `lang` / `xml:lang`, then the
section root, then validated book metadata is the source-language hint. Matching
target-language blocks receive no loader and no provider request.

Every submitted source block immediately gets the existing fixed-size inline
loading control. Successful output is inserted with `textContent` only. Failure
turns that block's loader into a keyboard- and pointer-operable retry control.
Unchanged model output does not create a translation node or a false completed
header state.

### Viewport scheduler and anchoring

The user-visible coverage unit is the complete reading viewport, the result and
failure unit is one semantic block, and the provider-efficiency unit is a
dynamic batch. A request limit must never define how much of the current screen
receives feedback. On activation, scroll, remount, or content mutation, every
eligible visible block immediately becomes translated, queued/loading, or an
explicit local error. The dispatcher then drains visible work before selecting
prefetch work.

Both URL and EPUB translation use one shared scheduling policy. All work uses a
priority queue: visible blocks, predicted reading-direction blocks, then a
smaller opposite-direction buffer. There are no reserved visible or prefetch
slots. The work-conserving pool may use one through six requests according to
the coverage deficit; visible work can use the whole pool and preempt the
farthest request that no longer contains visible content. Batches settle
independently and apply as soon as each response arrives.

Visible batches favor latency and contain at most eight blocks or about 2,000
source characters. Prefetch batches favor throughput and contain at most
sixteen blocks or 4,000 characters. Contiguous short passages therefore share
context without making the current screen wait for one large response. The
main-owned validator enforces the same sixteen-block and character ceilings,
and the isolated URL guest may describe at most six active batches to trusted
host code. The main service's global safety ceiling covers one complete pool for
each of the workspace's four possible panes.

The lookahead is time-based rather than a fixed block or viewport count. Each
surface tracks smoothed reading direction and viewport velocity; the controller
tracks recent request latency. Their product plus a safety margin determines a
bounded window, with a floor for stationary reading and a ceiling of about eight
viewports. Before direction is known the floor is symmetric. EPUB translation
temporarily expands lazy section mounting to that same maximum window while it
is enabled. A resize observer keeps that margin aligned with the live reader
height across pane resizing and summary/full transitions, then the reader retains
its mount-once behavior; it never mounts the whole spine.

Scheduling is event-driven. EPUB scroll, section registration, mutation, and
retry events wake its controller directly. The sandboxed URL runtime increments
a bounded work revision and resolves a trusted, timeout-bounded wait command;
the host still validates and selects every batch, so a remote page cannot submit
arbitrary text or enlarge limits. A low-frequency timeout is only a recovery
probe, not the normal scheduling path.

Before loading/status/translation DOM writes, the adapter captures the first
visible source block and its viewport offset. It batches writes, asks the
existing EPUB measurement path to resize affected frames, and compensates the
outer scrollport over bounded animation frames. Wheel, touch, keyboard, or
native scrollbar movement invalidates delayed compensation so translation
layout work never reverses user input.

### Failure isolation and recovery

Provider transport failures, rate limits, and server errors retry inside the
main-owned request while the affected blocks remain loading. Retries are
abortable, honor a bounded `Retry-After` when available, and use short
exponential backoff with jitter. Authentication, unavailable-model, and other
configuration failures do not retry.

After automatic retries are exhausted, only that batch becomes an accessible
local error. Other active and queued batches continue; an offscreen failure can
never freeze the document. Clicking an error prioritizes only that failed work.
If a failed source disappears, the trusted surface reconciles the header state
instead of retaining an orphaned error.
Successful requests restore normal pool capacity, while terminal provider
failures temporarily reduce new concurrency so a broad outage cannot turn the
whole lookahead window into errors. Configuration failures block new provider
work until configuration changes or the user explicitly retries, but preserve
completed translations.

### Lifecycle and provider boundary

The existing main-owned translation service remains the only model boundary.
EPUB requests use document-specific prompt context under the same validated
sixteen-block, per-block, per-batch, output, model-selection, cancellation,
retry, and secret-safe diagnostic limits as page translation.

Changing target language or model cancels book-local requests, clears results
for the old configuration, and restarts the current viewport when translation
is still enabled. Changing the resolved book destroys the old controller and
cache. Closing the pane cancels active work. A late response must match the
current book generation, section, source fingerprint, request id, and target
configuration before it can update the DOM.

## Requirements And Acceptance

- **FR-1 — Reader controls.** Eligible EPUB file panels expose the shared
  translation control, language/model choices, and scoped shortcut.
  - **AC-1:** When a reflowable EPUB resolves in a file-node page or dedicated
    reader, its header shows the Languages control with the same off, loading,
    completed, and error semantics as URL translation.
  - **AC-2:** When focus is in EPUB content and the user presses the platform
    shortcut, only the active preview toggles translation.
- **FR-2 — Explicit local-content consent.** EPUB automatic translation is
  independent from website automatic translation and defaults off.
  - **AC-3:** If website automatic translation is enabled but EPUB automatic
    translation is not, opening a foreign-language EPUB sends no book text
    until the user chooses Translate.
  - **AC-4:** When EPUB automatic translation is enabled and valid book or
    section language metadata differs from the target, the current reading
    window begins translating; missing or same-target metadata remains idle.
- **FR-3 — Bounded bidirectional scheduling.** Translation follows the reading
  viewport without eagerly traversing the book.
  - **AC-5:** When translation starts or lands on a dense viewport, every
    eligible visible block immediately shows cached output or loading; visible
    batches contain at most eight blocks / 2,000 characters, may use the whole
    six-request pool, and settle independently.
  - **AC-6:** When the reader scrolls down or up into an untranslated section,
    newly visible work preempts obsolete distant work, while latency- and
    velocity-derived prefetch stays bounded and sections outside the maximum
    lazy window remain unloaded and unsent.
- **FR-4 — Stable bilingual presentation.** Source text remains authoritative
  while plain-text translations and local recovery state are added in place.
  - **AC-7:** When a submitted block succeeds, its loader disappears and its
    translation appears after the source; when it fails, the loader becomes an
    accessible retry control that retries only affected work without pausing
    unrelated visible or prefetch translation.
  - **AC-8:** If a model returns unchanged text or the source record is stale,
    no translation node is inserted and the header does not claim completion
    from that result.
  - **AC-9:** When Show original is chosen and translation is later re-enabled
    in the same book/configuration, completed blocks reappear without another
    provider request.
- **FR-5 — Lifecycle and reading-position integrity.** Configuration, lazy
  section, and layout changes cannot apply stale output or reverse user input.
  - **AC-10:** When the target, model, resolved book, section text, or request
    generation changes, any late result from the previous identity is ignored.
  - **AC-11:** When translations resize section iframes, the visible source
    anchor stays at its prior viewport offset; a wheel, touch, keyboard, or
    scrollbar movement cancels delayed compensation.
- **NFR-1 — Privacy and security.** Only bounded eligible text reaches the
  configured provider, and output is inert.
  - **AC-12:** The implementation never sends an unvisited whole-book
    transcript, executes EPUB or model-produced script/markup, or inserts model
    output with an HTML parsing API.
- **NFR-2 — Bounded package loading.** Common image-heavy EPUBs do not inherit
  the generic binary IPC limit.
  - **AC-13:** A 29 MiB asset or trusted-local EPUB opens through its internal
    stream without calling `preview_read_bytes`; a package above the EPUB limit
    is rejected before its full body is buffered.

## Files And Verification

Expected production scope:

- `src/core/urlPageTranslation.ts`
- `src/main/pageTranslation.ts`
- `src/main/appPreferences.ts`
- `src/main/localFilePreviewStream.ts`
- `src/main/main.ts`
- `src/main/previewSource.ts`
- `src/preload/index.ts`
- `src/renderer/api/client.ts`
- `src/renderer/ui/preview/EpubPreview.tsx`
- `src/renderer/ui/preview/FilePreviewPanel.tsx`
- `src/renderer/ui/preview/previewRenderers.tsx`
- a private EPUB translation controller/adapter under
  `src/renderer/ui/preview/`
- a shared preview translation scheduling policy under
  `src/renderer/ui/preview/`
- translation preferences/shortcut helpers, localized messages, preview CSS,
  and current-behavior specs

Focused tests cover manual and automatic activation, the separate local-content
opt-in, same-language exclusion, stable ids across lazy section remounts,
whole-viewport loading, short-block batch utilization, the six-request safety
ceiling, latency/velocity lookahead bounds, event wakeups, response-order
rendering, bidirectional scrolling, preemption, transient automatic retry,
terminal failure isolation, explicit retry, cache restore, target/model/book
reset, stale-response rejection, iframe-focused shortcut handling, text-only
insertion, and scroll anchoring that yields to real user input. The same
scheduler cases run against URL page translation so the policies cannot drift.

Before readiness, run typecheck, relevant Core and renderer suites, full Core
and renderer suites, docs checks, design-system guards, and an Electron smoke
with reflowable same-language and foreign-language EPUB fixtures in light and
dark appearance.

## Open Questions

None. The PM ratified the separate, default-off EPUB auto-translation consent
boundary, reflowable-reader scope, and deadline-driven continuous-reading
scheduler shared with URL previews.
