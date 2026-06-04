---
status: done
owner: cc
topic: provider-config-cleanup
---

> **Shipped.** Part A in PR #100 (core fix — deliberate rows, startup reconcile
> guarded against keychain-lock / key-rotation / ambient-env data loss), Parts
> B/C/D in PR #101 (provider-list tile + dividers, strong-neutral auth-sheet
> primary, OAuth clarity + coverage guard, 32 display names + Xiaomi icon).
> Design folded into `docs/spec/agent-pi-mono-implementation.md` (Part A) and
> `docs/spec/design-system.md` (B/C/D). Follow-up surfaced post-merge: the OAuth
> sheet keeps the strong primary on *Re-authenticate* in the connected state
> instead of flipping it to *Done* — tracked separately as a fast-track fix.

# Provider config cleanup + settings-UI polish

## Goal

Fix the root cause behind the "shows *Add key* yet offers *Remove provider*"
contradiction in agent → Providers, by making **a config row mean the user
deliberately added a provider** — never a side effect of saving unrelated
settings. Bundle in three PM-requested UI improvements to the Providers surface
that can ship alongside the fix.

The four parts (one plan, see **Sequencing** for how they split into PRs):

- **A — Core fix.** Stop minting keyless provider rows; reconcile
  `configured` vs `hasCredential` so the row menu can't contradict the status
  label; never auto-activate an uncredentialed provider.
- **B — Provider list polish.** Unify provider icons behind a neutral tile
  (底色) and re-cut the row dividers to align with the icon, inset on both
  sides instead of bleeding to the panel edge.
- **C — Auth-sheet button hierarchy.** Give the OAuth / API-key sheet a clear
  primary↔secondary↔danger hierarchy; today the "primary" button reads weaker
  than the "secondary" one.
- **D — OAuth coverage / "Claude Code" clarity.** Confirm we surface every
  OAuth provider pi-ai exposes (we do — all three), and close the naming gap
  that made the PM expect a missing "Claude Code" entry.

## Non-goals

- No storage-format migration. Per pre-release policy there is no prod data;
  junk rows are reconciled on load (Part A) or a dev `userData` wipe — we do
  not write a versioned migration. (See `[[storage-format-no-backcompat-prerelease]]`.)
- Not redesigning the whole settings window, the composer provider picker, or
  the first-run onboarding empty state (`agent-empty-state-onboarding.md` owns
  that surface — keep clear of it).
- No new provider integrations or new auth *kinds*; Part D is coverage
  verification + copy, not new plumbing.
- B6 "icon controls deepen color, no box" is **not** in scope to revisit — a
  provider avatar is brand identity, not an icon control (see Part B note).

## Background — root cause

Confirmed in code **and** on disk (a packaged-app `agent-providers.json` held a
keyless `{providerId:"openai",modelId:"gpt-5.5",enabled:true}` row that was also
set `activeProviderId:"openai"`, while OpenAI showed *Add key*).

1. The main Settings pane's **Save** button is really for runtime settings
   (permissions / skills / active model), but `save()` in
   `AgentSettingsView.tsx:~487` **unconditionally** calls
   `agentUpsertProviderConfig({ providerId: draft.providerId, … enabled:true })`
   whenever `draft.providerId` is set — regardless of whether a key was entered.
2. `resolveInitialDraft()` (`AgentSettingsView.tsx:1017`) defaults
   `draft.providerId` to a *preferred catalog* provider (anthropic / openai / …)
   even when nothing is configured. So clicking Save to persist an unrelated
   permission toggle **materializes a keyless row** for whatever provider
   happened to be the draft default.
3. `upsertProviderConfig()` (`agentSettings.ts:172`) then does
   `file.activeProviderId ??= file.providers[0]?.providerId` — so the keyless
   provider silently becomes **active**.
4. The row `...` menu gates **Remove provider** on `provider.configured`
   (`AgentSettingsView.tsx:~110`), which is true for any row in
   `settings.providers`; the status label gates on `hasCredential`, which is
   false. → the contradiction the PM saw: *Add key* + *Remove provider* on the
   same uncredentialed row, and that row wrongly active.

`configured` (has a row) and `hasCredential` (has a usable key / oauth / env
key) are independent today, and the bug is exactly what makes them diverge in a
way the user can see.

## Design

### Part A — Core fix: rows are deliberate, state can't contradict

Three changes. **Approach decided (Q1 → Approach 1, PM-ratified):** the main
pane stops creating rows entirely — row creation lives only in the per-provider
window + OAuth login.

**A1. The main Settings pane stops creating provider rows.**
The per-provider `ProviderConfigWindow` (and OAuth login's
`ensureProviderConfig`, added in #95) become the **only** paths that create or
edit a provider config row. The main pane's `save()` drops its
`agentUpsertProviderConfig` call and persists only what that pane owns — runtime
settings and the *active provider/model selection*. Selecting an active
provider/model must update `activeProviderId` (and the active model) **without
minting a row** for an uncredentialed provider; if the chosen provider has no
row yet, either route through the same `ProviderConfigWindow` (so the user
supplies a credential) or persist the active selection against an existing
credentialed row only.

This follows A4 (commands are the deliberate mutation surface) and A7 (one
real mechanism, not a legacy dual-write): row creation lives in one place.

**A2. Never auto-activate an uncredentialed provider.**
`upsertProviderConfig`'s `activeProviderId ??= providers[0]` becomes
credential-aware: only auto-set `activeProviderId` to a provider that has a
usable credential (stored key, oauth, env key, or an explicit `baseUrl` local
endpoint). Set the active provider explicitly on a deliberate user action
instead of as an upsert side effect.

**A3. Reconcile on load (handles already-materialized junk + future drift).**
When provider settings are read (`getProviderSettings`), reconcile:
- Drop rows that are **junk**: no stored key **and** no oauth credential
  **and** no `baseUrl` **and** the provider has no env key. (This is exactly
  the shape the bug produced; a legit keyless row — local `baseUrl` or
  env-keyed provider — survives. Predicate is the safe-to-prune test, see Q2.)
- If `activeProviderId` points at a provider that is now uncredentialed /
  rowless, repoint it to the first credentialed provider, else `null`.

This makes the contradiction structurally impossible (uncredentialed providers
have no row → the *Remove provider* branch never shows) rather than papering
over it in the renderer. After A1–A3, re-derive the row menu so **Remove
provider** appears only for a real, user-added row, and confirm the
`configured` vs `hasCredential` split in `buildProviderChoices`
(`AgentSettingsView.tsx:1043`) stays internally consistent.

Files: `src/renderer/ui/agent/AgentSettingsView.tsx` (save/draft/menu),
`src/main/agentSettings.ts` (`upsertProviderConfig`, `getProviderSettings`
reconcile), possibly `src/renderer/ui/agent/ProviderConfigWindow.tsx`. No
`src/core/*` protocol change expected.

### Part B — Provider list: icon tile + divider alignment

**B1. Provider icon 底色 (neutral tile).** Today providers with a vendored
brand SVG render a *naked* glyph (`.settings-provider-avatar.has-logo` →
`background: transparent; border: 0`), while providers without an icon render a
monogram on a `--control-hover` fill. That inconsistency is what reads as
"missing background." Unify: every provider mark sits on **one neutral tile** —
`--fill-1`/`--fill-2` background, concentric radius from the B9 ladder, fixed
size — with the brand SVG (its own brand color is allowed; it is identity, like
an app icon, not a functional-state color per B3/B4) or the monogram centered
inside. Do **not** use per-provider colored tiles (that would reintroduce
brand/system color into chrome). Token-only, so B1/B11 guards stay green.

Files: `src/renderer/styles/settings-providers.css` (`.settings-provider-avatar`
rules ~154–199), `src/renderer/ui/agent/providerCatalog.tsx` (`ProviderAvatar`
if class changes are needed).

**B2. Divider geometry.** Today the row separator
(`settings-inset-list.css:63`, `::after` on `.inset-row:not(:last-child)`) is
inset on the **left** to align with the *text*
(`--inset-separator-inset` ≈ 36px in `settings-providers.css:147`) and runs
**flush to the right edge** (`right: 0`). Per the PM: align the rule's left edge
with the **icon** (the row content padding, where the tile starts — not past
it), and add a matching **right** inset so the rule sits within the row content
instead of bleeding to the panel edge ("居中"/balanced). Net: left inset →
content padding (~`--space-4`), right inset → same. Exact geometry is a
visual-confirm item (Q3) since "align with icon" + "centered" can be read a
couple ways.

### Part C — Auth-sheet button hierarchy

**Problem (measured).** In `settings-provider-sheet.css:240`, `.settings-sheet-
primary` paints `background: var(--fill-3)` (10% ink) with `color:
var(--text-primary)` (88% ink) — ~1.7:1, a faint gray. `.settings-sheet-
secondary` paints white `--surface` + a border — ~21:1. So the *secondary*
button visually outweighs the *primary* ("Sign in", "Save", "Continue"), and
users can't tell the main action apart. Danger is secondary-with-`--status-danger`
text.

**Fix.** Make the hierarchy legible while staying inside B3/B4 (functional
states neutral; one rose accent used sparingly; no `--primary` family):

**Decided (Q4 → strong-neutral-solid, PM-ratified):**

- **Primary** = a genuinely strong **neutral** fill — a solid dark button
  (e.g. `--surface-inverse` `#2e2e32` with on-inverse/white text), the native
  "filled default button" idiom but neutral, not system blue. High contrast,
  unmistakably the main action. (Rose `--accent` was rejected to keep accent
  sparse per B3/B4.)
- **Secondary** = today's bordered surface button (keep).
- **Danger** = keep text-danger; consider reserving it for genuinely
  destructive actions only (Sign out / Remove), so it doesn't compete as a
  third "loud" button.

Also re-check each action's class assignment in `ProviderOAuthForm.tsx` /
`ProviderConfigForm.tsx` so exactly one button per footer is primary.

Files: `src/renderer/styles/settings-provider-sheet.css` (button rules
~240–284; may add a strong-neutral token if none fits),
`ProviderOAuthForm.tsx`, `ProviderConfigForm.tsx` (class assignments only).

### Part D — OAuth coverage / "Claude Code" clarity

**Finding (settled).** pi-ai's built-in OAuth registry
(`@earendil-works/pi-ai` → `utils/oauth/index.js`, `BUILT_IN_OAUTH_PROVIDERS`)
has **exactly three** providers, and we surface all three:

| pi-ai id | pi-ai name | our `OAUTH_SIGN_IN` |
|---|---|---|
| `anthropic` | "Anthropic (Claude Pro/Max)" | ✅ |
| `github-copilot` | "GitHub Copilot" | ✅ |
| `openai-codex` | "ChatGPT Plus/Pro (Codex Subscription)" | ✅ |

There is **no separate "Claude Code" provider.** The Anthropic OAuth flow *is*
the Claude subscription login — its scopes literally include
`user:sessions:claude_code` (`utils/oauth/anthropic.js`). So nothing is missing;
the gap is **naming**: we label it plainly "Anthropic" with hint "Sign in with
your Claude Pro or Max subscription", which doesn't read as "the Claude Code /
Claude.ai login" the PM was looking for.

**Fix (copy only).** Tighten the `OAUTH_SIGN_IN` / display labels so the
Anthropic OAuth entry is recognizable as the Claude subscription sign-in (e.g.
name "Anthropic (Claude Pro/Max)" to match pi-ai, hint mentioning it is the
same login Claude Code uses). No new provider, no plumbing. Add a guard/test or
a short assertion that our OAuth catalog covers `getOAuthProviders()` so a
future pi-ai addition surfaces a TODO rather than silently dropping.

Files: `src/renderer/ui/agent/providerCatalog.tsx` (`OAUTH_SIGN_IN`, name map).

## Open questions

- **Q1 — Part A approach.** ✅ RESOLVED → **Approach 1** (main pane stops
  creating rows; creation only via `ProviderConfigWindow`/OAuth). PM-ratified.
- **Q4 — Primary button color.** ✅ RESOLVED → **strong-neutral-solid**
  (`--surface-inverse` + white text); rose `--accent` rejected. PM-ratified.
- **Q2 — Junk-row prune predicate.** OPEN (implementation-time, non-blocking):
  confirm "no key ∧ no oauth ∧ no baseUrl ∧ no env key ⇒ prune" via the
  reconcile path is acceptable, vs documenting a dev `userData` wipe and adding
  no prune logic (pre-release, no prod data).
- **Q3 — Divider geometry.** OPEN (implementation-time, non-blocking): confirm
  "left aligns to icon/content-padding + symmetric right inset" with a quick
  light/dark screenshot before locking the numbers.

## Sequencing (PRs under this plan)

Independent enough to land separately; keep logic and CSS on separate branches
(per AGENTS.md "keep unrelated concerns on separate branches"):

1. **PR-A — core fix** (`*/provider-config-fix`): Part A. Logic + reconcile;
   needs Q1/Q2 settled. Review gate: `/code-review` medium (no protocol change)
   + a unit test that Save-with-no-key creates **no** row and never activates an
   uncredentialed provider.
2. **PR-B — settings-UI polish** (`*/provider-settings-polish`): Parts B + C +
   D (all renderer/CSS/copy). Review gate: visual verification (light + dark) +
   B1/B11 token guards.

## Subtasks

- [x] PM ratifies plan + answers Q1–Q4.
- [x] PR-A (#100): stop main-pane row creation; credential-aware activation;
      startup reconcile (off the read path, guarded against transient-signal data
      loss); unit tests.
- [x] PR-B/B (#101): icon neutral tile; divider geometry.
- [x] PR-B/C (#101): auth-sheet button hierarchy. **NB:** the class-assignment
      audit missed the connected-state inversion (primary stays on
      *Re-authenticate*, not *Done*) — see the follow-up note in the header.
- [x] PR-B/D (#101): OAuth label/hint clarity + catalog-coverage assertion.
- [x] On ship: Part A semantics folded into `agent-pi-mono-implementation.md`,
      visual rules into `design-system.md`; status `done`; archived.
