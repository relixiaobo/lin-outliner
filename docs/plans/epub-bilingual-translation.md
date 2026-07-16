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
- Preserve the reader's position while injected translations change section
  and iframe heights.
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

Scheduling follows the EPUB reader's own scrollport and maps section-iframe
geometry into that viewport. Priority is visible blocks, blocks ahead in the
known scroll direction, then a smaller buffer behind. Before direction is
known, the initial window is symmetric so starting in the middle and scrolling
up works as well as scrolling down.

The first visible request contains at most two blocks or about 2,000 source
characters. Later requests contain at most four blocks or 4,000 characters.
At most three requests run concurrently and at most one is prefetch. A dense
viewport can start `2 / 4 / 4` without waiting for the first response. New
visible work may preempt only an obsolete off-window prefetch request. Batches
settle independently and render in response order.

The controller keeps approximately four viewports ahead and one behind once a
direction is known. It only sees sections already mounted by the existing EPUB
lazy-loader margin, so no translation action forces every spine section to load.
Scrolling into either direction mounts and schedules the new section normally.

Before loading/status/translation DOM writes, the adapter captures the first
visible source block and its viewport offset. It batches writes, asks the
existing EPUB measurement path to resize affected frames, and compensates the
outer scrollport over bounded animation frames. Wheel, touch, keyboard, or
native scrollbar movement invalidates delayed compensation so translation
layout work never reverses user input.

### Lifecycle and provider boundary

The existing main-owned translation service remains the only model boundary.
EPUB requests use document-specific prompt context under the same validated
four-block, per-block, per-batch, output, model-selection, cancellation, and
secret-safe diagnostic limits as page translation.

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
  - **AC-5:** When translation starts in a dense viewport, requests may begin as
    `2 / 4 / 4`, never exceed three concurrent requests, and never include more
    than one offscreen prefetch batch.
  - **AC-6:** When the reader scrolls down or up into an untranslated section,
    newly visible eligible blocks receive a loader or cached translation while
    sections outside the bounded lazy window remain unloaded and unsent.
- **FR-4 — Stable bilingual presentation.** Source text remains authoritative
  while plain-text translations and local recovery state are added in place.
  - **AC-7:** When a submitted block succeeds, its loader disappears and its
    translation appears after the source; when it fails, the loader becomes an
    accessible retry control that retries only affected work.
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

## Files And Verification

Expected production scope:

- `src/core/urlPageTranslation.ts`
- `src/main/pageTranslation.ts`
- `src/main/appPreferences.ts`
- `src/main/main.ts`
- `src/preload/index.ts`
- `src/renderer/api/client.ts`
- `src/renderer/ui/preview/EpubPreview.tsx`
- `src/renderer/ui/preview/FilePreviewPanel.tsx`
- `src/renderer/ui/preview/previewRenderers.tsx`
- a private EPUB translation controller/adapter under
  `src/renderer/ui/preview/`
- translation preferences/shortcut helpers, localized messages, preview CSS,
  and current-behavior specs

Focused tests cover manual and automatic activation, the separate local-content
opt-in, same-language exclusion, stable ids across lazy section remounts,
`2 / 4 / 4` batching, the three-request ceiling, response-order rendering,
bidirectional scrolling, preemption, retry, cache restore, target/model/book
reset, stale-response rejection, iframe-focused shortcut handling, text-only
insertion, and scroll anchoring that yields to real user input.

Before readiness, run typecheck, relevant Core and renderer suites, full Core
and renderer suites, docs checks, design-system guards, and an Electron smoke
with reflowable same-language and foreign-language EPUB fixtures in light and
dark appearance.

## Open Questions

None. The PM ratified the separate, default-off EPUB auto-translation consent
boundary and reflowable-reader scope.
