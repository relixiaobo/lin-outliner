# File-First Settings

This plan is **one complete feature delivered in one PR**. It replaces Tenon's
Settings window and split scalar-preference writers with one public,
overrides-only configuration document. `Settings...` opens that document in the
user's default editor. A person and an Agent change the same file; Tenon
validates and reloads it through the same Host path.

Resource managers remain separate product surfaces. Models, credentials,
Agents, Skills, Memory contents, access policy, local data, diagnostics, and
updates are not flattened into the configuration document merely because the
old Settings window happened to contain them.

## Goal

Make configuration a small, inspectable, tool-independent contract instead of
a renderer form hierarchy or a privileged mutation API.

- **OBJ-1:** A person can press `Cmd+,`, edit a documented configuration file
  with any text editor, save it, and see a valid change take effect without
  opening a Settings UI.
- **OBJ-2:** An Agent with ordinary permission to edit the active profile's
  configuration file can inspect and change the same source of truth with its
  existing file tools, then validate and verify the result.
- **OBJ-3:** Invalid or partially saved text never replaces the last accepted
  configuration or prevents Tenon from starting.
- **OBJ-4:** The public file contains only low-risk declarative preferences. It
  cannot carry credentials, destructive operations, executable code, resource
  lifecycle mutations, or Agent authority policy.
- **OBJ-5:** Each included preference has one definition for its public key,
  value schema, default, description, and application timing; the generated
  editor schema, validator, effective view, and runtime consume that definition.

The minimum acceptable outcome is not merely opening the existing
`app-preferences.json`. The file must be a stable public contract, preserve user
comments, reject invalid candidates as a whole, expose useful diagnostics, and
replace shadow preference sources for every key it owns.

## Non-goals

- Do not build a replacement Settings window, Settings rail, schema-generated
  form, or embedded text editor.
- Do not build a generic Settings control plane over unrelated domains.
- Do not add `tenon settings set`, resource mutation subcommands, model-native
  settings tools, exact-request capabilities, confirmation receipts, or another
  mutation/audit protocol. The Agent edits the file.
- Do not put Provider connections, API keys, OAuth material, model catalogs,
  Agent definitions, Skill installation or lifecycle, Memory contents/reset,
  persistent capability blocks, website-data clearing, manual update checks,
  diagnostic export, caches, recent selections, runtime revisions, or history
  in the public file.
- Do not add project/workspace configuration or configuration layering in this
  feature. The document is user-profile scoped.
- Do not add includes, imports, environment interpolation, expressions,
  functions, plugins, commands, or another executable configuration language.
- Do not add general shortcut customization. A future `keybindings.jsonc` may
  own stable command identities, scopes, conflicts, and OS registration; those
  semantics do not belong in the scalar settings document.
- Do not let Tenon rewrite, sort, format, or repair an existing user document.
- Do not preserve the current Settings routes, category/page aliases, scalar
  preference IPC writers, or `app-preferences.json` reader. Tenon is pre-release;
  make one clean cut without migration or compatibility readers.
- Do not redesign the internal behavior of resource managers except where
  required to give each surviving manager a truthful direct entry point.

## Design

### 1. Product decision and reference model

The selected target is **file-first**, following the part of Ghostty's model
that makes configuration an ordinary user-owned document:

- [Ghostty configuration](https://ghostty.org/docs/config) treats the
  configuration file as the primary editing surface, reloads changes, and
  exposes effective/default configuration for diagnosis.
- [VS Code settings](https://code.visualstudio.com/docs/configure/settings) and
  [Zed settings](https://zed.dev/docs/configuring-zed) demonstrate the value of
  JSON editor schemas, comments, completion, and explicit user/project scope.
- [Sublime Text settings](https://www.sublimetext.com/docs/settings.html)
  demonstrates an overrides-only user file rather than copied defaults.
- [Alacritty configuration](https://alacritty.org/config-alacritty.html)
  demonstrates that reload behavior must be declared rather than implied.

Tenon adopts the bounded parts: a plain data file, comments, generated schema,
overrides-only content, automatic reload, effective/default inspection, and
explicit application timing. It rejects executable configuration such as
WezTerm's Lua model and dynamic include graphs such as kitty's. Code execution
and implicit file traversal are especially inappropriate when an Agent may edit
the document.

Competitor behavior is directional evidence, not proof of Tenon's scope. The
deciding rule is that the document must remain safe to read into Agent context,
deterministic to validate, and unsurprising to edit with generic file tools.

The current renderer hierarchy and persistence files are resolvable legacy
constraints, not the target architecture. The hard constraints are profile
isolation, Electron process separation, no credential exposure through the
public document, and preservation of resource-manager reachability.

### 2. Product boundary

Tenon distinguishes four kinds of state:

| Kind | Meaning | Examples | Owner |
| --- | --- | --- | --- |
| **Public setting** | Low-risk, reversible, declarative user preference | theme, display language, automatic translation defaults, Memory enabled | `settings.jsonc` |
| **Resource configuration** | Named object with identity, validation, and lifecycle | Provider connection, Agent definition, Skill | its domain manager/store |
| **Sensitive or authority state** | Secret or policy that changes what an Agent may access | API key, OAuth token, persistent capability block | native/domain security owner |
| **Operation or runtime state** | Action, cache, status, history, or derived fact | reset Memory, clear website data, recent model, registered launcher hotkey | its domain owner |

A value is eligible for `settings.jsonc` only when all of these are true:

1. It is a user-profile-wide preference, not a project fact or selected
   resource instance.
2. Its complete value is safe for an authorized Agent to read.
3. It is reversible and cannot delete data, reveal a secret, install code, or
   widen Agent authority.
4. It can be validated locally and deterministically without fetching a model
   catalog, opening a credential store, or asking another application.
5. Its runtime application is idempotent and has an explicit timing contract.

If a candidate fails one rule, it stays with its domain owner. The public file
is not the index of everything that can be changed in Tenon.

The initial registry owns these settings:

| Public key | Value | Default | Application |
| --- | --- | --- | --- |
| `appearance.theme` | `system`, `light`, or `dark` | `system` | live in every window |
| `appearance.language` | `system`, `en`, or `zh-Hans` | `system` | live in every window and native menu |
| `translation.targetLanguage` | `interface` or a supported language code | `interface` | next translation request; existing rendered text is unchanged |
| `translation.automatic.webpages` | boolean | `false` | next eligible navigation/translation decision |
| `translation.automatic.epubs` | boolean | `false` | next eligible EPUB translation decision |
| `agent.memory.enabled` | boolean | `true` | live policy; disabling fences new Memory work and settles active work through the Memory owner |
| `updates.checkAutomatically` | boolean | `true` | live scheduling policy; disabling does not rewrite an already completed or in-flight result |

`translation.model` is deliberately absent because its validity depends on
mutable Provider/model resources. The last Agent model selection is recent
runtime state, not a default. The launcher hotkey remains a registered runtime
fact until a complete keybindings contract exists.

### 3. Public files and profile scope

The active profile owns:

```text
{userData}/config/settings.jsonc          # user-owned public document
{userData}/config/settings.schema.json    # Tenon-generated editor schema
{userData}/state/settings-last-good.json  # Host-private derived snapshot
```

Packaged Tenon therefore uses
`~/Library/Application Support/Tenon/config/settings.jsonc` on macOS. Each dev
clone continues to resolve the same relative path under its isolated
`ELECTRON_USER_DATA_DIR`; there is no shared `~/.config/tenon` escape hatch.

At startup and before `Settings...` opens the document, Tenon creates the
directory and atomically refreshes the generated schema. It creates this
document only when `Settings...` is invoked and the document is missing:

```jsonc
// Tenon configuration.
// Add only the settings you want to override. Remove a key to restore its default.
// Run `tenon config show --defaults` to inspect every available setting.
{
  "$schema": "./settings.schema.json"

  // "appearance.theme": "dark",
}
```

Tenon may replace its generated schema atomically when the application version
changes. After creating `settings.jsonc`, Tenon never writes that file. Human
and Agent edits therefore preserve comments, ordering, and formatting without a
second writer racing them.

Removing a public key restores its registry default. Defaults are never copied
into the user document. The `$schema` member is editor metadata, not a runtime
setting. It may be omitted; when present it must be a string. The runtime schema
version is owned by the generated schema and Host registry rather than a user-
maintained version field.

### 4. Document contract

`settings.jsonc` is a bounded JSON-with-comments object:

- one flat top-level object;
- stable dotted public keys;
- comments and trailing commas allowed;
- values restricted by each key's schema;
- UTF-8 and at most 256 KiB;
- duplicate keys, unknown keys, nested aliases, invalid types, malformed text,
  and unsupported values are errors;
- no includes, references other than `$schema`, interpolation, or executable
  values.

Flat dotted keys make one setting one patch target. They avoid ambiguous merge
rules between nested objects and let an Agent change one value without
rewriting its siblings.

One typed registry is authoritative for public key, codec, default,
description, examples, application timing, and safe effective projection. The
JSON schema and `tenon config` output are generated from it. Runtime consumers
read the accepted typed snapshot; they do not parse the file, keep their own
defaults, or consult the old preference stores.

Diagnostics include the file, line, column, public key when known, concise
cause, and expected value shape. Diagnostics quote only bounded public config
text and never attach unrelated Host errors or state.

### 5. Load, validation, and reload

The main-process configuration owner loads at startup and watches only the
canonical `settings.jsonc`. Atomic-save rename sequences and repeated events are
debounced into one stable read. Every read carries a content generation so a
slower older validation cannot replace a newer save.

Reload is whole-document and fail-closed at the validation/admission boundary:

1. Read one bounded stable snapshot.
2. Parse JSONC while retaining source locations.
3. Reject duplicate/unknown keys and validate every declared value.
4. Merge valid overrides with registry defaults into one typed candidate.
5. Persist the validated overrides as the private last-known-good snapshot and
   atomically replace the in-memory accepted snapshot.
6. Publish one generation; each runtime owner reads or idempotently converges to
   that accepted value according to the setting's timing contract.

There is no partial validation or admission. If any declared key is invalid,
the complete candidate is rejected and every runtime consumer continues to see
the preceding accepted generation. A failed candidate remains on disk for the
user or Agent to repair; Tenon neither rewrites it nor silently drops the bad
key.

Acceptance is not a cross-domain rollback transaction. After one valid snapshot
is accepted, owners converge independently from that immutable generation. An
unexpected owner failure records a key-scoped diagnostic and leaves that key's
last actual runtime value visible as its effective value until retry or restart;
it does not roll back unrelated keys or make a newer valid file disappear. The
eligibility rules keep fallible external acquisition out of this document, so
such failures are exceptional local application errors rather than normal
business outcomes.

At startup, a valid desired file wins. If the desired file is unreadable or
invalid, Tenon uses the compatible private last-known-good snapshot. If neither
is available, it uses registry defaults. The application still opens and makes
the configuration error discoverable. Deleting the file is an intentional
reset to defaults; Tenon recreates the template only when `Settings...` is next
invoked.

The owner publishes one bounded change event after accepting a generation.
Theme, locale, preview defaults, Memory policy, and update scheduling consume
the snapshot through their main-process owners. Renderer windows receive only
the narrow effective values/events they already need; the renderer never gains
filesystem access or becomes a configuration parser.

The Host exposes three concepts truthfully:

- **desired:** the bytes currently on disk, which may be invalid;
- **accepted:** the latest complete validated override document;
- **effective:** accepted values merged with defaults and resolved system
  values, plus application timing/status.

The initial registry has no restart-required setting. A future setting may add
one only by defining desired/effective divergence and a visible pending-restart
state in the same change.

### 6. User entry points and resource managers

`Settings...` and `Cmd+,` call the main process directly. Tenon ensures the
template/schema exist and asks the OS to open `settings.jsonc` with the user's
associated editor. If no application can open it, Tenon reveals the file in
Finder and shows/copies the exact path; it does not fall back to an embedded
editor.

The former Settings window and its `General -> Agent -> Preview` routes retire.
Every surviving non-scalar job receives a direct product command:

- `Manage Models...`
- `Manage Agents...`
- `Manage Skills...`
- `Manage Memory...`
- `Privacy & Data...`
- `About Tenon`

These commands open the owning manager or operation surface directly. They may
share native window infrastructure, but there is no broad Settings landing page
or rail that implies all domains share one state model. Existing contextual
entry points are renamed to their real target: a missing Provider opens Models,
an Agent identity opens Agents, a Skill action opens Skills, and Memory content
or reset opens Memory.

Scalar controls now owned by `settings.jsonc` disappear from manager surfaces.
Managers may show a safe effective value when it explains current status, but
their action is `Open Configuration`, not a shadow write. Context controls such
as enabling translation for the active preview remain contextual actions; they
do not rewrite the public default.

Diagnostics reveal/export moves to the Help menu or existing diagnostics
surface. Update check/download remains in About. Website and translation cache
clearing remains in Privacy & Data or the owning preview. None is represented
as a setting value.

When a watched save is invalid, Tenon posts one non-blocking in-app
configuration notice per content generation. It states that the previous
configuration remains active, shows the first source-located error, and offers
`Open Configuration` and `Copy Diagnostics`. An invalid file never opens a
modal loop or blocks unrelated work.

### 7. Agent workflow and diagnostic CLI

Ship a small packaged, read/diagnose-oriented command family:

```text
tenon config path [--json]
tenon config check [--json]
tenon config show --effective [--json]
tenon config show --defaults [--json]
tenon config reload [--json]
```

`path`, `check`, and `show --defaults` work from the active profile without a
running renderer. `show --effective` and `reload` ask the running Host so they
cannot claim that valid text is already active when it is not. Output is
bounded, stable, source-located where relevant, and contains only public
configuration values.

There is intentionally no CLI mutation command. The built-in inline
`settings` Skill teaches this workflow:

1. Resolve the active profile path.
2. Read the current file and preserve unrelated comments and overrides.
3. Make the smallest ordinary file edit.
4. Run `tenon config check`.
5. Repair an invalid edit, then use automatic reload or `tenon config reload`
   and inspect `show --effective` before reporting success.

The Skill remains a router, not a copied settings catalog. It uses exact CLI
help or the generated schema when it needs available keys. It never edits the
private last-known-good snapshot or domain-owned resource files as a fallback.

Existing Agent filesystem policy remains authoritative. Full Access may permit
the active profile path; an isolated worktree or explicit block may not. The
CLI and Skill do not mint a capability, widen a sandbox, bypass `file_edit`, or
turn natural-language intent into separate Host authority. If the file is not
writable under the current Turn, the Agent reports the exact path and leaves
the change to the person.

Agent-originated edits remain visible in normal Bash/file-tool history. Tenon
does not add a second settings audit log. Because only low-risk settings qualify
for the document, no native confirmation protocol is needed for file reload.

### 8. Main flows

#### FLOW-1: Person changes a setting

- **Actor:** Tenon user.
- **Entry path:** `Settings...` or `Cmd+,`.
- **Entry state:** Active profile resolved; file may be missing, valid, or
  invalid.
- **Mainline:** Tenon ensures the public artifacts exist, opens
  `settings.jsonc` in the associated editor, watches a save, validates the whole
  candidate, applies it, and publishes one effective generation.
- **Result:** The valid override is effective and remains the user-owned text.
- **Failure/recovery:** Invalid text remains open and editable while the prior
  accepted configuration remains active; the notice and CLI provide exact
  diagnostics.
- **Requirements:** FR-1, FR-2, FR-3, FR-5.

#### FLOW-2: Agent changes a setting

- **Actor:** Agent with ordinary file permission for the active profile.
- **Entry path:** User asks for a supported preference change.
- **Entry state:** The built-in Skill and packaged diagnostic CLI are available.
- **Mainline:** The Agent resolves the path, reads and minimally edits the file,
  validates it, reloads or observes automatic reload, and verifies the effective
  value.
- **Result:** The same public document changed; no Settings mutation API or
  renderer automation was used.
- **Failure/recovery:** The Agent repairs source-located validation errors. If
  filesystem policy or Host availability blocks completion, it reports that
  boundary without changing another store.
- **Requirements:** FR-4, FR-5, FR-7.

#### FLOW-3: Invalid file at startup

- **Actor:** Tenon Host.
- **Entry path:** Application launch with malformed, unreadable, or unsupported
  desired configuration.
- **Mainline:** The Host rejects the desired candidate, restores the compatible
  last-known-good snapshot or defaults, starts normally, and records a bounded
  configuration diagnostic.
- **Result:** Unrelated app work remains available and the invalid file is left
  untouched for repair.
- **Requirements:** FR-2, FR-3, FR-6.

#### FLOW-4: User manages a resource or performs an operation

- **Actor:** Tenon user.
- **Entry path:** A direct menu, launcher, or contextual command such as
  `Manage Models...` or `Manage Memory...`.
- **Mainline:** Tenon opens the owning manager or operation surface directly.
- **Result:** Resource lifecycle, credentials, destructive confirmation, and
  domain status retain their typed owner and do not enter the public file.
- **Requirements:** FR-8.

## Requirements

- **FR-1:** One user-profile `settings.jsonc` is the sole source of truth for
  every public setting in the initial registry.
- **FR-2:** One typed registry generates validation, defaults, editor schema,
  descriptions, application timing, and safe effective projections.
- **FR-3:** Startup and watched reload validate and accept one complete bounded
  candidate, preserve last-known-good behavior on failure, and never rewrite an
  existing user document.
- **FR-4:** `Settings...` opens the canonical file externally, and the packaged
  `tenon config` commands provide path, check, defaults, effective, and explicit
  reload behavior without a mutation subcommand.
- **FR-5:** The built-in `settings` Skill uses existing file tools and the
  diagnostic CLI; it receives no special configuration capability or hidden
  mutation transport.
- **FR-6:** Desired, accepted, and effective state plus source-located
  diagnostics remain distinguishable after invalid saves and restarts.
- **FR-7:** Existing filesystem permissions continue to govern whether an Agent
  may edit the active profile; configuration support never widens authority.
- **FR-8:** Every surviving resource/operation workflow has a direct reachable
  owner surface after the Settings window and routes are removed.
- **NFR-1:** The public file and each CLI result are bounded independently of
  Provider models, installed Skills, Agent history, Memory contents, caches, and
  diagnostics history.
- **NFR-2:** A configuration save never reads credentials, resource catalogs,
  Memory contents, website data, update history, or Agent history.
- **NFR-3:** The built-in Skill contains no copied registry or defaults and fits
  the repository's compact built-in Skill budget.
- **NFR-4:** Renderer processes receive narrow typed values/events only and gain
  no Node, filesystem, parser, CLI transport, or private snapshot access.

## Acceptance Criteria

- **AC-1 (FR-1, FR-2):** Registry tests prove unique stable keys and complete
  codec/default/description/application metadata. The generated JSON schema,
  standalone validator, Host loader, defaults output, and effective output agree
  on every fixture without copied definition tables.
- **AC-2 (FR-1, FR-3):** Fresh profile, existing valid file, missing file,
  deliberate deletion, comments, trailing commas, UTF-8, maximum size, unknown
  key, duplicate key, malformed JSONC, invalid type, and unsupported value cases
  have deterministic coverage.
- **AC-3 (FR-3, FR-6):** Watcher tests cover atomic rename saves, burst events,
  stale validation completion, and an edit observed mid-read. Only the newest
  stable valid generation may become accepted.
- **AC-4 (FR-3, FR-6):** A candidate with one invalid key applies no sibling
  change. An invalid startup file uses the compatible private last-known-good
  snapshot or defaults, starts the app, leaves desired bytes untouched, and
  exposes line/column recovery diagnostics.
- **AC-5 (FR-1, FR-3):** Theme and display language update every open window and
  native menu; translation defaults affect only subsequent eligible decisions;
  Memory disable fences new work and settles active work through its owner; and
  update scheduling observes the accepted value. Restart proves the same
  effective values without consulting retired preference sources.
- **AC-6 (FR-4):** `Cmd+,` and the Settings menu create only a missing template,
  refresh the generated schema, and open the canonical file through the OS.
  Open failure reveals the file and exact path without creating a renderer
  Settings surface.
- **AC-7 (FR-4, FR-5):** Source and packaged smoke tests execute every
  `tenon config` command. A real Agent composition test resolves the path,
  performs one ordinary file edit, validates, reloads, and verifies the live
  effective value with no settings mutation API, renderer IPC, or private-state
  edit.
- **AC-8 (FR-7):** Full Access, isolated-worktree, and explicit-block fixtures
  prove the workflow follows existing file policy. A denied edit cannot be
  converted into a Host mutation through `check`, `show`, or `reload`.
- **AC-9 (FR-8):** E2E coverage proves Models, Agents, Skills, Memory, Privacy &
  Data, About, diagnostics, update actions, and all current contextual deep links
  remain directly reachable after Settings routes are absent.
- **AC-10 (FR-1, FR-8):** `app-preferences.json` and included scalar writers/readers
  are absent. Non-public recent selections, resource-dependent choices, caches,
  and control generations have explicit domain owners and cannot override an
  accepted public setting.
- **AC-11:** Invalid-save notice behavior is non-modal, deduplicated by content
  generation, keyboard reachable, screen-reader named, and correct in English
  and Simplified Chinese. It remains usable in light/dark, increased contrast,
  reduced motion, and reduced transparency modes.
- **AC-12:** Current behavior is folded into the owning specs; `bun run
  typecheck`, relevant Core and renderer suites, focused Electron E2E,
  `bun run docs:check`, `git diff --check`, and packaged CLI smoke pass.

## Delivery

Deliver the entire cutover in one PR. Foundation-before-consumers is build order
inside that PR, not a separately shippable scaffold:

1. Define the small registry, JSONC codec/diagnostics, generated schema, profile
   paths, last-known-good record, watcher, and typed snapshot/events.
2. Cut the initial public keys over to that owner and split non-public values out
   of the retired composite preference store.
3. Add external file opening, `tenon config`, and the compact built-in Skill.
4. Replace Settings routes with direct resource-manager/operation entry points,
   remove shadow scalar controls and writers, and delete the old Settings shell.
5. Update current specs and verify source, packaged, restart, invalid-file,
   permission, direct-manager, and accessibility behavior end to end.

Expected areas:

- a new shared public configuration registry/codec and main-process
  configuration owner;
- `appPreferences`, theme/locale, translation preference, Memory control, app
  update, watcher, diagnostics, and profile-path owners;
- Window Application Host menu commands and external file opening;
- `settingsWindow` routes, Settings renderer components/styles/messages,
  preload contracts, and every current deep-link caller;
- direct Models, Agents, Skills, Memory, Privacy & Data, About, diagnostics, and
  update entry points;
- packaged `tenon config`, resolver/shell environment, generated schema, built-in
  `settings` Skill, and packaging smoke;
- focused Core, main, renderer, E2E, permission, restart, and packaged tests; and
- a new indexed current configuration spec plus affected architecture, i18n,
  Memory, Agent Skill, tool-permission, preview, update, diagnostics,
  workspace-layout, and design-system specs.

Implementation must coordinate before changing infrastructure-owned
`package.json` or `docs/spec/README.md`. It should not require
`src/core/commands.ts` or `src/core/types.ts`; discovering otherwise stops the
work for a separate shared-interface decision.

## Risks

- **The file becomes a junk drawer.** Enforce all five eligibility rules. New
  keys that depend on resources, secrets, destructive actions, or authority stay
  with their owner even if a file representation looks convenient.
- **One typo silently changes behavior.** Reject the entire candidate, retain
  last-known-good, surface source locations, and never ignore unknown keys.
- **The Host damages human formatting.** Write only the missing initial template
  and generated schema; never serialize over an existing user file.
- **A watcher accepts stale or partial bytes.** Bound reads, coalesce atomic-save
  events, attach generations, and accept only the newest stable candidate.
- **Agent convenience becomes privilege escalation.** Use ordinary file policy;
  keep authority and secrets out of the public file; give diagnostic commands no
  mutation fallback.
- **Removing Settings strands important jobs.** Gate deletion on direct entry
  and E2E reachability for every surviving manager, operation, and deep link.
- **A resource-dependent preference sneaks into the registry.** Keep values such
  as translation model and Agent selection with their domain owner until they
  have a separate stable resource-reference contract.
- **The single PR grows through unrelated redesign.** Preserve resource-manager
  domain behavior and restrict the cutover to ownership, entry points, scalar
  controls, and the public file contract.

## Collision Result

The 2026-09-03 check found open PRs #620, #621, #623, #624, and #625.

- #623 changes `package.json`, Desktop Host/Agent Bash composition, and shared
  Agent runtime areas required by the packaged diagnostic CLI and built-in
  Skill. Implementation starts after #623 merges and rebases onto its final
  packaging/shell mechanism.
- #620 currently names Settings as the future Delegation Runner/model policy
  authority. That premise must be reconciled before its implementation: resource
  policy belongs to the Agent manager/domain contract, not the low-risk public
  settings document. The two implementations must not concurrently rewrite the
  same Agent manager or execution-selection owners.
- #621 owns shared preview-shell files. Splitting global translation defaults
  from contextual preview actions must serialize behind #621 for any overlapping
  file found at claim time; this plan preserves its link/preview behavior.
- #624 and #625 own Trajectory evidence/paging and do not overlap the planned
  configuration, menu, manager-entry, or Settings-retirement surfaces.
- `agent-skill-authoring-foundation` changes Skill identity and Settings binding
  behavior. This feature consumes its merged identity contract rather than
  defining another Skill resource model.
- `semantic-working-state` still owns truthful Provider/managed-Skill editor
  behavior. This plan no longer absorbs it into a replacement Settings IA; it
  must run after direct manager entry points settle and serialize on overlapping
  manager files. The main-owned task board should be corrected after this plan
  is ratified.

This design-only rewrite does not touch `docs/TASKS.md`, `CHANGELOG.md`, runtime
code, or infrastructure-owned files.

## Open questions

None. File-first ownership, user-profile scope, JSONC syntax, initial eligibility
boundary, last-known-good behavior, external editor entry, diagnostic-only CLI,
ordinary Agent file permissions, direct resource managers, one-PR delivery, and
deferred keybindings/project layering are fixed by this plan. Reopen only if a
hard platform constraint invalidates one of those decisions, not to preserve an
outgoing implementation.

## Implementation Checklist

- [ ] Re-run the collision self-check and claim one implementation PR after #623
      and overlapping preview/Skill contracts settle.
- [ ] Implement the complete registry-to-runtime-to-file-to-Agent cutover and
      direct manager reachability in one PR; do not ship a registry or CLI
      scaffold without the user-visible file-first behavior.
- [ ] Update current specs in the same change and attach invalid-save,
      light/dark, direct-manager, and external-editor evidence.
- [ ] Run `bun run typecheck`, relevant Core and renderer suites, focused E2E,
      `bun run docs:check`, `git diff --check`, and packaged CLI smoke.
- [ ] At the main gate, run `/code-review ultra`, add `/security-review`, perform
      light/dark visual verification, repair stale Settings premises in active
      plans and the board, then fold/archive this plan according to the document
      lifecycle.
