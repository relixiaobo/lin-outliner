# File-First Settings And Complete Agent Control

This plan is a set of two complete features:

1. file-first scalar configuration, direct domain managers, and complete
   non-shortcut Agent control; and
2. complete shortcut configuration through `keybindings.jsonc`, the same Agent
   transport, and a direct Shortcut Manager.

Each feature ships in one PR. The plan is complete only when both ship. The
second depends on the first feature's final authenticated transport and receipt
contract; neither PR is a dormant scaffold.

## Goal

Make Settings file-first for people and semantically complete for Agents without
turning unrelated state into one settings store.

- **OBJ-1:** `Settings...` and `Cmd+,` open a documented scalar configuration
  file in the user's editor. A valid save applies automatically.
- **OBJ-2:** An Agent can inspect and initiate every legitimate Settings,
  resource, maintenance, update, diagnostic, shortcut, and contextual
  Translation workflow through one `tenon settings` command family.
- **OBJ-3:** One Agent intent normally uses one semantic invocation and receives
  one truthful bounded receipt. It does not need a read/edit/check/reload loop.
- **OBJ-4:** Invalid or partially saved text never replaces the last accepted
  configuration or prevents Tenon from starting.
- **OBJ-5:** Credentials remain outside model-readable data. Destructive or
  authority-expanding work requires Host-owned human confirmation that a
  Tenon-managed Agent cannot provide.
- **OBJ-6:** Every setting, resource, operation, context control, runtime fact,
  and shortcut has one owner and one public route.

The clean-slate target is deliberately asymmetric: files own declarative public
preferences, domain services own resources and operations, and the CLI only
routes semantic intent. Complete Agent control does not require a universal
Settings DTO, store, or service.

## Non-goals

- Do not build a replacement Settings window, Settings rail, generated form, or
  embedded editor.
- Do not place Provider connections, secrets, model catalogs, Agent definitions,
  Skill lifecycle, Memory contents/reset, capability blocks, website-data
  clearing, update actions, diagnostics, caches, or recent selections in
  `settings.jsonc`.
- Do not put Translation state in either global configuration file. Translation
  stays with one active preview.
- Do not make standard editing, selection/focus navigation, Return, Escape, Tab,
  delete, clipboard, undo/redo, printable-character, or IME grammar configurable.
- Do not add multi-chord sequences, workspace/project settings, project
  keybindings, layering, includes, interpolation, executable configuration, or
  cloud sync.
- Do not add a model-native Settings tool, a remote administration API, or an
  unauthenticated Host mutation route.
- Do not add a second product history or audit surface for Settings receipts.
- Do not preserve the Settings window routes, broad Settings DTO/events,
  `app-preferences.json`, or compatibility readers. Tenon is pre-release; the
  implementation makes one clean format cut.
- Do not redesign domain behavior that is unrelated to removing ambiguous
  ownership or preserving a direct human and Agent route.

## Design

### 1. Product boundary

The file-first direction follows the useful, bounded parts of existing tools:

- [Ghostty configuration](https://ghostty.org/docs/config) treats the file as
  the primary editing surface and exposes effective/default values for diagnosis.
- [VS Code settings](https://code.visualstudio.com/docs/configure/settings) and
  [Zed settings](https://zed.dev/docs/configuring-zed) use editor schemas,
  comments, completion, and explicit scope.
- [Sublime Text settings](https://www.sublimetext.com/docs/settings.html) uses an
  overrides-only user file rather than copying defaults.
- [Alacritty configuration](https://alacritty.org/config-alacritty.html) makes
  reload behavior explicit.

Tenon adopts plain data files, comments, generated schemas, overrides-only
content, automatic reload, and explicit effective-state reporting. It rejects
executable configuration and implicit file traversal.

Five kinds of capability remain distinct:

| Kind | Meaning | Example | Owner |
| --- | --- | --- | --- |
| Scalar setting | Low-risk installation-wide preference | theme | configuration owner |
| Resource | Named object with identity and lifecycle | Provider, Agent, Skill | domain owner |
| Operation | Explicit action with a result | reset Memory | domain owner |
| Context control | State meaningful for one active surface | Translation target | preview owner |
| Runtime fact | Read-only derived status | registered launcher binding | producing owner |

A value enters `settings.jsonc` only when it is installation-wide, safe for the
Agent and schema to read, reversible, locally deterministic to validate,
idempotent to apply, and independent of mutable resources. Failing any rule
keeps it with its domain owner; it may still have a `tenon settings` command.

### 2. Scalar configuration owner

The current Electron `userData` root owns these artifacts. Tenon has no product
user-profile abstraction, so this plan does not invent one.

```text
{userData}/config/settings.jsonc
{userData}/config/settings.schema.json
{userData}/state/settings-last-good.json
```

Packaged Tenon uses
`~/Library/Application Support/Tenon/config/settings.jsonc` on macOS. Dev clones
resolve the same relative path under their isolated `ELECTRON_USER_DATA_DIR`.
There is no second `~/.config/tenon` location.

The initial scalar registry is intentionally small:

| Key | Value | Default | Application |
| --- | --- | --- | --- |
| `appearance.theme` | `system`, `light`, `dark` | `system` | live in every window |
| `appearance.language` | `system`, `en`, `zh-Hans` | `system` | live in every window and native menu |
| `agent.memory.enabled` | boolean | `true` | live through the Memory admission owner |
| `updates.checkAutomatically` | boolean | `true` | live scheduling policy where updates are supported |

One scalar definition owns each key's codec, default, description, examples,
application timing, and safe projection. The generated JSON schema, local file
checker, CLI help, loader, and runtime consumers derive from these definitions.
No consumer keeps another default or preference writer.

`settings.jsonc` is one flat JSON-with-comments object with stable dotted keys,
comments, trailing commas, UTF-8, and a 256 KiB limit. Duplicate keys, unknown
keys, nested aliases, malformed text, invalid types, and unsupported values
reject the complete candidate. The only metadata member is optional string
`$schema`; there are no includes, expressions, references, or version fields.

The file contains overrides only. Removing a key restores its default. Startup
does not create the user file. `Settings...`, `file open`, or the first semantic
scalar `set` creates the template when needed; resetting a missing key is a
no-change. Tenon may atomically refresh the generated schema at startup or
before an open/write.

```jsonc
// Tenon configuration.
// Add only the settings you want to override. Remove a key to restore its default.
// Run `tenon settings list` to inspect available scalar settings.
{
  "$schema": "./settings.schema.json"

  // "appearance.theme": "dark",
}
```

The configuration owner exposes three states:

- **desired:** current file bytes, which may be absent or invalid;
- **accepted:** the latest complete document admitted by the current registry;
- **effective:** accepted values plus defaults and resolved system values, with
  any per-key application lag or failure stated explicitly.

Direct-file reload is whole-document and fail-closed at admission:

1. read one bounded stable snapshot and retain source locations;
2. reject malformed, duplicate, unknown, or invalid values;
3. form one typed candidate from overrides and defaults;
4. persist a current-registry private last-known-good snapshot;
5. publish one accepted generation; and
6. let each runtime owner idempotently converge from that immutable generation.

An invalid candidate remains on disk for repair while the preceding accepted
generation stays active. At startup, an absent desired document selects defaults;
a present valid document wins; and a present invalid document uses a snapshot
that validates against the current registry or defaults when none does. Deleting
the file intentionally selects defaults rather than reviving last-known-good.

Acceptance is not a cross-domain rollback transaction. If an exceptional local
application step fails after admission, that key retains its last actual runtime
value as effective, records one key-scoped diagnostic, and retries without
rolling back unrelated keys.

Semantic `set` and `reset` use a JSONC structural editor. Under the Host's
configuration queue, it reads bytes plus a file fingerprint, applies one
source-located edit, validates the complete candidate, rechecks the fingerprint
immediately before atomic replacement, and refuses a changed or malformed file.
It preserves unrelated comments, ordering, and whitespace and never serializes
a normalized full object over the user's document. External editors do not
participate in the Host queue, so the fingerprint check is the concurrency
boundary rather than a claim of an impossible cross-process lock.

### 3. Thin Agent command surface

Ship one packaged command family:

```text
tenon settings list|get|set|reset
tenon settings file path|open|check|show
tenon settings shortcuts ...
tenon settings models ...
tenon settings agents ...
tenon settings skills ...
tenon settings memory ...
tenon settings access ...
tenon settings data ...
tenon settings updates ...
tenon settings diagnostics ...
tenon settings context translation ...
```

This is a namespace and authenticated transport, not a new domain owner.
`SettingsCommandRouter` authenticates, bounds, and dispatches one discriminated
request. Each domain contributes its public route, input/result codec, risk, and
handler from the same module that owns validation, revision, persistence, and
events. A small assembled route manifest derives CLI help and parity tests but
does not copy resource schemas, defaults, state, revisions, or projections into
a universal Settings catalog.

One request targets one scalar, resource, context, or owner-composed operation.
There is no cross-owner batch. Routine callers do not pre-read a revision: the
owner validates and serializes the complete operation under its current state.
Commands whose meaning intentionally depends on prior state accept an optional
revision and refuse rather than silently retry when stale.

Default output is concise human-readable text; `--json` returns the same bounded
typed result. Complex resource create/update input comes from stdin or a file,
not shell-escaped prose. List calls have fixed page sizes, stable ordering, exact
lookup, and opaque cursors. `--all` is not part of the public CLI contract; every
caller uses cursor pagination, so origin classification or Skill guidance cannot
turn a bounded read into unbounded stdout. The built-in Skill uses exact lookup
or bounded pages.
Scalar `get` returns override, default, accepted, and effective facts for one
key. `file show` requires exactly one of `--desired`, `--accepted`, `--effective`,
or `--defaults`, so it never silently substitutes one state for another.

Offline discovery, `file path`, and local `file check` need no Host authority.
Every Host read, mutation, confirmation, or native handoff made by an Agent uses
a one-use capability bound to its root Turn and current Bash call. The Host
consumes it after decoding the normalized request, evaluates current Turn
permissions and persistent blocks, and invokes the typed owner. An ordinary
local process may edit public files with filesystem authority, but it cannot use
an unauthenticated CLI route to mutate private owners or claim a live receipt.

The built-in inline `settings` Skill is only a compact router. It explains the
five capability kinds, exact lookup, bounded pagination, risk/handoff behavior,
and the shortest command for an intent. It does not copy the coverage ledger,
scalar definitions, resource catalogs, schemas, or defaults. A user may
explicitly ask an Agent to edit JSONC, but the normal Agent path is one semantic
CLI call because only that path returns a live settlement receipt.

### 4. Receipts, confirmation, and secrets

Every route is one of:

- **inspect:** bounded, safe reads or opening a non-sensitive destination;
- **routine:** reversible mutations within current authority;
- **confirmed:** destructive work or a change that widens future Agent
  authority; or
- **native handoff:** secret entry, OAuth/browser interaction, file/directory
  selection, save panels, or human review outside model-readable I/O.

A confirmed or private native-handoff call remains one CLI invocation. Admission
is ordered: the Host consumes the one-use capability, captures relevant owner
state, parks the originating invocation, and makes that invocation incapable of
further Turn or tool admission while it waits. The Host then pauses new
Tenon-managed Agent Turn/tool admission and drains every other running
Tenon-managed desktop/Host-capable operation. The parked caller is the only item
exempt from the quiescence count; sibling work is not. Only after that drain does
the Host show private UI. The parked CLI call has no second command channel. If
quiescence cannot be established, no prompt opens and the barrier is released.

The main process owns the dialog/window lifecycle. CLI flags, stdin, environment
values, replayed tokens, renderer messages, Agent messages, and other tool calls
cannot confirm. On human completion, the Host rechecks permission and owner
state, commits at most once, releases the barrier, and settles the original
invocation. Cancellation changes nothing. Approval is never replayed against
new state.

This boundary covers Tenon-managed model and tool execution. It does not claim
to control unrelated software already granted macOS Accessibility authority.

Credentials are absent by construction from command schemas, projections,
receipts, Skill context, Thread Items, shared logs, and diagnostics. An
Agent-started edit handoff is write-only and never prefills a stored secret. An
Agent-started reveal/copy handoff keeps the barrier active, confines the secret
to its private window, destroys rendered secret state on close, and removes a
handoff-owned clipboard value before Agent work resumes when that value is still
unchanged. A person who opens Models directly retains the ordinary reveal/copy
workflow outside Agent handoff mode. Every handoff returns only provider
identity, safe connection status, and result. Provider failures are redacted
inside the credential owner before crossing a shared boundary.

The common receipt contains route id, operation, result, safe before/after facts
when meaningful, owner revision when the owner has one, effect timing, and one
recovery action. Domain payloads stay typed. Result semantics are:

- `applied`: the owner proves the commit/result represented by the receipt;
- `no-change`, `cancelled`, `refused`, `stale`, or `unavailable`: no mutation
  committed;
- `failed`: the owner proves the requested mutation did not commit; and
- `settlement-unknown`: transport or Host loss prevents a truthful conclusion.

The CLI never retries `settlement-unknown` automatically and never reports
dispatch as success. The recovery action names the narrow owner inspection that
can establish current state. This keeps receipts truthful without inventing a
second Settings operation-history product.

### 5. Human entry points and direct managers

`Settings...` and `Cmd+,` ensure the schema/template exist and use the OS to
open `settings.jsonc`. If no application accepts it, Tenon reveals the file in
Finder and exposes its exact path; there is no embedded fallback.

The broad `General -> Agent -> Preview` Settings window retires. Surviving work
has direct commands:

- `Keyboard Shortcuts...`
- `Manage Models...`
- `Manage Agents...`
- `Manage Skills...`
- `Manage Memory...`
- `Manage Access...`
- `Privacy & Data...`
- `About Tenon`

These destinations may share a generic auxiliary-window shell, but they do not
share a Settings landing page, navigation history, state container, DTO, or
feedback banner. Deep links target the domain directly: missing Provider to
Models, Agent identity to Agents, Skill action to Skills, Memory content or
reset to Memory, and a persistent block to Access.

Scalar writers disappear from managers. A manager may display a scalar effective
value when needed to explain status, but its action is `Open Configuration`.
Diagnostics lives in Help, update status/actions in About, and website data in
Privacy & Data.

Each manager reads a bounded owner projection and subscribes to that owner's
event. The global `settings-changed` broadcast, shell-owned polling, eager
cross-domain loading, counts/badges for unmounted pages, and global Settings
notice/error state all disappear. Shared visual primitives are renamed as
generic manager/window primitives; domain components, CSS, i18n keys, and tests
do not retain shell-derived `Settings*` names after the Settings surface is gone.

An invalid watched save posts one non-blocking notice per desired generation.
It says the previous configuration remains active, gives the first source-located
error, and offers `Open Configuration` and `Copy Diagnostics`.

### 6. Contextual Translation

Target language, model, automatic behavior, toggle state, and scoped
saved-translation maintenance belong to the active supported preview's language
controller. They do not appear in either global file, scalar definitions, or a
manager pretending there is one application-wide Translation preference state.
Closing the preview destroys its transient control state; cached translated
content remains domain data, not a preference source.

`tenon settings context translation` resolves the one active preview associated
with the originating root Turn's window. `show` returns a bounded context
identity and current values; `set` changes target/model/automatic behavior;
`toggle` changes the current translation state; and `clear-saved` requests
confirmed deletion only for that preview's cache scope. Zero or multiple
eligible active previews return `unavailable` and change nothing. Every receipt
names the resolved context, so no result can be reported as global.

The existing installation-wide translation-cache inventory and purge remain a
Data capability because they cover saved webpage, caption, and EPUB translations,
including closed previews. `tenon settings data translations show|clear` and the
Privacy & Data surface use the translation-cache data owner directly; `clear` is
confirmed and reports the globally affected cache scope. `show` returns bounded
aggregate counts, bytes, and media scopes rather than cached entries. This route
owns no target, model, automatic behavior, or toggle preference and does not
recreate a global Translation settings owner.

### 7. Shortcut configuration

The second feature adds:

```text
{userData}/config/keybindings.jsonc
{userData}/config/keybindings.schema.json
{userData}/state/keybindings-last-good.json
```

The public file is an overrides map from stable command id to one portable chord,
an ordered list of alternate chords, or `null` to disable the command. Removing
a key restores defaults. It uses the same bounded JSONC, desired/accepted/
effective, diagnostics, structural-edit, and last-known-good rules as scalar
configuration without sharing one owner or one document.

One user-command registry owns stable identity, localized label/category, scope,
configurable/fixed classification, defaults, portable parse/format, conflict
rules, runtime matching, and visible hints. Public scopes are `system`,
`application`, and declared mutually exclusive `context` scopes.

The configurable set is derived from current command handlers, not a hand-kept
list. It includes the global launcher; Agent panel, new Thread, Today,
Back/Forward, and active-preview Translation commands; description, checkbox,
move, duplicate, and tag commands in every applicable row/editor context. The
current registry's navigation, selection extension, selected-reference options,
enter-edit/type-to-edit behavior, indentation, deletion, clipboard, undo/redo,
Return/Escape/Tab handling, printable keys, and IME paths are explicitly fixed.
A parity guard requires every existing and new handler/hint to resolve one
configurable command or one named fixed interaction; unclassified literals fail.

The loader rejects malformed chords, reserved platform combinations, duplicate
bindings in overlapping scopes, and whole-candidate conflicts. Disjoint context
scopes may reuse a chord.

For the system launcher, the owner keeps the current registration while it tries
the ordered new candidates. It treats an unchanged current candidate as already
active, otherwise registers the first available new candidate before releasing
the old one. A later file-write or registration failure removes any provisional
registration and preserves the prior accepted/effective binding. Direct file
failure leaves desired bytes for repair; semantic CLI failure does not write the
candidate.

`tenon settings shortcuts list|get|set|reset|reset-all|record|open` uses the
shortcut owner and common transport/receipt rules. `record` opens the direct
Shortcut Manager on one command and waits for the human result; the model never
synthesizes the trusted key event. The searchable manager supports one-chord
recording, inline conflict resolution, disable, per-command Reset, Reset All,
and `Open Keybindings File`. Manager and CLI writes preserve unrelated JSONC
formatting.

### 8. Exhaustive coverage ledger

Each row has one Agent route and one human owner. Native handoff means the Agent
can start and await a private human workflow; it does not receive private input.

| Capability | Canonical Agent route | Risk | Owner / human surface |
| --- | --- | --- | --- |
| Scalar definitions, desired/accepted/effective values, diagnostics | `list|get`, `file path|open|check|show` | inspect | configuration owner / editor |
| Theme, interface language, Memory enablement, automatic update checks | `set|reset SETTING_KEY` | routine | configuration owner / editor |
| Provider/model catalog, connection and capability status | `models list|show` | inspect, paged | Provider/catalog owners / Models |
| Provider enable/disable/activate, id/base URL, test, catalog refresh | `models enable|disable|activate|configure|test|refresh` | routine | Provider/catalog owners / Models |
| Default image model | `models set-image-default|reset-image-default` | routine | image selection owner / Models |
| API-key add/replace | `models credentials edit` | private native handoff | credential owner / write-only handoff |
| Stored API-key reveal/copy | `models credentials view` | private native handoff without secret result | credential owner / direct-human Models only |
| Stored credential deletion | `models credentials delete` | confirmed | credential owner / Models |
| OAuth sign-in/challenge/sign-out | `models oauth ...` | private native handoff; sign-out confirmed | credential owner / browser/Models |
| Provider deletion | `models delete` | confirmed | Provider owner / Models |
| Agent catalog, identity, presentation, instructions, profile, layer | `agents list|show|create|update|duplicate` | inspect/routine | Agent definition owner / Agents |
| Agent tool/Skill ceiling | `agents update` | narrowing routine; widening confirmed | Agent definition owner / Agents |
| Agent model/reasoning execution selection | `agents execution set|reset` | routine | Agent configuration owner / Agents |
| Agent deletion | `agents delete` | confirmed | Agent definition owner / Agents |
| Merged Agent runtime/Runner policy | `agents runtime show|set|reset` | within owner-defined ceiling | Agent runtime owner / Agents |
| Skill catalog/source/status/update availability | `skills list|show|check-updates` | inspect or bounded network check, paged | Skill owners / Skills |
| Skill enable/disable and undo last Agent edit | `skills enable|disable|undo-agent-edit` | routine | Skill settings/provenance owners / Skills |
| Bind/reveal/unbind local Skill directory | `skills bind|reveal|unbind` | native selection/open; unbind routine | Skill settings owner / Skills |
| Discover/review/install managed Skill | `skills discover|install` | inspect then native review | managed Skill owner / Skills |
| Preview/apply managed Skill update | `skills preview-update|apply-update` | inspect then native review | managed Skill owner / Skills |
| Managed Skill rollback/uninstall | `skills rollback|uninstall` | confirmed | managed Skill owner / Skills |
| Memory status and Open Memory | `memory status|open` | inspect/native open | Memory owner / Memory |
| Memory reset | `memory reset` | confirmed | Memory owner / Memory |
| Per-Thread Memory mode | `memory thread show|set` | originating Thread routine | Memory owner / Thread details |
| Effective filesystem/tool access | `access show` | inspect runtime fact | permission owner / Access |
| Persistent capability blocks | `access blocks|block|unblock` | block routine; unblock confirmed | permission owner / Access |
| Website data status/clear | `data website show|clear` | inspect/confirmed | preview session owner / Privacy & Data |
| Persistent translation-cache status/global clear | `data translations show|clear` | inspect/confirmed | translation-cache data owner / Privacy & Data |
| Update status/check/open release | `updates status|check|open` | inspect/routine/native open | update owner / About |
| App/version/build, changelog, help, issue, license | `updates info` and targeted `open` | inspect/native open | app owner / About/Help |
| Reveal/export diagnostics | `diagnostics reveal|export` | native open/save handoff | diagnostics owner / Help |
| Active Translation target/model/automatic/toggle | `context translation show|set|toggle` | inspect/routine | active preview owner |
| Active preview saved translations | `context translation clear-saved` | confirmed | active preview owner |
| Registered launcher binding before shortcut delivery | `shortcuts get global.launcher` | inspect runtime fact | launcher owner |
| Configurable command bindings | `shortcuts list|get|set|reset|reset-all` | routine; Reset All confirmed | keybinding owner / Shortcuts |
| Physical shortcut recording | `shortcuts record COMMAND_ID` | native handoff | Shortcut Manager |
| Fixed platform interaction grammar | `shortcuts list|show` marks `fixed` | inspect only | renderer interaction owner |

The implementation parity test derives its queue from scalar definitions, the
assembled command-route manifest, current domain controls, and the complete
command/shortcut registry. Missing, duplicate, unbounded, secret-bearing, or
`future` mappings fail.

### 9. Clean cut of inherited ownership

The current code has eight shapes that must not survive behind adapters:

1. **Composite app preferences.** Split `appPreferences`: theme/language move to
   scalar configuration; Translation moves to active preview state; recent Agent
   selection moves to the Agent composer/runtime-selection owner. Delete the old
   reader and fallback order.
2. **Provider mega-owner.** Split `agentSettings` into Provider resources,
   credential storage, model-catalog cache, image selection, and surviving Agent
   runtime policy. Move `additionalSkillDirectories` and `disabledSkills` to the
   Skill settings owner. No public operation returns or rewrites the current
   mega-DTO; owners may still share private file helpers.
3. **Duplicate scalar authority.** Memory keeps admission generations, reset
   epochs, exclusions, and per-Thread modes as operational truth, but its global
   mode becomes a derived application of `agent.memory.enabled`. Update state
   keeps attempts/results/releases, but not automatic-check policy. Reconciliation
   flows only from accepted scalar configuration into these owners.
4. **Global Translation preferences.** Remove main-process global fields,
   broadcasts, and renderer optimistic preference singletons. Preview controllers
   own their context; the translation cache remains data, not preference state.
5. **Mixed shortcut/interaction registry.** Move configurable command identity
   and bindings to a shared registry consumed by main and renderer. Keep fixed
   DOM/IME interaction grammar renderer-private and non-configurable.
6. **Settings-window authority.** Remove `SettingsWindow`, category/page/anchor
   routes, navigation state, eager cross-domain reads, Settings-only sender
   admission, shell feedback, polling, and badges. Replace deep links with typed
   domain destinations.
7. **Broad Settings coupling.** Replace `lin:settings-changed` with narrow owner
   events. Extract the Provider editor destination/parameters from
   `settingsWindow.ts` before deleting that module. Dialogs receive their real
   owning manager/window rather than a generic Settings parent.
8. **Dead Settings vocabulary.** Rename surviving `Settings*` domain components,
   shared inset/window primitives, CSS selectors/files, i18n namespaces, tests,
   and spec sections so the removed shell does not remain the conceptual owner.

Current specs remain truthful until implementation ships. Each implementation
PR rewrites the affected current specs in the same change. Active premises need
these reconciliations before their implementation claims:

- `semantic-working-state` still applies to direct Provider and managed-Skill
  managers; this plan does not absorb it.
- `agent-skill-authoring-foundation` and `agent-skill-curation-report` target the
  direct Skills manager and Skill command owner, not a Settings page.
- `dark-mode-contrast-pass` verifies direct managers and Shortcut Manager, not
  retired Settings metadata.
- `agent-delegation-runtime` exposes final Runner/model policy through the Agent
  owner and Agent command routes, never `settings.jsonc`.
- the browser-extension reference routes website-data clearing to Privacy & Data
  and `tenon settings data`, not a global Settings page.
- the main-owned task board must stop saying this plan absorbs
  `semantic-working-state`.

### 10. Main flows

**Person edits scalar configuration.** `Settings...` opens the file. A valid
save publishes one accepted generation and converges owners. Invalid text stays
editable while prior effective state remains active and diagnostics identify the
source location.

**Agent performs routine work.** The Skill chooses one exact command. The Host
authenticates current Turn authority and invokes one domain owner atomically. One
receipt reports the proven result; invalid, stale, or unavailable work changes
nothing.

**Agent requests private or dangerous work.** The Host reaches quiescence before
opening private UI: it consumes and parks the incapable originating invocation,
blocks new admission, and drains all sibling Host-capable work. It then waits for
the person, rechecks authority/state, and settles the same invocation. Cancel or
stale state commits nothing; connection loss is reported as settlement unknown
rather than guessed.

**Agent controls Translation.** The Host resolves exactly one active preview for
the originating window. Only that context changes; missing or ambiguous context
returns unavailable.

**Person or Agent rebinds a shortcut.** The keybinding owner validates the whole
candidate, resolves conflicts, and swaps the system registration safely. File,
runtime matching, menus/hints, and receipt resolve from one accepted binding.

## Requirements

- **FR-1:** The scalar definition registry, JSONC artifacts, loader, watcher,
  last-known-good recovery, diagnostics, and structural writer implement the
  scalar ownership contract.
- **FR-2:** Desired, accepted, and effective scalar states remain distinct and
  every runtime consumer receives one accepted generation through its owner.
- **FR-3:** A thin authenticated route manifest exposes every non-shortcut ledger
  row through its typed domain owner without creating a universal Settings DTO
  or state service.
- **FR-4:** The built-in Skill and packaged CLI perform one semantic request and
  return one bounded truthful receipt, including settlement-unknown recovery.
- **FR-5:** Confirmed and native-handoff work establishes the interactive barrier,
  rechecks permission/state, and cannot be approved by Tenon-managed Agent work.
- **FR-6:** Secret input, display, clipboard use, errors, and results remain
  model-unreadable throughout an Agent-started handoff.
- **FR-7:** `Settings...` opens the scalar file; every other human workflow opens
  its direct domain manager, context, About, Help, or native handoff.
- **FR-8:** Translation preferences and scoped cache maintenance resolve exactly
  one active preview; installation-wide translation-cache inspection/clearing is
  a confirmed Data operation and creates no global preference authority.
- **FR-9:** `keybindings.jsonc`, the command registry, runtime matching, menus,
  hints, CLI, and Shortcut Manager resolve every configurable binding from one
  accepted shortcut owner.
- **FR-10:** Every current shortcut/handler is classified as configurable or as
  one named fixed platform interaction; conflicts and system registration fail
  without displacing the previous effective set.
- **FR-11:** The eight inherited ownership shapes in the clean-cut audit are
  removed rather than hidden behind compatibility adapters.
- **NFR-1:** Default reads and receipts are bounded; pagination makes every
  resource reachable without dumping an unbounded collection. The CLI exposes no
  `--all` escape hatch.
- **NFR-2:** Renderer processes receive only narrow typed owner values/events and
  gain no Node.js, filesystem, authenticated CLI, or private-snapshot access.

## Acceptance Criteria

- **AC-1 (FR-1, FR-2):** Registry tests prove exactly four scalar keys with one
  codec/default/description/timing source. Schema, checker, CLI, loader, and
  runtime agree; no resource or Translation key is admitted.
- **AC-2 (FR-1):** Missing, deleted, valid, commented, trailing-comma, UTF-8,
  maximum-size, duplicate, unknown, malformed, invalid-type, and unsupported
  files have deterministic tests. Watcher tests cover atomic rename, burst
  events, stale reads, and mid-read edits.
- **AC-3 (FR-1, FR-2):** Startup recovery, invalid-save notice, and scalar CLI
  mutation prove desired/accepted/effective truth, whole-candidate rejection,
  current-registry last-known-good recovery, formatting preservation, and stale-
  fingerprint refusal.
- **AC-4 (FR-2, FR-11):** Theme/language update every window/native menu; Memory
  disable uses its admission barrier; update scheduling consumes scalar policy.
  Restart proves no legacy store can override the accepted scalar.
- **AC-5 (FR-3, FR-11):** Route-manifest parity proves every coverage-ledger row
  has one route, typed owner, codec, risk/sensitivity, bounded result, and human
  destination. No current control is missing, duplicated, or marked future.
- **AC-6 (FR-3, FR-4, NFR-1):** CLI tests cover human/JSON output, exact help,
  all command families, pagination, no-change, owner failure, optional stale
  revision, unavailable Host/context, and settlement unknown. Every fixture
  remains reachable without an unbounded response, and `--all` is rejected before
  owner dispatch for every caller.
- **AC-7 (FR-3, FR-4):** Agent composition tests load the Skill and complete
  representative scalar, Provider, Agent, Skill, Memory, access, data, update,
  diagnostics, and Translation jobs through one Bash invocation, packaged
  resolver, one-use capability, owner result, event, and receipt.
- **AC-8 (FR-5):** Confirmation tests prove no prompt appears before quiescence
  and no CLI/stdin/env/replay/renderer/Agent channel can approve. Approve, cancel,
  stale owner state, changed permission, duplicate response, quiescence failure,
  Host loss, and caller disconnect never produce a false success or replay
  approval. The consumed, parked caller does not block its own quiescence wait and
  cannot admit more work; any running sibling Host-capable work does block the
  prompt until it settles.
- **AC-9 (FR-6):** Secret fixtures and secret-bearing failures never enter command
  schemas, CLI I/O, receipts, Skill context, Thread Items, shared logs, or
  diagnostics. Agent-started edit is write-only; private reveal/copy keeps the
  barrier and removes unchanged handoff clipboard content before resume.
  Completion, cancel, browser/editor failure, and concurrent Provider deletion
  are covered.
- **AC-10 (FR-8):** Webpage, caption, and EPUB tests prove contextual Translation
  resolves one active preview, changes no global scalar/singleton, clears only
  that context's saved scope, and returns unavailable for zero or ambiguous
  contexts. Separate Data tests inspect and confirm clearing the complete
  persistent translation cache, including entries from closed previews.
- **AC-11 (FR-9, FR-10):** Shortcut tests classify every current handler/hint,
  round-trip portable bindings, cover alternate/disabled values, overlapping/
  disjoint scopes, reserved chords, conflicts, localization, and fixed IME/editing
  grammar.
- **AC-12 (FR-9, FR-10):** File, CLI, manager, and restart tests cover recording/
  cancel, set, disable, Reset, Reset All, malformed JSONC, stale edit, persistence
  failure, global registration failure, live rebind, and preservation of the
  previous registration after every failed candidate.
- **AC-13 (FR-7):** E2E proves `Cmd+,` opens the external scalar file and every
  direct manager, About/Help action, credential handoff, diagnostic operation,
  and contextual deep link remains reachable after Settings routes are absent.
- **AC-14 (FR-11):** Static/behavior guards prove `appPreferences`, the Provider
  mega-DTO, duplicate Memory/update policy, global Translation preference state,
  broad Settings events/sender admission, shell polling/badges/feedback, mixed
  shortcut registry, and surviving shell-derived Settings UI names are absent.
- **AC-15 (FR-5, FR-7, FR-9):** Invalid-file notice, managers, handoffs,
  confirmation, and Shortcut Manager pass keyboard/screen-reader use, 200% text,
  long English and Simplified Chinese, light/dark, increased contrast, reduced
  motion, and reduced transparency without overlap or layout shift.
- **AC-16 (FR-1 through FR-11, NFR-2):** Current specs are rewritten in the owning
  implementation PR; typecheck, relevant Core/renderer tests, focused E2E, docs
  checks, diff checks, source CLI integration, and packaged CLI smoke pass.

## Delivery Units

### 1. File-first scalar Settings and complete non-shortcut control

One PR delivers the scalar file/schema/watcher/recovery path, thin authenticated
router, all non-shortcut typed domain routes, Skill, receipts, confirmation and
private handoff, direct managers, contextual Translation, ownership splits, and
complete Settings-window removal. Build order is scalar/transport contract,
typed owners, CLI/Skill/managers, verified parity, then deletion. No transport or
CLI scaffold ships without every non-shortcut ledger row working end to end.

Expected areas include new configuration and command-routing modules; split
Provider/credential/catalog/image/Skill/Agent owners; Memory/update integration;
Host shell capability and packaged `tenon` resolver; direct window destinations;
preload contracts; renamed manager components/styles/i18n; old Settings deletion;
tests; and affected current specs.

This unit coordinates `package.json`, `docs/spec/README.md`, and any protected
protocol ownership before implementation. Prefer a dedicated Settings contract
module over expanding `src/core/types.ts`.

### 2. Complete shortcut configuration

One PR delivers the shared user-command registry, keybinding files/schema/
recovery, complete classification and parity guard, application/context matching,
safe system registration, shortcut CLI family, searchable manager, recording,
conflicts/reset, converted handlers/hints, tests, and current specs.

Unit 1 is a complete replacement for every existing non-shortcut Settings job;
Unit 2 is the complete new customization capability. It consumes Unit 1's final
transport and receipt conventions. This plan and board item remain active until
both units ship, so shortcuts are included rather than deferred.

## Risks And Collisions

- **File becomes a junk drawer:** enforce scalar eligibility; typed domains keep
  everything else.
- **Router becomes a mega-service:** share authentication, route identity, risk,
  and receipt only; domain modules retain schemas, state, revisions, events, and
  behavior.
- **JSONC mutation damages human text:** use source edits plus optimistic file
  fingerprint and atomic replacement; never rewrite the full document.
- **Agent confirms itself:** establish the interactive barrier before private UI,
  expose no approval channel, and recheck at settlement.
- **Secret escapes through a generic error or handoff:** make secret values absent
  from public schemas; isolate Agent-started edit/view UI and its clipboard while
  the barrier is active.
- **Settings removal strands work:** gate deletion on route-manifest parity,
  direct-entry E2E, and Agent composition coverage.
- **Shortcut breaks native behavior:** classify fixed grammar explicitly and keep
  the previous global registration until the new candidate is durable and active.

The 2026-09-03 collision check found open PRs #620, #621, #623, #624, and #625.

- #623 owns packaging, Desktop Host/Agent Bash composition, and runtime areas
  needed by this CLI and barrier. Unit 1 starts after it merges and rebases onto
  its final mechanism.
- #620 owns Delegation Runner/model policy. Its Agent owner contract settles
  before Unit 1 claims overlapping runtime/settings files; Unit 1 then exposes
  the merged owner without redefining it.
- #621 owns preview-shell files. Contextual Translation changes serialize behind
  it for overlap found at implementation claim time.
- #624 and #625 own Trajectory work and do not overlap this design surface.
- `agent-skill-authoring-foundation`, `agent-skill-curation-report`,
  `semantic-working-state`, and `dark-mode-contrast-pass` retain their product
  behavior but target the direct owners/managers described above.

This design-only PR does not modify runtime code, current specs, the main-owned
task board, `CHANGELOG.md`, or infrastructure-owned files.

## Open questions

None. The PM review fixes file-first scalar ownership, complete mutation-capable
Agent coverage, contextual Translation, model-unreadable secrets, Host-owned
confirmation, complete shortcuts, and exhaustive parity. Implementation may
choose reversible private helper names, but it must not restore an outgoing
Settings shell or universal owner.

## Implementation Checklist

- [ ] Re-run the collision self-check and claim Unit 1 after #623 and overlapping
      Agent/preview/Skill contracts settle.
- [ ] Implement every non-shortcut ledger row and clean-cut item in Unit 1; update
      current specs in the same PR.
- [ ] Claim Unit 2 on the merged transport and implement every shortcut/classified
      fixed interaction in one PR; update current specs in the same PR.
- [ ] Run typecheck, relevant Core/renderer tests, focused E2E, docs checks, diff
      checks, source CLI integration, packaged smoke, and required visual evidence
      for each unit.
- [ ] At the main gate, run ultra code review plus security review and repair the
      listed active-plan/board premises before folding and archiving this plan.
