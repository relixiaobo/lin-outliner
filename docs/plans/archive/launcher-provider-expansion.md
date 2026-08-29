# Launcher Provider Expansion

> **Re-scoped (2026-06-04):** this is the **capture-provider-breadth** track —
> which URLs/apps we classify into which source `kind` + capture framing. It is
> *orthogonal* to the command surface (`unified-command-surface.md`) and survives
> the cmd+k/launcher unification intact. Rich content from an explicitly
> selected internal Preview belongs to `reference/browser-extension-integration.md`;
> authenticated external-browser content has no approved reader plan.

## Why this plan exists

Capture currently classifies a context from the **URL only** (basic-info) and
ships **6 providers**: `generic-webpage`, `youtube`, `x-twitter`, `github`,
`substack`, and the `unknown-app` fallback (`selectSiteProvider` in
`src/main/context/contextCapture.ts`). The shared type contracts
(`ContextProviderId`, `SourceDraft.kind`) already *declare* the full target set,
but the rest is unbuilt and — before this plan — was tracked nowhere. This plan is
the single home for "which providers we add next," so the declared-but-unproduced
union members aren't silent placeholders.

It does **not** own rich extraction (page body, transcript, email thread, chat
messages). `reference/browser-extension-integration.md` owns only the explicit internal
URL Preview path. External-browser authenticated DOM, email/chat bodies, and
other source readers are deferred until a source-specific plan owns them.
This plan is about URL/app **classification + the right source `kind` + capture
framing**; rich fields fill in when their source-specific readers land.

## Current baseline

| Provider | kind | Status |
|---|---|---|
| `generic-webpage` | webpage/article | ✅ shipped |
| `youtube` | video | ✅ shipped (clean canonical URL) |
| `x-twitter` | tweet | ✅ shipped |
| `github` | repo/profile | ✅ shipped |
| `substack` | article | ✅ shipped |
| `unknown-app` | app | ✅ shipped (fallback) |

## Goal

Light up the declared providers, in two tiers, each only when it actually works
(no disabled placeholders):

1. **Tier A — browser web apps (URL-classifiable now).** Same pattern as
   github/substack: a pure `parseX(url)` + `enrichXContext(ctx)` in
   `contextCapture.ts`, a `selectSiteProvider` branch, an icon, and a test. No new
   infrastructure.
2. **Tier B — native macOS apps (no URL).** Need per-app readers (AppleScript /
   Accessibility) on the `unknown-app` path. Heavier and TCC-sensitive, with no
   dependency on URL Preview or Agent Browser Control.

## Non-goals

- No rich content extraction. Internal URL Preview reading belongs to
  `reference/browser-extension-integration.md`; all other readers require a separate
  approved source-specific plan.
- No disabled "coming soon" provider rows. A provider id/kind is *declared* in the
  contract (A7) but only *produced* once its classifier + test land here.
- No timeline scraping / account actions (already a non-goal of the parent plan).

## Design

### Tier A — browser web app classifiers (ready now)

Each adds: a URL parser, an enricher that sets `providerId` + `kind` (+ any
URL-derivable author/title), a `selectSiteProvider` branch (exclusive order), a
launcher icon, and a unit test in `tests/core/contextCapture.test.ts`. The
`ContextProviderId` / `SourceDraft.kind` values already exist.

| Provider | Host(s) | kind | Notes |
|---|---|---|---|
| `gmail` | mail.google.com | email | thread id from `#…/<id>`; subject/body remain deferred |
| `linkedin` | linkedin.com `/in/`, `/feed`, `/messaging` | profile / chat | route-based, like github |
| `slack` | app.slack.com, `*.slack.com` | chat | workspace/channel from path |
| `whatsapp` | web.whatsapp.com | chat | URL-only framing; authenticated content remains deferred |
| `loom` | loom.com/share/… | video | id from path |
| `circle` | `*.circle.so` | article/webpage | post vs feed by path |
| `notion-public` | notion.site, notion.so public | article/webpage | URL-only metadata until a public-page reader is planned |
| `spotify` (web) | open.spotify.com | music | track/album/playlist by path |

Also the generic-provider **special cases** the parent matrix names but that
aren't built: Medium, TechCrunch, Amazon products — these stay `generic-webpage`
with better metadata (no new providerId), so they're lower priority.

### Tier B — native-app providers (deferred, pending native readers)

No URL; require app-specific AppleScript/AX on the `unknown-app` path. Sequence
after Tier A.

- `apple-mail` — selected message + `message://` deep link (AppleScript).
- `mimestream` — selected email title/link.
- `superhuman` (native) — focused message via AX/Shadow DOM.
- `messages` — conversation participant handle/name.
- `spotify` (native) — current track via AppleScript.
- `pdf` — Preview/Acrobat active document path (AX), or the browser PDF viewer.

### Adjacent deferred work this plan also tracks (so it isn't homeless)

- **Preview / open-original / reveal-original** for a capture's `OriginalResourceRef`
  (parent plan's "Save Model → Preview and open behavior"). The `local-file` /
  `asset` variants exist in the type but nothing emits them yet.
- **Local-file capture** (capturing a Finder/file selection), reusing the landed
  local-file reference identity (`outliner-local-file-references`).
- **Fuller permission-remediation UI** beyond today's single Automation banner
  (Open Accessibility settings, retry) — deferred until a dedicated permission
  UX plan owns it.

## Open questions (for the PM)

1. Tier-A priority order — gmail / linkedin / slack first? (likely highest value).
2. For thin-URL providers (whatsapp, notion-public), is URL-only classification
   valuable without an approved authenticated-content reader, or should it wait?
3. Which native-app readers justify their own complete Tier B feature first
   (for example Apple Mail or Spotify)? They have no Browser Control dependency.

## Subtasks

- [ ] Tier A: gmail classifier + test.
- [ ] Tier A: linkedin (profile/feed/messaging) classifier + test.
- [ ] Tier A: slack classifier + test.
- [ ] Tier A: loom / circle / notion-public / spotify-web classifiers + tests.
- [ ] Generic special-cases: Medium / TechCrunch / Amazon metadata.
- [ ] Tier B: native-app providers, independently sequenced after Tier A.
- [ ] Preview / open-original + local-file capture.
- [ ] As each lands: update `../spec/launcher.md` provider list + fold into spec.
