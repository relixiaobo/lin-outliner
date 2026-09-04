# Settings Control Plane

This plan is a **set of two independently complete features**, each delivered
in one PR:

1. a task-complete Agent-facing Settings CLI and built-in Skill over one
   validated Host control plane; and
2. a clean-slate Settings window that consumes that control plane and adds
   complete shortcut customization.

The second feature depends on the first because UI, CLI, and Skill must consume
the same final semantics. The first feature is not an interface-only scaffold:
after it ships, an Agent can inspect and change supported settings end to end
while the current Settings window continues to work.

## Goal

Turn Settings into Tenon's user control center instead of a hierarchy built
from implementation subsystems. A user should be able to understand what Tenon
will look like, what AI resources it uses, what Agents may do and remember, what
keyboard commands are available, and what local data exists without learning
the current storage or process topology.

The same product model must support three different consumers without forcing
them to mirror one another:

- the Settings window helps a person understand, inspect, and manage state;
- `tenon settings` gives scripts and Agent Bash a precise, validated, bounded
  command surface; and
- the built-in `settings` Skill routes natural-language intent to the shortest
  safe CLI workflow.

The clean-slate answer is the selected target. The current
`General -> Agent -> Preview` navigation, `category + page` routing, eager
cross-domain loading, and split preference APIs are resolvable pre-release
constraints, not product requirements.

- **OBJ-1:** A user can predict where a control lives from the thing they want
  to affect, with no category landing page that merely links to another page.
- **OBJ-2:** An Agent can answer a settings question with one bounded read and
  complete a supported low-risk change with one validated mutation.
- **OBJ-3:** UI, CLI, Skill, runtime evaluation, and deep links agree on the
  effective value, availability, validation, and owner of every exposed
  capability.
- **OBJ-4:** Credentials never become model-readable, and destructive or
  authority-expanding actions cannot be self-confirmed by the Agent that asked
  for them.
- **OBJ-5:** Opening one Settings section loads and reports only that section's
  state; an unrelated Provider, Skill, Memory, or update failure cannot break
  the visible page.

## Non-goals

- Do not preserve the current category/page URLs, aliases, or component
  hierarchy. Update every in-app caller in the same clean cut.
- Do not merge preferences, Provider configuration, Agent resources, secrets,
  Memory, and data maintenance into one file or one oversized DTO.
- Do not expose raw API keys, OAuth material, secret-file paths, private Host
  handles, or secret-bearing errors through the renderer, CLI, Skill, or Agent
  transcript.
- Do not turn every UI control into a CLI flag or every CLI capability into a
  visible row. The consumers share semantics, not presentation topology.
- Do not make Translation a Settings destination. Translation language, model,
  automatic behavior, and saved-translation maintenance stay with the active
  webpage, caption, or EPUB language controls.
- Do not make standard text editing, focus navigation, Escape, Return, Tab,
  copy/paste, undo/redo, or other interaction grammar user-remappable.
- Do not add a model-native settings tool. The Agent route remains Skill to
  `bash` to the packaged CLI, following the public Outline precedent.
- Do not create a general remote administration API or promise that
  `tenon settings` works without a running, authenticated Tenon Host.
- Do not add a second audit/history store. Agent-originated changes already
  retain the Bash invocation and bounded result in canonical Thread history.
- Do not redesign the Provider, Agent, or Skill editors' domain behavior unless
  the new shared contract exposes an existing contradiction.
- Do not add full-Settings search in this work. Shortcuts has local search
  because its command list is intrinsically scan-heavy.
- Do not ship migration readers. Reset affected pre-release settings data when
  a persisted shape changes and delete the retired decoder.

## Decision And Evidence

The selected direction is a shared Host control plane with consumer-specific
UI, CLI, and Skill surfaces, followed by a flat Settings rewrite and complete
shortcut customization. A visual-only reorganization is rejected because it
would preserve the split mutation semantics and force the CLI/Skill work to
replace the UI's assumptions again.

Current evidence:

- `SettingsCategoryTarget`, `SettingsPageTarget`, and `PAGE_CATEGORY` encode an
  artificial category/page relationship before any user task is considered.
- `AgentSettingsView` owns navigation, Provider and capability snapshots,
  Provider and Skill mutation queues, update/Skill badges, global feedback, and
  eager startup requests even when the user opens General.
- `SettingsAgentSection` mixes three resource managers, Memory, access status,
  and persistent blocks under one overview.
- `MemorySettingsGroup` polls every five seconds and sends inspection failures
  to shell feedback; the Open Memory path currently performs an ensure mutation
  before navigation.
- `SettingsPreviewSection` mixes contextual translation behavior with global
  website data maintenance, while `appPreferences` persists translation beside
  appearance and root-Thread selection.
- `agentSettings` combines Provider connections, runtime settings, image
  settings, model catalogs, and credential storage behind a DTO whose shape is
  unsuitable as a general Settings contract.
- `shortcutRegistry` already centralizes many runtime bindings, but only the
  launcher's chosen global accelerator is shown in Settings and it is read-only.

## Design

### 1. Lessons carried forward from the Outline redesign

The Settings work adopts the principles that made the public Outline interface
coherent, rather than copying its command names:

1. **Model the domain before its consumers.** Outline settled Node, Field,
   View, and Operation before rebuilding CLI and Skill behavior. Settings must
   first settle Setting, Resource, Credential, Operation, and Context Control;
   the window must not become the place where those semantics are invented.
2. **Use public vocabulary, not storage choreography.** `theme`, `memory`,
   `models`, and `blocked actions` are product concepts. JSON filenames,
   Provider DTOs, capability maps, Electron accelerators, and IPC channels are
   implementation details.
3. **One intent has one semantic invocation.** The CLI owns lookup, validation,
   persistence, live application, and verification. The Agent does not inspect
   files, synthesize IPC, discover internal IDs, or issue a write followed by a
   second read merely to learn whether it worked.
4. **Receipts close the loop.** A successful mutation means the value was
   persisted and its live effect was applied. The receipt states
   `applied`, `no-change`, `cancelled`, or `refused`, includes safe before/after
   values and recovery guidance, and never reports success at dispatch time.
5. **Progressive disclosure beats schema dumping.** The Skill teaches routing
   and safety. Exact command help and narrow registry-derived examples carry
   uncommon syntax. A complete internal schema is not normal Agent context.
6. **One registry generates every secondary description.** Validation,
   command help, examples, shortcut labels, accepted values, risk, sensitivity,
   and tests derive from the owning definition instead of drifting across UI,
   CLI, Skill prose, and runtime conditionals.
7. **A clean cut is cheaper than permanent aliases.** Tenon is pre-release.
   Retired routes, duplicated preference APIs, and obsolete Skill instructions
   disappear in the same PR that replaces them.
8. **Test composition, not only parts.** Unit tests for a codec, store, CLI, and
   Skill do not prove the Agent's real Bash environment reaches the owning Host.
   Acceptance crosses Skill -> Bash -> packaged CLI -> authenticated Host ->
   persisted and live state.

These rules also apply two later project lessons. A setting with more than one
source must define the event that invalidates an older fallback, and adjunct
configuration such as an Agent execution choice must resolve from the same
winning user/project layer as the Agent definition it belongs to.

### 2. Product boundary

The control plane distinguishes five concepts:

| Concept | Meaning | Examples | Agent visibility |
| --- | --- | --- | --- |
| **Setting** | A bounded value that persists and changes future behavior | theme, interface language, Memory enabled, a shortcut binding | safe current/effective/default values |
| **Resource** | A named object with its own identity and lifecycle | model connection, Agent definition, Skill | bounded metadata and status; only explicit supported actions |
| **Credential** | Secret material proving access | API key, OAuth tokens | status and owning resource only; never bytes |
| **Operation** | An explicit action rather than a standing value | refresh models, check updates, export diagnostics, reset Memory, clear website data | safe status/result; Host confirmation where required |
| **Context Control** | Behavior meaningful only while using content | translation language/model/automatic mode/cache | absent from Settings; owned by the preview language surface |

Physical stores remain separate and owned by their domains. The unified part is
the capability definition, validation, sensitivity, risk, mutation result,
change event, and adapter contract. A generic settings service delegates to the
existing owners; it never reads or rewrites their files itself.

Each capability definition has a stable public id, user-facing domain,
localized label key, kind, scope, readable projection, allowed operations,
value codec where applicable, default/effective-value resolver, sensitivity,
risk class, owner adapter, and invalidation event. Resource-specific fields
stay in typed resource contracts instead of entering a universal value union.

There is no cross-owner atomic batch. One CLI mutation targets one setting,
resource action, or operation. An owner validates its complete candidate,
commits once, applies the live effect, and only then returns a receipt. Requests
that would require two owners either use an explicit domain operation that owns
the composition or are refused before either side changes.

### 3. Final Settings information architecture

The rail is flat. Group labels aid scanning but are not selectable landing
pages, and no row exists only to reveal another level.

| Rail group | Destination | User question answered | Contents |
| --- | --- | --- | --- |
| Application | **General** | How does Tenon look and speak? | Theme, interface language |
| Application | **Shortcuts** | How do I invoke Tenon commands from the keyboard? | Searchable configurable command list, conflicts, reset |
| AI | **Models** | Which model connections can Tenon use? | Provider/model status, active connection, configuration entry |
| AI | **Agents** | Which Agents exist and how will new runs behave? | Built-in/custom identities, instructions, capabilities, execution selection |
| AI | **Skills** | Which Skills are available and enabled? | Unified library, source/status, install/link/update/enable actions |
| AI | **Memory** | What does Tenon remember? | Enablement, current status, Open Memory, reset |
| Privacy | **Access & Data** | What may Agents access, and what local web data exists? | Effective access summary, blocked actions, website data maintenance |
| System | **About** | Which build is this, is it current, and how do I diagnose it? | Version/update, diagnostics, help, issue reporting, legal |

There is no `Agent` landing page and no `Preview` destination. `Models`,
`Agents`, and `Skills` are first-class resource managers rather than children
of a catch-all AI page. Memory is separate because enablement, asynchronous
status, editable durable content, and destructive reset form one complete user
job; it must not poll or fail inside an unrelated Agent overview.

All translation controls and translation-cache maintenance move to the existing
preview language surface. Website data remains in Access & Data because it is
cross-site local state with sign-out consequences, not a preference for the
currently viewed page.

General is the default route. About remains addressable from the application
menu. Contextual failures and actions deep-link directly to one flat section
and optional entity or anchor. The route contract becomes `section` plus an
optional typed subject; `category + page` and contradictory pairs disappear.

### 4. Shared control plane and state ownership

A main-process `SettingsService` owns the public registry and typed adapters.
It exposes narrow operations to two transports:

- preload IPC for the Settings window and in-app deep links; and
- an authenticated local CLI transport for `tenon settings`.

The service returns section or command projections, not one global snapshot.
Opening General cannot read Providers, capability rules, Skills, Memory, or app
update state. Rail badges that require loading an unmounted domain are removed;
status belongs on the destination that owns it.

Every mutation publishes a typed change event containing the affected public
ids and owner revision. Consumers invalidate only the affected slice and
discard stale responses by owner revision. A Settings window and a running
Agent therefore observe CLI-originated changes without polling or reloading
unrelated domains. Memory status uses its owner notification/subscription while
the Memory section is visible; the current five-second renderer poll retires.

Failure ownership follows the action:

- route-load failure renders inside that route with Retry;
- field or row mutation failure stays with that field or row;
- editor failure stays in the editor that submitted it;
- a cancelled native confirmation is a normal `cancelled` result; and
- inspection-only status failure degrades that status without disabling other
  controls.

The shell owns only navigation, route lifetime, and window chrome. It does not
own Provider drafts, Skill queues, Memory polling, resource counts, or one
global error/notice banner. Every control keeps the existing immediate-commit
behavior unless its domain editor already has an explicit Save transaction.

### 5. `tenon settings` CLI and built-in Skill

Ship a packaged `tenon` executable with a `settings` command family. This plan
does not rename or proxy the existing `outline` executable. The public shape is
intent-oriented:

```text
tenon settings list
tenon settings get appearance.theme
tenon settings set appearance.theme dark
tenon settings reset appearance.theme
tenon settings shortcuts list
tenon settings shortcuts set global.launcher mod+shift+space
tenon settings models list
tenon settings models activate openai
tenon settings agents list
tenon settings agents set-execution explore --input -
tenon settings skills list
tenon settings skills disable browser-pilot
tenon settings memory status
tenon settings memory disable
tenon settings access blocks
tenon settings open models
```

Exact subcommands and JSON schemas derive from the capability registry. Default
output is concise human-readable text; `--json` returns the same bounded typed
result. `list`, exact help, and narrow examples are available without dumping
secret or irrelevant domain schemas.

The initial Agent surface is complete for these jobs:

- read, set, and reset exposed scalar settings;
- list and inspect safe metadata/status for Models, Agents, and Skills;
- perform stable low-risk actions such as activation, enable/disable, model
  refresh, Agent execution selection, Skill enable/disable, and Memory
  enable/disable;
- inspect Agent access and persistent blocked actions;
- request owner-confirmed destructive actions; and
- open the exact native Settings destination or credential editor when human
  input is required.

Full Provider credentials, OAuth, local-directory selection, remote Skill
review, and free-form secret input are native-only workflows. The CLI may open
their exact UI but has no input or output field capable of carrying secret
bytes. Resource create/edit actions use their existing complete domain codecs;
the generic scalar `set` command cannot manufacture a Provider, Agent, or Skill.

The built-in inline `settings` Skill is a compact router. It teaches the five
product concepts, when to use an in-context control, which changes require a
person, and how to use receipts. It does not copy the registry, enumerate every
model, Agent, Skill, or shortcut, or claim that loading the Skill grants
authority. Unknown syntax progresses from one exact help/example request, not a
full schema dump or trial-and-error mutation.

Agent Bash receives the packaged executable location and a short-lived
Host-issued capability bound to the originating root Turn and exact normalized
request. Directly editing preference JSON or invoking renderer IPC is never a
fallback. The real composition path must be tested in development and packaged
layouts.

### 6. Permission, confirmation, and receipt rules

Capabilities have one of four risk classes:

- **inspect:** safe bounded reads and targeted UI opening;
- **routine:** reversible setting changes and ordinary enable/disable actions;
- **confirmed:** destructive, authority-expanding, or broad lifecycle actions;
  and
- **native-only:** credential entry and workflows whose review requires a
  person-controlled surface.

Normal Agent permission evaluation still applies before the CLI process can
act. A `confirmed` request additionally creates a native Host confirmation tied
to the exact normalized action and current target revision. The requesting
Agent cannot satisfy that confirmation through `--yes`, stdin, environment,
replay, or a second CLI call. A stale target invalidates the confirmation and
requires a fresh review. Cancellation changes nothing and returns `cancelled`.

Removing a persistent block is authority-expanding and therefore confirmed.
Resetting Memory, clearing website data, deleting a Provider/Agent/Skill, and
install/update review are confirmed or native-only according to their existing
domain contract. Theme, language, eligible shortcut bindings, Memory
enable/disable, active Provider selection, and resource enable/disable are
routine when explicitly requested by the user and permitted by the Agent's
effective capability policy.

Receipts contain the public capability id, result status, safe effective
before/after value or resource status, owner revision, and next action when
human input or recovery is needed. They never include credential values, raw
Provider errors, private paths, internal DTOs, or an unbounded resource list.

### 7. Shortcut model and experience

Create one user-command registry separate from DOM key handling. A command is
configurable only when its definition explicitly opts in and supplies a stable
id, localized label/category, scope, default portable binding, alternate
bindings if any, and collision rules. Consumers match and format resolved
bindings from this registry; no component hard-codes a configurable keystroke.

Initial configurable commands are:

- global launcher;
- open Agent panel;
- new Thread;
- go to Today;
- active-pane Back and Forward;
- toggle translation for the active supported preview;
- move selected rows up or down;
- duplicate selected rows;
- toggle selected/current-row checkbox; and
- open the selected-row tag action.

Standard platform editing commands and structural interaction grammar remain
fixed as stated in Non-goals. A command may have a global OS scope, application
scope, or a narrower mutually exclusive context. Conflict detection compares
only scopes that can be active together; the same binding in disjoint contexts
is valid.

The Shortcuts destination provides local search, category groups, command name,
current binding, record-new-binding control, conflict explanation, per-command
Reset, and Reset All. Recording captures one chord, ignores modifier-only input,
allows Escape to cancel, and does not persist an invalid or conflicting value.
Portable CLI spelling uses tokens such as `mod+shift+o`; macOS presentation uses
native symbols. Electron accelerator strings are not public vocabulary.

Changing an application binding persists and broadcasts before every hint and
handler resolves the new value. Changing the global launcher binding is one
atomic owner operation: main attempts registration first, keeps the prior
working registration and persisted value on failure, and commits only after the
new binding is active. A CLI conflict result names the conflicting Tenon command
when known; an OS-level conflict reports that the combination is unavailable
without inventing another application's identity.

### 8. Main user flows

#### FLOW-1: Person changes a setting

The user opens Settings, chooses one flat destination, and sees only that
domain's loading state. Changing a bounded scalar value applies immediately.
Success is visible in place; failure leaves the last effective value visible
with a local retry. Closing or switching destinations cannot discard an already
committed change or leak its feedback into another page.

#### FLOW-2: Agent changes a routine setting

The user asks in natural language. The Agent loads the `settings` Skill, uses
one exact CLI mutation, and receives a committed receipt. UI and runtime
consumers observe the typed change event. The Agent reports the effective result
without rereading the setting unless the receipt explicitly says settlement is
unknown.

#### FLOW-3: Human-only or confirmed change

The Agent resolves the target and requests the exact action. The Host opens the
owning native confirmation or editor. Approval commits through the same owner;
cancellation leaves state unchanged. The Agent never sees or supplies the human
input and receives only a bounded result.

#### FLOW-4: Shortcut rebind

The user searches for a command, starts recording, and presses one chord. Tenon
validates reserved combinations and overlapping scopes. A conflict stays in the
row and offers no save. A valid application shortcut applies everywhere
immediately; a valid global shortcut commits only after OS registration. Reset
restores the same registry-owned default used by help and UI hints.

#### FLOW-5: Translation control

While viewing a supported webpage, caption track, or EPUB, the user opens its
language control and chooses translation behavior or clears saved translations.
The action affects the owning preview behavior and does not open Settings. The
Settings rail, CLI catalog, and built-in Skill never advertise Translation as a
global settings domain; the configurable toggle command remains discoverable
only as a shortcut for the active supported preview.

### 9. Edge cases and recovery

- If the Host is unavailable, the CLI performs no fallback file write and
  returns the exact command needed after Tenon is running.
- If a setting changes between inspection, confirmation, and commit, the stale
  request is refused with the current safe revision; no automatic overwrite
  occurs.
- If persistence succeeds but a live effect cannot be established, the owner
  rolls back to the last working value or reports a durable degraded state. It
  never returns `applied` for an effect that is not active.
- If a resource disappears while its page or CLI result is open, refresh
  removes that resource without breaking sibling rows or changing another
  resource.
- If localization, optional status, update checks, or catalog refresh fails,
  canonical ids and effective settings remain usable; diagnostics do not become
  mutation authority.
- Concurrent mutations for one owner serialize by owner revision. Mutations for
  unrelated owners do not block or overwrite each other.

## Requirements

- **FR-1:** One typed main-process control plane owns the public capability
  registry and delegates reads/mutations to domain adapters without merging
  their stores.
- **FR-2:** UI, CLI, and Skill expose the same effective values, validation,
  risk, sensitivity, revisions, and mutation results while retaining
  consumer-appropriate presentation.
- **FR-3:** `tenon settings` and the built-in `settings` Skill complete the
  Agent jobs listed in Design through the real authenticated Host path.
- **FR-4:** Credentials are status-only outside their native editor, and an
  Agent cannot self-confirm confirmed or native-only work.
- **FR-5:** The Settings window uses the flat eight-destination IA and route-
  scoped loading, subscriptions, feedback, and deep links.
- **FR-6:** Translation behavior and saved-translation maintenance exist only
  in supported preview language controls; no Settings route or scalar setting
  catalog entry represents them.
- **FR-7:** One user-command registry owns configurable shortcut identity,
  defaults, resolution, display, collision semantics, and runtime matching.
- **FR-8:** Global shortcut changes preserve the last working registration on
  validation, registration, or persistence failure.
- **NFR-1:** A bounded `settings list` or section projection has cost and output
  independent of total Provider models, installed Skills, Agent history, or
  Memory timeline size.
- **NFR-2:** Opening General performs no Provider, capability, Skill, Memory,
  translation, website-data, or update request.
- **NFR-3:** The built-in Skill contains no copied settings catalog and remains
  below the repository's compact built-in Skill budget.
- **NFR-4:** Renderer code receives secret-free DTOs only and has no Node,
  filesystem, socket, token, or secret-store access.

## Acceptance Criteria

- **AC-1 (FR-1, FR-2):** Registry/adapter contract tests prove each public id is
  unique, its operations have codecs and risk/sensitivity metadata, each owner
  returns a revisioned projection, and UI/CLI reads resolve the same fixture
  value without a second implementation table.
- **AC-2 (FR-3):** A real Agent composition test loads the built-in Skill and
  runs one inspect and one routine mutation through Bash, the packaged CLI
  resolver, authenticated Host transport, owning store, live effect, and typed
  receipt; no direct file write or renderer IPC occurs.
- **AC-3 (FR-3, NFR-1):** CLI goldens cover human and JSON list/get/set/reset,
  Models/Agents/Skills bounded status, Memory and access, targeted open, invalid
  ids/values, `no-change`, unavailable Host, stale revision, and bounded output
  with large catalogs.
- **AC-4 (FR-4):** Security tests prove secret bytes and raw secret-bearing
  errors never enter projections, CLI output, Skill context, logs, or Thread
  Items; fabricated confirmation flags/tokens and replayed/stale requests are
  refused before mutation.
- **AC-5 (FR-4):** Confirmed-action tests cover approve, cancel, stale target,
  no eligible native owner, duplicate submission, and restart. Exactly one
  mutation may settle and cancellation changes no owner revision.
- **AC-6 (FR-5, NFR-2):** Renderer and E2E tests open every flat destination and
  deep link, assert no category landing pages, and prove General remains usable
  while Provider, Skill, Memory, or update fixtures fail independently.
- **AC-7 (FR-5):** Memory uses one visible-route subscription with bounded
  teardown, no interval polling, local error/retry, and a working Open Memory
  action that performs no document mutation merely to navigate.
- **AC-8 (FR-6):** Translation settings routes, copy, IPC consumers, and tests
  are absent; webpage, caption, and EPUB controls retain language/model/automatic
  behavior/cache maintenance and pass their existing behavior coverage.
- **AC-9 (FR-7):** Shortcut registry tests cover unique ids, only explicit
  configurability, portable parse/format round trip, context-aware conflicts,
  reserved combinations, reset, localization, and every handler/hint resolving
  the effective binding rather than a literal.
- **AC-10 (FR-7, FR-8):** UI and CLI tests cover recording/cancel, known command
  conflict, disjoint-context reuse, OS conflict, persistence failure, successful
  live rebinding, per-command Reset, Reset All, restart, and preservation of the
  prior global registration after every failed attempt.
- **AC-11:** Settings passes keyboard-only use, screen-reader names, 200% text,
  long English and Simplified Chinese copy, light/dark, increased contrast,
  reduced motion, and reduced transparency without overlap or layout shift.
- **AC-12:** Current behavior is folded into the owning specs; `bun run
  typecheck`, relevant Core and renderer suites, focused Settings/Agent/preview
  E2E, `bun run docs:check`, `git diff --check`, and packaged CLI smoke pass.

## Delivery Units

### 1. Agent-facing Settings interface

Deliver the control-plane registry/adapters, authenticated Host transport,
packaged `tenon settings` CLI, built-in `settings` Skill, risk/credential rules,
revisioned events, bounded receipts, and end-to-end composition tests. Existing
Settings UI remains user-functional and its writes are routed through or
adapted to the same owner operations; no duplicate file writer is introduced.

Expected areas:

- new `src/settings/contract/`, `src/settings/cli/`, and packaged executable
  wrapper;
- new `src/main/settings/` service, adapters, transport, and Agent shell
  environment contribution;
- existing preference, Provider, Agent resource, Skill, Memory, permission,
  diagnostics, data-maintenance, and window owners;
- `src/main/builtInSkills/settings/SKILL.md` and built-in Skill packaging;
- `package.json` build/`extraResources` wiring and packaged smoke;
- preload/main integration only where current UI must consume the new owner
  operation rather than a duplicate writer; and
- a new indexed current Settings specification plus affected architecture,
  Agent Skill, tool-permission, and integration specs.

This unit must coordinate before changing infrastructure-owned `package.json`,
`docs/spec/README.md`, or any shared protocol surface. It should not need
`src/core/commands.ts` or `src/core/types.ts`; discovering that it does stops the
unit for a separate shared-interface decision.

### 2. Clean-slate Settings UI and shortcuts

Replace category/page routing and the monolithic settings shell with the flat
IA, route-owned queries/errors/subscriptions, final deep links, contextual
Translation ownership, and complete shortcut persistence/rebinding. Retain the
native preference-window frame and established design-system primitives while
deleting superseded overview, Preview, route, eager-load, polling, and global
feedback code.

Expected areas:

- `src/core/settingsWindow.ts`, Window Application Host routing, preload types,
  and every deep-link caller;
- `SettingsWindow`, `AgentSettingsView` replacement/split, current Settings
  domain sections, localized messages, and settings CSS;
- `shortcutRegistry`, workspace/editor shortcut consumers, launcher global
  registration, menus and visible shortcut hints, plus a bounded shortcut
  preference owner;
- preview language controls and translation-preference/cache placement;
- Settings route, mutation, Memory, shortcut, launcher, translation, DOM
  stability, accessibility, and E2E coverage; and
- current Settings, launcher, Memory, preview, error-observability,
  workspace-layout, and design-system specifications.

The active `semantic-working-state` plan overlaps Provider and managed-Skill
Settings consumers. Do not polish the outgoing surface independently: this unit
absorbs its truthful progressive-copy and stable-command-identity acceptance
into the final resource pages, after which the older plan can be archived as
superseded.

## Risks

- **A universal abstraction becomes another mega-object.** Keep typed domain
  adapters and section projections; the registry describes capabilities but
  never erases resource-specific contracts.
- **CLI becomes a secret exfiltration path.** Model credential status as a
  separate safe projection and make secret fields unrepresentable in shared
  codecs, not merely redacted after serialization.
- **A second writer causes stale runtime state.** All consumers invoke owner
  operations and typed invalidation; no CLI code edits JSON directly.
- **Confirmation is replayable or model-controlled.** Bind confirmation to
  exact normalized bytes, origin, owner revision, and one settlement; never
  accept a CLI acknowledgement flag.
- **UI rewrite retains the current eager coupling under new labels.** Assert
  per-route call sets and delete shell-owned domain state rather than hiding it
  behind new components.
- **Shortcut customization breaks native expectations or reachability.** Keep
  interaction grammar fixed, validate scope collisions, and commit global
  bindings only after successful OS registration while retaining Reset.
- **Translation loses discoverability.** Keep the existing contextual language
  affordance available in every supported preview and move cache maintenance
  into that same surface before deleting the Settings destination.
- **External plans target outgoing Settings files.** Re-run the collision check
  at each claim and serialize Settings consumers against the final control
  plane and route model.

## Collision Result

The 2026-09-03 check found open PRs #620, #621, #623, #624, and #625. Since that
snapshot, #623 has shipped `package.json`, Desktop Host/Agent Bash composition,
and the shared Agent protocol foundation needed by delivery unit 1. Unit 1 must
consume that final packaged Tool Task mechanism after its remaining
`agent-skill-authoring-foundation` predecessor merges.

- #620 is a design-only Agent delegation plan that declares Settings the future
  Runner/model policy authority. Its implementation and this plan's Settings
  consumers must not run concurrently; the later claimant consumes the earlier
  merged control plane and routes.
- #621 owns shared preview-shell implementation. This plan changes only where
  Translation configuration is presented and preserves preview behavior; any
  overlapping preview file discovered at claim time is serialized behind #621.
- #624 and #625 own Agent Trajectory evidence/paging and do not overlap the
  planned Settings contract, CLI, Skill, or renderer surfaces.
- Active `agent-skill-authoring-foundation` changes Skill identity and Settings
  binding behavior. Delivery unit 1 consumes that merged identity contract
  rather than defining a competing Skill resource shape.
- Active `semantic-working-state` directly overlaps outgoing Provider/managed-
  Skill Settings consumers and is absorbed as described under delivery unit 2.

The main worktree also contains unrelated local edits in `desktopHost.ts`,
`nativeAddon.ts`, and `hostPlatformComposition.test.ts`; they are not part of
this plan and must not enter either implementation claim.

## Open questions

None. The product boundary, final IA, Translation placement, CLI name and scope,
credential/confirmation policy, shortcut eligibility rule, delivery shape, and
dependency order are fixed by this plan. Reopen only if implementation proves a
hard platform constraint, not to preserve an outgoing abstraction.

## Implementation Checklist

- [ ] Delivery unit 1: implement and verify the Agent-facing control plane,
      CLI, built-in Skill, security model, receipts, packaging, and current-UI
      adaptation as one complete PR.
- [ ] Delivery unit 2: implement and verify the flat Settings window,
      route-owned state, contextual Translation move, and configurable
      shortcuts as one complete PR.
- [ ] For each unit, update current specs in the same change, run the collision
      self-check, and attach light/dark plus relevant native/packaged evidence.
- [ ] At the main gate, run `/code-review ultra`, add `/security-review`, perform
      light/dark visual verification, retire stale Settings premises from active
      plans, and archive/fold completed design according to the document system.
