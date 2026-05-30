---
status: draft
priority: P1
owner: relixiaobo
created: 2026-05-30
updated: 2026-05-30
---

# Native-Feel & UI Audit (verified snapshot)

## Goal

A verified, no-gaps audit of native-feel and design-system compliance across the
whole product, turned into a dev-agent work contract. Triggered by two
independent reviews (Claude + Codex) under the `native-feel-cross-platform-desktop`
skill and `docs/spec/design-system.md`. Every finding below was re-checked
against the actual code at commit `d9f1fa8` (local `main` == `origin/main`); the
two suspected-stale e2e specs were re-run to confirm they fail.

This file does **not** replace the two forward plans it audits. It is the
point-in-time evidence + packaging layer; each work package (PKG) names the
existing plan it belongs to so ownership does not fragment:

- [`native-feel-remediation.md`](native-feel-remediation.md) — host/shell native
  feel (cursor, focus, menus, window, IPC, perf, packaging).
- [`design-system-rollout.md`](design-system-rollout.md) — tokens, dark mode,
  materials, neutral-functional components, floating-rails shell.

## Non-goals

- No native shell rewrite, no Liquid-Glass / `NSGlassEffectView` (inherited from
  `native-feel-remediation.md` Non-goals; Electron vibrancy/mica is the ceiling).
- This audit ships no code itself — it is the contract the PR branches implement.

## Audit correction (must read before picking up work)

`native-feel-remediation.md` and its index row in `plans/README.md:52` summarize
Stage 3 (cursor/font + material, #46/#47) and Stage 4 (native interactions, #48/#49)
as shipped. Verified at `d9f1fa8`, **material + font landed but several bundled
sub-items did not**:

- Stage 3 "restore visible focus rings" — NOT done. `base.css:94-99` still kills
  `button:focus`/`:focus-visible` globally (`outline:none; box-shadow:none`).
- Stage 3 strict-native cursor pass — NOT complete. `cursor:pointer` remains on
  non-link controls (`outliner.css:2115`, `agent-composer.css:131,169`).
- Stage 4 native right-click `Menu` — NOT done. No `webContents.on('context-menu')`
  anywhere in `src/main/`; right-clicking chrome shows Chromium's default menu.

Net: the staged plan's *index status over-claims*. The PRs below close the real
gaps. When PR-C and PR-D land, update `native-feel-remediation.md` Stage 3/4 notes
and the README index row to reflect what actually shipped.

## Lesson from the prior UI-refactor round (why this plan is linear)

The first UI-refactor plan was unreliable because it treated visual fixes as
independent when they are not: **the theming / media-query / token mechanism is a
foundation, and cosmetic component changes layered on top must assume the *final*
mechanism or they get redone.** Concretely, the dependency traps are:

1. **Dark-mode mechanism (D1).** While dark mode is driven by `[data-theme]`+JS,
   any component PR that adds a dark override writes `:root[data-theme='dark'] …`.
   The moment D1 migrates to `@media (prefers-color-scheme)`, every one of those
   overrides has to be migrated again. → settle the mechanism *before* component
   work touches dark styling.
2. **User-preference media queries (A3) vs overlay materials (D2).** Overlay glass
   needs a `prefers-reduced-transparency` fallback. If overlay work lands first it
   invents an ad-hoc fallback; if the consolidated a11y-media layer lands first,
   overlays plug into one established pattern. → foundation before consumers.
3. **Same-file collisions.** `base.css` is touched by both the focus-ring fix and
   the cursor/web-tell pass; the popover/overlay CSS is touched by both materials
   and elevation. Splitting these into separate PRs creates serial rebase churn
   for no review benefit.

So the work is grouped into **four coherent, dependency-ordered PRs** (not nine
micro-PRs). Order is `PR-A → PR-B → PR-C`, with `PR-D` joinable after PR-A.

## Decisions (fixed)

- **D4 — rail-toggle hover.** Follow the spec, do not change it.
  `design-system.md:751-756, 799-801` already forbids a `--fill-*` box on
  icon-only chrome controls (rail toggles, pane close, header actions): hover
  signals by **deepening glyph colour**, and *if* a fill is genuinely needed it
  must be **circular/pill-shaped, never a rounded square**. Current
  `shell.css:108,115-118` uses exactly the forbidden rounded-square + fill.
  Default fix: colour-deepen only (`--text-secondary → --text-primary`, drop the
  `background`). If colour-only reads too weak in use, switch to a pill fill — not
  the rounded square. → folded into PR-C.

- **D1 — dark mode.** Split into D1-min (this round) + D1-full (deferred feature).
  `design-system.md:434-437` already fixes the target mechanism
  (`color-scheme: light dark`; one `@media (prefers-color-scheme: dark)` block;
  in-app light/dark/system control driven by `nativeTheme.themeSource`). The
  current `[data-theme]` + JS bridge (`theme.ts`, `theme-dark.css:7`) is a known
  interim (its own comment cites Track B / #45).
  - **D1-min (PR-B, this round):** migrate the CSS to `@media` + set
    `color-scheme: light dark`. Today `color-scheme: light` (`tokens.css:46`) is
    hard-coded, so native UA controls (scrollbars, form controls, native menus)
    stay light in dark mode. Also removes the one-frame JS delay. No in-app toggle
    exists today, so this loses no capability.
  - **D1-full (deferred):** `nativeTheme.themeSource` + persisted preference +
    in-app light/dark/system control. That is a product feature; it stays in
    `design-system-rollout.md` / #45 Track B and is NOT part of this round.

- **X1/X2 — IPC envelope + flushSync.** Excluded from this round; measure first.
  Both live in `native-feel-remediation.md` Stage 5. X1 (versioned IPC envelope)'s
  skill motivation is multi-language hosts; this is pure-TS Electron, where a
  shared types module / codegen is the more on-point fix. X2 (`shared.ts:112-120`
  `flushSync` per projection apply) is an intentional input-latency optimization;
  removing it trades latency for throughput and must be measured with the existing
  `measureRender` probe before any change.

## Findings (verified at d9f1fa8)

Severity: P0 blocks ship; P1 spec-required or clear web-tell; P2 polish; P3 deferred.
The PR column maps each finding to its consolidated PR (see Work packages).

| ID | Severity | Finding | Evidence | PR |
| --- | --- | --- | --- | --- |
| A1 | P0 | Global focus-ring removal kills keyboard `:focus-visible` on all buttons | `base.css:94-99` (some buttons re-add it: `shell.css:127`, `confirm-dialog.css:73`) | PR-C |
| A2a | P0 | No native right-click menu → Chromium default menu leaks on chrome/blank | no `webContents.on('context-menu')` in `src/main/` | PR-D |
| A2b | P0 | No application menu → no `Cmd+,`, no Edit/Window menus | no `Menu.buildFromTemplate`/`setApplicationMenu` in `src/main/` | PR-D |
| T1 | P1 | Token guard spec reads dead `src/renderer/styles.css` (deleted in CSS split) | `typography-tokens.spec.ts:31,90,196,213,227`; 5 ENOENT failures re-run | PR-A |
| T2 | P1 | workspace-layout spec asserts removed top chrome / tab strip | `workspace-layout.spec.ts:58,146,267,434,498` (old `.top-chrome`/`.workspace-tab`); 5 failures re-run | PR-A |
| T3 | P1 | Spec docs contradicted design-system (top-bar Back/Forward, tab strip) | `ui-behavior.md:17`, `workspace-layout.md` vs `design-system.md:770-771` | **DONE (PR-0)** |
| T4 | P1 | Page-title font drift: test expects 26/36px; app + scale say 24/32px | `typography-tokens.spec.ts:299-302`; `panel.css:55,57`+`tokens.css:32-33`=24/32; doc typo `design-system.md:853` | PR-A |
| A3 | P1 | No `prefers-contrast` anywhere; reduced-motion/transparency cover only the two rails | grep: 0 `prefers-contrast`; reduced-motion in 3 files, reduced-transparency in 2 | PR-B |
| A4 | P1 | No inactive-window state (no focus/blur forward, no `.window-inactive`) | none in `src/main/` or CSS | PR-D |
| A5 | P1 | `cursor:pointer` on non-link controls (web tell) | `outliner.css:2115` (tag), `agent-composer.css:131,169` (approval) | PR-C |
| A6 | P1 | Bullet hover `transform: scale(1.375)` — non-native pop, violates "hover never changes layout" | `outliner.css:1689-1690` vs `design-system.md:757-758` | PR-C |
| D1 | P1 | Dark mode via `[data-theme]`+JS, `color-scheme: light` hard-coded → native UA controls stay light in dark | `tokens.css:46`, `theme.ts:9-16`, `theme-dark.css:7` vs `design-system.md:434-437` | PR-B |
| D2 | P1 | Overlays/menus don't use the defined `--material-popover` glass tier | `--material-popover` defined (`tokens.css:164`) but popovers use opaque `--bg` (`popover-command.css:7`) | PR-C |
| D3 | P2 | Overlay elevation not tiered: `--overlay-shadow-level-2` defined but unused; dialogs/palette use level-1 | `tokens.css:115` unused; `confirm-dialog.css:16`, `popover-command.css:8` use `--shadow`(=level-1) | PR-C |
| D4 | P2 | rail-toggle hover uses rounded-square + fill (spec forbids) | `shell.css:108,115-118` vs `design-system.md:751-756,799-801` | PR-C |
| D5 | P2 | `--status-info` blue tints inline file mentions (second semantic colour) | `agent-message.css:47`, `agent-composer.css:375` vs colour-restraint rule | PR-C |
| A7 | P2 | `not-allowed` cursor on disabled items (native greys, doesn't change cursor) | `popover-command.css:41` et al. | PR-C |
| A8 | P2 | Chrome text broadly selectable (only `.window-chrome-zone` has `user-select:none`) | `shell.css:59`; sidebar/breadcrumb/tags selectable | PR-C |
| D6 | P2 | Pre-paint light colour ≠ token: `#f7f6f1` vs `--bg-window:#ececec` (dark `#2a2a2c` matches) | `main.ts:184` vs `tokens.css:73` | PR-D |
| D7 | P2 | window-corner addon builds only in packaged app → dev shows wrong 16pt corner; visual QA must use packaged build | `native/window-corner` built by `build:native` (in `app:build` only) | PR-D (doc) |
| X1 | P3 | IPC stringly-typed, no versioned envelope | `client.ts:40`, `preload/index.ts:83`, `main.ts:310` | deferred |
| X2 | P3 | `flushSync` on every projection apply (intentional latency trade) | `shared.ts:112-120` | deferred |

### Manual verification (out of automated reach)
IME composition (Chinese pinyin) + candidate-box placement; list type-ahead;
full Tab keyboard-nav path (with A1); scroll inertia / rubber-band; actual
right-click menus per region (with A2a); packaged-build 24pt corner + concentric
radius chain + vibrancy + inactive-window grey-out (with A4, D7).

### PASS — do not regress
Hardened webContents (`setWindowOpenHandler` deny+external, `will-navigate`/
`will-redirect` `^https?://` only, permission allow-list = `clipboard-sanitized-write`,
packaged `file://` CSP); single-instance lock + activate; `before-quit` flush;
sandboxed `webPreferences`; vibrancy/mica rails with reduced-transparency fallback;
window-corner private-API implementation; semantic token layer (neutral functional
state, no `--primary`, single rose accent + single rose link, hardcoded-colour
discipline); neutral `::selection` + scrollbars; font smoothing; FOUC mitigation
(`show:false`+ready-to-show + first-frame `data-windowMaterial`); drag/no-drag
carve-outs.

## Work packages (4 consolidated, dependency-ordered PRs)

Grouped to respect the linear dependencies above and to avoid micro-PRs. Each PR
is one `cc/<topic>` branch + Draft PR; dev agents implement, only the main agent
merges. **PR-0 (spec reconciliation, T3) is already done** in this session.

```
PR-A  guards          ─┐ (re-arm first: policed + DOM-truth fixed)
                       ├─> PR-B  theming+a11y foundation ──> PR-C  component pass
PR-D  native shell  ───┘ (joinable after PR-A; serializes on main.ts)
```

### PR-A — Re-arm design-system guard tests (T1, T2, T4)
- **Branch:** `cc/guard-tests-refresh` · test infra (+1 doc-line typo)
- **Why first:** until the token guard reads the split `styles/*.css` again, none
  of the later CSS PRs are actually policed. Also realigns the workspace-layout
  assertions to the shipped floating-rails DOM. Independent of every other PR.
- **Covers:** T1 (repoint `productStyleFiles` + the `:227` read from the deleted
  `src/renderer/styles.css` to a glob of `src/renderer/styles/*.css`); T2 (rewrite
  the 5 stale cases to `.window-chrome-zone*` / `.rail-toggle*` /
  `.panel-sticky-breadcrumb` and the sidebar tab switcher `.sidebar-tab*` —
  `.workspace-tab*` is dead-token-only; keep the 5 passing cases); T4 (fix the
  test to `24px/32px` and correct the `design-system.md:853` "26px/36px" typo).
- **Accept:** both specs green (was 11 failed / 7 passed); guard would catch a
  raw font/hex/self-alias/outline-stroke violation in any split file; typecheck +
  renderer tests pass; no new e2e regressions vs baseline.
- **Full spec:** drafted at `tmp/pkg7-pr-spec.md`.

### PR-B — Theming & a11y CSS foundation (D1-min, A3)
- **Branch:** `cc/theme-and-a11y-foundation` · CSS architecture · higher churn,
  isolated
- **Why second / why grouped:** this is the mechanism layer every later visual
  change sits on (traps #1 and #2 above). Settling dark-mode `@media` +
  user-preference media queries in one coherent PR means PR-C never writes a
  `[data-theme]` override or an ad-hoc transparency fallback that has to be redone.
- **Covers:** D1-min — migrate `theme-dark.css` `:root[data-theme='dark']` →
  `@media (prefers-color-scheme: dark)`, set `color-scheme: light dark`
  (`tokens.css:46`), trim the `theme.ts` JS bridge to only what a future
  `themeSource` toggle needs. A3 — add `@media (prefers-contrast: more)` (borders /
  higher text contrast / drop translucency) and consolidate `prefers-reduced-motion`
  + `prefers-reduced-transparency` into a coherent global layer instead of the
  current per-file scatter.
- **Out of scope:** the in-app light/dark/system toggle + `themeSource` +
  persistence (D1-full / #45). The inactive-window state is PR-D.
- **Accept:** dark follows OS with no JS-frame delay; native scrollbars/controls go
  dark; high-contrast + reduced-motion verified via DevTools emulation; PR-A
  guards stay green; typecheck + tests pass. Keep isolated; rebase others after.

### PR-C — Native-feel component pass (A1, A5, A6, A7, A8, D2, D3, D4, D5)
- **Branch:** `cc/native-feel-component-pass` · CSS · the big visual unit
- **Why third / why grouped:** all are component-level visual polish that assume
  the PR-B foundation is final, and they collide on the same files (`base.css`,
  `outliner.css`, `agent-composer.css`, popover/overlay CSS). One review touches
  each file once instead of 3–4 PRs rebasing over each other.
- **Covers:**
  - **A1 (P0 a11y):** replace the global focus kill (`base.css:94-99`) with
    `button:focus:not(:focus-visible)` suppression + a neutral `:focus-visible`
    ring (`--focus-ring-shadow`); audit existing rings for double-rings.
  - **Web-tells:** remove `cursor:pointer` from non-link controls (A5); bullet
    hover → colour/background, no `transform:scale`, no reflow (A6); disabled
    `not-allowed` → `default` (A7); `user-select:none` on chrome containers,
    content stays selectable (A8); rail-toggle hover colour-deepen, drop the
    rounded-square fill (D4, per Decisions).
  - **Materials/elevation:** `--material-popover` + `backdrop-filter` on popover/
    menu containers with a `prefers-reduced-transparency` fallback that reuses
    PR-B's pattern (D2); dialogs + command palette → `--overlay-shadow-level-2`,
    menus/popovers stay level-1 (D3).
  - **Colour restraint:** drop `--status-info` tint on inline file mentions, use
    neutral text (D5).
- **Same-PR test update:** rewrite `cursor-affordances.spec.ts` to the strict-native
  contract (it currently asserts the old `pointer` behaviour).
- **Note:** contains the P0 focus-ring fix. If you want that shipped *immediately*
  rather than waiting for the rest of PR-C, it can be fast-tracked as a tiny
  standalone PR (`cc/focus-visible-restore`, spec drafted at `tmp/pkg1-pr-spec.md`)
  — otherwise it rides here per the "fewer PRs" preference.
- **Accept:** Tab shows a neutral ring on every control, mouse-click shows none;
  no `cursor:pointer`/`not-allowed` on chrome; no hover reflow; menus read as glass
  under vibrancy and opaque under reduced-transparency; dialog/palette shadow
  clearly deeper than a menu; PR-A guards green; typecheck + tests pass.

### PR-D — Native shell behaviors (A2a, A2b, A4, D6, D7)
- **Branch:** `cc/native-shell-behaviors` · main process · serialize on `main.ts`
- **Why grouped / when:** all touch `src/main/main.ts` (serialize-on-main per
  remediation Coordination) plus the inactive-window CSS that pairs with it.
  Joinable any time after PR-A; its `.window-inactive` desaturation leans lightly
  on PR-B tokens, otherwise independent of PR-B/PR-C.
- **Covers:** A2a/A2b — standard macOS app menu (`Menu.buildFromTemplate` +
  `setApplicationMenu`: App incl. Preferences `Cmd+,` → `openSettingsWindow`, Edit
  roles, View, Window) + `webContents.on('context-menu') → Menu.popup` (editable vs
  minimal), with renderer `preventDefault` only where a custom React menu owns the
  region; resolve remediation S4's native-vs-DOM-menu open question (native bare
  right-click, keep DOM command menus). A4 — forward window focus/blur →
  `<html>.window-inactive`, desaturate rails + selection. D6 — align
  `prePaintBackgroundColor()` light value to `--bg-window` (`#ececec`) and fix the
  stale `≈ #f7f6f1` comment. D7 — doc note that the 24pt corner is packaged-build
  only (visual QA uses `app:build`).
- **Accept:** `Cmd+,` opens settings; right-click shows a native menu not
  Chromium's; node custom menus still work; blurring the window greys chrome and
  restores on focus; no startup colour seam on non-material windows; typecheck +
  tests pass.

## Sequencing & coordination

- **Order:** PR-A → PR-B → PR-C is a hard chain (guards police the rest; the
  theming/media foundation must precede component CSS — see Lesson). PR-D is
  joinable after PR-A and serializes internally with any other `src/main/main.ts`
  work per `native-feel-remediation.md` Coordination.
- **Coordination-required files:** PR-A touches `design-system.md` (1-line typo —
  flag on the PR for the main agent). PR-D touches `src/main/main.ts`. Open these
  isolated and let other clones rebase.
- **After merge:** when PR-C and PR-D land, correct the
  `native-feel-remediation.md` Stage 3/4 status and the `plans/README.md:52` index
  row (Audit correction). When PR-A is green, update memory
  `stale-design-system-guard-specs`.
- **Main-agent direct (no dev PR):** PR-0 spec reconciliation (T3) — done this
  session.

## Open questions

- T4: RESOLVED — 24/32px is intended. `panel.css:55,57` → `--font-panel-title`/
  `--line-panel-title` (`tokens.css:32-33`) = 24/32, matching the design-system
  type scale (`design-system.md:123-124, 595-598`). The stray `design-system.md:853`
  "26px / 36px" is a doc typo; PR-A fixes both the test assertion and that line.
- PR-D inactive-window: how far to desaturate — rails only, or selection + accent
  too? Match macOS first-responder behaviour during the package.
