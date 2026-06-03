---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# macOS Native Branding & Chrome Polish

## Goal

After the Lin Outliner → Tenon rebrand (PR #83), make Tenon present as a
first-class **native macOS** app: a correctly-shaped Dock/app icon, a single
brand identity (no duplicate "Tenon"), correct app-menu naming, and complete
About / bundle metadata. This is a focused polish pass on the macOS-native
surface — no new product features.

## Non-goals

- **Cross-platform.** macOS only (Win/Linux dropped in `native-feel-remediation`).
- **Code-signing / notarization / Gatekeeper.** The unsigned `.dmg` stays; that
  is a separate track.
- **Renaming internal `lin:*` protocol / storage identifiers.** `#83` deliberately
  preserved them (A4). The residual internal `lin-outliner` names (dev userData
  `.lin-outliner-dev`, drag MIME `application/x-lin-outliner-node-id`,
  localStorage `lin-outliner:workspace-layout:v1`, GitHub repo slug) are **not**
  user-visible macOS chrome and are out of scope here (renaming the userData/
  localStorage keys would orphan dev state). Track separately if ever wanted.
- New outliner/agent functionality.

## macOS-native checklist (assessment baseline)

The surfaces a native macOS app must get right, with **current state** from the
2026-06-03 audit (`file:line` in Findings below):

| # | Surface | State |
|---|---|---|
| 1 | App name in menu bar + About/Hide/Quit role labels | ✅ packaged ("Tenon" via `productName`→CFBundleName); ⚠️ **dev shows "Electron"** |
| 2 | App-menu order (About · Settings… ⌘, · Services · Hide/Hide Others/Show All · Quit) | ⚠️ correct order, but item reads "Preferences…" (macOS 13+ = "Settings…") |
| 3 | Edit / Window role menus (Undo…/Select All/Dictation/Emoji; Minimize/Zoom/Bring All to Front) | ✅ role-based, complete |
| 4 | **App icon shape** — macOS squircle w/ ~10% margin, transparent corners (macOS does NOT auto-mask) | ❌ **BUG: full-bleed dark square** |
| 5 | `.icns` size ladder (16→1024 @1x/@2x) + dev Dock icon via `app.dock.setIcon` | ✅ ladder complete; wiring correct (inherits the square art) |
| 6 | About panel (name / version / copyright / credits) | ⚠️ name+version+icon set; **copyright missing** |
| 7 | electron-builder mac metadata (appId, productName, category, icon, copyright) | ⚠️ all set except **`copyright` (NSHumanReadableCopyright)** |
| 8 | Window chrome (hiddenInset + native traffic lights + OS title) | ✅ correct ("Untitled" in the shot is an in-app page placeholder, not the OS title) |
| 9 | **Single brand identity** (don't show the product name twice) | ❌ **BUG: sidebar brand header "Tenon" + workspace-root row "Tenon"** |
| 10 | Dark mode via `nativeTheme.themeSource` + `@media`; no forced Aqua | ✅ correct |
| 11 | Lifecycle (single-instance + focus, keep-alive on close, activate, before-quit flush) | ✅ correct |
| 12 | Optional niceties (Dock menu, represented filename + edited dot, Help "Tenon Help") | ◻️ absent (optional; Help URL is stale) |

## Findings & tasks (prioritized)

### P0 — visible bugs (the three flagged in the screenshots)

**T1 — App icon renders as a full-bleed square in the Dock; rebuild the master to Apple's macOS icon grid.**

*Root cause (researched, PM-confirmed framing).* The **logo glyph itself is fine** —
the problem is the icon **master was authored full-bleed** (the `#1E1E1E`
background fills the entire 1024×1024 canvas; verified all four corner pixels
`alpha=255`) instead of being built to Apple's macOS app-icon grid. Unlike iOS,
**macOS does not auto-mask app icons** — whatever shape you ship is what appears
in the Dock / Launchpad / ⌘-Tab. So a square master → a hard-edged square Dock
icon, visibly non-native. This is the single most common way Electron apps get the
macOS icon wrong; the fix is a known template, not a redesign.

*How other developers solve it (the macOS icon grid).* On a **1024×1024**
transparent canvas, the artwork sits inside a **rounded-rect ("squircle")** of
**824×824 px**, **corner radius ≈185.4 px**, centered → **exactly 100 px
transparent gutter on all four sides**; everything outside the squircle is
transparent. (Apple uses a continuous-curvature superellipse; a plain rounded
rect at r≈185 is the pragmatic approximation every template ships.) macOS adds its
own subtle shadow, so the art stays clean.

*Concrete recipe for the dev.* Keep the existing Tenon glyph; recompose it onto the
824/100px-gutter squircle master (the brand fill becomes the squircle, not the
whole canvas) — e.g. an SVG (squircle path + centered glyph) rendered to a 1024
PNG, or Apple's macOS icon template. Then regenerate **both** `build/icon.icns`
(full size ladder — coverage is already complete, only the shape changes; via
`iconutil -c icns <iconset>` or an icon tool) **and** `build/icon.png` (the dev
Dock icon loaded by `app.dock.setIcon`, `main.ts:~1379`). Also update the two
`tenon-logo.svg` copies if the in-app brand mark should match. **Clear the build
output and rebuild** — both Electron and the OS cache icons aggressively, so a
stale square may linger otherwise. Finish with a **visual Dock check (light +
dark)**.

*Sources:* the macOS icon grid (824×824 / r185.4 / 100 px gutter on 1024) and the
"macOS does not auto-round, add transparent padding" guidance are the standard
documented practice — see [Apple HIG · App
icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
and the recurring Electron reports (e.g. electron-builder
[#7845](https://github.com/electron-userland/electron-builder/issues/7845)).

**T2 — Remove the duplicate "Tenon" in the sidebar.**
`src/renderer/ui/Sidebar.tsx:146-149` renders a static brand header (logo mark +
"Tenon" wordmark); separately the workspace-root row (`Sidebar.tsx:~79`,
`~267-282`) shows the root node whose title is also "Tenon" (seeded at
`src/core/core.ts:2154`). Two "Tenon"s in one rail.
*Decision (PM-ratified, Q1 = option a):* **drop the static brand header** —
remove `Sidebar.tsx:146-149` and its `sidebar-brand*` CSS in `sidebar.css:~71-96`,
so the navigable workspace-root row is the single identity (Notion/Tana-style
single workspace row). Do **not** rename the workspace root; leave `core.ts:2154`
as "Tenon". Update `docs/spec/design-system.md` in the same change if it documents
the sidebar brand block (A6).

### P1 — naming / metadata polish

**T3 — App menu reads "Electron" in dev.** `main.ts:~296` first submenu label is
`app.name`; the About/Hide/Quit items are role-based, so their labels come from the
bundle's CFBundleName. Packaged = "Tenon" (correct). Dev = "Electron". *Decision
(PM-ratified, Q3 = hardcode):* hardcode the labels — `{ role: 'about', label:
'About Tenon' }`, `{ role: 'hide', label: 'Hide Tenon' }`, `{ role: 'quit', label:
'Quit Tenon' }`, and set the first-submenu label literal to `'Tenon'` (not
`app.name`) — so dev and packaged both read "Tenon".

**T4 — "Preferences…" → "Settings…".** `main.ts:~299` — rename the label to match
macOS 13+ (the in-app button already says "Settings", `Sidebar.tsx:~298`). Keep ⌘,.

**T5 — Add copyright (two places).** (a) `main.ts` `setAboutPanelOptions`
(~`:1380`) — add `copyright: '© 2026 …'` (and optionally `credits`). (b)
`package.json` — add top-level `"copyright": "© 2026 …"` (electron-builder →
NSHumanReadableCopyright). Confirm the exact holder/string with the PM.

**T6 — Help menu.** `main.ts:~324-332` — single "Learn More" → stale
`github.com/relixiaobo/lin-outliner`. Rename to "Tenon Help" (HIG) and/or update
the URL once the repo is renamed; optionally add "Report an Issue".

### Optional (later pass — not required this round)

- View → "Show/Hide Sidebar" item mirroring the in-app chrome toggle.
- `app.dock.setMenu` (e.g. New Tab, Settings…).
- `mac.minimumSystemVersion` + `mac.artifactName` in `package.json`.
- Represented filename + `setDocumentEdited` (only if windows ever map to files).

### Verified correct — do NOT touch (so the dev doesn't chase non-issues)

`app.setName` timing (module top, before `whenReady`); window title "Tenon" with
`hiddenInset` (the visible "Untitled" is `NodePanel.tsx:~609` empty-page
placeholder, **not** the OS title); Edit/Window role menus; dark mode; single-
instance + lifecycle; `.icns` size ladder; electron-builder icon wiring.

## Open questions

**Resolved (PM-ratified 2026-06-03):**

1. ~~Brand de-dup approach (T2).~~ **→ (a) Drop the sidebar brand header**; keep
   the workspace-root row as the single "Tenon". (T2 locked.)
2. ~~Icon (T1).~~ **→ Not a design problem with the provided glyph** — the master
   was authored full-bleed instead of to Apple's macOS icon grid. The dev
   re-places the **existing** glyph on the 824/100px-gutter squircle template and
   regenerates the assets; **no new design pass / new master art needed.** (T1
   locked.)
3. ~~Dev-only "Electron" labels (T3).~~ **→ Hardcode** About/Hide/Quit (and the
   first-submenu label) to "Tenon" so dev matches packaged. (T3 locked.)

**Still open (blocks T5 only — the rest can build):**

4. **Copyright string (T5).** Exact holder + year for `© 2026 <name/org>` (About
   panel + electron-builder `NSHumanReadableCopyright`). Everything else is
   unblocked; the dev can ship T1–T4/T6 and fill T5's string when provided.

## Task checklist (for the dev agent)

- [ ] T1 — recompose existing glyph onto the 824/r185.4/100px-gutter squircle master → regenerate `build/icon.icns` + `build/icon.png` (clear caches/rebuild); visual Dock check (light + dark)
- [ ] T2 — drop the sidebar brand header (`Sidebar.tsx:146-149` + `sidebar-brand*` CSS); keep the workspace-root row
- [ ] T3 — hardcode About/Hide/Quit + first-submenu label to "Tenon"
- [ ] T4 — "Preferences…" → "Settings…"
- [ ] T5 — copyright in About panel + electron-builder (string from Q4)
- [ ] T6 — Help menu label/URL
- [ ] `bun run typecheck` + `bun run test:renderer` + `bun run test:e2e` (token guard); visual verification of the sidebar + icon (light + dark); update `docs/spec/design-system.md` if the sidebar brand block is removed (A6)

## Key files

- `src/main/main.ts` — `buildApplicationMenu` (~`:294-332`), `app.setName` (`:71`),
  `setAboutPanelOptions` (~`:1380`), `app.dock.setIcon` (~`:1379`).
- `package.json` — electron-builder `mac` block (~`:61-91`).
- `build/icon.icns`, `build/icon.png`, `assets/brand/tenon-logo.svg`,
  `src/renderer/assets/tenon-logo.svg`.
- `src/renderer/ui/Sidebar.tsx` (brand header `:146-149`, root row `~:79/:267-282`),
  `src/renderer/styles/sidebar.css` (`sidebar-brand*` ~`:71-96`).
- `src/core/core.ts:2154` — workspace-root seed title.
