# File-First Configuration

This plan is one complete feature in one PR: replace the Settings control plane
with two public configuration files, preserve direct domain management, and
remove the unified Settings application surface in one clean cut. No partial
router, compatibility layer, or transitional Settings shell ships.

## Goal

- **OBJ-1:** `Settings...` and `Cmd+,` open the real scalar configuration file
  in the user's editor. A valid save applies automatically.
- **OBJ-2:** People and authorized Agents configure Tenon by reading and editing
  the same documented files. There is no second mutation API with different
  behavior.
- **OBJ-3:** Invalid or partially saved text never replaces the last accepted
  configuration or prevents Tenon from starting.
- **OBJ-4:** Configuration contains only declarative preferences. Resources,
  secrets, destructive actions, contextual state, and runtime facts retain
  direct domain ownership instead of being recast as settings.
- **OBJ-5:** Every surviving human workflow remains directly reachable after the
  unified Settings window is removed.
- **OBJ-6:** Configurable shortcuts use the same file-first model without making
  fixed editor, selection, or IME grammar configurable.

The clean-slate decision is intentionally small: the files are the configuration
API, the filesystem is the Agent interface, and domain managers own everything
that is not declarative configuration.

## Non-goals

- Do not build or retain any Settings or Configuration CLI, including read-only
  discovery, validation, schema, inspection, or status commands.
- Do not build a Settings-specific Agent tool, authenticated Settings router,
  route manifest, or generic Settings receipt protocol.
- Do not ask an Agent to call `get`, `set`, `check`, `reload`, and `show` around a
  file edit. The file edit is the configuration mutation.
- Do not build a replacement Settings window, generated form, embedded editor,
  or Shortcut Manager.
- Do not place Provider connections, credentials, model catalogs, Agent
  definitions, Skill sources/lifecycle, Memory contents/reset, capability
  blocks, website or translation data, update actions, diagnostics, or recent
  selections in either configuration file.
- Do not add Agent control for resources or operations that lack it today. Such
  work belongs to the owning domain and is not a reason to create a Settings
  control plane.
- Do not place Translation target, model, automatic behavior, toggle state, or
  cache operations in global configuration. Translation remains contextual;
  persistent cache maintenance remains a Data operation.
- Do not make navigation, selection, Return, Escape, Tab, delete, clipboard,
  undo/redo, printable-character, or IME behavior configurable.
- Do not add configuration scopes, profiles, layering, includes, interpolation,
  executable configuration, remote administration, or cloud sync.
- Do not preserve `app-preferences.json`, Settings routes/events, or legacy
  readers. Tenon is pre-release, so the implementation makes one format cut.

## Design

### 1. Product decision, constraints, and evidence

The design takes the narrow lesson from file-first tools:

- [Ghostty configuration](https://ghostty.org/docs/config) makes the file the
  primary Settings surface.
- [VS Code settings](https://code.visualstudio.com/docs/configure/settings) and
  [Zed settings](https://zed.dev/docs/configuring-zed) pair editable JSON with a
  schema, comments, and completion.
- [Sublime Text settings](https://www.sublimetext.com/docs/settings.html) stores
  overrides instead of copying defaults.
- [Alacritty configuration](https://alacritty.org/config-alacritty.html) makes
  reload and invalid-file behavior explicit.

Tenon adopts plain files, generated schemas, overrides-only content, automatic
reload, and last-known-good runtime behavior. It does not copy the surrounding
editor product: resources and operational workflows are not forced into a
configuration abstraction merely because the outgoing UI displayed them under
Settings.

There are four distinct product kinds:

| Kind | Example | Owner | Public interaction |
| --- | --- | --- | --- |
| Declarative configuration | theme, shortcut | configuration file owner | edit file |
| Resource | Provider, Agent, Skill | domain owner | direct manager |
| Operation | reset Memory, clear data | domain owner | direct action and confirmation |
| Context/runtime state | preview Translation, effective access | producing owner | contextual control or inspection |

A value enters a configuration file only when it is installation-wide,
non-secret, reversible, locally deterministic to validate, idempotent to apply,
and independent of mutable resource lifecycle. Failing any rule leaves it with
its domain owner.

The hard constraints are Electron process isolation, per-clone `userData`,
model-unreadable credentials, existing Agent filesystem policy, and fail-closed
configuration admission. The outgoing Settings window, stores, DTOs, and routes
are legacy constraints to remove, not interfaces to preserve.

The accepted tradeoff is asynchronous settlement. A filesystem write proves the
desired bytes changed; it does not prove that Tenon accepted or applied them.
Keeping that distinction is simpler and more truthful than creating a second
Settings protocol solely to acknowledge the first one. People receive an
in-application diagnostic for invalid saves. Agents can inspect the generated
schema and resulting desired file, but must describe only the write they can
prove.

### 2. Public files and ownership

The current Electron `userData` root owns:

```text
{userData}/config/settings.jsonc
{userData}/config/settings.schema.json
{userData}/config/keybindings.jsonc
{userData}/config/keybindings.schema.json
{userData}/state/settings-last-good.json
{userData}/state/keybindings-last-good.json
```

The two JSONC files and generated schemas are public, model-readable files. The
last-known-good snapshots are private implementation state, never editing
surfaces or alternate sources of desired configuration.

Packaged Tenon resolves the files below its pinned
`~/Library/Application Support/Tenon/` userData root. Dev clones resolve the same
relative paths under their isolated `ELECTRON_USER_DATA_DIR`. There is no second
`~/.config/tenon`, workspace, project, or active-profile location.

At startup Tenon creates the public configuration directory and atomically
refreshes both generated schemas. It does not create either user override file
until that file is opened for editing or explicitly created by an authorized
writer. An Agent can therefore inspect the schema before the first override
exists.

The main process resolves this path before configuration loads. It exposes the
resolved public configuration directory to authorized local Agent execution as
`TENON_CONFIG_DIR`. This is path discovery, not a command surface:

- it grants no filesystem authority;
- existing Full Access, block, and worktree-containment policy remains
  authoritative;
- an Agent without permission to reach the path cannot read or edit it; and
- changing a file outside Tenon follows the same watcher path regardless of
  whether a person, Agent file tool, shell command, or editor wrote it.

There is no Settings Skill or CLI wrapper. An authorized Agent reads the schema
or existing file with ordinary filesystem tools, makes a source edit, and reports
that file mutation truthfully. It does not claim runtime application from
file-write success alone. One short local-tool guidance rule names
`TENON_CONFIG_DIR` and directs the Agent to the generated schema; it contains no
copied key catalog or defaults. Tenon owns runtime validation, application, and
the visible invalid-save notice.

### 3. Scalar configuration

`settings.jsonc` initially owns exactly four keys:

| Key | Value | Default | Application |
| --- | --- | --- | --- |
| `appearance.theme` | `system`, `light`, `dark` | `system` | live in every window |
| `appearance.language` | `system`, `en`, `zh-Hans` | `system` | live in every window and native menu |
| `agent.memory.enabled` | boolean | `true` | live through Memory admission |
| `updates.checkAutomatically` | boolean | `true` | live where updates are supported |

One scalar definition owns each key's codec, default, description, examples,
application timing, and safe effective projection. The schema, template, loader,
diagnostics, and runtime consumers derive from those definitions. No consumer
keeps another default or preference writer.

The file is one flat JSON-with-comments object with stable dotted keys, comments,
trailing commas, UTF-8, and a 256 KiB limit. Duplicate keys, unknown keys, nested
aliases, malformed text, invalid types, and unsupported values reject the whole
candidate. Optional string `$schema` is the only metadata member. There are no
includes, expressions, references, or version fields.

The file contains overrides only. Removing a key restores its default. Startup
does not create the user file. `Settings...` creates the template when needed,
refreshes the generated schema, then asks the OS to open the file.

```jsonc
// Tenon configuration.
// Add only the settings you want to override. Remove a key to restore its default.
{
  "$schema": "./settings.schema.json",

  // "appearance.theme": "dark",
}
```

The owner distinguishes:

- **desired:** current file bytes, which may be absent or invalid;
- **accepted:** the latest complete document admitted by the current registry;
  and
- **effective:** accepted values plus defaults and resolved system values, with
  any exceptional application failure recorded per key.

Direct-file reload is whole-document and fail-closed at admission:

1. read one bounded stable snapshot and retain source locations;
2. reject malformed, duplicate, unknown, or invalid values;
3. form one immutable typed candidate from overrides and defaults;
4. persist a current-registry private last-known-good snapshot;
5. publish one accepted generation; and
6. let each runtime owner idempotently converge from that generation.

An invalid candidate remains on disk for repair while the preceding accepted
generation stays active. At startup, an absent desired document selects defaults;
a present valid document wins; and a present invalid document uses a snapshot
that still validates against the current registry or defaults when none does.
Deleting the file intentionally selects defaults rather than reviving the
snapshot.

Acceptance is not a cross-domain rollback transaction. If a local application
step fails after admission, that key retains its last actual runtime value,
records one key-scoped diagnostic, and retries without rolling back unrelated
keys.

The watcher coalesces burst events and handles editor-style atomic replacement.
It reads only after size and stability checks; a mid-read change discards that
attempt and schedules another. Tenon never normalizes or rewrites the user's
document after creation. Concurrent editors own their normal filesystem conflict;
Tenon does not invent a cross-process merge protocol.

### 4. Shortcut configuration

`keybindings.jsonc` is a separate file because commands, scopes, chord parsing,
conflicts, and native registration belong to a shortcut owner rather than the
scalar registry.

The file is an overrides map from stable command id to one portable chord, an
ordered list of alternate chords, or `null` to disable the command. Removing a
key restores its default. It follows the same bounded JSONC, schema, desired /
accepted / effective, watcher, diagnostics, and last-known-good rules as scalar
configuration without sharing one document or state owner.

One user-command registry owns stable identity, localized label/category, scope,
configurable/fixed classification, defaults, portable parse/format, conflict
rules, runtime matching, and visible hints. Public scopes are `system`,
`application`, and declared mutually exclusive `context` scopes.

The configurable set is derived from current command handlers. It includes the
global launcher; Agent panel, new Thread, Today, Back/Forward, and active-preview
Translation commands; description, checkbox, move, duplicate, and tag commands
in applicable row/editor contexts. Navigation, selection extension,
selected-reference options, edit entry, indentation, deletion, clipboard,
undo/redo, Return/Escape/Tab, printable keys, and IME paths are named fixed
interactions. A parity guard fails when any handler or visible hint is neither a
configurable command nor a named fixed interaction.

The loader rejects malformed chords, reserved platform combinations, duplicate
bindings in overlapping scopes, and whole-candidate conflicts. Disjoint context
scopes may reuse a chord.

For the system launcher, the owner keeps the current registration while trying
the ordered new candidates. It registers the first available new candidate
before releasing the old one. A validation, persistence, or registration failure
leaves the previous accepted and effective binding intact while preserving
invalid desired bytes for repair.

`Keyboard Shortcuts...` creates or opens `keybindings.jsonc` in the external
editor. Reset means removing one override; Reset All means deleting all overrides
or the file. There is no recorder or generated shortcut UI in this feature.

### 5. Direct domains, not Settings

Removing the Settings shell must not remove human capability. Each non-file job
has a direct destination:

| Capability | Owner / human destination |
| --- | --- |
| Provider/model catalog, connection, credentials, OAuth, image default | Models |
| Agent definitions and execution/runtime selection | Agents |
| Skill sources, enablement, install, update, rollback | Skills |
| Memory contents, exclusions, per-Thread mode, reset | Memory |
| Effective access and persistent blocks | Access |
| Website data and persistent translation-cache maintenance | Privacy & Data |
| Update status/check/release information | About Tenon |
| Diagnostics reveal/export, help, issue reporting | Help |
| Translation target/model/automatic behavior/toggle/scoped cache | active preview |

The application menu keeps `Settings...` and `Keyboard Shortcuts...`, then groups
Models, Agents, Skills, Memory, Access, and Privacy & Data in one native `Manage`
submenu. About and Help retain their platform-standard homes. Contextual deep
links open the same owners directly. Destinations may reuse a generic
auxiliary-window shell, but they share no Settings landing page, category
navigation, DTO, store, polling, badge counts, or feedback state.

This plan neither promises nor blocks Agent automation for those domains. A
future Agent workflow must be designed by that domain as a typed tool or private
native handoff with its own authority and result semantics. It must not be routed
through a universal Settings namespace. Credentials remain outside
model-readable files and outputs; destructive or authority-expanding domain
actions retain Host-owned human confirmation.

Translation remains contextual. Target, model, automatic behavior, and toggle
state belong to one active preview controller. Scoped saved-content clearing
belongs to that preview. Installation-wide webpage, caption, and EPUB cache
inspection/clearing remains a confirmed Data action in Privacy & Data. Neither
path creates global Translation preferences.

### 6. Retire inherited ownership

The implementation removes these outgoing shapes rather than wrapping them:

1. **Composite app preferences.** Theme/language move to scalar configuration;
   Translation moves to preview state; recent Agent selection moves to the Agent
   composer/runtime-selection owner. Delete the old reader and fallback order.
2. **Provider mega-owner.** Split `agentSettings` into Provider resources,
   credential storage, model-catalog cache, image selection, and Agent runtime
   policy. Move `additionalSkillDirectories` and `disabledSkills` to the Skill
   owner. No direct manager rewrites a mega-DTO.
3. **Duplicate scalar authority.** Memory keeps admission generations, reset
   epochs, exclusions, and per-Thread modes, but its global switch derives only
   from `agent.memory.enabled`. Update state keeps attempts/results/releases but
   not automatic-check policy.
4. **Global Translation preferences.** Remove main-process global fields,
   broadcasts, and renderer optimistic preference singletons. Preview controllers
   own context; persistent translations remain Data.
5. **Mixed shortcut grammar.** Move configurable identities and bindings to the
   shared command registry. Keep fixed DOM/IME interaction grammar private to the
   renderer.
6. **Settings-window authority.** Remove `SettingsWindow`, category/page/anchor
   routes, navigation state, eager cross-domain reads, Settings-only sender
   admission, polling, badges, and shell feedback.
7. **Broad Settings coupling.** Replace `lin:settings-changed` with narrow owner
   events. Extract the Provider editor destination and parameters from
   `settingsWindow.ts` before deleting that module. Dialogs use their real owner
   window rather than a generic Settings parent.
8. **Dead Settings vocabulary.** Rename surviving domain components, styles,
   i18n namespaces, tests, and spec sections so `Settings*` no longer appears to
   own resources or operations.

Current specs remain truthful until implementation ships. The implementation PR
rewrites affected current specs in the same change.

Active plans keep their product behavior but must target the new owners:

- `semantic-working-state` applies to direct Models and Skills managers;
- `agent-skill-authoring-foundation` and `agent-skill-curation-report` target the
  Skill owner and direct Skills manager;
- `dark-mode-contrast-pass` targets surviving direct managers and file notices;
- `agent-delegation-runtime` must treat Agent runtime policy as Agent-domain
  state, not a future Settings authority; and
- the browser-extension reference routes data clearing to Privacy & Data.

### 7. Main flows and failure behavior

**Person edits configuration.** `Settings...` or `Keyboard Shortcuts...` opens
the corresponding file. A valid save publishes one accepted generation and
converges runtime owners. Invalid text stays editable while previous effective
state remains active; one notice per desired generation names the first
source-located error and offers `Open File` and `Copy Diagnostics`.
If no application accepts the JSONC document, Tenon reveals it in Finder and
offers its exact path rather than opening an embedded fallback.

**Agent edits configuration.** An authorized Agent resolves
`TENON_CONFIG_DIR`, reads the relevant schema/file through ordinary filesystem
tools, and edits only the requested override. Existing filesystem policy admits
or rejects the write. Tenon observes the same save path as a human edit. The
Agent reports the file change, not an invented synchronous application receipt.

**Person manages a domain.** A menu command or contextual deep link opens the
owning manager or surface directly. That owner reads its bounded projection,
performs its own validation and confirmation, and publishes its own event. No
configuration file or Settings service mediates the operation.

**Invalid startup file.** Tenon starts with a current valid snapshot or defaults,
shows a repairable diagnostic after the application is usable, and never
silently overwrites the desired file.

## Requirements

- **FR-1:** The scalar registry, public JSONC/schema artifacts, watcher,
  last-known-good recovery, diagnostics, and runtime application implement the
  scalar file contract.
- **FR-2:** Desired, accepted, and effective scalar states remain distinct; each
  runtime consumer receives one accepted generation through its owner.
- **FR-3:** People and authorized Agents mutate scalar configuration only by
  editing `settings.jsonc`; no Settings-specific mutation command, tool, router,
  receipt, or alternate preference writer exists.
- **FR-4:** The shared command registry, `keybindings.jsonc`, schema, watcher,
  conflict validation, native registration, runtime matching, menus, and hints
  resolve every configurable shortcut from one accepted owner.
- **FR-5:** Every current shortcut handler/hint is classified as configurable or
  as one named fixed interaction, and failed candidates do not displace the
  previous effective binding set.
- **FR-6:** Every non-configuration workflow in the ownership table remains
  directly reachable through its domain after the Settings shell is removed.
- **FR-7:** Translation preferences remain preview-contextual and persistent
  translation-cache maintenance remains a Data operation.
- **FR-8:** The eight inherited ownership shapes are removed without compatibility
  adapters or replacement global coupling.
- **NFR-1:** Public configuration reads are bounded to 256 KiB per file; watcher
  work is coalesced and never blocks startup or renderer interaction.
- **NFR-2:** Renderer processes receive narrow typed values/events and gain no
  Node.js, filesystem, private snapshot, credential, or domain-store access.

## Acceptance Criteria

- **AC-1 (FR-1, FR-2):** Registry tests prove exactly four scalar keys with one
  codec/default/description/timing source. Schema, template, loader, diagnostics,
  and runtime agree; no resource or Translation key is admitted.
- **AC-2 (FR-1):** Missing, deleted, valid, commented, trailing-comma, UTF-8,
  maximum-size, duplicate, unknown, malformed, invalid-type, and unsupported
  files have deterministic tests. Watcher tests cover atomic rename, event bursts,
  stale reads, and mid-read edits.
- **AC-3 (FR-1, FR-2):** Startup and invalid-save tests prove desired/accepted/
  effective truth, whole-candidate rejection, current-registry last-known-good
  recovery, defaults after deletion, and preservation of invalid desired bytes.
- **AC-4 (FR-2, FR-8):** Theme/language update every window and native menu;
  Memory disable uses its admission barrier; update scheduling consumes scalar
  policy. Restart proves no legacy store can override accepted configuration.
- **AC-5 (FR-3):** E2E proves `Settings...` and `Cmd+,` create/open the exact
  public file in the external editor. A Full Access Agent can discover the same
  path and apply a valid change with generic file tools; restricted and blocked
  Agents cannot escape existing filesystem policy. No Settings or Configuration
  CLI, Settings tool/router, or application receipt is present.
- **AC-6 (FR-4, FR-5):** Shortcut tests classify every handler/hint, round-trip
  portable bindings, cover alternate/disabled values, overlapping/disjoint
  scopes, reserved chords, conflicts, localization, and fixed IME/editing
  grammar.
- **AC-7 (FR-4, FR-5):** File and restart tests cover valid/invalid candidates,
  live rebind, persistence failure, system registration failure, and preservation
  of the previous registration. `Keyboard Shortcuts...` opens the exact external
  file; removing one/all overrides restores defaults.
- **AC-8 (FR-6):** E2E proves Models, Agents, Skills, Memory, Access, Privacy &
  Data, About, Help, Provider editing, and contextual Translation remain directly
  reachable after all Settings routes and navigation are absent.
- **AC-9 (FR-7):** Webpage, caption, and EPUB tests prove contextual Translation
  changes no global file/singleton; scoped clearing affects only one preview;
  global confirmed Data clearing includes entries from closed previews.
- **AC-10 (FR-8):** Static and behavior guards prove `appPreferences`, the
  Provider mega-DTO, duplicate Memory/update policy, global Translation
  preference state, broad Settings events/sender admission, mixed shortcut
  registry, shell polling/badges/feedback, and surviving Settings-derived domain
  names are absent.
- **AC-11 (FR-1, FR-4, FR-6, NFR-1, NFR-2):** Invalid-file notices and every
  surviving direct manager pass keyboard and screen-reader use, 200% text, long
  English and Simplified Chinese, light/dark, increased contrast, reduced motion,
  and reduced transparency without overlap or layout shift.
- **AC-12 (FR-1 through FR-8, NFR-1, NFR-2):** Current specs are rewritten in the
  implementation PR; typecheck, relevant Core/renderer tests, focused E2E, docs
  checks, diff checks, and packaged smoke pass.

## Delivery

One PR delivers both public configuration files, shared JSONC parsing primitives,
runtime consumers, Agent path discovery, direct domain destinations, shortcut
registry conversion, Settings-shell deletion, ownership splits, tests, and
current-spec updates. Build order within the PR is definitions and file owners,
runtime consumers, direct destinations, parity/E2E verification, then deletion.
Nothing deletes the old writer or surface before its final consumer has moved.

Expected areas include configuration modules; `appPreferences`; Provider, Skill,
Memory, update, Translation, and Agent ownership; command and shortcut registries;
Window Application Host routing; preload types; direct manager components/styles/
i18n; Agent local execution environment; tests; and affected specs.

Implementation coordinates before touching infrastructure-owned files,
`docs/spec/README.md`, shared protocol surfaces, or Agent runtime composition.
Prefer a private configuration contract module over expanding
`src/core/commands.ts` or `src/core/types.ts`.

## Risks And Collisions

- **A file becomes a junk drawer:** enforce the admission rule and exactly four
  scalar definitions; domain resources never enter the registry.
- **File-write success is overstated:** Agent copy and tests distinguish desired
  file mutation from asynchronous accepted/effective state.
- **Invalid files break launch:** admission keeps last-known-good/default runtime
  truth and leaves desired bytes repairable.
- **Settings removal strands work:** direct-entry E2E gates route deletion.
- **Shortcuts break native behavior:** fixed grammar is explicit and prior system
  registration remains active until a valid replacement succeeds.
- **Owner splitting becomes another abstraction:** share only JSONC mechanics;
  scalar, shortcut, and domain owners retain distinct schemas and behavior.

The 2026-09-03 collision check found open PRs #620, #621, #623, and #626.

- #623 owns Agent Bash/runtime composition. This plan touches that area only to
  expose the resolved public configuration path; implementation waits for #623
  and rebases before claiming the file.
- #620 still names Settings as Agent Runner/model policy authority. That premise
  is incompatible with this clean-slate decision and must be corrected to the
  Agent-domain owner before either implementation claims overlapping files.
- #621 owns preview-shell files. Contextual Translation ownership changes
  serialize behind it for overlap found at implementation claim time.
- This design PR #626 is the only open claim on the configuration plan itself.

This plan does not modify the main-owned board or changelog. The gate must repair
their stale Settings/`semantic-working-state` premises when the design is
accepted or implemented.

## Open questions

None. The selected target is direct file editing for declarative configuration,
direct domain ownership for everything else, and no Settings control plane or
Settings/Configuration CLI. Reopen only if a platform proves external editor
opening or reliable watched-file application impossible, not to preserve an
outgoing abstraction.

## Implementation Checklist

- [ ] Re-run the collision check after #623 and reconcile #620's stale Settings
      authority premise before claiming overlapping implementation files.
- [ ] Implement the complete file-first cutover in one PR and update current
      specs in the same change.
- [ ] Run typecheck, relevant Core/renderer tests, focused E2E, docs checks, diff
      checks, packaged smoke, and light/dark visual verification.
- [ ] At the main gate, run ultra code review plus security review, repair active
      plan/board premises, then fold and archive this plan after verified release.
