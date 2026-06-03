---
status: done
priority: P1
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# macOS Native Branding & Chrome Polish

> **Shipped** on `cc/macos-native-branding-polish`. T1–T6 done. Q4 → copyright
> `© 2026 Lin Lab`. Icon source: `assets/brand/tenon-icon-master.svg` (squircle
> master) + `scripts/gen-icon.mjs` (Chromium rasterizer — `qlmanage` was dropped
> because it mattes the transparent gutter white, the "白边" bug). Sidebar
> single-identity rule folded into `docs/spec/design-system.md`.
>
> **Menu name — resolved.** The bold app-menu name + the ⌘, Settings item are
> macOS-managed from the running bundle, so a **dev run shows "Electron" /
> "Preferences…"**. A packaged `--dir` build was produced and launched to verify:
> Info.plist `CFBundleName=Tenon`, `CFBundleIdentifier=dev.linlab.tenon`,
> `NSHumanReadableCopyright=© 2026 Lin Lab`, bundled `icon.icns` sha256-identical
> to `build/icon.icns`; the running packaged app's menu reads **"Tenon"** (bold) +
> **"Settings…"** + About/Hide/Quit Tenon. PM decision: **accept dev-"Electron"**
> (packaged is correct; only developers see the dev shell). Main agent: archive at
> the merge gate. (Aside: packaging needed `bun install` first — node_modules had
> drifted to `@earendil-works/pi-*@0.75.4` vs lock `0.78.0`; an infra item, not
> this PR.)

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

**Resolved (PM-ratified 2026-06-03):**

4. ~~Copyright string (T5).~~ **→ `© 2026 Lin Lab`** (matches the `dev.linlab.tenon`
   appId namespace). Applied to the About panel (`main.ts` `setAboutPanelOptions`)
   and electron-builder `NSHumanReadableCopyright` (`package.json` top-level
   `copyright`). (T5 locked.)

## Task checklist (for the dev agent)

- [x] T1 — recomposed the existing glyph onto the 824/r185.4/100px-gutter squircle master (`assets/brand/tenon-icon-master.svg`); regenerated `build/icon.icns` + `build/icon.png` via `scripts/gen-icon.mjs`; verified transparent gutter + corners at 1024/512/32px. **Fix after first pass:** the original `qlmanage` rasterizer mattes the transparent gutter to opaque WHITE — the master's 100px gutter came out `rgba(255,255,255,255)`, which rendered as a white frame in the Dock (the user-reported "白边"). Switched the rasterizer to headless Chromium (Playwright, already a devDependency) with `omitBackground`, which keeps the gutter truly transparent (`rgba(0,0,0,0)` confirmed by pixel probe at 1024/512/32). The packaged bundle's `icon.icns` is sha256-identical to `build/icon.icns` (clean icon ships).
- [x] T2 — dropped the sidebar brand header (`Sidebar.tsx` brand block + unused logo import) and the `sidebar-brand*` CSS; kept the workspace-root row as the single identity. Verified light + dark sidebar renders.
- [x] T3 — About/Hide/Quit read "Tenon" even in a dev run (explicit labels off `APP_NAME` — ordinary items, so the label wins). The bold app-menu title is OS-managed from the bundle's CFBundleName and can't be set by the template label, so a dev run shows **"Electron"**; a packaged build was launched and reads **"Tenon"** (CFBundleName=Tenon verified in Info.plist). PM decision: accept dev-"Electron". (Earlier "dev and packaged both read Tenon" was wrong — corrected.)
- [x] T4 — label "Settings…" in code; verified the **packaged** app renders "Settings…" (the dev shell rendered the legacy "Preferences…", an Electron-dev-bundle artifact, not our code).
- [x] T5 — `© 2026 Lin Lab` in the About panel + electron-builder `copyright`.
- [x] T6 — Help menu: "Learn More" → "Tenon Help"; added "Report an Issue…".
- [x] `bun run typecheck` (clean) + `bun run test:renderer` (268 pass) + token-guard e2e (`typography-tokens.spec.ts`, 8 pass); light+dark visual on icon + sidebar; `docs/spec/design-system.md` updated (A6 — sparse-accent brand-mark line now points at the single workspace-root avatar). Pre-existing failures in `test:core` (file_glob/file_grep) and `workspace-layout.spec.ts` reproduce on clean `origin/main` — not introduced here.

## Key files

- `src/main/main.ts` — `buildApplicationMenu` (~`:294-332`), `app.setName` (`:71`),
  `setAboutPanelOptions` (~`:1380`), `app.dock.setIcon` (~`:1379`).
- `package.json` — electron-builder `mac` block (~`:61-91`).
- `build/icon.icns`, `build/icon.png`, `assets/brand/tenon-logo.svg`,
  `src/renderer/assets/tenon-logo.svg`.
- `src/renderer/ui/Sidebar.tsx` (brand header `:146-149`, root row `~:79/:267-282`),
  `src/renderer/styles/sidebar.css` (`sidebar-brand*` ~`:71-96`).
- `src/core/core.ts:2154` — workspace-root seed title.
