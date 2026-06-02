---
status: done
priority: P2
owner: relixiaobo
created: 2026-06-01
updated: 2026-06-02
---

> **Shipped in PR #69 (2026-06-02).** Providers-first (D-SCOPE) landed: inset
> grouped-list primitive, native master-detail Providers, and the per-provider
> config. **D-FORM evolved from an in-renderer sheet to its own native modal-child
> window** (the System Settings attached-dialog idiom) — accepted by the owner as a
> more-native realization of the same "focused credential moment". The design now
> lives in `docs/spec/design-system.md` → "Settings window" (A6). Follow-ups:
> packaged-build visual QA of the config window's native presentation (24pt corner
> per D7, sheet-attach / parent-dim); Permissions / Skills adopting the inset
> primitive (D-SCOPE phase 3).

# Native-Feel Settings Redesign

Evolve the agent **Settings** surface (`src/renderer/ui/agent/AgentSettingsView.tsx`)
toward the macOS System Settings *interaction* idiom — inset grouped lists,
master-detail, focused credential sheets, on-row status — while rendering it
entirely in **our** design system (tokens + B-rules). We borrow the interaction,
not the chrome. Provider settings is the first and motivating section.

> **Not a rewrite.** The bones already exist: a category nav
> (`settings-nav`: Providers / Permissions / Skills / Agent Profiles), a provider
> master-detail (`settings-provider-aside` list + `settings-provider-detail`), status
> badges (`Active` / `Configured`), and vendored brand logos (`providerIcon.ts`).
> This plan refines that structure; it does not replace the provider/permission/model
> logic.

## Sequencing & dependency

- **Unblocked: PR-D merged (#68, 2026-06-01).** PR-D wired the *invocation* mechanism
  — the native app menu, `Cmd+,` → `openSettingsWindow`, native context menus — which
  this redesign consumes (A7: foundation before consumers). With PR-D on `main`, this
  plan is now ready to start when prioritized; build the settings content against the
  settled window-open path.
- **Hand-off & bundling (active 2026-06-01).** Assigned to **cc-2**
  (`cc-2/native-settings-redesign` branch + Draft PR), with a **performance pass**
  folded into the same work (see *Performance* below). Serialize on
  `AgentSettingsView.tsx` with any in-flight settings work. The three IA / form /
  scope questions are now **locked** (see *Decisions (locked)* below) so cc-2 builds
  against fixed contracts, not open options.
- **Cross-cutting plan.** `agent-oauth-providers.md` (draft) adds OAuth sign-in +
  managed credentials to the *same* provider-config surface. The credential sheet
  below MUST be designed so an API-key field is one of several credential modes
  (OAuth, AWS/Vertex managed), not the only one. Coordinate the two so the sheet is
  built once.

## Decisions (locked — 2026-06-01)

The three open questions are resolved; build against these, do not re-open them.

- **D-IA — Hybrid (option A).** The sidebar stays settings *categories*
  (Providers / Permissions / Skills / Agent Profiles). The **Providers** detail
  becomes the inset grouped list with on-row status; selecting a provider opens its
  config in the detail pane. Providers are **not** promoted to top-level sidebar rows
  (option B rejected — it mixes providers into the Permissions/Skills nav level, an
  awkward IA). Credential add/replace lives in a focused **sheet**.
- **D-FORM — Focused credential surface (shipped as a native window).** Originally
  locked as an in-renderer **sheet** + inline detail. **As shipped (PR #69) it evolved
  into the credential editor opening as its OWN native window** — a frameless modal
  child of the settings window (`lin:open-provider-config`, `?surface=provider-config`),
  the System Settings attached-dialog idiom rather than a web overlay. Owner-accepted as
  a more-native realization of the same focused-credential intent. It hosts the
  connection only (credential + base URL inline, async non-blocking validate with
  cancel); model / reasoning stay in the composer. It is multi-mode so
  `agent-oauth-providers.md` (OAuth, AWS/Vertex managed) plugs in as additional modes —
  built once. (The earlier "sheet" wording is kept here for history; the authoritative
  contract is `design-system.md` → "Settings window".)
- **D-SCOPE — Providers-first, primitive built reusable.** This PR builds the
  reusable **inset grouped-list primitive + master-detail shell tokens** (A7
  foundation), then restyles **Providers** on top of them. Permissions / Skills
  adoption is an explicit **follow-up** (Phasing step 3), *not* in this PR — keeps the
  PR reviewable and proves the primitive on the motivating section first.

## What to borrow from macOS System Settings (interaction only)

| macOS pattern | Borrow | Maps to in Lin |
|---|---|---|
| Inset grouped list (rounded card, hairline dividers, section headers, trailing per-row controls) | **Yes — the primary win** | Provider list grouped `Connected` / `Available`, status dot + `⋯` menu per row |
| Master-detail (category sidebar → detail pane) | Already present; polish | `settings-nav` + `settings-content` |
| On-row status (✓ connected, 🔒 secured, signal) | Yes | Provider status model (below) |
| Focused modal sheet for a single credential step | Yes | "Paste API key → validate" as a sheet |
| Sidebar search | Optional / later | A provider search already exists; could grow to full-settings search |

## Information-architecture decision (open)

The reference images conflate two readings — "provider" labelled on a *sidebar row*
vs on a *detail list*. Pick one:

- **A — providers as a detail list (recommended).** Sidebar stays settings
  *categories*; the Providers detail is the inset grouped list with status; selecting
  a provider opens its config. Smallest change; reuses today's structure.
- **B — providers as top-level sidebar entries.** Each provider is its own nav row
  (like Wi-Fi / Bluetooth). More macOS-faithful, but mixes providers into the same
  nav level as Permissions / Skills — an awkward IA.
- **Recommendation: hybrid** — keep categories in the sidebar (A), make the Providers
  detail an inset grouped list with status, and use a focused **sheet** for the
  add-key + validate step (matches the reference's password dialog).

## Design-system red lines (the "our own spec" part)

Copying macOS verbatim violates the B-rules. Enforce:

- **No system accent for selection.** macOS blue selection → neutral `--fill-*`
  selection + neutral focus ring (**B3/B4**). The primary action button (its "OK")
  → the single rose accent or neutral, never system blue (**B4**).
- **No colorful OS-glyph grid.** macOS colorful rounded-square icons → monochrome
  icon chrome (**B6**). The vendored provider brand logo is allowed as *identity*
  (content, not chrome): keep it small and restrained, not a colorful glyph wall.
- **Status color is allowed — for status only.** Availability / validation may use a
  green / amber / red dot (**B4**: status colors carry status meaning only). Selection
  and hover MUST stay neutral; never let status color leak into them.
- **Materials on chrome only.** A translucent settings sidebar maps to **B5** (material
  on the rail, opaque content base, `prefers-reduced-transparency` opaque fallback).
- **Geometry from tokens.** Inset-card radius + hairline derive from the radius /
  hairline ladders (**B9** concentric chain) — no hand-picked values.
- **No web feel.** Arrow cursor on all chrome (**B10**); the PR #65
  `cursor-affordances` guard already polices this — extend it to the new settings DOM.
- **Tiered overlay.** The credential sheet uses the existing dialog elevation tier
  (`confirm-dialog` / level-2, **B10**), not a bespoke shadow.

## Reusable primitive + shell (A7)

Settle two foundations before restyling any section:

1. **Inset grouped-list primitive** — section header + rounded inset card + hairline
   rows + leading icon/avatar + label/sublabel + trailing slot (status, `⋯`). Today's
   `settings-provider-*` and `settings-skills-*` classes are bespoke one-offs;
   collapse them onto this primitive so Permissions and Skills can adopt it later for
   free consistency.
2. **Master-detail shell tokens** — nav rail, detail pane, the back/forward affordance
   if kept.

Do these first; only then port Providers, then optionally Permissions / Skills.

## Config form: inline vs sheet

Provider config is heavier than a Wi-Fi password (credential, base URL, model,
reasoning, validation result). Use **two tiers**, not one:

- **Sheet** for the atomic *add / replace credential → validate* moment — focused,
  matches the reference dialog, and is the natural host for `agent-oauth-providers.md`
  credential modes.
- **Inline detail** for ongoing config (model / reasoning / advanced base URL). A
  modal is wrong for multi-field ongoing settings; all-inline loses the focus of the
  secret-entry moment.

## Provider status model

"Available" is not a boolean. Model the orthogonal states explicitly, each with a
clear affordance:

- **Has credential** (key/OAuth present) → lock-style glyph.
- **Validated / reachable** (a test call succeeded) → green dot; failure → red dot +
  reason.
- **Active** (currently selected provider/model) → ✓ or neutral highlight.
- **Model availability** → surface the current flagship in the detail (the
  recency-ranked registry from #67, `src/main/modelRanking.ts`).

## Performance (bundle into the implementation)

This surface is not on the hot outliner path, but per A9 keep it perceptually crisp:

- **Async, non-blocking validation.** The credential test call must not freeze the
  sheet; show a pending state and a result, with cancel.
- **Long model lists.** Some providers expose 100+ models (Bedrock). The detail's
  model picker should stay responsive — windowing / lazy render if the list is long,
  not a giant synchronous DOM.
- **Material cost.** `backdrop-filter` on the sidebar has a GPU cost; the
  reduced-transparency opaque fallback (B5) doubles as the cheap path.
- **Render isolation.** Master-detail selection should not re-render the whole window;
  keep the nav and detail panes independently memoized.

## Cross-platform note

macOS System Settings is intensely macOS. The *interaction* (inset list,
master-detail, sheet) is portable; the *chrome* (traffic lights, system blue,
colorful glyphs) is not — which is exactly why this plan borrows the former and
forbids the latter (**B10**; see the `native-feel-cross-platform-desktop` guidance).

## Phasing

1. Inset grouped-list primitive + master-detail shell tokens.
2. Restyle Providers: grouped list + status + credential sheet (coordinate with
   `agent-oauth-providers.md`).
3. *Optional:* adopt the primitive for Permissions / Skills for consistency.
4. Guards + spec: extend the `cursor-affordances` / token guards to the new settings
   DOM; update `docs/spec/` (A6) with the settled interaction model.

## Open questions (decide before implementation)

All three are now **RESOLVED** — see *Decisions (locked — 2026-06-01)* above.

1. **IA** — RESOLVED → hybrid (A): categories in the sidebar, Providers as an inset
   grouped detail list (`D-IA`).
2. **Config form** — RESOLVED → two tiers: sheet for credential + inline for ongoing
   config (`D-FORM`).
3. **Scope** — RESOLVED → Providers-first; build the reusable primitive, defer
   Permissions / Skills adoption to a follow-up (`D-SCOPE`).
