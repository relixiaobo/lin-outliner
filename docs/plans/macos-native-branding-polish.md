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

**T1 — App icon is a full-bleed square; redraw as a macOS squircle.**
`build/icon.png` / `build/icon.icns` / `assets/brand/tenon-logo.svg` /
`src/renderer/assets/tenon-logo.svg` are a 1024×1024 image whose dark `#1E1E1E`
background fills the whole canvas with opaque, square corners (verified: all four
corner pixels `alpha=255`). macOS does not mask app icons, so this renders as a
hard dark square in the Dock / Launchpad / ⌘-Tab — visibly non-native.
*Fix:* produce a new 1024×1024 **master** where the artwork sits on Apple's
app-icon grid — the continuous-rounded-rect ("squircle") occupying ≈824/1024 px
(~100 px transparent margin per side), transparent outside the squircle. Keep the
brand glyph centered on the squircle fill. Regenerate `build/icon.icns` (full size
ladder) **and** `build/icon.png` (dev Dock via `main.ts` `app.dock.setIcon`,
~`:1379`). The `.icns` size coverage is already complete — only the artwork shape
changes. Note this needs a brief **visual check** in the Dock after regen.

**T2 — Remove the duplicate "Tenon" in the sidebar.**
`src/renderer/ui/Sidebar.tsx:146-149` renders a static brand header (logo mark +
"Tenon" wordmark); separately the workspace-root row (`Sidebar.tsx:~79`,
`~267-282`) shows the root node whose title is also "Tenon" (seeded at
`src/core/core.ts:2154`). Two "Tenon"s in one rail.
*Recommended fix (see Open question Q1):* **drop the static brand header**
(`Sidebar.tsx:146-149` + its `sidebar-brand*` CSS in `sidebar.css:~71-96`) and let
the navigable workspace-root row be the single identity (Notion/Tana-style single
workspace row). Do **not** also rename the root unless Q1 says so.

### P1 — naming / metadata polish

**T3 — App menu reads "Electron" in dev.** `main.ts:~296` first submenu label is
`app.name`; the About/Hide/Quit items are role-based, so their labels come from the
bundle's CFBundleName. Packaged = "Tenon" (correct). Dev = "Electron". *Fix
(optional, see Q3):* hardcode the labels — `{ role: 'about', label: 'About Tenon' }`,
`{ role: 'hide', label: 'Hide Tenon' }`, `{ role: 'quit', label: 'Quit Tenon' }` —
so dev and packaged both read "Tenon".

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

## Open questions (PM to ratify before build)

1. **Brand de-dup approach (T2).** (a) **Drop the sidebar brand header**, root row
   becomes the single "Tenon" *(recommended — lower risk, the root row is the real
   navigable workspace entry)*; or (b) keep the brand header and rename the
   workspace root to a neutral "Workspace" (`core.ts:2154`, add "Tenon" to the
   alias array). Pick one — don't do both.
2. **Icon (T1).** Confirm the squircle direction, and decide whether the existing
   red/dark glyph simply gets re-placed on a margined squircle by the dev, or this
   needs a real **design pass** (and who provides the master art). The geometry is
   mechanical; the aesthetic is a design call.
3. **Dev-only "Electron" labels (T3).** Worth hardcoding About/Hide/Quit labels to
   match in dev, or accept it as a dev-only artifact since the packaged app is
   already correct?
4. **Copyright string (T5).** Exact holder + year ("© 2026 <name/org>").

## Task checklist (for the dev agent)

- [ ] T1 — new squircle icon master → regenerate `build/icon.icns` + `build/icon.png`; visual Dock check (light + dark)
- [ ] T2 — de-dup sidebar brand per Q1 (drop brand header + `sidebar-brand*` CSS, or rename root)
- [ ] T3 — (if Q3=yes) hardcode About/Hide/Quit labels to "…Tenon"
- [ ] T4 — "Preferences…" → "Settings…"
- [ ] T5 — copyright in About panel + electron-builder
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
