# Settings redesign

## Goal

Make Settings answer a user's question instead of exposing the app's module
structure. One axis the user thinks in, one commit model, one status vocabulary,
and detail surfaces that state what they are for — plus the defects the audit
turned up on the way, which are inseparable from the redesign because the
redesign deletes the mechanisms that cause most of them.

## Non-goals

- No new preferences. Nothing that has deliberately no UI gains one: the five
  agent runtime knobs (`AgentRuntimeSettings`), subagent token budgets, the
  launcher hotkey, keyboard-shortcut customization.
- No change to where per-Thread choices live. Model and reasoning effort stay on
  the composer, per-Thread Memory stays in Thread Details. Those are correct.
- No "Check for updates" / in-app updater. It belongs to the release pipeline.
- No capability-block *creation* UI. The API exists with no caller; adding an
  authoring surface is its own feature.
- No document-level view settings. Per-node view configuration is data, edited in
  the outliner, and does not belong here.

## Prior art, and what this does not undo

Five plans have already shaped this surface — `native-settings-redesign` (#69,
the inset grouped-list primitive, the native master-detail Providers pane, and
the per-provider config as a modal child window), `settings-design-consistency`
(#105/#106), `settings-macos-clarity`, `security-settings-ia-redesign`, and
`agent-skill-library-settings` (#470, the one unified Skill list).

**Everything they established about the interaction idiom stands.** Inset grouped
lists, rows that carry status, the config window as a real native modal child
rather than an in-renderer overlay, one Skill list across all sources — this plan
builds on all of it and reuses those primitives.

What none of them settled is what this plan is about: the **axis** the categories
are cut along, the **commit model**, and the **status vocabulary**. Each earlier
pass improved a pane; the rail itself was inherited, and the panes were made
consistent with each other rather than with a user's mental model. That is why a
surface redesigned five times still audits at 56 problems — they were working a
different layer.

## Shape

**(a) — ONE complete feature in one PR.** The sections below are build order
inside that PR (A7: settle the mechanism before the surfaces that consume it),
not shippable slices. The redesign cannot land in halves: the status model, the
commit model, and the pane layout each assume the others.

## Collision self-check

Run at plan time, re-run at review (2026-08-04):

- **#485** (`cc/unified-command-surface`) and **#483**
  (`codex-3/agent-canonical-tool-call-history`) both touch `src/main/main.ts`.
  Real overlap — this plan edits the settings-window creation, the
  settings-changed broadcast, and the About menu item. Expect a rebase; none of
  the three touch the same functions.
- **#480** (`main-agent/release-pipeline`) owns `scripts/release-notes.ts`, which
  About's What's-New section reads. Both a collision and an ordering dependency:
  that section builds after #480 lands. Nothing else in the plan depends on it.
- No overlap on `src/renderer/ui/agent/**`, `src/core/settingsWindow.ts`, or the
  settings stylesheets — the bulk of the diff.
- `src/core/types.ts` is touched (see §6 and §11) and is an
  infrastructure-ownership file; the exact shapes are stated here so the other
  clones can read them without opening the diff.

## Design

### 1. Information architecture

Three categories, cut along user task domains:

| Category | Contents |
|---|---|
| **General** | Appearance (theme, language) · Diagnostics · About ▸ |
| **Agent** | Model services ▸ · Skills ▸ · Memory · Permissions |
| **Preview** | Translation · Websites |

`▸` marks a sub-page. What moves: Memory leaves General for Agent, where a user
looks for it. Security becomes the **Permissions** group inside Agent — one
read-only row, a normally empty list, and a prose footnote do not earn a
top-level slot. Websites and the translation cache leave General for Preview,
which is also where the four translation preferences that today exist *only* in
the preview popover now get a home.

**Skills and Model services are both sub-pages; Memory and Permissions are
inline.** The rule, stated so it can be applied to the next group rather than
argued case by case: *a collection the user installs or connects, unbounded in
size and carrying its own lifecycle, becomes a sub-page; a bounded set of
settings stays inline.* Skills (install, update, trust, uninstall) and model
services (connect, enable, remove) are collections; Memory (three rows) and
Permissions (three rows) are settings. The earlier draft drilled Skills but left
model services inline, which was an asymmetry with no rule behind it.

Skills belongs in Agent because a Skill **is** an agent capability — a user
adding one is thinking "give my agent something it can do", the same reasoning
that moves Memory and Permissions there. That reason stands on its own; the
earlier draft leaned on a second argument (it gives the disabled back/forward
chrome something to do) which had the logic backwards — if the IA reason did not
hold, the right answer would be to delete the arrows, not to invent work for
them. The toolbar becoming useful is a *consequence* of a two-level IA, not a
justification for one.

The add-a-service catalog is a group **on** the Model services page, not a page
of its own; the per-provider config stays a modal child window. So the depth is
two levels of page plus a dialog, which is the System Settings norm.

**No deep-link aliases.** The earlier draft claimed `providers`/`security` would
be aliased "exactly as the retired `permissions` id was handled" — that precedent
does not exist: `c4bf86db` *deleted* `permissions` from the union. There is
exactly one in-app caller passing a category (`ThreadDock.tsx`, `'providers'`)
and no persisted or external deep links, so the ids become
`general | agent | preview` plus `agent/services`, `agent/skills`,
`general/about`, and that one caller is updated.

What a deep link owes the user instead of an alias is **anchoring**: landing at
the top of a long Agent pane is a downgrade for the dock's "open settings"
affordance, so a link carrying a target scrolls to and briefly highlights that
group.

**Translation preferences become bidirectional.** Target language,
auto-translate webpages, auto-translate EPUBs, and translation model already
persist in `app-preferences.json` and already broadcast to every window, so
Settings reads and writes the same preference the popover does. The popover stays
— it is the right place to act in context — and the two surfaces now agree.

Naming, decided and noted (AGENTS.md treats names as reversible locals):
**Agent** (智能体) over "AI". **Preview** (预览) rather than the earlier draft's
"Reading" — the app already ships 预览 as the user-facing word for these panes,
including inside the settings copy being rewritten here
(`websiteDataSublabel`: "URL 预览使用的 Cookie、缓存和网站存储"), so a third term
would be invented to fix a second one. **Model services** (模型服务) replaces
"Providers" in user-facing copy.

Default landing becomes **General**. Providers-on-open is a first-run concern
leaking onto the everyday ⌘, path.

### 2. About

**General → About**, a sub-page. It answers three questions a user actually asks:
what is this, what changed, and how do I reach you.

1. **Identity** — app icon, name, version, copyright, and a **Copy version info**
   action, because the first thing a bug report needs is the
   version/platform/runtime triple that diagnostics export already assembles and
   a user has no way to read back.
2. **What this is** — one short paragraph.
3. **What's new** — the current version's release notes, earlier versions
   reachable from the same page.
4. **Contact & support** — Help and Report an issue (both exist in the native
   Help menu and are repeated here because nobody looks in a menu bar for
   support), plus the product's own channels.
5. **Legal** — open-source acknowledgements and a one-line privacy statement,
   worth stating because it is true and unusual: diagnostics are local-only and
   never uploaded.

**Release notes come from `CHANGELOG.md`** through `scripts/release-notes.ts`,
not a separate hand-written file — already-ratified reasoning in #480: two
descriptions of one release drift, and the one nobody maintains is the one users
read. The in-app rendering differs from the GitHub release body in one way, it
**omits the `Internal` category**, which exists to hold entries written for us
rather than for users. Rendering reuses the markdown pipeline the file preview
ships.

The native **About Tenon** menu item stops opening the OS panel and opens this
page. Two About surfaces would be the duplication this redesign exists to remove,
and the OS panel cannot hold release notes or support links;
`setAboutPanelOptions` stays for the metadata the OS reads elsewhere.

### 3. One commit model

**Everything applies instantly. The footer Save and Cancel are deleted.**

The spec already leans this way, though it is worth being exact about how far:
`docs/spec/design-system/surfaces.md:294-298` says Theme and Language "apply
immediately across windows **without a save footer**" — a statement scoped to
General, which has no footer anyway. So the footer is not strictly
spec-*violating*; it is spec-*absent*. Instant-apply is the documented idiom for
every pane the spec describes, and the footer exists only in the two panes
(Security, Skills) the spec never documents at all. Deleting it makes the surface
uniform and finally writes the rule down.

It is also the highest-value change because it removes a mechanism rather than
adding one: with no draft, the self-broadcast has nothing to revert, the
per-category footer has nothing to hide, and "Cancel closes the window" stops
being a data-loss trap.

**Failure semantics** — the load-bearing rule once the draft is gone, and an A12
question (a write on the user path must degrade, not throw):

- **Optimistic.** The control moves immediately; it reflects intent, not
  confirmation. Perceived responsiveness is the point (A9).
- **Revert on failure.** The control returns to the persisted value and an
  actionable message appears **at that row** with `role="alert"` — not in a shared
  slot at the bottom of the pane. Raw `Error.message` never reaches it; the raw
  text goes to the diagnostics log.
- **Serialized per key.** The write queue the Skill toggles already use is
  extended to provider enable (defect 8), so two fast toggles cannot race and each
  write builds on what main actually stored rather than on a stale read.
- **Never disabled mid-flight.** The current code disables only the footer while
  saving, which taught users nothing; a queued control stays live because the
  queue, not the UI, enforces ordering.

**And the broadcast is fixed at the source.** Deleting the draft removes the
damage but not the bug: `main.ts:2349` still fans `settings-changed` back to the
window that wrote, so every instant toggle would still cost a full
`agentGetProviderSettings()` round-trip and a list re-render in the sender.
Excluding the sender via `BrowserWindow.fromWebContents(event.sender)`, and
keeping the settings-window send only for writes originating in the
provider-config child, is what makes instant-apply actually cheap.

### 4. One status vocabulary

`providerStatusLabel` becomes a typed status model — a state value plus an
optional reason — rendered by one component used in **both** the list row and the
detail window. Consequences:

- "Connected" (OAuth) and "Ready" (list) collapse into one word for one state.
- `Add key` / `Needs key` collapse: the distinction is whether a config row
  exists, which is not a user-visible fact.
- The detail window leads with the same status the list showed.

Skill chips split into **three kinds with distinct weight** — source (where it
came from), state (on/off, update available), attention (modified, needs action)
— instead of seventeen strings sharing one neutral `.settings-chip` skin. The
Enabled/Disabled chip is removed: it duplicates the switch beside it and can
contradict it.

### 5. Provider detail window

Four groups, replacing "one form plus a button row":

1. **Status** — the shared status line, plus the instant actions that today sit
   in the button bar: enable, set as active, remove.
2. **Connection** — the only editable part: key or sign-in, base URL. The stored
   key becomes an explicit row (saved · show · copy · replace) instead of an
   empty field wearing an `sk*****` placeholder that makes "empty means
   unchanged" invisible.
3. **Models** — what this connection actually reaches, with Refresh here rather
   than hidden in the list row's ⋯ menu where its result has nowhere to appear.
4. **Cancel / Save only** at the bottom, governing the connection draft alone —
   which is what makes "Set active discards the key you just typed" impossible.

Key-read and copy feedback move onto the key row; the connection-result slot
stops serving as a mailbox for unrelated messages. The loading skeleton is keyed
to `authKind` so a managed-credential provider stops flashing a key field it will
not have, and an OAuth provider stops flashing a form it will never show.

### 6. The connection probe, and what "Ready" is allowed to mean

Today the list says **Ready** when a credential exists — never when the
connection works. The app owns a probe that knows the difference and throws its
answer away. Making that answer persist is the only part of this plan that
changes protocol state, so it gets its own rules.

**What the probe costs.** Not nothing:
`testProviderConnection` (`agentSettings.ts:1171`) lists models *and* — because
some gateways expose `/models` unauthenticated, so listing alone does not prove a
credential — issues a **1-token completion** (`maxTokens: 1`) against a
discovered or catalog model. Negligible per call, but non-zero and provider-side.
Everything below follows from that: **Tenon never probes silently.**

- **Save does not block on the network.** Saving commits the credential
  immediately — that is the user's intent — and the probe runs after, updating
  the row when it returns. The window closes at once; no timeout to design, no
  "can I close mid-probe" question. The existing explicit **Test connection**
  stays for a user who wants the answer now.
- **No probe on window open, no background refresh, no re-probe on a schedule.**
  A settings surface that costs money to look at is not acceptable.
- **Three outcomes, not two.** A failure that is not about the credential must
  not libel the key:

  | outcome | when | how the status reads |
  |---|---|---|
  | `ok` | probe succeeded | Ready |
  | `rejected` | 401/403 — the credential was refused | **Key rejected** |
  | `unreachable` | timeout, offline, 429, 5xx, DNS | Ready, plus "couldn't check" |

- **Staleness is shown, not hidden.** The record carries a timestamp and the
  detail renders "checked <when>". A stale `ok` is still displayed as Ready — the
  honest reading of "it worked when we last looked" — and the timestamp is what
  lets a user judge. Writing a credential **clears** the record back to
  unverified, so a rotated key never inherits the old verdict.

The field, stated exactly because `src/core/types.ts` is
infrastructure-owned — additive, optional, on `AgentProviderConfigView`:

```ts
connectionCheck?: {
  outcome: 'ok' | 'rejected' | 'unreachable';
  at: number;            // epoch ms
  statusCode?: number;
  message?: string;      // already redacted by redactSecretLikeContent
};
```

It maps directly from what `testProviderConnection` already returns
(`{ success, message, statusCode }`); no existing field changes shape.

### 7. Feedback surfaces

- Errors render at the control that raised them (see §3), not in a shared slot at
  the bottom of a scroll container that outlives the pane that caused it.
- Notices become transient and announced (`aria-live`); errors keep `role="alert"`.
- The managed-skill alert moves inside the dialog, so acquisition failures — the
  entire GitHub-install error surface — stop rendering behind the backdrop.
- **One confirmation idiom**: destructive actions use the native dialog. Reset
  Memory moves off the in-renderer `ConfirmDialog` to match the two Clear actions;
  unbinding a directory gains one, and names how many Skills will disappear.

### 8. Primitives

- `InsetRow` gains the drill-down affordance whose CSS already exists unused, so
  a row that opens a page or a window stops looking identical to a static one.
- Empty states use the `EmptyState` primitive instead of a `disabled` row, which
  reads as a greyed-out rule named "No blocks".
- The two 52-line copy-paste data-maintenance groups collapse into one
  parameterized row.
- Dead state goes: `creatingCustom`, the unread `ProviderDraft` fields, seven dead
  `managed*` i18n keys, four dead category `hint` strings, seven dead CSS blocks.

### 9. Visual system & accessibility

- Sublabels carry the pane's real content and currently fail AA in both themes
  (2.11:1 light); they move up the text ladder. Status colors used as small
  foreground text move to the `-strong` variants dark mode already lifts.
- `dimmed` rows stop being painted at 50% opacity — including, today, the very
  switch that undoes the state.
- The settings base and its "floating" cards stop being the same token, so the
  two-layer model the code comments describe actually renders.
- Trailing row controls get the inset focus ring the main button already uses,
  inside an `overflow: hidden` card that clips outer rings.
- `border-bottom: var(--inset-hairline) …` is invalid CSS — a box-shadow token in
  a border shorthand — and silently drops the separator. Fixed, with the three
  competing hairline treatments unified.
- Hand-rolled px literals give way to tokens; fixed-width label columns give way
  to content-sized ones, since this surface ships a language picker.
- Two new guards, because the audit found these passing CI: raw dimension
  literals, and the level-2 overlay tier for the two settings dialogs the current
  guard's hardcoded regex misses.

### 10. Defects fixed

1. A settings mutation self-broadcasts and wipes the unsaved Skill draft — fixed
   at the source by excluding the sender (§3), not only by deleting the draft.
2. No dirty guard on window close; `lin:close-settings` accepts any sender. The
   draft is gone, but the sender check lands.
3. The Skill trust model is dead UI — resolved by deletion, §11.
4. Rollback sets `updateCommit` to the abandoned commit, so the app reports a
   fake available update and inflates the rail badge.
5. Acquisition errors and notices render behind the dialog backdrop.
6. Install leaves the Skill disabled and the only notice saying so is hidden.
7. One offline update check paints every managed row "Needs attention",
   contradicting the row's own muted diagnostic and `agent-skills.md`.
8. Provider enable toggles have no write serialization (§3).
9. `openSettingsWindow` touches the window without the codebase's own liveness
   guard, throwing inside `ipcMain.handle` on a ⌘, in the close→closed gap.
10. Invalid CSS drops the managed-skill detail separators.
11. Every Skill row is labelled `/name` regardless of `userInvocable`, so a
    model-only Skill advertises a slash command that does nothing. This is a spec
    change too — `agent-skills.md:227` currently mandates the unconditional form.
12. A truncated update diff is presented as complete (`diffTruncated` is produced
    and never read).

### 11. Three rulings folded in

**The connection-probe field lands in this PR** (PM, 2026-08-03) rather than
behind an interface-only PR. Exact shape in §6.

**The OS-notification switch is removed** (PM, 2026-08-03), not wired. It has
never delivered a notification — there is no `new Notification(...)` anywhere in
`src/` — so the control has always been inert. The row, the
`osNotificationsEnabled` preference, and the get/set IPC pair all go; pre-release
carries no migration, so the field is dropped from `app-preferences.json`.
General loses its Notifications group entirely: an empty group is better removed
than staffed with a switch that does nothing.

**The Skill trust model is deleted outright** (PM, 2026-08-03). It is two ideas
under one name, both unreachable today:

- `ratified` is a **permission gate** — `getModelInvocableSkills()` filters on it,
  so an unratified Skill cannot be invoked until the user accepts it. Hardcoded
  `true` since the Agent Core rebuild.
- `accepted` is a **provenance claim** whose only writer is a button gated behind
  that dead flag.

The gate is residue, not oversight: `agent-tool-permissions.md` states Tenon adds
"no agent filesystem sandbox, permission mode, approval policy", and #410 shipped
Full Access as the ratified posture. A per-Skill accept-before-use gate *is* an
approval policy.

What goes: `ratified`/`accepted` on `SkillDefinition` (a **removal** from the
protocol surface, not an additive change), the `getModelInvocableSkills` filter,
`acceptedHash` in the provenance record, the accept / revoke-acceptance commands
and IPC, the Accept button, the Pending / Workspace-not-accepted / Accepted chips
and their i18n keys in both locales, and the spec's acceptance language.

What stays: the provenance record itself — it also holds `agentHash` and
`previousVersion`, which back **Undo last agent edit**, independent of acceptance.

Blast radius, measured: `agentSkills.ts` (~24 references) and
`tests/core/agentSkills.test.ts` (~65) as the bulk, then
`SettingsSkillLibrarySection.tsx`, `main.ts` IPC, `outlinerMock.ts`, the DOM
snapshots, and `src/core/types.ts`. `ThreadService.refreshTrustRecords()` exists
only to propagate acceptance made outside a Thread and is expected to fall out as
dead code; verify at build time rather than assuming.

### 12. Spec updates (same change, A6)

`docs/spec/design-system/surfaces.md` is the main casualty: it advertises a fifth
rail category (**Configuration Profiles**) that has never existed, describes
General as owning only theme and language, and never documents the Security pane,
the Skills pane, or the conditional footer at all.
`docs/spec/design-system/components.md` credits `AgentSettingsView.tsx` with
controls it no longer contains and lists a `CheckboxControl` with zero consumers;
`docs/spec/design-system/decision-audit.md` D43/D44/D46 cite files that no longer
own those decisions; the `docs/spec/design-system.md` implementation index is
missing 8 of 14 settings files.

`docs/spec/agent-skills.md` loses its acceptance language — "Authoring And Trust"
is rewritten to describe provenance as what it will be, an agent-edit record
backing Undo — and the row-action table drops accept / revoke acceptance. Its
`/name` mandate at `:227` becomes conditional on `userInvocable` (defect 11).

`docs/spec/agent-tool-permissions.md` records that the per-Skill gate is gone,
since §11's deletion argument is itself a claim about permission posture and the
spec should not have to be re-derived from a plan.

### 13. Tests

Order matters, because two changes have real semantics and no safety net today:

1. **Before touching it**, write the **old-label → new-state mapping table** for
   `providerStatusLabel` (`settingsProviderModel.ts:169-180`, 9 branches, zero
   direct tests). Pinning the old branches immediately before deleting them buys
   little; the mapping table costs the same, proves no state silently changed
   meaning, and survives as the new model's regression test. Same for the
   footer-visibility rule, which encodes real product logic and is unasserted, so
   its removal would otherwise look like a no-op to CI.
2. **Extend `tests/e2e/outlinerMock.ts`**, which is missing the memory,
   managed-skill, image-generation, and prefs channels. Unhandled channels throw,
   so `MemorySettingsGroup` errors on every e2e run of General and re-fires every
   5s — which means `design-system-runtime.spec.ts:495` has been photographing an
   error banner at every gate. This is the most urgent item in the plan and lands
   first.
3. Add the behavioral coverage that does not exist: theme, language, diagnostics
   outcomes, the feedback surface, and at least one pane rendered in zh-Hans (only
   one settings test renders a non-English locale today).
4. **Regenerate the four DOM snapshots in their own commit, touching nothing
   else**, so the diff can be read on its own — at this size it is not a review
   artifact otherwise. The PR body names the structural changes it is expected to
   show, so a reviewer can check the snapshot against a stated prediction rather
   than reverse-engineering it.

## Open questions

1. **Board entry** in `docs/TASKS.md` (main-agent-owned). Note that `docs:check`
   reports OK for this plan by accident: C2 tests `tasks.includes(slug)` as a
   plain substring and the board mentions the archived
   `native-settings-redesign.md`, of which `settings-redesign` is a substring. The
   guard is not evidence the plan is on the board. Main is fixing C2 separately.
2. **About needs content only the PM owns**: contact channels beyond the two
   GitHub links already in the Help menu, and the one-paragraph product
   description. Empty slots are omitted, not filled with placeholder text.

## Checklist

- [ ] Status model extracted, typed, shared by list + detail; mapping table first
- [ ] Footer Save/Cancel removed; instant writes with optimistic + revert + queue
- [ ] `settings-changed` excludes the sender
- [ ] Categories re-cut to General / Agent / Preview; one caller updated, no aliases
- [ ] Sub-pages: Model services, Skills, About; deep links anchor to their group
- [ ] Translation preferences surfaced in Preview, bidirectional with the popover
- [ ] Provider detail restructured; connection probe persisted per §6
- [ ] Feedback relocated to the row; one confirmation idiom; typed error copy
- [ ] Primitives: drill-down affordance, EmptyState, one data-maintenance row
- [ ] Visual + a11y corrections; two new guards
- [ ] Twelve defects fixed
- [ ] Skill trust model deleted end to end; Undo last agent edit still works
- [ ] Notification switch and its preference removed
- [ ] Specs rewritten, including agent-skills and agent-tool-permissions
- [ ] Mock extended first, new tests added, snapshots regenerated in their own commit
