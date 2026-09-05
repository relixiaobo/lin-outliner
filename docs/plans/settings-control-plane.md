# File-First Settings For People And Agents

## Goal

People can discover, change, and recover Tenon's settings without learning its
storage layout. Agents can perform the same jobs through public configuration
files and domain operations, then report what actually took effect.

This plan is a set of independently complete features, described in Delivery.
Each feature includes its own consumers, failure recovery, and verification.

- **OBJ-1:** Settings is a searchable, lightweight human entry over real sources.
- **OBJ-2:** Every supported settings job has a human and an Agent route.
- **OBJ-3:** Saved, accepted, and effective configuration remain distinguishable.
- **OBJ-4:** Theme and Skill/tool availability are ordinary file-editing jobs.
- **OBJ-5:** Each value has one desired-state owner across all editing surfaces.
- **OBJ-6:** Invalid files preserve user text and do not prevent application use.
- **OBJ-7:** Shortcuts are configurable without rewriting fixed editing grammar.
- **OBJ-8:** A person can set up the first model; an already runnable Agent can
  use an explicitly supplied key without asking for it again.

## Non-goals

- No Settings or Configuration CLI, including discovery, validation, status,
  hidden helper executables, or read-only commands.
- No universal Settings model tool, cross-domain mutation service, second
  preference store, or fixed quota of domain tools.
- No application configuration profiles, project overrides, includes,
  interpolation, executable settings, remote administration, or cloud sync.
  Root Configuration Profile scopes remain owned by the Agent domain.
- No restoration of retired Agent types, Roles, per-type presentation or
  execution selections, spawn-definition editors, or isolated-Skill settings.
- No same-account security isolation through hidden paths, private JSON, or
  file permissions; no configuration-specific authorization state machine.
- No new credential store or Keychain integration.
- No migration readers, dual writes, or compatibility wrappers for retired
  settings formats. Each field changes ownership once.
- No copying user content, installed assets, Session history, catalog caches,
  credentials, or operation progress into editable configuration.
- No requirement that every domain occupy a separate window, or that every
  configurable object be rendered as a generated form.

## Design

### Overview And Decision

The selected target is public files for declarative configuration, a human UI
over those files, domain tools for operations, and one small configuration Skill.
A domain can own configuration, credentials, resources, and runtime state
without treating them as the same kind of data.

A value belongs in configuration when it describes a durable desired behavior
or definition. It need not be scalar: model references, connection definitions,
root Configuration Profiles, and Skill source bindings qualify. Executing an
installation, signing in, deleting content, or probing a connection is an operation.

One source per value does not mean one file for the whole application. Domain
owners supply definitions and apply their own values; shared file mechanics
handle parsing, structural edits, observation, and recovery.

### Constraints, Tradeoffs, And Evidence

Electron process isolation, per-clone userData, canonical Agent lifecycle and
capability contracts, local credential storage, and the absence of a Settings
CLI constrain implementation. Old Settings categories, composite stores, the
ten-key limit, and a mandatory ten-tool catalog do not constrain the target.

File-only interaction loses discovery and first-model setup. A second Settings
write API for Agents duplicates a task already served by ordinary file tools.
The selected design accepts a bounded read/edit/verify workflow for declarative
changes; semantic domain operations keep the canonical tool-result contract.

Reference patterns, rather than requirements to copy:

- [Ghostty](https://ghostty.org/docs/config): useful defaults, optional overrides,
  generated reference documentation, and explicitly limited runtime reload.
- [VS Code](https://code.visualstudio.com/docs/configure/settings): UI and JSON
  share settings, with search, modified values, reset, diagnostics, and links.
- [VS Code configuration definitions](https://code.visualstudio.com/api/references/contribution-points#contributes.configuration):
  one definition supplies validation, completion, descriptions, and UI metadata.
- [Zed](https://zed.dev/docs/configuring-zed): searchable UI saves to configuration;
  advanced structured values remain editable in the file.
- [Zed providers](https://zed.dev/docs/ai/use-api-access) and
  [Agent profiles](https://zed.dev/docs/ai/agent-profiles): non-secret resource
  definitions and model/tool choices can be configuration; auth has its own owner.

These sources establish feasible patterns, not measured Tenon usability.
Acceptance exercises both human discovery and real Agent task completion.

### Public Sources And Ownership

The current userData root owns `config/settings.jsonc`,
`config/keybindings.jsonc`, their generated `*.schema.json` files, and
`config/status.json`. Packaged and dev paths use the same relative layout under
their isolated roots. There is no additional global configuration directory.

Root Agent configuration remains in public domain files: `agent/config.json`
under userData and `.tenon/agent.json` for an explicit project. The surviving
contract is named root Configuration Profiles, default Profile selection,
instructions, capability ceilings, model/effort defaults, and root-only
presentation. Project Profiles replace same-name user Profiles; a root without
an explicit project uses the user source. Expose paths, format, schema, source
origin, and status through the root configuration owner, without copying fields
into application settings. A Profile's model pin specializes root execution
under the precedence below; it does not override the application settings file.

The prerequisite [approved delegation retirement](https://github.com/relixiaobo/lin-outliner/pull/620) removes
Role-backed Agent types, their definitions, per-type presentation, and
`agentExecution` selections. Do not preserve the old loader/writer contract as
a whole or recreate its editors. Delegation uses Runner policy and fixed
`general`/`explore`/`plan` Task Profiles, not configurable Agent identities.
Task Profiles constrain intent and access; they contain no persona or model.

| Desired information | Source | Applying owner |
| --- | --- | --- |
| Appearance, global Memory availability, request policy, update policy | Settings file | Appearance, Memory, Provider runtime, Updates |
| Global Skill/tool availability | Settings file | Skill catalog and tool selection |
| Local Skill bindings, including exact-Skill/container mode | Settings file | Skill source owner |
| Non-secret model connections and default text/image model selection | Settings file | Models |
| Installation-wide delegation defaults and Runner/model references | Settings file | Delegation policy owner |
| Root Configuration Profiles, default Profile, and root-only presentation | Root Agent configuration files | Root configuration owner |
| Command binding overrides | Keybindings file | Shortcut owner |

Existing ten preference keys keep their names and meanings:
`appearance.theme`, `appearance.language`, `agent.memory.enabled`,
`agent.skills.disabled`, `agent.tools.disabled`,
`agent.provider.timeoutMs`, `agent.provider.maxRetries`,
`agent.provider.maxRetryDelayMs`, `agent.provider.cacheRetention`, and
`updates.checkAutomatically`. Defaults come from their definition owners.

Structured additions are domain-owned definition groups: `models.connections`,
`models.default`, `models.imageDefault`, `agent.skills.sources`, and
`agent.delegation`. Connections retain canonical Provider identities and model
qualification, with adapter, endpoint, enabled state, optional explicit model
declarations, and non-secret credential references. This does not introduce a
new connection identity space. Defaults reference Provider/model identity;
automatic or inherited selection has the domain-specific meaning below. Skill
bindings record a path and explicit `skill` or `container` mode, following the
identity foundation.

Removing a connection or root Profile removes future availability, not
credentials, user files, or existing Sessions/history. Unbinding a Skill never
deletes its directory. Installation records, provenance, catalog caches, recent
selections, effective connection snapshots, and user content stay domain-owned.
No install index keeps a second global enabled flag.

### File Admission And Recovery

Each definition owns its decoder, default, description, examples, edit metadata,
and application boundary. Generate schema and UI projections from it. Dynamic
catalogs supply current identities through bounded owner queries, not giant
enums in schemas. Unknown but well-formed resource references stay visible as
unavailable; they do not invalidate unrelated preferences or select substitutes.

Settings use one object with dotted keys and typed structured values. JSONC
supports comments, trailing commas, UTF-8, and a 256 KiB source bound. Reject
malformed text, duplicate/unknown keys, invalid types or identity syntax, and
unsupported values as a whole candidate. Network health and resource existence
are application concerns, not syntax validity. Agent files use their declared
format and domain decoder, with the same source-preservation rules.

Connection definitions accept credential references, never inline keys,
credential-bearing URLs, or secret header values. Validation diagnostics name
the key and problem without quoting secret-bearing input.

Overrides are optional; absence restores declared defaults. Open File creates
an overrides-only template when needed. A valid observed candidate produces an
immutable accepted snapshot and updates a private last-known-good recovery
record. An invalid candidate stays untouched while the preceding accepted
snapshot remains in use. At startup, validate recovery records against current
definitions, otherwise use defaults and report the source failure. Recovery
records are caches of accepted input, never editing surfaces or security policy.

Watch containing directories, coalesce bursts, handle atomic replacement, and
discard unstable reads. Application owners converge independently; one failure
keeps that owner's previous effective value and diagnostic without rolling back
unrelated settings. Retries are bounded or triggered by a relevant resource
change or explicit retry; a failed remote probe never causes a tight loop.

### Human Interaction

`Settings...` and `Cmd+,` open a flat searchable surface with common controls,
a modified-values filter, per-setting Reset, source errors, and Open File.
Search matches labels, descriptions, and stable IDs. A setting can deep-link to
its row or its domain editor. Models, Agents, Skills, Memory, Access, and Data
are discoverable from this entry and directly from their relevant application
surfaces; discovery does not eagerly load every domain. About and Help keep
their platform homes. Keyboard Shortcuts opens its dedicated searchable editor.

Scalar values use direct controls; connections, root Profiles, Skill
bindings, and shortcuts use purpose-built editors over the same sources.
Managers may be views or auxiliary windows. They share no cross-domain draft,
save transaction, polling loop, failure state, or aggregate Settings DTO.

Main performs typed structural edits using a real syntax tree and an observed
source digest. Reset removes an override. Preserve comments, ordering,
whitespace, and unrelated values. Serialize Tenon-originated edits, recheck the
source before replacement, and return a conflict for stale input. Arbitrary
external editors do not participate in that serialization: do not promise a
cross-process transaction or silently overwrite a detected concurrent save.

Malformed source disables structured edits for that source and shows the error,
Open File, and the preceding effective values. Other sources and unrelated
operations remain usable. UI edits pass through the same admission/status path
as manual and Agent edits. A control cannot claim success merely because its
write completed. Main sends narrow projections; renderers have no file access.

### Effective Status And Agent Workflow

`status.json` is bounded, non-secret, atomically generated Host output. Per
source it reports existence, observed byte digest, accepted digest, and
source-located rejection. Per key or domain entry it reports desired/effective
values, application boundary, pending/unavailable/failure reason, and the
revision being applied. File absence has an explicit marker, not an empty-file
digest. Editing generated output changes no runtime state.

The Host includes a fresh session identity. A running root Agent receives
`TENON_CONFIG_DIR` and the current Host session in its ordinary execution
context. This is discovery, not permission. An external reader without a live
Host context can report saved or last-observed state, not prove live settlement;
a stale file from a prior process is never current application evidence.

The built-in on-demand `configuration` Skill routes one user intent:

1. Read the relevant schema, source, and status; query a domain catalog if an
   identity is needed. Use advertised paths and formats.
2. Make the smallest generic file edit, preserving unrelated values and comments.
   Preserve invalid input unless repairing it is part of the user's request.
3. Compute the saved digest and wait a bounded time for matching accepted input
   and application results for the addressed keys in the current Host session.
4. Re-read the source. Report success only if it still matches and the requested
   values reached their declared boundary. Otherwise report rejection, pending
   application, unavailable resource, concurrent modification, or unknown result.

A theme edit can succeed while a separate connection is unavailable; do not
require every domain to settle before reporting the addressed change. Display
the relevant failure separately and never describe the whole file as effective.
No polling daemon, Settings receipt ledger, validator executable, or second
Agent configuration writer is added.

The Skill names routing rules and public owners, not a copied catalog of
defaults and action schemas. Operation tools contribute their schemas through
the canonical registry and return canonical bounded outcomes. Reuse existing
domain routes where applicable; their number follows operations, not UI pages.

### Application Boundaries And Authority

Appearance applies live through `nativeTheme.themeSource`, native menus, and
normal renderer updates. No renderer theme override mechanism is added. Memory,
request policy, and update scheduling use their owner admission boundaries.
Global Skill/tool selection affects later root Turns. The authoring Turn retains
its admitted catalog so it can verify its change; explicit blocks still apply
at each invocation. Root Profile defaults are snapshotted when a root Thread
is created; edits do not rewrite existing Threads or their model choices.
Delegation policy is snapshotted at Session creation; continuation retains its
Runner/model and revalidates current authorization and capability ceilings.
Disabling a Runner or losing its pinned model blocks continuation rather than
rebinding the Session. No configuration edit rewrites Session history.

Tool availability changes, including enable/reset, are ordinary configuration
edits under the user's task authority. Removing a disabled entry does not waive
root Profile ceilings, Task Profile restrictions, inherited Session ceilings,
or explicit action blocks.
Configuration reset needs no private disabled-tool baseline or approval digest.

Root-only domain tools remain Host-enforced. Application configuration tasks
are routed to root execution; descendants retain the no-permission-laundering
rule. Withholding a path or Skill is not filesystem enforcement. Same-account
Full Access can access configuration and private stores through generic tools;
tool selection and explicit blocks are not an OS sandbox.

Keep domain-native human interactions for credentials, acquisition review, and
irreversible actions. They are product interactions and mistake prevention,
not a claim of protection from a hostile Full Access Agent. No shared
park/drain/pause coordinator or model-redeemable approval token is introduced.
The Host validates the target/revision again after interaction; cancellation or
lost settlement never becomes success. `request_user_input` is not an
authorization primitive. A stronger security boundary requires a separate
execution/storage-isolation design.

### Model Selection And Defaults

Resolve a new root Thread's Provider/model as one qualified selection, using
this order. The selected root Configuration Profile is the explicitly requested
Profile, otherwise the root owner's user/project default Profile.

1. A model explicitly chosen for this new Thread, including a deliberate
   composer selection or a caller's explicit model request.
2. An explicit model pin in the selected root Configuration Profile. An omitted
   model or `inherit` supplies no pin; selecting a Profile alone is not a model
   override. Default-selected Profiles obey the same rule.
3. An explicit `models.default` selection.
4. In automatic mode only, a currently valid remembered root execution selection.
5. The Models owner's automatic selection from runnable connections/catalogs.
   If none is runnable, show model setup/unavailability rather than starting work.

`models.default` defaults to `auto`; removing the override or choosing `auto`
restores steps 4-5 when no explicit request/Profile pin applies. Setting a pin
does not erase history. Automatic Thread creation does not record the resolved
default as a new user choice; remembered selection changes only after a
deliberate user selection. The composer must distinguish a displayed inherited
default or remembered suggestion from a choice made for this new Thread, so it
cannot promote old UI state into an explicit request. Reset may therefore use
the still-valid last user choice, without mutating any existing Thread.

An explicit Provider-only request constrains every candidate to that Provider;
it does not permit an unrelated application default or memory to select another
Provider. Use a compatible Profile pin, then a compatible application pin, then
that Provider's automatic path. For a Provider-only request, a selected Profile
pin in another Provider is a conflict, not a hint to discard. A qualified explicit
model identifies its Provider; mismatched explicit pairs are rejected. A winning
explicit request, Profile, or application pin that is unavailable starts no
model request and reports that choice, never
falling through to memory or automatic selection. Only automatic candidates may
skip stale/unavailable entries. Profile lookup failures are likewise not hidden.

Effort follows explicit request, explicit Profile effort, remembered effort only
when memory wins, then the winning model's supported default. Never combine A's
model with B's remembered Provider or effort. Explicit unsupported effort reports
a validation failure instead of silently changing the requested selection.

The composer preview and Thread admission share this resolver and report the
winning source. `models.default` status proves the application default is ready
for inheriting new Threads, not that it overrides an explicit request/Profile.
Revalidate selection and readiness at admission. Existing Threads retain their
snapshots and explicit model changes; changing a default never retargets them.
Delegation's internal `Inherit parent` copies the parent's effective model/effort
at Session creation, not `models.default`; explicit Runner policy and pinned
Session continuation retain the delegation owner's contract. Image defaults use
the image owner's resolver and never consume root-composer history.

### Models: Bootstrap, Credentials, And Connection Recovery

With no runnable connection, the Agent surface offers `Set Up a Model`.
Models opens without an Agent and supports provider/auth selection, endpoint,
API key or OAuth, model selection, Test Connection, Save, and retry. Connection
definitions edit the public source; credentials stay with their owner in
`agent-secrets.json` using mode `0600`. Typed routes never return stored
credentials or private paths. Full Access remains able to read same-account
storage; file permissions do not provide Agent isolation.

Test Connection probes an unsaved candidate without saving it. Save first
persists any new credential, then the exact non-secret definition and its opaque
credential reference through the source editor, then tests that saved candidate.
A source-write failure leaves no partial configured definition and preserves
recoverable form input. A failed auth/network/quota test retains the saved
candidate and credential for retry and displays Saved, not verified.

The Models owner derives complete configured snapshots from accepted definitions
and credential identity. A snapshot contains every runtime connection input,
including adapter, endpoint, enabled state, model-resolution inputs, and
credential reference. Public references identify credentials but grant no access.
Explicit credential replacement creates a new reference; ordinary OAuth token
refresh stays inside its existing credential identity.

Only a verified complete snapshot becomes active. Persist the active snapshot
and effective default selection together; never combine the new endpoint with
an old credential or candidate fields with an old active pointer. Failed
replacement retains the previous complete active connection and explicitly
shows which connection is still in use. On first setup there is no fallback.

Late probe completion promotes only if that connection's current desired inputs,
credential identity, selection intent, and invocation authority still match.
An unrelated appearance edit need not invalidate a connection test. Disable or
definition removal stops new use without a network probe and cannot revive an
older enabled snapshot. Selecting an unavailable model retains the desired
choice and reports unavailability; it never silently substitutes another model.
A user request to replace a working connection may retain its previous effective
selection while verification is pending, visibly distinguished from the desired
selection. This recovery state is not a fallback for a newly pinned different
model: new root admission follows the precedence and unavailability rules above.
An existing model may keep using its previous complete active connection during
connection replacement, with the pending replacement shown. In-flight work
keeps its already resolved snapshot.

Recovery and garbage collection retain credentials/snapshots referenced by
accepted recovery input, configured/active connections, probes, or in-flight
requests. Remove only unreferenced staging after a failed commit or crash.
Saved unverified candidates survive restart without credential re-entry.

An already runnable root Agent may supply the key explicitly present in its
current renderer-authored user request to one sensitive Models operation.
Validate that provenance and reject fabricated input, child traffic, and replay.
That operation uses the same credential-plus-source workflow; it does not become
a general settings setter. Redact before durable Tool/Trajectory recording and
never echo the key in results, diagnostics, errors, or shared renderer state.
The original user input remains original; no redundant credential prompt is
shown. Without an explicit key, open the human credential form. OAuth, reveal,
copy, and credential deletion remain owner operations with public outcomes only.

### Shortcuts And Contextual Translation

The command owner derives configurable identities, defaults, scopes, parsing,
matching, hints, and schema from one registry. Keybindings support a portable
chord, alternate chords, or explicit disable. Reset removes overrides.
The editor supports search, physical recording/cancel, conflicts, Reset All,
and Open Keybindings File. Agent changes use ordinary file editing; recording
is a human interaction, not a prerequisite for setting a known chord.

Reject reserved combinations and conflicts in overlapping scopes; disjoint
contexts may reuse a chord. Preserve the previous effective system registration
until replacement succeeds, including unchanged chords already owned by Tenon.
Failed registration reports the attempted source and actual retained binding.
Classify every handler/hint as configurable or fixed; navigation, selection,
editing, clipboard, undo/redo, printable input, and IME grammar remain fixed.

Translation remains contextual, as selected for this product. New preview
contexts follow the UI language and current Agent model, with automatic
translation off. Explicit target/model/automatic/toggle choices affect that
preview context; retain them while it remains open, including its navigations,
and reset on close/reopen. No hidden global Translation singleton or default
preference is introduced. Reusable global Translation defaults would be a
separate product decision, not a side effect of moving storage.

The contextual tool must resolve exactly one preview, return unavailable for
missing/ambiguous context, and clear only that preview's saved translations.
Data separately owns global cache status and clearing, including closed webpage,
caption, and EPUB entries. Deleting contextual preferences is an explicit
behavior change; the capability promise covers contextual control and both
cache-maintenance scopes, not preservation of global default semantics.

### Capability Coverage

The following is a design/test ledger, not a runtime router. Each declarative
field has one source; each operation has one semantic owner. Native interactions
are Agent-initiated and return an outcome without exposing private input.
All Agent routes remain subject to available tools and applicable capability
ceilings. Missing authority is reported, never bypassed through private files.

| Job | Agent route | Human route / owner |
| --- | --- | --- |
| Inspect configuration, defaults, errors, effective values | Public schema/source/status | Settings / source owner |
| Appearance, Memory enablement, request/update policy | Settings edit | Settings / applying owner |
| Skill/tool availability; default text/image model | Settings edit | Settings or Skills/Models/Access |
| Connection create/edit/disable/remove and model declarations | Settings edit | Models source editor |
| Provider/model catalog, readiness, test, refresh | Models operation | Models |
| New key, current-request key, reveal/copy/delete, OAuth | Sensitive Models operation / native interaction | Models / credential owner |
| Root Profile selection/editing, instructions, ceilings, model/effort defaults, and root-only presentation | Root configuration file edit | Agents / root configuration owner |
| Delegation defaults, Runner selection, limits and scheduling policy | Settings edit; readiness inspection | Agents / delegation owner |
| Skill source bind/unbind | Settings edit with explicit binding mode | Skills / source owner |
| Skill discovery/status, install/update/review/rollback/uninstall | Skill operation / acquisition interaction | Skills / lifecycle owner |
| Undo an Agent-authored Skill edit | Provenance operation | Skills / provenance owner |
| Memory status/open/reset and per-Thread mode | Memory operation | Memory and Thread details |
| Effective access, persistent action/command blocks and removal | Access operation | Access / capability owner |
| Website/session data, global translation-cache status/clear | Data operation | Privacy & Data |
| Update status/check/release; app/build/version/changelog | Update/application operation | About |
| Help/issues/license; reveal/export diagnostics | Help/diagnostics operation | Help / diagnostics owner |
| Active Translation target/model/automatic/toggle/scoped clear | Contextual Translation operation | Active preview |
| Command catalog/effective bindings/fixed grammar | Shortcut inspection / status | Keyboard Shortcuts |
| Binding changes/reset and physical recording | Keybindings edit; native recording interaction | Keyboard Shortcuts |

A clean-userData Models bootstrap is the explicit prerequisite for model-driven
routes. Every other limitation must be a named permission, missing resource,
context, or operation result, not an unspecified future human-only capability.
Derive coverage tests from post-retirement controls, definition registries,
canonical tool contracts, delegation policy, and command handlers. Include
hidden configurable fields, not just visible UI rows. Retired Role/Agent-type
CRUD, per-type presentation/execution, and isolated-Skill fields are absence
assertions, not capabilities to restore for coverage.

### Delivery And Retirement

Each row is one complete implementation PR. Dependencies name usable features,
not scaffold releases. Foundation-before-consumer is build order within a PR.
Protected shared interfaces still follow the repository's coordination rule.

| Unit | Independently useful result | Dependencies / scope |
| --- | --- | --- |
| A. File-backed preferences | Existing preference controls plus root Agent file edits, schema/status/recovery, configuration Skill, global availability, request/update policy | Configuration modules and preference consumers; FR-1 through FR-4, FR-6; removes migrated fields from old stores immediately |
| B. Model configuration and bootstrap | File-backed connection/default definitions, shared composer/admission precedence, complete Models UI, auth/test/catalog operations, sensitive input, complete snapshot recovery | A; Provider/credential/catalog/image owners, root start defaults, and Tool/Trajectory boundary; FR-2, FR-5, FR-6, FR-12 |
| C. Root configuration and delegation policy | Public root-source discovery/schema/status and structural UI edits, file-backed Runner/Session defaults, access inspection/block operations; no Agent-type editor | A and final delegation runtime; surviving root Profile/presentation, delegation policy, and Access owners; FR-2 through FR-6 |
| D. Skill configuration and lifecycle | File-backed exact source bindings, one availability predicate, complete Agent install/update/reversal/provenance routes and human editor | A and Skill identity foundation; Skill owners; FR-2 through FR-6 |
| E. Memory, data, and contextual operations | Complete Memory, Data, update, diagnostics, and preview Translation jobs through their actual owners | A; preserve preview shell and use owner-local contracts; FR-5 through FR-7 |
| F. Configurable shortcuts | Full file/UI/Agent remapping, registry/hint parity, physical recording, safe system registration | A; shortcut and launcher owners; FR-8, FR-9 |
| G. Unified settings discovery | Final flat search/modified/reset UI, direct domain destinations, no nested Settings shell or aggregate loading/state | A-F; Settings routing/components/preload and narrow owner events; FR-10, FR-11 |

Existing human routes stay usable until their replacement ships. A-F consume
the current UI where needed through the final source owner; no temporary second
writer or duplicated desired values is allowed. G supplies the discoverability
feature and removes the remaining category shell. Complete source ownership and
Agent reachability do not wait for G to become usable.

Each schema exposes only groups implemented in its complete delivery unit;
unsupported groups are not published ahead of their consumers. C and D use the
unchanged Provider/model identity contract and need not wait for B's persistence
replacement. All units also cover FR-10 and the applicable shared acceptance
criteria; A-G together cover the complete ledger.

Retirement is derived from remaining references, not a manual cleanup list.
Remove migrated fields/readers from `appPreferences`, the `agentSettings`
mega-store/DTO, managed-Skill enabled state, and update preference persistence as
their units ship. Contextual Translation replaces the global preferences in E.
G removes Settings-category routing, aggregate sender admission, broad
`lin:settings-changed` broadcasts, polling/badges/feedback coupling, and domain
components whose names falsely imply Settings ownership. Domain-owned services
and auxiliary-window primitives remain reusable.
Root configuration schemas, editors, and source handlers must continue to reject
retired Roles and per-Agent-type presentation/execution after C; Skill owners
likewise keep isolated-Skill fields retired. No compatibility decoder or
replacement entity restores them.

## Requirements

- **FR-1:** Public sources, validation, observation, recovery, and per-entry
  status implement the saved/accepted/effective contract.
- **FR-2:** Declarative preferences and structured definitions have one desired
  source, decoder, default, and applying owner. Root model admission obeys the
  declared precedence; configuration coverage excludes retired Agent entities.
- **FR-3:** UI and Agent edits converge on public files without a Settings CLI,
  second preference store, or general Agent setter.
- **FR-4:** The configuration Skill routes files and operations using current
  schemas, catalogs, and truthful settlement evidence.
- **FR-5:** Every capability-ledger job has complete human and Agent reachability.
- **FR-6:** Credential handling and domain interactions preserve canonical
  authority contracts without claiming same-account isolation.
- **FR-7:** Translation choices and scoped clearing remain preview-local; Data
  retains installation-wide clearing.
- **FR-8:** Shortcut source, registry, editor, runtime, and hints share semantics.
- **FR-9:** Fixed grammar and previous effective bindings survive failed edits.
- **FR-10:** Each ownership change deletes its old writers/readers; final
  discovery removes the cross-domain Settings shell.
- **FR-11:** Searchable human controls edit real sources, preserve user text, show
  failures, and reset by removing overrides.
- **FR-12:** Human-first model bootstrap and Agent-supplied credentials use the
  same source/credential workflow and complete connection snapshots.
- **NFR-1:** Source reads are bounded to 256 KiB; catalog/tool/status projections
  are bounded; watcher and remote work do not block startup or unrelated UI.
- **NFR-2:** Renderers retain narrow preload bridges and no Node/file/private-store
  access. Newly entered secrets reach only their credential owner.

## Acceptance Criteria

- **AC-1 (FR-1, FR-2):** Definition tests prove schema, defaults, UI metadata,
  decoders, and consumers agree for scalar and structured configuration.
- **AC-2 (FR-1):** Missing/deleted files, JSONC comments/trailing commas, limits,
  invalid keys/types, duplicates, atomic saves, bursts, and unstable reads have
  deterministic admission results without rewriting input.
- **AC-3 (FR-1, FR-2):** Invalid startup uses validated recovery or defaults;
  desired bytes survive; one unresolved resource does not block unrelated keys.
- **AC-4 (FR-1, FR-2):** Theme/language apply live, owner policies apply at their
  declared boundary, later Turns use new availability, and the authoring Turn
  can verify its change. Root Profiles affect new Threads; delegation defaults
  affect new Sessions, with authorization revalidated on continuation.
- **AC-5 (FR-2, FR-6):** Enable/reset uses the ordinary source path, cannot
  override inherited ceilings or explicit blocks, and creates no confirmation
  baseline. Tests distinguish catalog availability from OS authority.
- **AC-6 (FR-3, FR-4, FR-11):** A real root Agent changes theme, disables a Skill
  and tool, then proves the addressed results by current-session/source status.
- **AC-7 (FR-3, FR-4, FR-10):** Package/static checks find no Settings/Configuration
  CLI, universal model setter, duplicated preference authority, or copied Skill
  catalogs. Only the declared sensitive connection workflow composes credential
  storage with a source edit; ordinary Agent setters remain file edits.
- **AC-8 (FR-5):** Artifact-derived coverage proves every ledger job has a source
  or operation, applying owner, human entry, bounded result, and failure route.
- **AC-9 (FR-5):** Domain integration covers actual owners, identity discovery,
  stale revisions, pagination, missing tools/resources, and truthful outcomes;
  no failure falls back to private-store edits.
- **AC-10 (FR-6):** Native interactions cover target revalidation, cancel,
  concurrent changes, caller/Host loss, and no false success or approval replay;
  unrelated Agents are not globally paused or drained.
- **AC-11 (FR-6, FR-12):** Stored keys never enter typed results, shared renderer
  state, diagnostics, or status. Sensitive invocation persistence is redacted;
  Full Access's same-account reach remains accurately documented and tested.
- **AC-12 (FR-7):** Two previews retain independent choices; new/reopened contexts
  use declared defaults; scoped clearing leaves other previews intact, while
  Data clearing includes closed webpage/caption/EPUB caches.
- **AC-13 (FR-8, FR-9):** Every shortcut handler/hint is classified; bindings
  cover portable parsing, scope conflicts, fixed editing/IME, and localization.
- **AC-14 (FR-8, FR-9):** Recording/cancel, alternate/disabled bindings, reset,
  failed registration, unchanged owned chords, and restart preserve actual
  effective bindings and matching status.
- **AC-15 (FR-5, FR-10, FR-11):** Settings search, direct managers, bootstrap,
  About/Help, and active-preview actions remain reachable after shell retirement.
- **AC-16 (FR-10):** Each unit's removed fields have no legacy readers/writers;
  final guards find no composite preference DTO, duplicate enabled flag, global
  Translation preference singleton, or category-owned domain lifecycle.
- **AC-17 (FR-11, FR-12, NFR-1, NFR-2):** Loading/empty/error/stale/working states
  pass keyboard, screen reader, 200% text, long English/Chinese, light/dark,
  contrast, reduced motion/transparency, and packaged preload smoke checks.
- **AC-18 (FR-1 through FR-12):** Each complete unit updates current specs and
  passes typecheck, relevant Core/renderer tests, focused E2E, docs/diff checks,
  and required packaged/visual verification.
- **AC-19 (FR-12):** With clean userData, human setup enables a real model request
  without restart. Test failure survives restart for retry without key re-entry;
  save failure preserves recoverable input and previous active state.
- **AC-20 (FR-1, FR-3, FR-11):** Interleaved UI/manual/Agent edits preserve
  unrelated values, reject detected stale writes, verify the final source
  digest, and never treat old-Host or superseded status as current success.
- **AC-21 (FR-1, FR-11):** Malformed sources disable their structured edits,
  preserve exact bytes and effective state, recover after external repair, and
  do not disable unrelated sources or domain operations.
- **AC-22 (FR-6, FR-12):** Current-user key submission needs no repeated prompt;
  fabricated/delegated/replayed input fails. Snapshot tests vary endpoint,
  adapter, auth, model inputs, selection, and credential together; stale probes,
  source-write failure, explicit disable/remove, credential rotation, in-flight
  requests, and crash cleanup never produce a mixed or resurrected connection.
- **AC-23 (FR-2, FR-5, FR-10):** Root Profiles, default Profile selection,
  instructions, ceilings, model/effort defaults, and root-only presentation
  remain editable through both UI and file.
  Post-delegation guards find no Role/Agent-type CRUD, per-type presentation or
  execution editor/schema, or isolated-Skill settings, even with Delegation off.
  Task Profiles cannot acquire persona/model fields; new Runner defaults do not
  rebind existing Sessions, and disabled/unavailable policies block continuation.
- **AC-24 (FR-1, FR-2, FR-11):** After deliberately choosing model B, setting
  `models.default` to runnable A makes the composer preview and a new unqualified
  root Thread use A, while the existing B Thread remains B. Run this through
  both UI and Agent edits, with the composer already open and across restart.
  A fresh explicit B request or Profile pin wins over A; an inheriting Profile
  uses A. Removing the override or choosing `auto` restores still-valid B history;
  stale automatic history may use another runnable candidate. Unavailable pins,
  missing Profiles, incompatible explicit Provider/Profile pairs, and unsupported
  explicit effort fail without silent fallback. Provider-only requests stay in
  their Provider, and no outcome mixes models with another selection's effort.

## Risks And Collisions

- Expanding configuration must not copy operational state into files. Definition
  and ownership tests cover new groups before adding consumers.
- Unavailable references, partial application, and external saves must remain
  visible; no silent model fallback or whole-file success from a single key.
- Native confirmation and private files cannot isolate same-account Full Access.
  Security claims must stay within actual enforcement boundaries.
- Broad coverage is delivered by complete owner-sized features, not one
  all-domain implementation PR or speculative scaffolding.

The collision check finds #626 claiming this design file and #628 implementing
Agent delegation across `agentSettings`, Agent Settings UI, capability/runtime,
protocol, and shared types. #628 lands before overlapping C work; the plan
consumes its surviving root configuration and final Runner, Session, execution,
and CLI contracts, not the retired Role/Agent-type definitions. Its execution
CLI is outside the prohibited Settings/Configuration CLI surface. B updates
`resolveRendererThreadStartDefaults` and its callers/tests so remembered choices
cannot bypass the new application default or Profile pin.

Merged #627 owns exact-or-unavailable Trajectory evidence. Before B registers
sensitive input, coordinate the shared persistence contract so raw credential
Tool Input is explicitly unavailable rather than retained as exact diagnostics.
[Skill identity foundation](agent-skill-authoring-foundation.md) owns exact
bindings and provenance; D consumes it.
[Settings working states](semantic-working-state.md) supplies the final Provider
and managed-Skill progress behavior for B and D. Contextual Translation follows
the merged preview-shell baseline.

Expected touched areas are the configuration modules, `appPreferences`,
`agentSettings`, the surviving root configuration loader/writer and start resolver,
Provider/credential/catalog/image owners, Skill/Memory/Access/Updates/Data owners,
Agent execution context and tool contributions, shortcut/launcher owners,
Settings/domain UI and routing, preload, tests, and affected specs. Coordinate
shared tool/action/protocol/types and infrastructure files before implementation.
Recheck open claims before each unit; no cross-clone filesystem changes.

At integration, main reconciles the board's delivery ordering and the
working-state consumer ownership. This design change does not edit the
main-owned board or changelog. Specs describe current behavior until each
implementation unit lands and folds its design into them.

## Open questions

No unresolved choice blocks this target. Reusable global Translation defaults
and stronger Agent/storage isolation are excluded product changes, not implicit
implementation tasks. Usability and Agent completion remain empirical checks
in acceptance, rather than claims inferred from reference products.

## Implementation Checklist

- [ ] Claim each complete delivery unit after its dependency/collision check.
- [ ] Settle protected shared contracts before building their consumers.
- [ ] Ship source ownership, human/Agent routes, failure handling, and tests
      together; remove superseded fields/readers in the same unit.
- [ ] Complete the artifact-derived capability and retirement sweeps.
- [ ] Fold each shipped unit into specs; let main update board/changelog and
      archive this design only when the complete capability ledger is covered.
