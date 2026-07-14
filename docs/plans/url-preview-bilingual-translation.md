# URL Preview Bilingual Translation

This is shape **(a): one complete feature in one PR**. The PR adds
viewport-driven bilingual translation to the existing hardened URL preview. It
also delivers the reusable scheduling mechanism, but the shipped consumer is a
fully working webpage reader rather than standalone groundwork.

## Goal

- Let a user turn bilingual translation on and off from one icon control in the
  URL preview header.
- Preserve the webpage and place a plain-text translation directly after each
  eligible source block.
- Translate the visible viewport first, prefetch a small reading window, and
  never submit the entire page eagerly.
- Use Neva's currently configured model and provider connection without
  creating a conversation, Agent Run, memory entry, or persisted transcript.
- Keep reading position stable while translations are inserted, hidden, or
  restored from cache.
- Send page text to the configured provider only after the user explicitly
  enables translation.

## Non-goals

- EPUB, local HTML, Markdown, or prose-text translation. Those are independent
  future consumers of the scheduler after the webpage behavior ships.
- PDF translation. Fixed-layout PDFs need a separately ratified presentation
  model; scanned PDFs additionally need OCR.
- Translation for source code, delimited data, directories, images, audio, or
  video.
- A target-language setting. The first version targets the effective Tenon UI
  locale (`en` or `zh-Hans`).
- Persistent or cross-page translation caches, translation history, glossary
  management, provider selection, or usage accounting UI.
- Reader extraction, browser-extension integration, authenticated-browser
  control, or weakening the URL webview's sandbox.

## Design

### Header control and states

Place a `Languages` icon button immediately before the existing URL-preview
actions menu. It is an icon-only panel control with a tooltip and
`aria-pressed`; it follows the neutral icon-control states from the design
system and never adds a rounded-square hover fill.

The control has four observable states:

1. **Off**: no page text is collected or sent.
2. **Starting**: visible blocks are being discovered and the first request is
   pending; the control remains operable so the user can cancel.
3. **On**: translations are visible and the viewport scheduler remains active.
4. **Partial error**: completed translations stay readable, the original text
   stays intact, and Tenon's existing dismissible error toast explains that
   some visible content could not be translated. Toggling off and on retries
   missing blocks when they re-enter the priority window.

Turning translation off hides injected translations, stops queued work, and
cancels in-flight requests. Turning it on again restores cached translations
without another model call and resumes missing work. A top-level navigation,
reload, target-locale change, pane close, or webview replacement cancels the
session and clears its in-memory cache.

### Eligible content and privacy boundary

Discover readable semantic blocks from visible page content. Start with
headings, paragraphs, list items, block quotes, captions, table cells, and
leaf-most block containers needed by modern article layouts. Deduplicate nested
candidates and assign stable session-local ids from normalized text plus DOM
order.

Never collect content inside `script`, `style`, `noscript`, `pre`, `code`,
form controls, editable regions, hidden/inert/`aria-hidden` subtrees, or
Tenon-injected translation nodes. Ignore empty, punctuation-only, and
already-target-language blocks. The main process revalidates request counts,
ids, and bounded text lengths before any provider call.

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

### Model request boundary

Add a main-owned page-translation service behind the existing generic preload
invoke bridge. The renderer sends a request/session id, effective target locale,
and a bounded list of `{ id, text }` blocks. A separate cancellation command
aborts the active provider request for that session.

The service resolves the same effective model as Neva: the profile's explicit
model over the active provider connection, falling back to the provider's
ranked default. It uses the lowest reasoning level supported by that model and
no tools. Extract/reuse the existing configured-model completion path so custom
endpoints, OAuth/stored credentials, request options, abort handling, and
OpenAI Responses compatibility behavior do not fork.

The prompt treats source blocks as untrusted data, asks for one JSON result per
requested id, and forbids instructions from the page from changing the task.
The parser accepts only a bounded JSON array, exact requested ids, and string
translations. Malformed or missing entries fail that batch without changing
the source page.

### Error and lifecycle behavior

- No configured provider/model: remain Off and show a localized error directing
  the user to Agent settings.
- No eligible visible text: remain On and wait for later eligible content; do
  not treat an image-only viewport as a failure.
- Provider or parse failure: preserve successful translations and report one
  localized toast for the current failure wave; do not loop automatically.
- Navigation/reload/close/disable: cancel active work, invalidate late results,
  disconnect observers, and remove or hide injected nodes as appropriate.
- A source block whose text changes invalidates only that block's cached
  translation.

### Specification

Update the current-behavior specs with the header control, explicit-send privacy
boundary, viewport/prefetch contract, scroll anchoring, model ownership,
translation lifecycle, and unchanged URL-preview sandbox posture.

## Open questions

None. The target locale, viewport-driven scheduling, in-memory-only cache,
Neva-model ownership, and format boundary are ratified.

## Files

- `src/main/agentRuntime.ts` and a focused main-process page-translation module
- `src/main/main.ts`
- `src/renderer/api/client.ts`
- `src/renderer/ui/preview/FilePreviewPanel.tsx`
- `src/renderer/ui/preview/previewRenderers.tsx`
- focused URL translation controller/script modules under
  `src/renderer/ui/preview/`
- `src/renderer/ui/WorkspaceCanvas.tsx` and `src/renderer/ui/App.tsx` for the
  existing error-toast path
- `src/renderer/ui/icons.ts`
- file-preview/breadcrumb styles and English/Simplified Chinese messages
- focused core/main, renderer, security, and Playwright tests
- `docs/spec/workspace-layout.md`
- `docs/spec/ui-behavior.md`
- `docs/spec/agent-pi-mono-implementation.md`
- this plan

No dependency, document command/protocol, persisted data, `docs/TASKS.md`, or
`CHANGELOG.md` change is required.

## Risks

- Arbitrary webpages have inconsistent DOM structure and may rerender blocks.
  Eligibility, stable ids, mutation handling, and text-change invalidation need
  fixture coverage across article, nested-list, table, and lazy-content shapes.
- Injecting translations changes layout. Anchor compensation must cover result
  insertion, toggle hide/show, partial batches, and cached restoration.
- Page text is sent to a third-party provider. Explicit opt-in, sensitive
  element exclusions, bounded viewport collection, and no persistence are
  trust-critical behavior.
- A fast scroll can otherwise spend tokens on stale offscreen work. Queue
  reprioritization and cancellation must be deterministic and tested.
- Model JSON can be malformed or prompt-injected by page content. Exact id
  allow-listing and text-only insertion keep malformed output from becoming a
  DOM/security boundary failure.
- URL preview hardening must not regress: no preload, Node integration,
  permissions, popup capability, or non-HTTP navigation is added.

## Collision check

- PR #395 modifies Agent stream retry lifecycle, `agentRuntime.ts`, the pi-mono
  spec, and the same i18n files. It lands first; this branch rebases onto its
  merged result before becoming ready. Translation is a non-conversation
  `completeSimple` utility request and does not emit the PR's runtime retry row.
- PR #394 modifies outliner field rows and `ui-behavior.md`. The spec addition is
  in the file-preview section and should merge independently; no renderer or
  behavior ownership overlaps.
- `browser-extension-integration` remains record-only. This feature operates
  solely inside the existing hardened URL preview.
- Result: ordered behind #395; no unresolved scope collision.

## Checklist

- [ ] Add the localized header toggle and observable translation states.
- [ ] Discover eligible content without collecting sensitive or executable
  page regions.
- [ ] Schedule visible blocks first with directional prefetch and bounded
  batching.
- [ ] Cache translated blocks in memory and invalidate changed source text.
- [ ] Preserve scroll anchoring across insert, hide, show, and cache restore.
- [ ] Add the cancelable, validated main-process model request path.
- [ ] Insert only requested plain-text results and reject malformed output.
- [ ] Cover navigation, reload, pane close, locale change, cancellation, no
  model, partial failure, and dynamic-content lifecycle.
- [ ] Preserve the URL webview security guard and add targeted regressions.
- [ ] Update current-behavior specs.
- [ ] Run typecheck, focused tests, full core/renderer suites, docs check, and
  light/dark Playwright visual verification.
