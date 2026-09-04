# File-First Configuration And Complete Agent Control

## Goal

This plan is a set of two complete features:

1. file-first declarative configuration, complete non-shortcut Agent control,
   direct human domain managers, and removal of the unified Settings surface;
2. complete shortcut configuration through `keybindings.jsonc`, the same
   effective-status contract, and a direct Shortcut Manager.

The first feature preserves and improves every current non-shortcut Settings
capability. The second is a complete new customization feature and depends only
on the first feature's final file/status primitives. Neither PR ships a dormant
router, compatibility layer, or partially usable control plane. This plan is
complete only when both features ship.

- **OBJ-1:** `Settings...` and `Cmd+,` open Tenon's real configuration file in
  the user's editor. An ordinary valid save is observed automatically and
  applies without restarting Tenon; authority expansion pauses for private
  review.
- **OBJ-2:** A root Agent can complete every legitimate configuration, resource,
  maintenance, update, diagnostic, shortcut, and contextual Translation job.
  Declarative changes edit the same files as people; other jobs call their typed
  domain owners directly.
- **OBJ-3:** After a file edit, the Agent can prove whether the exact saved bytes
  were rejected, accepted but still applying, or effective. File-write success
  alone is never reported as configuration success.
- **OBJ-4:** Disabling a Skill or model tool and changing theme to dark are all
  ordinary Agent-completable tasks. Re-enabling model authority, widening an
  Agent ceiling, exposing credentials, and destructive work retain Host-owned
  human confirmation or private handoff.
- **OBJ-5:** Every capability has one state owner, one Agent route, and one human
  destination. Complete Agent reachability does not recreate a universal
  Settings service, DTO, router, tool, or CLI.
- **OBJ-6:** Invalid or partially saved text never replaces the last accepted
  configuration or prevents Tenon from starting.
- **OBJ-7:** Configurable shortcuts use the same file-first and verifiable model
  without making fixed editor, selection, or IME grammar configurable.

The clean-slate product model has three parts: public files own declarative
policy, typed domain tools own resources and operations, and direct managers own
human interaction. The built-in `configuration` Skill is only the decision and
workflow guide across those existing surfaces.

## Non-goals

- Do not build or retain any Settings or Configuration CLI. There is no
  `tenon settings`, hidden helper executable, or read-only CLI for discovery,
  validation, schema, status, or domain operations.
- Do not build a model tool named `settings` or `configuration`, a universal
  Settings route manifest, a Settings receipt protocol, or a mega-owner that
  imports every domain schema.
- Do not build a replacement Settings window, generated form, embedded editor,
  or category landing page.
- Do not place Provider connections, credentials, model catalogs, Agent
  definitions, Skill sources or managed lifecycle, Memory contents/reset,
  capability rules, website or translation data, update actions, diagnostics,
  recent selections, or contextual Translation state in a configuration file.
- Do not let a domain model tool become a second writer for declarative values.
  A direct human manager may request a formatting-preserving source edit through
  the configuration owner, but the public file remains the only desired state.
- Do not return API keys, OAuth material, secret paths, private Host handles, or
  secret-bearing errors to the model, renderer DTOs, status artifacts, logs, or
  diagnostics.
- Do not use `request_user_input` as security confirmation. It collects product
  input and cannot authorize destructive or authority-expanding work.
- Do not place Translation target, model, automatic behavior, toggle state, or
  cache operations in global configuration. Translation remains contextual;
  installation-wide cache maintenance remains a Data operation.
- Do not make navigation, selection, Return, Escape, Tab, deletion, clipboard,
  undo/redo, printable-character, or IME behavior configurable.
- Do not add configuration scopes, profiles, layering, includes, interpolation,
  executable configuration, remote administration, or cloud sync.
- Do not preserve `app-preferences.json`, the current `agent-providers.json`
  mega-shape, Settings routes/events, or legacy readers. Tenon is pre-release,
  so each implementation unit makes a direct format cut.

## Design

### 1. Boundary and evidence

Tenon adopts the useful common core of file-first developer tools:

- [Ghostty configuration](https://ghostty.org/docs/config) makes a file the
  primary Settings surface and reloads saved changes.
- [VS Code settings](https://code.visualstudio.com/docs/configure/settings) and
  [Zed settings](https://zed.dev/docs/configuring-zed) pair editable JSON with a
  schema, comments, completion, and explicit ownership.
- [Sublime Text settings](https://www.sublimetext.com/docs/settings.html) stores
  overrides rather than copied defaults.
- [Alacritty configuration](https://alacritty.org/config-alacritty.html) makes
  reload and invalid-file behavior explicit.

The earlier narrow plan copied the visible file shape but not the completed user
job. It let an Agent change desired bytes for four values, could not establish
whether those bytes became effective, and removed Agent reachability for every
resource and operation. This design keeps file-first mutation while restoring
semantic completion and verification without restoring a CLI.

Tenon distinguishes four product kinds:

| Kind | Examples | State owner | Agent interaction |
| --- | --- | --- | --- |
| Declarative policy | theme, disabled Skills/tools, request retry policy | public configuration file | generic file tools plus public status |
| Resource | Provider, Agent, Skill source, Runner selection | typed domain owner | domain model tool |
| Operation | reset Memory, clear data, update check | typed domain owner | domain model tool, confirmation when required |
| Context/runtime fact | active-preview Translation, effective access | producing owner | contextual model tool or inspection |

A value enters `settings.jsonc` when it is installation-wide, non-secret,
reversible, deterministic to validate, idempotent to apply, and independent of a
mutable resource's lifecycle. A bounded disabled-identity set is the deliberate
exception: absence is valid, unknown syntactically valid identities remain
disabled if that resource later appears, and the list selects availability
without owning the selected resource.

The hard constraints are Electron process isolation, isolated per-clone
`userData`, existing Full Access and Agent ceiling rules, model-unreadable
credentials, root-only application management, fail-closed file admission, and
no false claim of runtime settlement. The outgoing Settings shell and composite
stores are legacy constraints to delete, not contracts to preserve.

### 2. Public files and generated effective status

The current Electron `userData` root owns:

```text
{userData}/config/settings.jsonc
{userData}/config/settings.schema.json
{userData}/config/keybindings.jsonc
{userData}/config/keybindings.schema.json
{userData}/config/status.json
{userData}/state/settings-last-good.json
{userData}/state/keybindings-last-good.json
```

The JSONC files are desired state. The generated schemas and `status.json` are
public, model-readable Host output. Last-known-good snapshots and confirmation
state are private implementation data; they are never editing surfaces, Agent
inputs, or alternate desired state.

Packaged Tenon resolves these paths below its pinned
`~/Library/Application Support/Tenon/` userData root. Dev clones use the same
relative paths under isolated `ELECTRON_USER_DATA_DIR`. There is no second
`~/.config/tenon`, workspace, project, or active-profile location.

At startup Tenon creates the directory and atomically refreshes generated files.
It does not create a user override file until that file is opened or an
authorized writer creates it. Main exposes only the public configuration
directory to root Agent execution as `TENON_CONFIG_DIR`. The variable grants no
filesystem authority: ordinary tool selection, Full Access, explicit blocks,
and worktree containment remain authoritative. Delegated Sessions, child Agents,
and isolated execution do not receive the path or the `configuration` Skill and
must refuse application-configuration work under the existing no-permission-
laundering rule.

`status.json` is a bounded, atomically replaced observation, never a mutation
surface. For each public source it contains:

- existence, byte length, and SHA-256 digest of the latest stable desired bytes;
- `absent`, `observing`, `rejected`, `awaiting-confirmation`, `applying`,
  `effective`, or `degraded` state;
- accepted and effective generation plus their source digests;
- non-secret accepted/effective values and key-scoped application state; and
- bounded, source-located validation, confirmation, or application diagnostics.

The Host publishes status after observing a stable source snapshot, after
admission, and after every owner acknowledgement. `effective` means every key in
that accepted generation reached its declared runtime boundary. `degraded`
names keys that retained their preceding actual value after an application
failure. A status entry proves only the desired digest it names; a newer save
makes it stale evidence. Editing or deleting `status.json` changes no runtime
state and the Host recreates it. System-theme changes may update the resolved
effective value under the same accepted source generation.

This artifact resolves the direct-file race without a CLI or second settings
protocol. After writing, an Agent computes the desired file digest with ordinary
filesystem/shell capability and waits for a bounded interval until the matching
status entry reaches a terminal state. It may claim applied only for matching
`effective`; it reports `rejected`, `awaiting-confirmation`, or `degraded`
truthfully, and reports settlement unknown if the bounded wait expires.

### 3. `settings.jsonc`

One definition registry initially owns these declarative keys:

| Key | Value | Default | Effective boundary |
| --- | --- | --- | --- |
| `appearance.theme` | `system`, `light`, `dark` | `system` | `nativeTheme` and every window acknowledge |
| `appearance.language` | `system`, `en`, `zh-Hans` | `system` | every window and native menu acknowledge |
| `agent.memory.enabled` | boolean | `true` | Memory admission uses the generation |
| `agent.skills.disabled` | unique canonical names | `[]` | next catalog refresh excludes the set |
| `agent.tools.disabled` | unique canonical tool identities | `[]` | later root Turns exclude/reject the set |
| `agent.provider.timeoutMs` | positive integer or `null` | `null` | subsequent Provider requests use the value |
| `agent.provider.maxRetries` | non-negative integer or `null` | `null` | subsequent Provider requests use the value |
| `agent.provider.maxRetryDelayMs` | non-negative integer or `null` | `60000` | subsequent Provider retries use the value |
| `agent.provider.cacheRetention` | `none`, `short`, `long` | `short` | subsequent Provider requests use the value |
| `updates.checkAutomatically` | boolean | `true` | update scheduler acknowledges the policy |

Delegation Runner/model/access/scheduling policy does not enter this file. It
references mutable Runner and model resources and remains one Agent-domain
resource consumed by the merged `agent-delegation-runtime` design. Additional
Skill directories are Skill-source bindings, not strings owned by configuration.
Default image model and Agent execution choices likewise reference live resource
catalogs and remain with their domains.

Each definition owns codec, default, description, examples, application timing,
and safe effective projection. Schema, template, loader, diagnostics, status,
and consumers derive from those definitions. No consumer keeps another default
or preference writer.

The file is one flat JSON-with-comments object with stable dotted keys,
comments, trailing commas, UTF-8, and a 256 KiB limit. Duplicate or unknown keys,
nested aliases, malformed text, invalid types, duplicate list members, invalid
identity syntax, and unsupported values reject the whole candidate. Optional
string `$schema` is the only metadata member. Unknown but canonical Skill/tool
identities are accepted and remain disabled if later discovered. There are no
includes, expressions, references, or version fields.

The file contains overrides only. Removing an ordinary key restores its default.
Removing entries from `agent.skills.disabled` is routine because a Skill adds
instructions but cannot widen execution authority. Adding entries to
`agent.tools.disabled` narrows authority and applies routinely. Removing a
currently effective disabled-tool entry, including through deletion/reset of
the whole file, is authority expansion: direct file admission leaves the prior
accepted/effective generation active and publishes `awaiting-confirmation`.
The Access owner must complete a Host-native review bound to the exact desired
digest. Approval admits those unchanged bytes; any intervening edit makes the
approval stale. Cancel leaves desired bytes visible but changes no accepted or
effective state. When a person initiates enablement directly in Access, that
surface confirms first and then requests one formatting-preserving edit through
the configuration owner. Thus the public file remains desired truth without
making a model-authored edit its own approval.

Tool selection is Turn-stable. A newly accepted disabled-tool set never revokes
the already admitted file/status capabilities of the root Turn that authored
it; the configuration owner acknowledges the new baseline as effective for
every later root Turn. This lets the originating Agent verify the matching
status without granting any future invocation a temporary bypass. Explicit
capability blocks remain independently enforceable at each call.

Startup does not create the user file. `Settings...` creates a commented
overrides-only template when needed, refreshes generated artifacts, and asks the
OS to open it:

```jsonc
// Tenon configuration.
// Add only values you want to override. Remove an ordinary key to use its default.
{
  "$schema": "./settings.schema.json",

  // "appearance.theme": "dark",
}
```

The owner keeps desired, accepted, and effective state distinct. Reload is
whole-document and fail-closed at admission:

1. read one bounded stable snapshot and retain source locations;
2. reject malformed, duplicate, unknown, or invalid values;
3. stop before admission when the candidate widens disabled-tool authority;
4. form one immutable typed candidate from overrides and defaults;
5. persist a current-registry private last-known-good snapshot;
6. publish one accepted generation and `applying` status; and
7. let runtime owners idempotently converge and acknowledge that generation.

An invalid or awaiting-confirmation candidate stays on disk for repair/review
while the preceding accepted generation remains active. On startup, an absent
file selects defaults only when doing so does not silently widen a persisted
effective tool block; otherwise it enters the same confirmation path. A present
valid file wins. A present invalid file uses a last-known-good snapshot that
still validates against the current registry. If both desired input and the
persisted disabled-tool baseline are untrusted, ordinary UI starts with safe
non-authority defaults but new Agent execution remains unavailable until a
person repairs or explicitly resets configuration. Decode failure never turns
an unknown prior block into an empty allow set.

Acceptance is not a cross-domain rollback transaction. If one runtime owner
fails after admission, that key keeps its last actual runtime value, status
becomes `degraded`, and the owner retries without rolling back unrelated keys.
The watcher coalesces burst events, handles atomic replacement, discards stale
mid-read snapshots, and never normalizes the user's document after creation.

### 4. Agent workflow and domain tools

One immutable built-in inline Skill named `configuration` is the root Agent's
on-demand guide. Its catalog description covers Tenon preferences, shortcuts,
Models, Agents, Skills, Memory, Access, Data, Updates, Diagnostics, and active
preview Translation. Loading it adds instructions only; it does not add tools,
commands, permissions, execution overrides, hidden state, or approval authority.

For declarative work the Skill tells the Agent to:

1. resolve `TENON_CONFIG_DIR` without guessing a home-directory path;
2. select `settings.jsonc` or `keybindings.jsonc` from the user's intent;
3. read the matching generated schema, existing overrides, and current status;
4. make the smallest generic file edit while preserving unrelated comments;
5. compute the exact saved digest and inspect only matching Host status; and
6. report effective, rejected, degraded, awaiting-confirmation, or unknown
   settlement exactly as observed.

For resources, operations, private input, and contextual work the Skill selects
one typed domain model tool. It never edits private domain stores, invents a
shell command, or asks for a Settings CLI. The Skill may name the stable domain
tools and routing rule, but copies no setting key, default, command identity,
resource action catalog, validation schema, or receipt format; generated schemas
and model-tool contracts remain authoritative.

If a public override file is absent, the Agent treats it as empty. If existing
bytes cannot be edited confidently as JSONC, it preserves them and reports the
parse blocker. If `TENON_CONFIG_DIR`, the required file capability, a selected
domain tool, or active preview is unavailable, it reports that boundary instead
of searching private state or switching mechanisms. A Tool disabled by this
workflow cannot use another domain route to re-enable itself; only the direct
human Access destination remains when `access` is unavailable.

Ten domain tools provide complete semantic reachability without a Settings
router:

| Model tool | Typed owner | Scope |
| --- | --- | --- |
| `models` | Provider, catalog, image-selection, and credential owners | Provider/model resources and private auth handoffs |
| `agents` | Agent definition, execution, and delegation-policy owners | Agent resources, ceilings, Runner/model policy |
| `skills` | Skill source, provenance, and managed-lifecycle owners | discovery, binding, install/update/rollback lifecycle |
| `memory` | Memory owner | status, open, per-Thread mode, reset |
| `access` | capability-selection owner | effective access, rules, blocking, confirmed unblocking |
| `data` | preview-session and translation-cache data owners | bounded status and confirmed clearing |
| `updates` | update/application-info owner | status, check, release and product information |
| `diagnostics` | diagnostics/help owner | reveal, bounded export, help and issue destinations |
| `translation` | active preview owner | contextual language/model/automatic/toggle/cache work |
| `shortcuts` | command/keybinding owner | effective inspection and native physical recording |

These are ordinary Host model tools in the canonical registry, not commands
under a common namespace. Each owner contributes its own input/output schema,
operation-specific action descriptors, bounded pagination, revision checks,
idempotency, result envelope, and handler through the existing tool-registry
seam. Capability evaluation uses the decoded operation's descriptors rather
than one union for the whole tool, so blocking a mutation does not accidentally
remove inspection. The Agent runtime only assembles these contributions. No
domain imports another domain's state, and no shared service can list or mutate
all settings.

All ten tools are `rootThread` only and remain subject to the effective Profile,
Role tool ceiling, `agent.tools.disabled`, and explicit capability rules. Their
schemas are concise and stable; mutable Providers, models, Skills, Runners, and
commands are paged runtime data, never enum-expanded into the persistent model
catalog. The implementation measures total provider catalog bytes and rejects
an unbounded schema or result rather than inventing lazy tool activation that
would complicate authority.

Routine domain mutations settle through the existing canonical model-tool
envelope after the owner durably commits and applies the change. One intent uses
one tool call and does not require a read/edit/check sequence. A stale revision,
owner failure, unavailable context, or lost settlement returns the truthful
structured result already required of Host tools; there is no second Settings
receipt or audit store.

### 5. Private handoff and authority changes

The domain tool schema contains references and intended actions, never secret
values. API-key entry/replacement, secret reveal/copy, OAuth interaction, native
file/directory selection, and physical shortcut recording use Host-owned native
handoffs. The model receives only bounded public outcome and resulting non-secret
status. Secret text cannot enter model arguments, Thread Items, renderer-shared
DTOs, clipboard echoes, logs, diagnostics, status files, or errors.

Destructive operations and authority expansion use one shared Host interaction
coordinator owned outside Settings. Before showing private UI it consumes and
parks the originating model-tool invocation so it cannot issue more work,
pauses new Tenon-managed Agent admission for the affected profile, drains other
Host-capable Agent work, and then opens a Host-owned prompt. The parked caller is
excluded from its own quiescence wait; any sibling capable of interacting with
the prompt is not. The Host rechecks tool authority, target revision, and domain
preconditions after the person responds, then commits or returns cancel/stale.

No CLI, stdin, environment variable, renderer message, `request_user_input`,
Agent message, replay, or model-visible token can approve. If the app or caller
disconnects, canonical tool state and owner state determine the result; unknown
settlement is never called success or automatically retried.

Risk rules are consistent across domains:

- inspection and reversible routine changes execute directly;
- disabling a Tool, Skill, Provider, or Runner and narrowing an Agent ceiling is
  routine authority reduction;
- re-enabling a model tool, removing a capability block, or widening an Agent
  tool/Skill ceiling requires Host confirmation;
- deleting a Provider/Agent/credential, resetting Memory, clearing persistent
  data, and managed-Skill rollback/uninstall requires Host confirmation; and
- secret input/display and OAuth use a private native handoff even when the
  surrounding resource change is routine.

### 6. Shortcut configuration

`keybindings.jsonc` is separate because commands, scopes, chord parsing,
conflicts, and native registration belong to the shortcut owner rather than the
declarative preference registry.

The file maps stable command id to one portable chord, an ordered list of
alternates, or `null` to disable that command. Removing a key restores its
default. It follows the same bounded JSONC, schema, desired/accepted/effective,
status, watcher, diagnostics, and last-known-good contract without sharing one
state owner.

One user-command registry owns stable identity, localized label/category, scope,
configurable/fixed classification, defaults, portable parse/format, conflict
rules, runtime matching, and visible hints. Public scopes are `system`,
`application`, and declared mutually exclusive `context` scopes.

The configurable set is derived from handlers. It includes the global launcher;
Agent panel, new Thread, Today, Back/Forward, and active-preview Translation;
description, checkbox, move, duplicate, and tag commands in applicable row/editor
contexts. Navigation, selection extension, selected-reference choices, edit
entry, indentation, deletion, clipboard, undo/redo, Return/Escape/Tab, printable
keys, and IME paths are named fixed interactions. A parity guard fails when any
handler or visible hint is neither one configurable command nor one fixed rule.

The loader rejects malformed chords, reserved platform combinations, duplicate
bindings in overlapping scopes, and whole-candidate conflicts. Disjoint context
scopes may reuse a chord. For the system launcher, the owner registers the first
available candidate before releasing the old registration. Validation,
persistence, or registration failure preserves the previous accepted/effective
set and publishes matching status diagnostics.

`Keyboard Shortcuts...` opens the file. Reset means removing one override; Reset
All means deleting overrides; both are routine source edits that restore known
defaults. A searchable direct Shortcut Manager exists only
for physical recording, conflict resolution, disable, per-command Reset, Reset
All, and `Open Keybindings File`; it has no Settings parent or category shell.
The `shortcuts` model tool can inspect effective bindings or start the private
recording handoff, while ordinary Agent edits remain file-first.

### 7. Complete capability ledger

Every current control, current hidden policy, and new shortcut capability has
exactly one Agent route and one human destination. A native handoff means the
Agent starts and awaits private human interaction but never receives its input.

| Capability | Canonical Agent route | Risk | Owner / human destination |
| --- | --- | --- | --- |
| Configuration schema, desired/accepted/effective values, diagnostics | `configuration` Skill -> generated files/status | inspect | configuration owner / editor |
| Theme and interface language | `configuration` Skill -> `settings.jsonc` | routine, live | configuration owner / editor |
| Global Memory enablement and automatic update checks | `configuration` Skill -> `settings.jsonc` | routine, live | configuration owner / editor |
| Global Skill enable/disable | `configuration` Skill -> `agent.skills.disabled` | routine, live catalog refresh | configuration owner / Skills |
| Global model-tool disable | `configuration` Skill -> `agent.tools.disabled` | routine narrowing | configuration/access owners / Access |
| Global model-tool re-enable | `access review_pending_tool_enable` | confirmed widening bound to pending digest | access/configuration owners / Access |
| Provider timeout/retry/cache policy | `configuration` Skill -> `settings.jsonc` | routine; next request | configuration/Provider runtime owners / editor |
| Provider/model catalog, connection and capability status | `models list|show` | inspect, paged | Provider/catalog owners / Models |
| Provider enable/disable/activate, id/base URL, test, catalog refresh | `models enable|disable|activate|configure|test|refresh` | routine | Provider/catalog owners / Models |
| Default image model | `models image_default set|reset` | routine | image-selection owner / Models |
| API-key add/replace | `models credentials edit` | private native handoff | credential owner / Models handoff |
| Stored API-key reveal/copy | `models credentials view` | private handoff, no secret result | credential owner / direct-human Models only |
| Stored credential deletion | `models credentials delete` | confirmed | credential owner / Models |
| OAuth sign-in/challenge/sign-out | `models oauth ...` | private handoff; sign-out confirmed | credential owner / browser/Models |
| Provider deletion | `models delete` | confirmed | Provider owner / Models |
| Agent catalog, identity, presentation, instructions, Profile, layer | `agents list|show|create|update|duplicate` | inspect/routine | Agent definition owner / Agents |
| Agent tool/Skill ceiling | `agents update` | narrowing routine; widening confirmed | Agent definition owner / Agents |
| Agent model/reasoning execution selection | `agents execution set|reset` | routine | Agent execution owner / Agents |
| Agent deletion | `agents delete` | confirmed | Agent definition owner / Agents |
| Delegation enablement, Runner/model/access/scheduling policy and readiness | `agents delegation show|set|reset` | routine within ceilings; widening confirmed | Agent delegation owner / Agents |
| Skill catalog/source/status/update availability | `skills list|show|check_updates` | inspect or bounded network check, paged | Skill owners / Skills |
| Bind/reveal/unbind local Skill directory | `skills bind|reveal|unbind` | native selection/open; unbind routine | Skill source owner / Skills |
| Undo latest Agent Skill edit | `skills undo_agent_edit` | revision-checked routine | Skill provenance owner / Skills |
| Discover/review/install managed Skill | `skills discover|install` | inspect then private native review | managed Skill owner / Skills |
| Preview/apply managed Skill update | `skills preview_update|apply_update` | inspect then private native review | managed Skill owner / Skills |
| Managed Skill rollback/uninstall | `skills rollback|uninstall` | confirmed | managed Skill owner / Skills |
| Memory status and Open Memory | `memory status|open` | inspect/native open | Memory owner / Memory |
| Memory reset | `memory reset` | confirmed | Memory owner / Memory |
| Per-Thread Memory mode | `memory thread show|set` | originating Thread routine | Memory owner / Thread details |
| Effective filesystem/tool access | `access show` | inspect runtime fact | capability owner / Access |
| Persistent Action/Command capability blocks | `access blocks|block|unblock` | block routine; unblock confirmed | capability owner / Access |
| Website/session data status and clear | `data website show|clear` | inspect/confirmed | preview session owner / Privacy & Data |
| Persistent translation-cache status and global clear | `data translations show|clear` | inspect/confirmed | translation-cache owner / Privacy & Data |
| Update status/check/open release | `updates status|check|open` | inspect/routine/native open | update owner / About Tenon |
| App/version/build, copy version, changelog, help, issue, license | `updates info` and `diagnostics open` | inspect/native open | application owner / About/Help |
| Reveal/export diagnostics | `diagnostics reveal|export` | native open/save handoff | diagnostics owner / Help |
| Active Translation target/model/automatic/toggle | `translation show|set|toggle` | inspect/routine | active preview owner |
| Active preview saved translations | `translation clear_saved` | confirmed | active preview owner |
| Registered launcher and effective bindings | generated keybinding status or `shortcuts show` | inspect runtime fact | shortcut/launcher owner |
| Configurable command bindings and reset | `configuration` Skill -> `keybindings.jsonc` | routine | keybinding owner / editor/Shortcuts |
| Physical shortcut recording | `shortcuts record` | private native handoff | Shortcut Manager |
| Fixed platform interaction grammar | schema/`shortcuts show` marks `fixed` | inspect only | renderer interaction owner |

The parity test derives its work queue from configuration definitions, current
domain controls, assembled domain-tool contracts, the Agent delegation policy,
and the complete command registry. A missing, duplicate, unbounded,
secret-bearing, human-only, or `future` mapping fails. This ledger is not a route
manifest used at runtime.

### 8. Direct human destinations

Removing the Settings shell does not remove human capability. The application
menu keeps `Settings...` and `Keyboard Shortcuts...`, then groups Models, Agents,
Skills, Memory, Access, and Privacy & Data in a native `Manage` submenu. About
and Help retain platform-standard homes. Active-preview Translation remains on
the preview. Contextual deep links open the same owners directly.

Destinations may reuse a generic auxiliary-window primitive, but share no
Settings landing page, category navigation, aggregate DTO, eager loading,
polling, badge counts, feedback state, or generic Settings dialog parent.
Configuration-backed controls shown in a direct manager use the configuration
owner's formatting-preserving source edit and matching status; they do not keep
another preference store.

### 9. Retire inherited ownership

The implementation removes these outgoing shapes instead of wrapping them:

1. **Composite app preferences.** Theme/language move to configuration;
   Translation moves to preview context; recent Agent selection moves to its
   Agent owner. Delete the old reader and fallback order.
2. **Provider mega-owner.** Split `agentSettings` into Provider resources,
   credential storage, model-catalog cache, image selection, declarative request
   policy, Skill sources, and Agent/delegation policy. No public operation reads
   or rewrites the mega-DTO.
3. **Duplicate policy authority.** Memory global enablement, global Skill/tool
   disabled sets, Provider request policy, and automatic update checks derive
   only from accepted configuration. The managed-Skill index no longer keeps a
   second enabled flag; install creates the resource and the one global disabled
   set determines availability. Domain owners keep operational state.
4. **Global Translation preferences.** Remove global fields, broadcasts, and
   optimistic renderer singletons. Preview controllers own context; persistent
   translations remain Data.
5. **Mixed shortcut grammar.** Move configurable identities and bindings to the
   command registry. Keep fixed DOM/IME behavior renderer-private.
6. **Settings-window authority.** Remove `SettingsWindow`, category/page/anchor
   routes, eager cross-domain reads, Settings sender admission, shell polling,
   badges, and feedback.
7. **Broad Settings coupling.** Replace `lin:settings-changed` with narrow owner
   events. Extract Provider editor routing before deleting `settingsWindow.ts`.
   Dialogs use their real owner window.
8. **Dead Settings vocabulary.** Rename surviving components, styles, i18n,
   tests, and spec sections so `Settings*` no longer owns domains.

Current specs remain truthful until implementation ships. Each implementation
PR folds its design into the affected specs in the same change.

### 10. Main flows and failures

**Person or Agent edits configuration.** The writer opens or edits the public
file. Tenon observes a stable digest, validates the whole candidate, and
publishes matching status. Ordinary valid changes converge live. Invalid bytes
remain editable while prior effective state stays active. A person sees one
notice with `Open File` and `Copy Diagnostics`; an Agent reads the same bounded
diagnostic from status.

**Agent disables a Skill.** The root Agent loads `configuration`, reads the
schema and current file, adds the canonical name to `agent.skills.disabled`,
and saves. The Skill registry acknowledges the accepted generation, subsequent
catalog projection omits that Skill, and matching effective status proves the
task. No `skills` command or tool mutation duplicates the file.

**Agent disables a tool.** The root Agent adds the canonical identity to
`agent.tools.disabled`. The current Turn keeps its immutable admitted catalog,
so it can observe matching effective status. Every later root Turn excludes or
rejects that identity. Disabling all future file/status tools is therefore
verifiable once without creating a re-enable path for the current Agent.

**Agent changes theme to dark.** The root Agent edits `appearance.theme`, then
waits for matching `effective` status. `nativeTheme.themeSource` and every open
window acknowledge the same generation; new windows initialize from it. No
renderer `[data-theme]` bridge or restart is involved.

**Agent manages a domain.** The Skill selects one typed domain model tool. The
owner validates current revision and authority, commits once, applies, publishes
its event, and returns one bounded canonical result. No public or private
configuration file mediates the operation.

**Agent requests secret or dangerous work.** The domain tool enters the shared
private handoff/confirmation coordinator. The user completes or cancels native
UI; the Agent receives only public outcome and cannot approve its own request.

**Invalid startup file.** Tenon starts from a current valid snapshot or safe
non-authority defaults, publishes rejected status, and shows repair guidance
only after the application is usable. If no trusted effective Tool-disable
baseline survives, Agent execution stays unavailable rather than widening by
default. Tenon never silently rewrites desired bytes.

## Requirements

- **FR-1:** Public JSONC/schema/status artifacts, watcher, last-known-good
  recovery, diagnostics, and runtime acknowledgements implement the declared
  desired/accepted/effective contract.
- **FR-2:** The ten declarative definitions have one codec, default,
  description, application boundary, and source writer. No legacy store can
  override them.
- **FR-3:** People and root Agents mutate declarative policy through the public
  files. No Settings/Configuration CLI, model tool, router, validator command,
  status command, or alternate state store exists.
- **FR-4:** The `configuration` Skill routes file, domain, private, confirmed,
  and contextual work without duplicating schemas or adding authority.
- **FR-5:** Every non-shortcut ledger row has exactly one bounded root-thread
  file or domain-tool route and one direct human destination. No legitimate
  control is Agent-unreachable or marked future.
- **FR-6:** Host confirmation and private handoff cannot be completed by
  Tenon-managed Agent work, and secret bytes never cross a model-readable
  boundary.
- **FR-7:** Translation preferences and scoped clearing resolve exactly one
  active preview; global translation-cache maintenance remains Data.
- **FR-8:** The command registry, `keybindings.jsonc`, schema/status, watcher,
  conflict validation, native registration, runtime matching, hints, file-first
  Agent workflow, and Shortcut Manager share one binding owner.
- **FR-9:** Every shortcut is configurable or one named fixed interaction, and
  failed candidates never displace the previous effective binding set.
- **FR-10:** The eight inherited ownership shapes are removed without adapters,
  duplicate state, or residual Settings-derived domain vocabulary.
- **NFR-1:** Each public configuration read is bounded to 256 KiB; status,
  model-tool schemas/results, and resource pages are bounded. Watcher work is
  coalesced and never blocks startup or renderer interaction.
- **NFR-2:** Renderers receive narrow typed values/events and gain no Node.js,
  filesystem, credential, private snapshot, confirmation, or domain-store
  access.

## Acceptance Criteria

- **AC-1 (FR-1, FR-2):** Registry tests prove exactly ten initial keys and one
  definition source. Schema, template, loader, status, and consumers agree;
  resources, secrets, delegation references, and Translation are rejected.
- **AC-2 (FR-1):** Missing, deleted, valid, commented, trailing-comma, UTF-8,
  maximum-size, duplicate, unknown, malformed, invalid-type, invalid-identity,
  and unsupported files have deterministic tests. Watcher tests cover atomic
  rename, bursts, stale reads, and mid-read edits.
- **AC-3 (FR-1, FR-2):** Startup and invalid-save tests prove distinct desired,
  accepted, and effective state; exact digest correlation; whole-candidate
  rejection; last-known-good recovery; safe non-authority defaults; refusal of
  Agent admission when no trusted disabled-tool baseline survives; per-key
  degradation; and preservation of desired bytes.
- **AC-4 (FR-1, FR-2):** Theme/language acknowledge every window/native menu;
  Memory uses its admission boundary; Skill catalogs and tool admission refresh;
  Provider request policy affects only subsequent requests; update scheduling
  consumes accepted policy. Tool-disable tests prove the authoring Turn remains
  stable while every later root Turn applies the new ceiling. Restart restores
  the same effective result.
- **AC-5 (FR-2, FR-6):** Adding a disabled Tool is routine. Directly removing
  one, deleting the file, or resetting that key cannot widen authority; matching
  status remains `awaiting-confirmation` until Access approval admits that exact
  unchanged digest. Human-initiated Access enablement confirms before its single
  structural source edit. Cancel, stale digest, restart, and concurrent edits
  preserve the prior effective block; corrupt desired and private baseline state
  cannot decode as an empty disabled set.
- **AC-6 (FR-3, FR-4):** E2E proves `Settings...`/`Cmd+,` opens the exact file.
  A root Agent loads `configuration` and completes theme-dark, Skill-disable,
  and Tool-disable tasks with minimal generic file edits plus matching effective
  status. Missing path, restricted file authority, invalid current bytes, stale
  status, rejection, degradation, confirmation, and timeout remain truthful.
- **AC-7 (FR-3, FR-4):** Static/package guards find no `tenon settings`, Settings
  or Configuration CLI entry, executable, parser, help text, route, model tool,
  universal DTO/service, or Settings-specific receipt. The Skill contains no
  copied keys/defaults/command identities/action schemas.
- **AC-8 (FR-5):** A parity test derived from live controls and owner registries
  proves every capability-ledger row has one tool/file route, risk class, typed
  owner, bounded result, and human destination. Missing, duplicate, unbounded,
  secret-bearing, human-only, and `future` rows fail.
- **AC-9 (FR-5):** Model-tool contract and integration tests complete Provider,
  Agent/delegation, Skill lifecycle, Memory, access, data, update, diagnostics,
  and Translation examples through their actual owners. Stale revisions, owner
  failures, unavailable context, blocks, pagination, and no-change results are
  explicit and never fall back to files or shell commands.
- **AC-10 (FR-6):** Confirmation tests prove the consumed parked caller cannot
  block its own quiescence wait or issue more work, while capable siblings do
  delay private UI. No model-visible channel can approve; approve, cancel,
  stale state, changed authority, duplicate response, Host loss, and caller loss
  never produce false success or replay approval.
- **AC-11 (FR-6):** Secret fixtures never enter tool schemas/arguments/results,
  Thread Items, status, shared renderer state, logs, or diagnostics. API-key,
  OAuth, reveal/copy, cancel, browser/editor failure, and concurrent resource
  deletion retain private handoff isolation.
- **AC-12 (FR-7):** Webpage, caption, and EPUB tests prove contextual
  Translation changes no global file/singleton, scoped clearing affects only one
  preview, zero/ambiguous context is unavailable, and confirmed Data clearing
  includes entries from closed previews.
- **AC-13 (FR-8, FR-9):** Shortcut tests classify every handler/hint, round-trip
  portable bindings, cover alternate/disabled values, overlapping/disjoint
  scopes, reserved chords, conflicts, localization, and fixed IME/editing rules.
- **AC-14 (FR-8, FR-9):** File, status, manager, and restart tests cover physical
  recording/cancel, minimal edit, disable, Reset, Reset All, malformed JSONC,
  stale digest, persistence failure, global registration failure, live rebind,
  and preservation of the previous registration after every failed candidate.
- **AC-15 (FR-5, FR-10):** E2E proves every direct manager, About/Help action,
  Provider editor, credential handoff, diagnostics operation, and active-preview
  control remains reachable after Settings routes/navigation are absent.
- **AC-16 (FR-10):** Static/behavior guards prove `appPreferences`, the Provider
  mega-DTO, duplicate policy owners, global Translation preferences, broad
  Settings events/sender admission, shell polling/badges/feedback, mixed shortcut
  registry, and surviving Settings-derived domain names are absent.
- **AC-17 (FR-1, FR-5, FR-6, FR-8, NFR-1, NFR-2):** Notices, direct managers,
  handoffs, confirmation, and Shortcut Manager pass keyboard/screen-reader use,
  200% text, long English/Simplified Chinese, light/dark, increased contrast,
  reduced motion, and reduced transparency without overlap or layout shift.
- **AC-18 (FR-1 through FR-10, NFR-1, NFR-2):** Each implementation PR folds
  shipped behavior into current specs and passes typecheck, relevant Core and
  renderer tests, focused E2E, docs/diff checks, packaged smoke, and required
  light/dark visual verification.

## Delivery

### 1. File-first configuration and complete current capability control

One PR delivers `settings.jsonc`, generated schema/status, watcher and recovery,
ten declarative definitions, root path exposure, the `configuration` Skill, all
nine non-shortcut domain tools, confirmation/private handoff, direct managers,
contextual Translation, ownership splits, and unified Settings removal. Build
order is file/status definitions, typed owner contracts, runtime application,
domain tools/handoff, direct human destinations, verified parity, then deletion.
Nothing removes an existing route before its file, tool, and direct destination
pass end-to-end tests.

Expected areas include new configuration/status modules; `appPreferences`;
Provider, credential, catalog, image, Skill, Memory, Access, update,
Translation, Agent/delegation ownership; canonical model-tool contracts and
capability action kinds; Agent local execution environment; Window Application
Host routing; preload types; direct manager components/styles/i18n; tests; and
affected specs.

### 2. Complete shortcut configuration

One PR delivers the shared command registry, `keybindings.jsonc` and generated
schema/status, recovery, complete handler classification, application/context
matching, safe system registration, the `shortcuts` domain tool, direct Shortcut
Manager, converted hints, parity tests, and current specs.

Feature 1 is a complete replacement for every current non-shortcut Settings job.
Feature 2 is a complete independently useful shortcut-customization feature. It
consumes Feature 1's shipped generic JSONC/status primitives but no temporary
Settings route or scaffold. The plan and board item remain active until both
features ship.

Both units coordinate before touching infrastructure-owned files,
`docs/spec/README.md`, `src/core/agent/tools.ts`, `src/core/types.ts`, or Agent
runtime composition. Protected model-tool/action-kind contracts land under the
shared-interface ownership rule; domain behavior remains in the complete
feature PR rather than entering the shared layer.

## Risks And Collisions

- **A file becomes a junk drawer:** only deterministic declarative policy enters
  JSONC; live resources and operations remain typed domain state.
- **A file write is mistaken for completion:** exact desired digest and generated
  effective status are mandatory before success language.
- **An Agent re-enables its own authority:** disabled-tool removal never admits
  directly; the Access owner and Host confirmation must edit the source.
- **Domain tools recreate Settings:** there is no shared namespace, route table,
  aggregate schema, or state service; the runtime only assembles owner contracts.
- **Tool catalog grows without bound:** schemas contain operations, cursors, and
  identifiers rather than live resource enums; catalog-byte tests gate delivery.
- **Secret escapes through a result or error:** secrets are absent from public
  schemas and isolated through native handoff end to end.
- **Invalid files break launch:** last-known-good/safe defaults preserve runtime
  while desired bytes and diagnostics remain repairable.
- **Settings removal strands work:** generated parity and direct-entry E2E gate
  every old route's deletion.
- **Shortcuts break native behavior:** fixed grammar is explicit and prior system
  registration stays active until a replacement succeeds.

The 2026-09-04 collision check found open PRs #621, #623, and #626; #620's Agent
delegation design is merged and remains active implementation authority.

- #623 owns generic Background Tool Tasks and overlaps canonical Agent tool
  registry/runtime files. Feature 1 waits for #623 and rebases before claiming
  those files.
- The merged #620 design still calls the outgoing Settings surface the only
  Runner-policy authority. Its internal-delegation implementation and this plan
  must converge on the direct Agent/delegation owner: whichever implementation
  claims first publishes that typed owner, and the other rebases before work.
- `agent-skill-authoring-foundation` and `agent-skill-curation-report` own Skill
  authoring/curation behavior. Feature 1 follows the foundation and preserves its
  final Skill source/provenance owners rather than recreating them.
- #621 owns preview-shell files. Contextual Translation work serializes behind it
  when Feature 1 claims implementation files.
- `semantic-working-state` remains applicable to direct Models/Skills managers;
  Feature 1 absorbs its final behavior when those managers are moved.
- This design PR #626 is the only open claim on this plan file.

This plan does not edit the main-owned board or changelog. At the integration
gate, main must update their stale two-unit and outgoing Settings/Runner-owner
premises to match the accepted design and real implementation order.

## Open questions

None. The selected target is file plus generated effective status for
declarative policy, typed domain model tools for resources and operations,
Host-private confirmation/handoff for protected work, direct human managers, and
no Settings/Configuration CLI or universal Settings control plane.

## Implementation Checklist

- [ ] Re-run collision checks after #623 and before each implementation claim;
      settle protected tool contracts and Agent delegation ownership first.
- [ ] Ship Feature 1 as a complete current-capability replacement, fold current
      specs, and remove the unified Settings surface only after parity passes.
- [ ] Ship Feature 2 as complete shortcut customization and fold its current
      specs without restoring Settings navigation.
- [ ] Run typecheck, relevant Core/renderer tests, focused E2E, docs/diff checks,
      packaged smoke, model-tool catalog bounds, and light/dark verification.
- [ ] At the main gate, run ultra code review plus security review, repair active
      plan/board premises, and archive this plan only after both features ship.
