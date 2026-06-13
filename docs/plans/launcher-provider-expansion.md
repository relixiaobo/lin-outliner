# Launcher Provider Expansion

> **Re-scoped (2026-06-04):** this is the **capture-provider-breadth** track —
> which URLs/apps we classify into which source `kind` + capture framing. It is
> *orthogonal* to the command surface (`unified-command-surface.md`) and survives
> the cmd+k/launcher unification intact. Rich extraction (page body/transcript)
> belongs to `browser-extension-integration.md`, not here.

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
messages) — that is the unified backend in `browser-extension-integration.md`.
This plan is about URL/app **classification + the right source `kind` + capture
framing**; rich fields fill in when the extension backend lands.

## Status: what's done

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
   Accessibility) on the `unknown-app` path. Heavier, TCC-sensitive; sequenced
   after Tier A and the extension backend.

## Non-goals

- No rich content extraction (body/transcript/thread/messages) — that's
  `browser-extension-integration.md`.
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
| `gmail` | mail.google.com | email | thread id from `#…/<id>`; subject needs the extension |
| `linkedin` | linkedin.com `/in/`, `/feed`, `/messaging` | profile / chat | route-based, like github |
| `slack` | app.slack.com, `*.slack.com` | chat | workspace/channel from path |
| `whatsapp` | web.whatsapp.com | chat | URL alone is thin; mostly framing until extension |
| `loom` | loom.com/share/… | video | id from path |
| `circle` | `*.circle.so` | article/webpage | post vs feed by path |
| `notion-public` | notion.site, notion.so public | article/webpage | better title needs the extension |
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
  (Open Accessibility settings, retry) — unless folded into the extension plan.

## Open questions (for the PM)

1. Tier-A priority order — gmail / linkedin / slack first? (likely highest value).
2. For thin-URL providers (whatsapp, notion-public), is URL-only classification
   worth shipping before the extension supplies real content, or wait?
3. Do native-app providers (Tier B) wait for the extension/CDP backend entirely,
   or do a couple of high-value AppleScript ones (apple-mail, spotify) sooner?

## Subtasks

- [ ] Tier A: gmail classifier + test.
- [ ] Tier A: linkedin (profile/feed/messaging) classifier + test.
- [ ] Tier A: slack classifier + test.
- [ ] Tier A: loom / circle / notion-public / spotify-web classifiers + tests.
- [ ] Generic special-cases: Medium / TechCrunch / Amazon metadata.
- [ ] Tier B: native-app providers (after Tier A / extension backend).
- [ ] Preview / open-original + local-file capture.
- [ ] As each lands: update `../spec/launcher.md` provider list + fold into spec.
