---
status: superseded
owner: cc-2
branch: cc-2/lazy-like-global-launcher
superseded-by: browser-extension-integration.md
supersedes-section: lazy-like-global-launcher.md (Phase 6 Resolvers, Provider matrix)
---

# Launcher Capture — Resolver Runtime, YouTube Transcript, and Remaining Providers (SUPERSEDED)

> **Outcome (2026-06-04).** The resolver runtime and the YouTube transcript
> resolver were built during this wave and then **removed by clean deletion**.
> Rich, in-app content extraction (page body, tweet text, transcript) is deferred
> wholesale to the future **unified browser extension / CDP backend** — a single
> clean path is simpler than maintaining an offscreen-scrape resolver plus an
> AppleScript page-script layer that the extension would replace anyway. The
> successor plan is `docs/plans/browser-extension-integration.md`.
>
> **What landed and survives:** the per-site **provider classification** (URL →
> `ExternalContext` shape) for X/Twitter, GitHub, and Substack. These run from the
> URL alone via `selectSiteProvider` + `enrich*Context`, so a captured link still
> gets the right shape (#tweet / #repo / #profile / #article) with no rich data.
> When the extension supplies `raw` (a `PageContentExtractor`), the same enrichers
> fold the rich fields in — no further change needed here.
>
> **What was removed:** `resolverRunner.ts`, `youtubeTranscript.ts` +
> `youtubeTranscriptScript.ts`, `captureStore.ts` (payload-to-file writer), the
> `apply_capture_resolver_result` protocol command, and the whole
> payload/resolver/content sidecar schema (`CapturePayloadRef`,
> `CaptureResolverRef`, `ResolverKind`, `CapturedContent`, `CapturedMedia`,
> `deriveCaptureStatus`). The capture sidecar (`CaptureNodeMetadata`) is now
> **provenance only**: source identity + origin + status (`saved`|`partial`) +
> warnings.

The remainder of this file is kept verbatim as the record of the path not taken.

---

Execution plan for the next wave of the launcher capture feature. Design detail for
the data contracts and the provider matrix lives in
`docs/plans/lazy-like-global-launcher.md` (Save Model, Provider Implementation
Details, Phase 6); this file is the build order + the decisions taken this session,
and it records the deferred follow-ups the PM asked to log but NOT execute yet.

## Goal (original — resolver goals NOT pursued)

1. Stand up the **resolver runtime**: a post-save, off-hot-path job runner that
   enriches a capture and writes the result back to its `capture` sidecar as a
   hidden payload (file under `userData/captures/<id>/`), never into the outline.
   — _Built, then removed; deferred to the unified extension path._
2. Ship the first resolver: **YouTube transcript**, extracted in an **offscreen,
   sandboxed Electron `webContents`** — invisible, no live-tab mutation, no Apple
   Events toggle. — _Built, then removed; deferred._
3. Continue the **remaining site providers** from the master plan's matrix.
   — _Done as URL-classification (X/GitHub/Substack)._

## Provider classification (LANDED — the surviving part)

Pattern (per the YouTube provider): URL matcher (`selectSiteProvider`) → `enrich*Context`
classifies into `ExternalContext` from the URL, and folds in `raw` when the
`PageContentExtractor` seam supplies it (the future extension). GitHub/Substack are
pure URL-route + OG, so they needed no DOM script even before the removal.

1. **X/Twitter** — `x.com`/`twitter.com` `/status/` pages → kind `tweet`, handle
   derived from the URL. Tweet text/author/avatar return when the extension supplies
   `raw` (the enricher folds it in when `confidence` is `exact`). The non-automation
   boundary (focused tweet only, no timeline scroll) carries forward to the extension.
2. **GitHub** — fully URL-based. `github.com/<owner>/<repo>` → kind `repo` (title
   `owner/repo`, owner as author); bare `github.com/<owner>` → kind `profile`.
   Reserved top-level routes (`features`, `settings`, …) excluded.
3. **Substack** — URL-based. `*.substack.com` subdomains; `/p/` → kind `article`,
   else `webpage`. Byline/OG return with the extension. Custom-domain Substacks fall
   through to generic (indistinguishable without the page).
4. **LinkedIn**, **Gmail Web** — NOT BUILT. Both read auth-walled private content
   (DMs / email bodies); defer to a focused pass on the extension with a privacy note.

## Open questions (carried to the successor plan)
- Offscreen/extension scrape needs the user's session for login/age-gated content;
  default to a clean session (public only), gated content a later opt-in (privacy review).
- Storing DM/email text as captured content is a sensitive trade-off worth surfacing
  to the PM before any LinkedIn/Gmail extraction lands.

## Final state (checklist)
- [x] C X/Twitter provider — `enrichXTwitterContext` (URL classification) + tests
- [x] C GitHub provider — `enrichGithubContext` (URL-route) + tests
- [x] C Substack provider — `enrichSubstackContext` + tests
- [removed] B1 resolver runtime + write-back command — deleted (unified-path decision)
- [removed] B2 offscreen YouTube transcript resolver — deleted (unified-path decision)
- [ ] C LinkedIn + Gmail Web providers (deferred — auth-walled, privacy note)
