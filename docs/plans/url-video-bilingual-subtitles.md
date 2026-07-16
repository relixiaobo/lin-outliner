# URL Video Bilingual Subtitles

This is shape **(a): one complete feature in one PR**. The PR extends URL
preview translation with bilingual subtitles for prerecorded videos while
preserving the existing page-translation workflow and security boundary.

## Goal

- Translate the active subtitle track in URL-preview videos with the user's
  existing target language and translation model.
- Cover standards-based HTML media players, including Frontend Masters' Video.js
  player, plus YouTube's custom caption pipeline.
- Keep source captions visible immediately and add translated text as the second
  subtitle line as results arrive.
- Translate a bounded playback-time window, prioritize the current cue after
  activation or seeking, and never translate an entire transcript eagerly.
- Share the existing three-request page budget so current captions can displace
  stale off-window prefetch without increasing provider fan-out.
- Keep all caption discovery, parsing, and presentation in the trusted isolated
  world and send only bounded cue text to the configured provider.

## Non-goals

- Speech recognition, audio extraction, or captions for media without a usable
  text track.
- Live-generated captions. The first version requires a finite prerecorded cue
  timeline that can be translated ahead of playback.
- DRM circumvention, media downloading, or access beyond what the loaded page
  already grants the user.
- Local video-file translation, audio-only media, persistent transcript caches,
  subtitle export, editing, glossary management, or manual source-language
  selection.
- Main-world script injection, response-body interception, browser-extension
  integration, or a remote-page-to-main IPC channel.
- Separate target-language, model, shortcut, or automatic-translation settings
  for subtitles.

## Design

### Unified user flow

The existing URL-preview `Languages` control remains the single translation
control. Translate enables both eligible page blocks and any usable video
captions discovered later. Show original hides page translations, disables the
Tenon subtitle track or overlay, restores the site's previous caption state,
and retains page-local results for a later re-enable.

Target language, `Follow Agent` or an explicit translation model, automatic
translation, and `Option+A` / `Alt+A` keep their current meaning. Automatic
translation activates when either the valid page language or a known active
caption language differs from the target. This lets an English video translate
inside a Chinese YouTube UI. Unknown caption language remains manual unless the
page-language rule already activates translation.

When translation is enabled and no source track is active, Tenon selects the
site's default/original caption track when one can be identified without a
guess. A later source-track change invalidates subtitle-only results and starts
the current playback window again. A source track whose language matches the
target remains original-only and never reaches the provider.

Observable states remain `off`, `starting`, `idle`, `on`, and `error`:

- No video, no usable captions, or captions not loaded yet is `idle`, not an
  error and not a permanent spinner.
- A current cue waiting for its first translation contributes to `starting`.
- Rendering at least one bilingual cue contributes to `on`, even if no page
  translation node was inserted.
- The original cue remains visible during loading and failure. The translation
  line uses the existing fixed-size loader; failure becomes a keyboard- and
  pointer-operable retry control for that caption batch.
- An off-window caption failure does not interrupt playback or erase completed
  subtitles. A provider/configuration failure pauses new caption batches until
  retry while independently completed page content remains visible.

The primary popover command is renamed from the page-specific `Translate page`
to `Translate`; no additional persistent switch or nested settings section is
introduced.

### Caption adapters and presentation

The isolated guest runtime owns a small adapter chain:

1. **Standards adapter.** Observe `HTMLMediaElement.textTracks`, choose the
   active/default `captions` or `subtitles` track, and copy finite `VTTCue`
   timelines into one Tenon-managed bilingual text track. The generated cue
   initially contains the source text and is replaced with source plus
   translation when ready. This keeps captions visible in fullscreen and covers
   Video.js players such as Frontend Masters. Source modes and the user's
   selected track are restored on disable or teardown.
2. **YouTube adapter.** On `youtube.com/watch`, fetch a bounded copy of the
   current same-origin watch document in the guest session, extract
   `ytInitialPlayerResponse` as JSON without evaluation, validate a
   `youtube.com/api/timedtext` caption URL, and parse its finite timed-text cue
   response. Render source plus translation in a Tenon overlay inside the active
   player so it follows site fullscreen. Re-resolve on video-id or player-track
   changes.

Adapters expose normalized cue snapshots: stable session-local id, source text,
start/end time, source language, and track revision. Applying, failing, or
releasing a result requires an exact id and revision match, so a stale response
cannot overwrite a replaced track or cue. Page-provided text is always inserted
with text-only DOM APIs. Parsed response markup is never executed.

The runtime bounds watch-document and caption-response parsing, validates
origins before fetching, and rejects malformed or unbounded timelines. Caption
fetches use the webview's existing authenticated session but never expose
cookies, URLs, or response bodies to the renderer or main process.

### Playback-window scheduler

Caption work joins the existing controller rather than creating an independent
request pool. Each guest batch declares `page` or `caption`; main applies
content-kind-specific limits while the controller enforces three total active
requests per URL preview.

Priority order is:

1. current and immediately upcoming caption cues;
2. currently visible page blocks;
3. caption prefetch ahead of playback;
4. page prefetch and a small caption buffer behind playback.

The initial caption request contains at most six cues with a soft budget of
roughly 1,500 source characters. One indivisible cue may exceed that soft budget
but remains bounded by the trusted 4,000-character per-cue limit. Later caption
batches contain at most sixteen cues or 4,000 source
characters. The runtime fills approximately 90 seconds ahead and 15 seconds
behind, scaled upward for playback speed and capped at two minutes. It requests
no cue outside that moving window.

Seeking or changing videos invalidates deferred corrections and preempts only
requests that no longer overlap the new playback window. Completed cues remain
cached for the page session, so backward seeking does not call the provider
again. Concurrent caption batches settle independently and become visible in
response order. Page batches retain their existing `2 / 4 / 4` behavior and
limits.

### Provider and security contract

The existing main-owned translation service accepts an explicit content kind.
Page requests retain their four-block limit. Caption requests permit the bounded
sixteen-cue batch while preserving the existing 4,000-character total, provider
selection, cancellation, exact-id response validation, secret-safe diagnostics,
and non-persisted request model.

The isolated-world guest command validator accepts only bounded runtime
operations and normalized results. Remote scripts cannot replace the runtime,
manufacture provider requests, select a larger batch, or supply hidden page
content. No subtitle capability weakens the webview sandbox, navigation policy,
permission allow-list, or popup denial.

### Files and verification

Expected production scope:

- `src/core/urlPageTranslation.ts`
- `src/core/urlPageTranslationGuest.ts`
- `src/main/pageTranslation.ts`
- `src/main/urlPageTranslationGuest.ts`
- `src/renderer/ui/preview/urlPageTranslationGuest.ts`
- `src/renderer/ui/preview/urlPageTranslationController.ts`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`
- `docs/spec/workspace-layout.md`
- `docs/spec/ui-behavior.md`

Focused tests cover:

- Frontend Masters-style remote `TextTrack` discovery, bilingual cue rendering,
  fullscreen-compatible track behavior, source-mode restoration, and cue
  revision protection.
- Bounded YouTube player-response extraction, timed-text parsing, video changes,
  origin rejection, and text-only overlay presentation.
- Same-language exclusion, no-caption idle behavior, source-track replacement,
  retry, target/model reset, seek preemption, cache reuse, and a three-request
  combined ceiling.
- Main validation for page versus caption limits and exact response ids.
- Existing page translation scheduling, privacy, loading, scroll anchoring, and
  model-selection behavior without regression.

Before readiness, run typecheck, core and renderer suites, docs checks, a
production build, and Electron smoke. Verify Frontend Masters and YouTube in the
real URL preview with original/bilingual/off states, seeking, fullscreen,
light/dark host chrome, and a failed-request retry.

## Open questions

None. The PM ratified the standards-plus-YouTube, prerecorded-video scope on
2026-07-15.
