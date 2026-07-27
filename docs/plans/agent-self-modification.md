# Agent Self-Modification

## Goal

Let a foreground root Thread inspect and deliberately update the configuration
that shapes future Threads without introducing a second agent model, a hidden
authorization workflow, or direct writes to runtime-owned state.

The feature uses the canonical Agent Core vocabulary and lifecycle:

- a `ConfigurationProfile` supplies root Thread defaults;
- an `AgentRole` narrows child Thread behavior;
- the effective configuration is a snapshot owned by a Thread;
- each model call and configuration change is recorded as a canonical
  `ThreadItem` inside a Turn;
- Thread and Turn lifecycle hooks use `ThreadService` and `ExtensionRegistry`.

This plan is a set of independent complete features. Each unit is useful and
verifiable on its own. The configuration read/edit unit must land before hooks
can consume configuration declared by the same files.

## Non-goals

- Do not recreate Agent identities, Conversations, Channels, Runs, Issues,
  Activities, Tasks, or a parallel execution ledger.
- Do not add a sandbox mode, permission profile, approval policy, approval card,
  pause/resume authorization state, or access-acquisition protocol.
- Do not use `request_user_input` as permission or confirmation. It remains a
  product-input tool only.
- Do not let a child Thread widen its parent tool, skill, plugin, or MCP-server
  ceiling.
- Do not mutate the effective configuration snapshot of an existing root
  Thread. A file change affects only future root Threads; a child resume may
  re-resolve its stored Role against its parent's current effective ceiling.
- Do not put Memory extraction, Automation scheduling, provider credentials,
  skill authoring, or silent background curation in this feature.
- Do not add format migration, legacy readers, aliases, or dual writes.

## Design

### Configuration ownership

Agent configuration has two structured JSON sources:

- user: `<userData>/agent/config.json`;
- project: `<cwd>/.tenon/agent.json`.

Both files use the same exact-key schema with `defaultProfile`, `profiles`, and
`roles`. Project definitions replace same-name user definitions. Built-in
`default`, `worker`, and `explorer` Roles remain available unless a user or
project definition deliberately replaces the same name.

A Profile may define developer instructions, model, reasoning effort, tools,
skills, plugins, and MCP servers. A Role defines description, developer
instructions, optional nickname candidates, and optional overrides for the same
execution fields. Unknown fields, invalid names, duplicate capabilities,
unsupported effort values, malformed JSON, and unsafe nicknames fail closed.

Creating a root Thread resolves its selected Profile into one immutable
`EffectiveThreadConfiguration` and stores that snapshot with Thread metadata.
Creating or resuming a child Thread resolves its named Role through the same
loader, applies explicit spawn-time model/effort choices, then intersects every
capability source with the parent ceiling. Explicit spawn choices and tool
ceilings are private Thread metadata so resume does not mistake an old Role
default for a user override.

The config files contain no provider secrets, permission state, Memory content,
Automation definitions, rollout history, or extension-private state.

### Configuration tools

One Agent Core extension contributes two namespaced tools:

- `codex_app.configuration_read` returns the selected source paths, sanitized
  Profile/Role definitions, the current Thread's effective snapshot, and
  validation diagnostics. It never returns credentials or unrelated settings.
- `codex_app.configuration_edit` accepts a target (`user` or `project`), a
  complete replacement document, and the expected current content hash. The
  host validates exact schema, writes a temporary sibling, fsyncs it, atomically
  replaces the target, reloads it, and returns the new hash plus normalized
  definitions.

The edit tool uses the ratified Full Access model. Availability comes from the
effective tool catalog and current explicit user blocks. A user request
authorizes the requested change; Tenon adds no confirmation or authorization
state. Native filesystem errors and concurrent hash conflicts are returned as
ordinary tool failures.

Every call is recorded through the normal dynamic tool Item lifecycle, including
arguments, result or failure, capability audit, and causation. There is no
configuration event store, self-maintenance history, or renderer-only change
record.

Configuration reads and edits are root-Thread-only because the root owns the
project intent. A child asks its parent through `collaboration.send_message`.

### Recovery

The host keeps one last-known-good byte snapshot and hash beside each writable
configuration file. A successful validated write promotes the previous valid
document to last-known-good before replacing the live file. Snapshots contain
only the same non-secret configuration fields.

On read or startup:

1. Parse and validate the live file.
2. If it is valid, use it and refresh diagnostics.
3. If it is invalid, leave the live bytes untouched and report the error.
4. Restore only through an explicit `configuration_edit` request whose expected
   hash matches the invalid live file and whose replacement is valid. The caller
   may choose the surfaced last-known-good document as that replacement.

Recovery never silently rewrites user files. Pre-release schema changes replace
the schema cleanly; they do not migrate older formats.

### Lifecycle hooks

Hooks are configuration-declared extension callbacks, not shell aliases and not
a second event taxonomy. Supported hook points are exactly the canonical seams
already exposed by `ExtensionRegistry`:

- Thread started, resumed, idle, and stopped;
- Turn admitted, started, stopped, aborted, and errored;
- tool started and completed.

The first hook feature supports prompt-only context contributions. A hook has a
stable ID, one lifecycle point, an optional canonical tool-identity matcher, a
bounded text template, and an enabled flag. At its lifecycle point the extension
renders structured Thread/Turn/tool facts into additional context or a
diagnostic `ThreadItem`.

Hooks cannot execute shell commands, mutate Nodes, start Turns, change a Goal,
edit configuration, or invoke tools. Mutating behavior remains an explicit
model-tool call inside an admitted Turn. Hook failures are recorded as native
extension diagnostics and do not create authorization states.

### UI

Settings uses the words `Configuration Profile` and `Agent Role`. It shows:

- the user and current project configuration paths;
- the default Profile and available named Profiles;
- built-in, user, and project Roles with source labels;
- validation errors and last-known-good availability;
- read-only effective configuration for the selected Thread.

The Thread Details surface remains the canonical diagnostic view. It may add the
Thread's `profileName`, Role, model, reasoning effort, and enabled capability
identities directly from the persisted effective snapshot. It must not build an
Agent, Session, or execution view model.

### Delivery units

1. **Configuration read/edit and recovery:** complete extension tools, exact
   schema validation, atomic hash-guarded writes, last-known-good handling,
   Settings diagnostics, Thread Details fields, and tests in one PR.
2. **Prompt-only lifecycle hooks:** complete configuration schema, extension
   callbacks, context/diagnostic recording, Settings controls, and tests in one
   later PR.

The second unit depends on the first unit's settled file ownership and loader,
but the first unit is independently useful and shippable.

### Verification

Configuration tests cover user/project precedence, built-in replacement,
unknown fields, malformed files, hash conflicts, atomic write failure,
last-known-good presentation, root-only tool scope, and reload from empty
userData. Runtime tests prove root snapshot stickiness, child Role re-resolution,
explicit spawn override persistence, and capability ceilings across tools,
skills, plugins, and MCP servers.

Hook tests cover each supported lifecycle point, matcher behavior, deterministic
ordering, bounded context, restart, disabled hooks, and failure diagnostics.
Renderer and E2E tests use the canonical DTOs and verify light/dark plus narrow
window layout.

## Open questions

None. This plan inherits the ratified Full Access model, canonical
Thread/Turn/Item/Profile/Role vocabulary, clean replacement policy, and
interface-first rule for any future shared protocol change.

## Implementation checklist

- [ ] Ship configuration read/edit, hash conflict handling, recovery, Settings,
  Thread Details, and focused tests as one complete feature.
- [ ] Fold the shipped configuration behavior into the active Agent Core and
  settings specs in the same PR.
- [ ] Ship prompt-only lifecycle hooks as a separate complete feature after the
  configuration feature is merged.
- [ ] Add terminology guards for removed agent models, tools, authorization
  concepts, storage keys, i18n, CSS, specs, and active plans.
- [ ] Run `bun run typecheck`, relevant Core and renderer tests, focused E2E,
  `bun run docs:check`, and `git diff --check` for each unit.
