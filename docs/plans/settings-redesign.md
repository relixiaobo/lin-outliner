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
- No "Check for updates" / in-app updater. It belongs to the release pipeline,
  not to Settings.
- No capability-block *creation* UI. The API exists with no caller; adding an
  authoring surface is its own feature.
- No document-level view settings. Per-node view configuration is data, edited in
  the outliner, and does not belong here.

## Prior art, and what this does not undo

Five plans have already shaped this surface —
`native-settings-redesign` (#69, the inset grouped-list primitive, the native
master-detail Providers pane, and the per-provider config as a modal child
window), `settings-design-consistency` (#105/#106), `settings-macos-clarity`,
`security-settings-ia-redesign`, and `agent-skill-library-settings` (#470, the
one unified Skill list).

**Everything they established about the interaction idiom stands.** Inset grouped
lists, rows that carry status, the config window as a real native modal child
rather than an in-renderer overlay, one Skill list across all sources — this plan
builds on all of it and reuses those primitives.

What none of them settled is what this plan is about: the **axis** the categories
are cut along, the **commit model**, and the **status vocabulary**. Each earlier
pass improved a pane; the rail itself was inherited, and the panes were made
consistent with each other rather than with a user's mental model. That is also
why the audit behind this plan found 56 problems on a surface that has been
redesigned five times: they were not looking at the same layer.

## Shape

**(a) — ONE complete feature in one PR.** The sections below are build order
inside that PR (A7: settle the mechanism before the surfaces that consume it),
not shippable slices. The redesign cannot land in halves: the status model, the
commit model, and the pane layout each assume the others.

## Design

### 1. Information architecture

Three categories, cut along user task domains:

| Category | Groups |
|---|---|
| **General** | Appearance (theme, language) · Diagnostics · About |
| **Agent** | Model services · Memory · Skills · Permissions |
| **Reading** | Translation · Websites |

What moves: Memory leaves General for Agent, where a user looks for it. Security
becomes the **Permissions** group inside Agent — one read-only row, a normally
empty list, and a prose footnote do not earn a top-level slot (Apple keeps
equivalents as a group inside the pane that owns the domain). Websites and the
translation cache leave General for Reading, which is also where the four
translation preferences that today exist *only* in the preview popover now get a
home.

**Skills stops being a top-level category and becomes a sub-page of Agent.** A
Skill is an agent capability — a user adding one is thinking "give my agent
something it can do", which is the Agent domain, the same reasoning that moves
Memory and Permissions there. The only thing that argued for a category of its
own was the pane's size, and sizing the rail by how much code sits behind a
surface is exactly the mistake this redesign is correcting. The Agent pane gets a
**Skills** row carrying the installed count and the update badge; the row drills
into the library, unchanged in substance.

That drill-down is also what makes the toolbar honest. Today the route stack has
one route type, so back/forward is permanently disabled chrome duplicating the
rail two inches to its left. With the Skill library and the add-a-model-service
catalog as real second-level pages, history has something to hold and the arrows
start doing the job they were built for — the fix is to give them work, not to
delete them.

The trade is one extra click for someone who manages Skills often. Acceptable:
Skills are installed rarely and used constantly, and the update badge still
surfaces one level up on the Agent row, so nothing goes unnoticed.

**Translation preferences become bidirectional.** Target language, auto-translate
webpages, auto-translate EPUBs, and translation model already persist in
`app-preferences.json` and already broadcast to every window, so Settings reads
and writes the same preference the popover does. The popover stays — it is the
right place to act in context — and the two surfaces now agree.

Naming is a reversible local, decided here and noted rather than escalated:
**Agent** (智能体) over "AI"; **Reading** (阅读) over "Translation", because
website data belongs to the reading domain and not to translation. **Model
services** (模型服务) replaces "Providers" in user-facing copy.

Default landing becomes **General**. Providers-on-open is a first-run concern
leaking onto the everyday ⌘, path.

Deep-link ids become `general | agent | reading`, plus `agent/skills` for the
sub-page. `providers` and `security` are kept as **aliases** resolving to
`agent`, and `skills` to the sub-page, exactly as the retired `permissions` id
was handled — the agent dock's "open settings" call and any persisted link keep
working.

### 2. About

**General → About**, a sub-page (the third consumer of the drill-down mechanism,
alongside the Skill library and the service catalog). It answers three questions
a user actually asks: what is this, what changed, and how do I reach you.

1. **Identity** — app icon, name, version, copyright, and a **Copy version info**
   action. The action exists because the first thing a bug report needs is the
   version/platform/runtime triple that diagnostics export already assembles;
   today a user has no way to read it back.
2. **What this is** — one short paragraph. A settings pane is not a landing page:
   Apple's About is facts, and the intro earns its place only by orienting
   someone who opened Settings before they understood the product.
3. **What's new** — the current version's release notes, rendered in-app, with
   earlier versions reachable from the same page.
4. **Contact & support** — Help and Report an issue (both already exist in the
   native Help menu and are duplicated here because nobody looks in a menu bar
   for support), plus the product's own channels.
5. **Legal** — open-source acknowledgements, and a one-line privacy statement.
   That statement is worth making because it is true and unusual: diagnostics are
   local-only and never uploaded, which the error-observability spec already
   guarantees.

**Where release notes come from.** From `CHANGELOG.md`, through the extractor
`scripts/release-notes.ts` — *not* from a separate hand-written file. That is
already-ratified reasoning in the release-pipeline work (#480): two descriptions
of one release drift, and the one nobody maintains is the one users read. The
in-app rendering differs from the GitHub release body in exactly one way — it
**omits the `Internal` category**, which exists precisely to hold entries written
for us rather than for users. One source of truth, two renderings. Rendering
reuses the markdown pipeline the file preview already ships.

**Ordering dependency:** #480 is open, not merged. It supplies both the
per-version changelog structure and the extractor this page reads. About's
What's-New section builds on top of it; the rest of this plan does not.

The native **About Tenon** menu item stops opening the OS panel and opens this
page instead. Two About surfaces would be the same duplication this redesign
exists to remove, and the OS panel cannot hold release notes or support links.
`setAboutPanelOptions` stays for the metadata the OS reads elsewhere.

### 3. One commit model

**Everything applies instantly. The footer Save and Cancel are deleted.**

This is the single highest-value change, because it removes a mechanism rather
than adding one:

- Skill toggles commit through the write queue that managed toggles already use,
  so the two identical-looking switches stop meaning different things.
- Capability-block removal commits on the row, behind a confirmation.
- With no draft, the self-broadcast that silently reverted pending toggles has
  nothing to revert, the per-category footer that hid dirty state has nothing to
  hide, and "Cancel closes the window" stops being a data-loss trap.

The per-provider connection form keeps Cancel/Save, because it is a genuine modal
dialog editing one object — but it keeps *only* that (see §4).

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
   in the button bar: enable, set as active, remove. Apple puts "Forget This
   Network…" in the pane, not next to Done.
2. **Connection** — the only editable part: key or sign-in, base URL. The stored
   key becomes an explicit row (saved · show · copy · replace) instead of an
   empty field wearing an `sk*****` placeholder that makes "empty means
   unchanged" invisible.
3. **Models** — what this connection actually reaches, with Refresh here rather
   than hidden in the list row's ⋯ menu, where its result has nowhere to appear.
4. **Cancel / Save only** at the bottom, governing the connection draft alone —
   which is what makes "Set active discards the key you just typed" impossible.

Key-read and copy feedback move onto the key row; the connection-result slot
stops serving as a mailbox for unrelated messages. The loading skeleton is keyed
to `authKind` so a managed-credential provider stops flashing a key field it will
not have, and an OAuth provider stops flashing a form it will never show.

**Saving runs the connection probe** (the same IPC the Test button calls) and
persists the result, so a stored-but-wrong key stops reading as "Ready". This is
the one part of the plan that touches the protocol surface — see Open questions.

### 6. Feedback surfaces

- Errors render at the control that raised them, not in a shared slot at the
  bottom of a scroll container that outlives the pane that caused it.
- Notices become transient and announced (`aria-live`); errors keep `role="alert"`.
- The managed-skill alert moves inside the dialog, so acquisition failures — the
  entire GitHub-install error surface — stop rendering behind the backdrop.
- **One confirmation idiom**: destructive actions use the native dialog. Reset
  Memory moves off the in-renderer `ConfirmDialog` to match Clear website data
  and Clear saved translations; unbinding a directory gains one, and names how
  many Skills will disappear.
- Raw `Error.message` stops reaching product UI. Mutation paths map to typed,
  actionable copy; the raw text goes to the diagnostics log.

### 7. Primitives

- `InsetRow` gains the drill-down affordance whose CSS already exists unused, so
  a row that opens a window stops looking identical to a static one.
- Empty states use the `EmptyState` primitive instead of a `disabled` row, which
  reads as a greyed-out rule named "No blocks".
- The two 52-line copy-paste data-maintenance groups collapse into one
  parameterized row.
- Dead state goes: `creatingCustom`, the unread `ProviderDraft` fields, the seven
  dead `managed*` i18n keys, the four dead category `hint` strings, the seven dead
  CSS rule blocks.

### 8. Visual system & accessibility

- Sublabels carry the pane's real content and currently fail AA in both themes;
  they move up the text ladder. Status colors used as small foreground text move
  to the `-strong` variants that dark mode already lifts.
- `dimmed` rows stop being painted at 50% opacity — including, today, the very
  switch that undoes the state.
- The settings base and its "floating" cards stop being the same token, so the
  two-layer model the code comments describe actually renders.
- Trailing row controls get the inset focus ring the main button already uses,
  inside an `overflow: hidden` card that clips outer rings.
- `border-bottom: var(--inset-hairline) …` is invalid CSS — a box-shadow token in
  a border shorthand — and silently drops the separator. Fixed, along with the
  three competing hairline treatments.
- Hand-rolled px literals give way to tokens; fixed-width label columns give way
  to content-sized ones, since this surface ships a language picker.
- New guards, because the audit found these passing CI: raw dimension literals,
  and the level-2 overlay tier for the two settings dialogs the current guard's
  hardcoded regex misses.

### 9. Defects fixed

Each of these is a defect, not a preference — verified in source, and listed so
the PR body can be checked against reality:

1. A settings mutation self-broadcasts and wipes the unsaved Skill draft
   (`main.ts` sends `settings-changed` to the settings window itself).
2. No dirty guard on window close; `lin:close-settings` accepts any sender.
   Moot once the draft is gone, but the sender check stays.
3. The Skill trust model is dead UI — `deriveSkillTrust` hardcodes
   `ratified: true`, so Pending/Accept can never render. Resolved by deletion,
   §12.
4. Rollback sets `updateCommit` to the abandoned commit, so the app reports a
   fake available update and inflates the rail badge.
5. Acquisition errors and notices render behind the dialog backdrop.
6. Install leaves the Skill disabled and the only notice saying so is hidden.
7. One offline update check paints every managed row "Needs attention",
   contradicting both the row's own muted diagnostic and `agent-skills.md`.
8. Provider enable toggles have no write serialization.
9. `openSettingsWindow` touches the window without the codebase's own liveness
   guard, throwing inside `ipcMain.handle` on a ⌘, in the close→closed gap.
10. Invalid CSS drops the managed-skill detail separators.
11. Every Skill row is labelled `/name` regardless of `userInvocable`, so a
    model-only Skill advertises a slash command that does nothing.
12. A truncated update diff is presented as complete (`diffTruncated` is produced
    and never read).

### 10. Spec updates (same change, A6)

`surfaces.md` is the main casualty: it advertises a fifth rail category
(**Configuration Profiles**) that has never existed, describes General as owning
only theme and language, and never documents the Security pane, the Skills pane,
or the conditional footer Save at all. It gets rewritten to the shipped IA.
`components.md` credits `AgentSettingsView.tsx` with controls it no longer
contains and lists a `CheckboxControl` with zero consumers; `decision-audit.md`
D43/D44/D46 cite files that no longer own those decisions; the `design-system.md`
implementation index is missing 8 of 14 settings files.

`agent-skills.md` also loses its acceptance language: the "Authoring And Trust"
section is rewritten to describe provenance as what it will actually be — an
agent-edit record backing Undo — and the row-action table drops accept and revoke
acceptance.

### 12. Three rulings folded in

**The connection-probe field lands in this PR** (PM, 2026-08-03) rather than
behind an interface-only PR. `AgentProviderConfigView` in `src/core/types.ts` is
an infrastructure-ownership file, so the addition is announced on the PR and kept
to one additive field plus its writer; no existing shape changes.

**The OS-notification switch is removed** (PM, 2026-08-03), not wired. It has
never delivered a notification — there is no `new Notification(...)` anywhere in
`src/` — so the control has always been inert. The row, the
`osNotificationsEnabled` preference, and the get/set IPC pair all go; pre-release
carries no migration, so the field is simply dropped from
`app-preferences.json`. General loses its Notifications group entirely, which is
the honest outcome: an empty group is better removed than staffed with a switch
that does nothing. If notification delivery is built later it arrives with its
own preference.

**The Skill trust model is deleted outright** (PM, 2026-08-03). It is two ideas
under one name, and both are unreachable today:

- `ratified` is a **permission gate** — `getModelInvocableSkills()` filters on it,
  so an unratified Skill cannot be invoked by the model until the user accepts it.
  It has been hardcoded `true` since the Agent Core rebuild.
- `accepted` is a **provenance claim** — "I reviewed exactly these bytes" — whose
  only writer is a button gated behind that dead flag.

The gate is not an oversight, it is residue: `agent-tool-permissions.md` states
Tenon adds "no agent filesystem sandbox, permission mode, approval policy", and
#410 shipped Full Access as the ratified posture. A per-Skill accept-before-use
gate *is* an approval policy. Deleting it aligns the code with the decision that
already governs it.

What goes: `ratified` and `accepted` on `SkillDefinition`, the
`getModelInvocableSkills` filter, `acceptedHash` in the provenance record, the
accept / revoke-acceptance commands and their IPC, the Accept button, the
Pending / Workspace-not-accepted / Accepted chips, their i18n keys in both
locales, and the spec's acceptance language.

What stays: the provenance record itself. It also holds `agentHash` and
`previousVersion`, which back **Undo last agent edit** — that action is
independent of acceptance and keeps working.

Blast radius, measured: `agentSkills.ts` (~24 references) plus
`tests/core/agentSkills.test.ts` (~65) as the bulk, then
`SettingsSkillLibrarySection.tsx`, `main.ts` IPC, `outlinerMock.ts`, the DOM
snapshots, and `src/core/types.ts` — the **second** protocol-surface touch in this
PR, announced together with the connection-probe field. `ThreadService`'s
`refreshTrustRecords()` exists only to propagate acceptance made outside a Thread
and is expected to fall out as dead code; verify at build time rather than
assuming.

### 13. Tests

Order matters, because two changes have real semantics and no safety net today:

1. **Before touching them**: table-driven unit tests for `providerStatusLabel`
   (a 9-branch ladder with zero direct tests) and for the footer-visibility rule,
   pinning current behavior.
2. **Extend `tests/e2e/outlinerMock.ts`**, which is missing the memory,
   managed-skill, image-generation, and prefs channels. Unhandled channels throw,
   so `MemorySettingsGroup` currently errors on every e2e run of General and
   re-fires every 5 seconds — which means the design-system contrast probe has
   been photographing an error banner.
3. Add the behavioral coverage that does not exist: theme, language, and
   notification controls; diagnostics outcomes; the shared feedback surface.
4. **Regenerate the four DOM snapshots last**, as a reviewed artifact. That file
   is a deliberate refactor tripwire; its diff is the clearest record of what the
   redesign moved.

## Open questions

1. **Board slot.** This plan needs an entry in `docs/TASKS.md`, which is
   main-agent-owned. Note that `docs:check` currently reports OK for it — but only
   by accident: C2 tests `tasks.includes(slug)` as a plain substring, and the
   board already mentions the archived `native-settings-redesign.md`, of which
   `settings-redesign` is a substring. The guard is therefore not evidence the
   plan is on the board, and any slug that is a substring of another mention
   escapes C2 the same way.
2. **About needs content only the PM owns.** Two pieces cannot be invented:
   the product's own contact channels beyond the two GitHub links already in the
   Help menu (support email? website? community?), and the one-paragraph
   description of what Tenon is. The page ships the slots either way; empty ones
   are simply omitted rather than filled with placeholder text.

## Checklist

- [ ] Status model extracted, typed, shared by list + detail; unit tests first
- [ ] Footer Save/Cancel removed; skill + capability writes go instant
- [ ] Categories re-cut to General / Agent / Reading, aliases kept
- [ ] Sub-page routing: Skill library, add-a-service catalog, and About become
      real second-level pages, giving back/forward actual work
- [ ] About: identity + copy-version, intro, What's new, contact, legal; native
      About menu item re-pointed at it (What's-new section lands after #480)
- [ ] Translation preferences surfaced in Reading, bidirectional with the popover
- [ ] Provider detail restructured into Status / Connection / Models / commit bar
- [ ] Feedback surfaces relocated; one confirmation idiom; typed error copy
- [ ] Primitives: drill-down affordance, EmptyState, one data-maintenance row
- [ ] Visual + a11y corrections; two new guards
- [ ] Twelve defects fixed
- [ ] Skill trust model deleted end to end; Undo last agent edit still works
- [ ] Notification switch and its preference removed
- [ ] Specs rewritten to the shipped surface
- [ ] Mock extended, new tests added, snapshots regenerated last
