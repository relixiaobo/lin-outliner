# URL Preview Bilingual Translation

This is shape **(a): one complete feature in one PR**. The PR adds
viewport-driven bilingual translation to the existing hardened URL preview. It
also delivers the reusable scheduling mechanism, but the shipped consumer is a
fully working webpage reader rather than standalone groundwork.

## Goal

- Let a user choose a common target language and turn bilingual translation on
  and off from the URL preview header or the scoped keyboard shortcut.
- Preserve the webpage and place a plain-text translation directly after each
  eligible source block.
- Translate the visible viewport first, prefetch a small reading window, and
  never submit the entire page eagerly.
- Default to the model currently selected by Neva, while allowing a cheaper
  enabled model to be chosen and remembered specifically for translation.
- Optionally translate newly navigated pages automatically when their valid
  top-level language differs from the target language.
- Keep reading position stable while translations are inserted, hidden, or
  restored from cache.
- Show progress and recoverable failure at the source block being translated,
  rather than only in remote header chrome.
- Send page text to a configured provider only after the user manually enables
  translation or explicitly opts into automatic translation.

## Non-goals

- EPUB, local HTML, Markdown, or prose-text translation. Those are independent
  future consumers of the scheduler after the webpage behavior ships.
- PDF translation. Fixed-layout PDFs need a separately ratified presentation
  model; scanned PDFs additionally need OCR.
- Translation for source code, delimited data, directories, images, audio, or
  video.
- Manual source-language selection. Source language follows the nearest valid
  page `lang` declaration when present and otherwise remains model-detected.
- A user-configurable shortcut. The first version uses `Option+A` on macOS and
  `Alt+A` elsewhere, scoped to the active URL preview.
- Persistent or cross-page translation caches, translation history, glossary
  management, provider configuration, or usage accounting UI.
- Reader extraction, browser-extension integration, authenticated-browser
  control, or weakening the URL webview's sandbox.

## Design

### Header control and states

Place a `Languages` icon button immediately before the existing URL-preview
actions menu. It opens a compact anchored translation popover ordered by task
frequency: target language, the full-width Translate page / Show original command,
then globally remembered automatic-translation and model preferences below a
separator. The command uses the matching semantic show/hide icon and the shared
high-contrast neutral primary button while translation is off; once translation
is active, Show original becomes a quieter secondary reversal. Hover, pressed,
and keyboard focus feedback remain distinct. The header button
exposes popover expansion separately from a dynamic accessible label that reports
whether translation is on or off. It follows the neutral icon-control states from
the design system and never adds a rounded-square hover fill. Once at least one
translation succeeds, the stable language glyph gains a subtle circular selected
fill whenever that page-local cached translation is visible; no second glyph is
composited into the small header slot. Clicking the webpage itself closes the
popover even though the page runs in a separate webview.

The target-language catalog contains common model-supported languages as stable
BCP-47 codes and presents each language by its autonym. The default follows the
effective Tenon UI language until the user explicitly chooses a target. An
explicit choice persists in app preferences and becomes the default for later
pages and launches. Changing target while translation is active cancels the old
request and clears the old target's page-local results. Manual translation then
restarts immediately; an auto-activated page re-evaluates its top-level language
and stays off when the new target now matches.

The model selector defaults to `Follow Agent`. That mode resolves Neva's current
model at request time, so later Agent model changes apply without a separate
translation setting. Its other options are the enabled, authenticated, runnable
models from Agent provider settings, grouped by provider. A provider-qualified
explicit choice persists globally. Choosing `Follow Agent` clears that override.
If an explicit model later becomes unavailable, the selector keeps showing it as
unavailable and translation reports a recoverable configuration error; it never
silently falls back. Changing model during translation cancels the active request,
clears all page-local translation state, and immediately translates the current
viewport again with the newly selected model.

Automatic translation defaults off and persists globally. Turning it on checks
the current page immediately and enables translation only when the document has
a valid top-level `<html lang>` that differs from the target language. A missing,
empty, or invalid top-level language stays manual; descendant language metadata
continues to filter individual blocks. Turning the switch off does not hide
translations already visible. Manually choosing Show original suppresses automatic
translation for only the current page. The next top-level navigation clears that
suppression and evaluates the new page again. The keyboard shortcut toggles only
the current page and never changes the automatic-translation preference.

`Option+A` on macOS and `Alt+A` elsewhere runs the same toggle command for the
active URL-preview panel, including while focus is inside its webview. It never
registers a system-global shortcut and does nothing when the active panel is not
a URL preview. The shortcut appears in the control tooltip and popover action.

The control has five observable states:

1. **Off**: no page text is collected or sent.
2. **Starting**: visible blocks are being discovered and each submitted source
   block shows an inline loading indicator; the control remains operable so the
   user can cancel.
3. **Idle**: translation remains enabled, but the current page window has no
   eligible untranslated blocks and the header does not claim completion.
4. **On**: at least one translation is visible and the viewport scheduler remains
   active without unresolved failures.
5. **Partial error**: completed translations stay readable, the original text
   stays intact, and each failed source block replaces its loader with a focused,
   clickable error control. The completion check remains if an earlier block
   succeeded. Clicking the error retries only that block. Tenon's existing
   dismissible error toast still announces the failure wave.

Turning translation off hides injected translations, removes transient loading
and error controls, stops queued work, and cancels in-flight requests. Turning
it on again restores cached translations without another model call and resumes
missing work. A top-level navigation or reload cancels the session, clears its
in-memory cache, and re-evaluates automatic translation after DOM readiness. A
target-language or model change, pane close, or webview replacement also cancels
the session and clears its in-memory cache.

### Eligible content and privacy boundary

Discover readable semantic blocks from visible page content. Start with
headings, paragraphs, list items, block quotes, captions, table cells, and
leaf-most block containers needed by modern article layouts. Deduplicate nested
candidates and assign stable session-local ids from normalized text plus DOM
order.

Never collect content inside `script`, `style`, `noscript`, `pre`, `code`,
form controls, editable regions, hidden/inert/`aria-hidden` subtrees, or
Tenon-injected translation nodes. Ignore empty and punctuation-only blocks, plus
blocks whose nearest declared `lang` already matches the selected target
language. Same-language blocks create no loading indicator and no provider
request. The main process revalidates request counts, ids, and bounded text
lengths before any provider call.

The provider receives only the eligible blocks that enter the active viewport
window. Translation results are accepted only for requested ids and are
inserted with `textContent`; model-produced HTML is never parsed or executed.

### Viewport scheduler

When enabled, prioritize work in this order:

1. blocks intersecting the current viewport;
2. blocks up to roughly two viewports ahead in the current scroll direction;
3. blocks up to roughly half a viewport behind.

Blocks outside that window stay unsent. Batch adjacent pending blocks under
bounded block and character limits. Use limited concurrency so prefetch cannot
flood a provider; a newly visible block always outranks queued prefetch work.
Fast scrolling discards obsolete queued batches and rebuilds priority around
the new viewport. Dynamic page mutations register new eligible blocks, but
they are not submitted until they enter the same window.

Keep high-frequency viewport coordinates, queues, observers, and translation
cache in an imperative controller/ref rather than React state. React state owns
only the header control's observable status. Scroll listeners, where needed,
are passive; observer and handler subscriptions are stable for the mounted
webview.

### Scroll anchoring and DOM presentation

Before a batch changes visibility or inserts results, capture the first visible
source block and its viewport offset. Apply DOM writes as one batch, measure the
same anchor once, and compensate the webview scroll position by the delta. This
prevents translations above the reading point from moving the user's current
sentence.

Each translation is one inert block immediately after its source. It inherits
the page's font and current text color, uses a quiet opacity and modest block
spacing, and does not install links, event handlers, forms, images, or remote
resources. Tenon's injected nodes and styles use a collision-resistant prefix.
Reduced-motion users receive no insertion animation; the feature does not need
motion in the default mode either.

As soon as a block enters a submitted batch, append a small neutral inline
loader at the end of its source. Its 16px status area and 10px spinner stay
constant across headings and body text instead of inheriting the page's type
scale. Success removes that loader as the inert
translation is inserted. A provider or parse failure replaces it with a compact
error control; activating the control changes it back to loading and retries
only that record. Cancel, disable, navigation, source mutation, and destruction
remove transient controls. Reduced-motion mode renders a static progress ring
instead of animation. Loader/error DOM mutations participate in the same anchor
compensation as translation insertion.

### Model request boundary

Add a main-owned page-translation service behind the existing generic preload
invoke bridge. The renderer sends a request/session id, effective target locale,
an optional provider-qualified explicit model, and a bounded list of
`{ id, text }` blocks. A separate cancellation command aborts the active provider
request for that session.

Without an explicit model, the service resolves the same effective model as Neva:
the profile's current model over the active provider connection, falling back to
that provider's ranked default. With an explicit model, it strictly resolves the
qualified provider and model against that provider's current enabled, authenticated,
runnable runtime configuration. An unavailable explicit choice returns
`not-configured`; it does not consult the Agent model. The service uses the lowest
reasoning level supported by the resolved model and no tools. Extract/reuse the
existing configured-model completion path so custom endpoints, OAuth/stored
credentials, request options, abort handling, and OpenAI Responses compatibility
behavior do not fork.

The prompt treats source blocks as untrusted data, asks for one JSON result per
requested id, and forbids instructions from the page from changing the task.
The parser accepts only a bounded JSON array, exact requested ids, and string
translations. Malformed or missing entries fail that batch without changing
the source page.

### Error and lifecycle behavior

- No configured provider/model, or an unavailable explicit model: keep submitted
  blocks in the recoverable error state and show a localized error directing the
  user to select or configure a model. After configuration, activating a block's
  error control retries only that block.
- No eligible visible text: remain enabled in Idle and wait for later eligible
  content; do not show the completion check or treat an image-only viewport or
  same-language blocks as a failure.
- Provider or parse failure: preserve successful translations and report one
  localized toast for the current failure wave. Do not retry automatically;
  poll only for an explicit failed-block retry while paused.
- Navigation/reload/close/disable: cancel active work, invalidate late results,
  disconnect observers, and remove or hide injected nodes as appropriate.
- A source block whose text changes invalidates only that block's cached
  translation.

### Specification

Update the current-behavior specs with the header control, manual/automatic send
privacy boundary, viewport/prefetch contract, scroll anchoring, model ownership,
translation lifecycle, and unchanged URL-preview sandbox posture.

## Open questions

None. The common target-language catalog, UI-language default, remembered
explicit target/model choices, dynamic `Follow Agent` default, strict unavailable
model behavior, opt-in automatic translation rules, scoped shortcut, block-local
recovery, viewport-driven scheduling, in-memory-only cache, and format boundary
are ratified.

## Files

- `src/core/urlPageTranslation.ts`
- a focused core translation-language catalog
- `src/main/appPreferences.ts` and `src/preload/index.ts` for the remembered
  target, translation-model override, and automatic-translation preferences
- `src/main/agentModelResolution.ts`, `src/main/agentRuntime.ts`, and a focused
  main-process page-translation module
- `src/main/main.ts`
- `src/renderer/api/client.ts`
- `src/renderer/ui/preview/FilePreviewPanel.tsx`
- `src/renderer/ui/preview/previewRenderers.tsx`
- focused URL translation controller/script modules under
  `src/renderer/ui/preview/`
- `src/renderer/ui/WorkspaceCanvas.tsx` and `src/renderer/ui/App.tsx` for the
  active-panel shortcut scope and existing error-toast path
- `src/renderer/ui/interactions/shortcutRegistry.ts`
- `src/renderer/ui/icons.ts`
- file-preview/breadcrumb styles and English/Simplified Chinese messages
- focused core/main, renderer, security, and Playwright tests
- `docs/spec/workspace-layout.md`
- `docs/spec/ui-behavior.md`
- `docs/spec/agent-pi-mono-implementation.md`
- this plan

No dependency, document command/protocol, `docs/TASKS.md`, or `CHANGELOG.md`
change is required. App preferences gain optional target-language and
provider-qualified model fields plus an automatic-translation boolean; older
preference files remain valid by defaulting to UI language, `Follow Agent`, and
automatic translation off.

## Risks

- Arbitrary webpages have inconsistent DOM structure and may rerender blocks.
  Eligibility, stable ids, mutation handling, and text-change invalidation need
  fixture coverage across article, nested-list, table, and lazy-content shapes.
- Injecting translations changes layout. Anchor compensation must cover result
  insertion, toggle hide/show, partial batches, and cached restoration.
- Inline progress/error controls must survive arbitrary page CSS, remain
  keyboard accessible, avoid becoming translation candidates themselves, and
  never trigger the page's own form/navigation behavior.
- The shortcut must work in both the host renderer and URL webview without
  intercepting `Option+A` outside the active URL preview.
- Page text is sent to a third-party provider. Manual activation or an explicitly
  enabled automatic-translation preference, sensitive element exclusions,
  bounded viewport collection, and no persistence are trust-critical behavior.
- Provider catalogs and credentials can change after a model is selected. The
  explicit qualified model must remain visible but fail closed when it is no
  longer runnable, while `Follow Agent` must continue resolving dynamically.
- Page language metadata is author-controlled and sometimes absent. Automatic
  translation therefore accepts only a valid top-level language tag and never
  substitutes model detection for the opt-in gate.
- A fast scroll can otherwise spend tokens on stale offscreen work. Queue
  reprioritization and cancellation must be deterministic and tested.
- Model JSON can be malformed or prompt-injected by page content. Exact id
  allow-listing and text-only insertion keep malformed output from becoming a
  DOM/security boundary failure.
- URL preview hardening must not regress: no preload, Node integration,
  permissions, popup capability, or non-HTTP navigation is added.

## Collision check

- GitHub currently reports no other open PR touching app preferences, preload,
  shortcut registration, URL preview chrome, or the translation guest runtime.
- PR #397 also updates `docs/spec/ui-behavior.md`, but in a separate semantic
  ingest section with no line-level or behavioral overlap.
- `browser-extension-integration` remains record-only. This feature operates
  solely inside the existing hardened URL preview.
- Result: PR #396 is the only live claim in this area; no unresolved scope
  collision.

## Checklist

- [ ] Add the localized target/model popover, remembered preferences, automatic
  translation switch, scoped shortcut, checked icon state, and observable states.
- [ ] Discover eligible content without collecting sensitive or executable
  page regions.
- [ ] Schedule visible blocks first with directional prefetch and bounded
  batching.
- [ ] Cache translated blocks in memory and invalidate changed source text.
- [ ] Preserve scroll anchoring across insert, hide, show, and cache restore.
- [ ] Add the cancelable, validated main-process model request path with dynamic
  Agent following and strict explicit-model resolution.
- [ ] Insert only requested plain-text results and reject malformed output.
- [ ] Add block-local loading, error, and click-to-retry controls with reduced
  motion and keyboard coverage.
- [ ] Cover navigation, reload, pane close, locale change, cancellation, no
  model, partial failure, and dynamic-content lifecycle.
- [ ] Preserve the URL webview security guard and add targeted regressions.
- [ ] Update current-behavior specs.
- [ ] Run typecheck, focused tests, full core/renderer suites, docs check, and
  light/dark Playwright visual verification.
