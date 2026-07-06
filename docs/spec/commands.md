# Command Protocol

All document mutations and agent runtime calls are Electron IPC commands backed
by the TypeScript core in `src/core` and the main process in `src/main`.

## Source of Truth

The authoritative list lives in [`src/core/commands.ts`](../../src/core/commands.ts):

- `DOCUMENT_COMMANDS` — document tree, rich text, fields, tags, references,
  search nodes, view config, batch ops, undo/redo. Every mutating command
  persists the workspace snapshot and returns a `CommandOutcome` with the new
  `DocumentProjection` and optional `FocusHint`.
- `AGENT_COMMANDS` — agent session lifecycle, message send/edit/regenerate,
  follow-ups, steering, provider settings, debug snapshots, child-run control.
- `ASSET_COMMANDS` — asset ingest, lookup, native pickers, safe system file
  actions, and external URL opening. Asset commands never mutate document state;
  renderer flows pair them with document commands when a picked/dropped file
  should appear in the outline.

The renderer calls them through `window.lin.invoke(...)` via
[`src/renderer/api/client.ts`](../../src/renderer/api/client.ts).

## Categories

### Document — tree and editing
`init_workspace`, `get_projection`, `create_node`, `create_rich_text_node`,
`create_tagged_node`, `create_tag_and_tagged_node`, `create_nodes_from_tree`,
`create_capture`, `paste_nodes_into_node`, `split_node`, `apply_node_text_patch`,
`update_node_description`, `merge_node_into`, `move_node`, `batch_move_nodes`,
`indent_node`, `outdent_node`.

`create_nodes_from_tree` materializes a typed `CreateNodeTree` recursively,
including content, optional descriptions, code block language, tags, fields, and
task checkbox state. It is the bulk structural path for paste and import.

`create_capture` atomically creates one launcher-capture node: a plain node
carrying a hidden, typed `capture` provenance sidecar (`CaptureNodeMetadata` on
`NodeBase.capture`) plus the source projected into native outline shape — a
capture-kind tag (rolling up to `#capture`) and typed fields (URL / Author /
Published) — in a single transaction so undo/redo stays coherent. The sidecar is
system-owned JSON, hidden from outline rendering and default full-text search; the
outline projection is the readable/searchable surface. The launcher invokes this
through the `launcher:*` main-process IPC (not the renderer command client) so the
renderer can't supply the source metadata. See [`launcher.md`](launcher.md).

### Document — batch operations on a row selection
`batch_trash_nodes`, `batch_indent_nodes`, `batch_outdent_nodes`,
`batch_toggle_done`, `batch_cycle_done_state`, `batch_duplicate_nodes`,
`batch_move_nodes`, `batch_move_nodes_up`, `batch_move_nodes_down`,
`batch_apply_tag`.

### Document — done state and trash
`toggle_done`, `cycle_done_state`, `trash_node`, `restore_node`, `delete_node`.

`trash_node` / `batch_trash_nodes` move live nodes into Trash and preserve a
restore location. `restore_node` moves one trashed node back to that remembered
location when possible. `delete_node` is the permanent removal command: the UI
exposes it only from Trash affordances such as **Delete forever** and **Empty
Trash**, both guarded by confirmation.

### Document — node presentation
`set_node_checkbox_visible`, `set_node_icon`, `set_node_banner`,
`create_image_node`, `set_node_image`, `create_attachment_node`.

`create_image_node(parentId, index, source)` creates a block image row from
either a local `assetId` or an `http(s)` `mediaUrl` and persists optional image
dimensions. `set_node_image(nodeId, source)` converts an existing plain content
row into the same image node shape.

`create_attachment_node(parentId, index, metadata)` creates a block attachment
row. It requires a local `assetId`, MIME type, original filename, and byte size;
optional `thumbnailAssetId`, `pdfPageCount`, `audioDurationMs`, and
`videoDurationMs` are copied from asset metadata. Image MIME types are rejected
here because they use the image-node commands.

### Document — view configuration
`set_view_toolbar_visible`, `set_view_mode`, `add_sort_rule`, `update_sort_rule`,
`remove_sort_rule`, `clear_sort_rules`, `add_filter_rule`, `update_filter_rule`,
`remove_filter_rule`, `clear_filter_rules`, `set_group_field`,
`add_display_field`, `update_display_field`, `remove_display_field`.

### Document — knowledge model (tags and fields)
`create_tag`, `apply_tag`, `remove_tag`, `set_tag_config`, `set_field_config`,
`create_field_def`, `create_inline_field`, `create_inline_field_after_node`,
`reuse_field_definition`, `register_collected_option`,
`create_collected_field_option`, `select_field_option`, `clear_field_value`.

User tag and field definitions are reusable only while they are active: the
definition node must exist, have the expected `tagDef` / `fieldDef` type, and not
live in the Trash subtree. Applying a tag, creating a tagged node, reusing a field
definition, configuring definitions, and selecting `options_from_supertag` values
all reject trashed definitions. Name-based creation ignores trashed same-name
definitions and creates a fresh active definition under Schema.

`reuse_field_definition(entryId, targetDefId)` repoints a field entry at an
existing definition instead of the throwaway draft `>` minted, dropping the now
-orphaned draft def. `targetDefId` is either a real `fieldDef` node (reuse a
user field) or a `sys:*` id (a built-in system field with no backing node — value
derived from the owner). When `targetDefId` is a system field, the entry's stored
value children are also dropped (the value is computed, not stored). Most system
fields render read-only; `sys:done` is the exception — a read-write checkbox that
toggles the owner node's done state.

### Document — references
`add_reference`, `add_reference_conversion`, `set_reference_target`,
`replace_node_with_reference`, `replace_node_with_reference_conversion`,
`replace_node_with_inline_reference`, `convert_reference_to_inline_node`,
`restore_inline_reference_node_to_reference`.

### Document — search and dates
`search_nodes`, `backlinks`, `ensure_date_node`, `ensure_tag_search`,
`create_search_node`, `set_search_node`, `set_search_query_outline`,
`refresh_search_node_results`.

### Document — command nodes (scheduled routines)
`set_command_node`, `set_command_schedule`, `mark_command_fired`.

A `command` node is **node-native**: its text content is a natural-language brief,
its body (the non-field child outline) is the prompt detail, and its config lives
in one real child field row — `Schedule`. Arming its schedule makes it run
unattended on a timer. (Design history: `docs/plans/archive/agent-scheduled-routines.md`.)

- `set_command_node(nodeId)` converts a plain content row into a `command` node
  (brief stays in the node's content), seeds the user-only `commandSchedule`
  protected field, and seeds a `fieldEntry` child pointing at the built-in system
  field `sys:commandSchedule`, whose value editor writes the gated scalar.
  Idempotent (find-or-create — a re-conversion never duplicates the row). Drafting
  a command is allowed from any origin.
- `set_command_schedule(nodeId, schedule?)` arms / changes / clears the schedule
  — a canonical `<endpoint> RRULE:...` string parsed by `dateSchedule.ts`. **The
  bright line: a command node's schedule is rejected unless `origin === 'user'`**
  (gated on the `command` node-type invariant, not the mutable `protectedFields`
  array, so it can never fail open). The agent can draft a brief and propose a
  schedule as text, but only the user can arm an unattended run. A non-empty
  value re-arms the watermark (`sysLastRunAt = now`); clearing it makes the node
  manual-only and leaves the watermark untouched.
- `mark_command_fired(nodeId, firedAt)` advances the system fire watermark
  (`sysLastRunAt`) after a successful run. **Forward-only** — a fire that captured
  an older sweep-start time never moves the watermark backward (so a long run that
  straddled a user re-arm can't re-expose a covered occurrence). Like the schedule
  bright line it is **system-managed**: an `origin === 'agent'` write is rejected
  at the gateway (symmetric to `set_command_schedule`, so an agent can never
  suppress a user's schedule by jumping the watermark ahead).
- `mark_command_attempted(nodeId, attemptedAt)` records the at-most-once marker
  (`sysLastAttemptAt`) **before** a run starts, so a crash mid-run can be told
  apart from a clean failure on the next launch. Forward-only and agent-rejected,
  exactly like `mark_command_fired`.

The anacron scheduler (main process) sweeps command nodes on a 60s tick, on app
launch, and on `powerMonitor.resume`, firing each due node once (catch-up
coalesces a multi-day gap). Due nodes fire **concurrently** — one slow/hung run
never blocks the others or subsequent sweeps. A fire runs the brief as a
**delegated child run** anchored to the command's own delivery conversation. The
run is recorded in the Run index, surfaces in Work/Runs and durable
notifications, and its full detail/transcript is available through the Run detail
view; it is not inserted into the chat transcript as an inline child-run row.
Under the one-Neva invariant there is exactly one agent, so a scheduled command
always forks the current agent (Neva), running under its identity and
capabilities — a command never selects an executing agent. The run prompt is the
brief — the command's title plus its non-field child outline serialized as a
nested bullet list (`commandBriefText`, with inline references reconstructed via
reference markup so they survive); field-entry children (the Schedule row) are
config, not prompt, and are excluded. An
empty brief is skipped (never fires, never advances the watermark). **Only a run
that actually
completes advances the watermark** — a failed run (no provider, bad key, rate
limit) leaves the occurrence due and arms an in-memory backoff ladder (measured
from the failure time, not the sweep-start time, so the ladder doesn't collapse
on a slow run). The sweep also prunes backoff state and deletes the delivery
conversation of a command node that was permanently removed.

**At-most-once across a crash.** Before each fire the scheduler persists
`mark_command_attempted(dueAt)`, then starts the run. The due check itself reads
only `sysLastRunAt`, so an in-process failure still retries through the backoff
ladder. But a crash *during* a run would otherwise re-fire the same occurrence on
the next launch (the watermark never advanced). To prevent that, a one-time
startup pass — `reconcileCommandAttempts()`, run once before the first sweep —
advances the watermark past any occurrence whose `sysLastAttemptAt` is newer than
its `sysLastRunAt`: an interrupted run is **skipped, not re-fired** (at-most-once
for the crash case; the user re-arms or the next occurrence picks it up). A clean
node (`sysLastAttemptAt <= sysLastRunAt`) is left untouched.

**Unattended permission model.** A scheduled fire runs with no interactive
approval channel (`unattended: true` → no `approvalHandler`), so it can never
hang waiting on a human. Tools whose policy resolves to **soft_blocked** are
denied and reported (the run continues and records the denial) rather than
blocking; matching `softBlockAllows` exceptions are still honored.
`agent_run_command_now` runs attended (the human is present), so it can surface
the soft-block card.

`agent_run_command_now(nodeId)` (agent command) runs the brief attended, right
now: the same no-human-turn execution with a `{type:'node'}` trigger and **no
watermark advance**, so testing a command never disturbs its schedule. It
coordinates with the scheduled sweep through a shared in-flight guard — if a fire
for the same node is already running it returns the existing conversation rather
than colliding. Returns the delivery `conversationId`.

`agent_ensure_command_conversation(nodeId)` ensures the command's delivery
conversation exists (creating an empty one titled from the brief if needed) and
returns its id **without running**. The renderer calls this before
`agent_run_command_now` so it can reveal/select the conversation up front and then
watch the run stream in live — selecting a not-yet-created conversation would
throw.

Entry points (renderer): the `/command` slash command converts the current row
into a command node. A command node is **node-native** — it carries a command
glyph instead of a bullet (`RowMarker` `command` variant) and is always shown
expanded (its config + steps stay visible the way the old controls card did,
`isRowExpanded`). Under the brief (the inline-edited row text = the title) sit the
two seeded config field rows plus the prompt steps (any other child nodes).

**Run lives on the title, not in the Schedule value.** A labelled **Run** button
(`CommandRunButton` — a text action button with a background, aligned with the
title like the inline Done checkbox) sits at the start of the command title;
`useCommandRun` drives the attended run: ensure the delivery conversation
(`agent_ensure_command_conversation`), reveal the agent panel on it (without
auto-opening Work — that was abrupt), then run it
(`agent_run_command_now`), so the run streams through the Run index and can be
opened from Work/Runs. While the run is in flight the **command bullet glyph becomes a
spinner** (`RowMarker` `processing` → `.is-processing`) — that is the *only*
running indicator; the Run button never reflects running/failed state (a
`runningRef` in the hook just guards against a double-trigger). The two config
field values render in the **standard outliner value style** (plain value text +
a muted trailing glyph, no pill), so they read like ordinary fields. Each value
also carries its **own leading bullet** (`.command-field-value-bullet`, reusing
the standard value-node `.row-bullet-shape.content` + dot), so a value reads as
its own node the way Tana field values do. The schedule/agent stay **scalar-backed**
(no value node exists), so this bullet is decorative — there is nothing to zoom
into; it is `aria-hidden` and non-interactive. Both values default **blank** and
open their picker on **Space** (or click), mirroring the standard date field's
"Press Space to pick…" empty value:

- The **Schedule** field row (`sys:commandSchedule`) carries a **calendar** marker
  icon; when empty it shows the "Press Space to pick a date…" placeholder, and when
  armed the schedule summary as plain text with a trailing calendar glyph. Space or
  a click opens the **standard date picker** (`DateValuePicker`) — the same editor
  every date field uses, with a **Repeat** control (the date field gained
  recurrence; see `date-field-values.md`) — in **single-only mode**
  (`allowRange={false}`, since a schedule is always a single anchor). The picker
  commits live through the user-only `set_command_schedule` gateway (the bright line
  is unchanged: only the generic field-value write path is bypassed, never the
  gate). The summary is built from the shared recurrence labels
  (`scheduleChipSummary`).

Navigating to the config row focuses its value cell (`OutlinerFieldRow` consumes
both the field-name and row focus targets onto the value button), so the keyboard
Space-to-pick affordance works after arrow navigation, not just on click.

The field editor honors the owner's edit lock. The prompt is everything else
under the command node (ordinary child rows) — edited as normal outline content,
serialized to the run brief by `commandBriefText`.

### Document — history
`undo`, `redo`.

### Assets
`ingest_asset`, `ingest_local_file`, `lookup_asset`, `delete_asset`,
`pick_image_files`, `pick_attachment_files`, `open_asset`, `reveal_asset`,
`copy_asset_file`, `open_external_url`.

`ingest_asset` stores bytes under the workspace asset directory and returns
`AssetMetadata`. It derives image dimensions, PDF page count, audio/video
duration when the format is locally parseable, and a best-effort first-page PDF
thumbnail when the platform thumbnail tool is available. MIME type is resolved
from file signatures or filename extension first, then from a renderer hint when
present, falling back to `application/octet-stream`.

`ingest_local_file` is the ingest bridge for agent-produced files (agent-file-model
F4): it path-ingests a file into the asset store and returns `AssetMetadata`, but
**only** when the path resolves inside the agent's trusted roots
(workdir/scratch) via `resolveTrustedLocalFileReference` — the same gate that backs
previewing those file chips. The renderer can thus only ingest a file it could
already preview, so this does not reopen the arbitrary-local-file read primitive
that `ingest_asset`'s buffer-only-over-IPC rule guards against. Directories and
gone/out-of-root paths return `null`.

`pick_image_files` and `pick_attachment_files` open native file pickers in the
main process and ingest selected regular files before returning metadata to the
renderer. The renderer decides whether each asset becomes an image node or an
attachment node.

`open_asset`, `reveal_asset`, and `copy_asset_file` operate only on files whose
resolved real path remains inside the asset directory. `open_asset` additionally
uses the local-file open policy before handing the file to the OS. `reveal_asset`
reveals the asset copy in Finder; `copy_asset_file` copies both a text path and,
where supported, a native file URL/file-list flavor to the clipboard.

### Agent — conversations and persistence
`agent_restore_latest_conversation`, `agent_restore_conversation`,
`agent_create_conversation`, `agent_list_conversations`,
`agent_rename_conversation`, `agent_delete_conversation`,
`agent_close_conversation`, `agent_reset_conversation`.

The conversation surface is product-shaped around DMs and Channels:
`agent_list_conversations` returns one immutable canonical DM row for every
configured agent, plus named Channels. The reserved `#General` Channel
(`lin-agent-channel-general`, `title/goal = General`) is ensured by the runtime,
sorted first among Channels, and auto-includes every current durable peer agent.
It stores no conversation `kind` and cannot be renamed, deleted, or manually
membership-edited through ordinary conversation commands. The Agent Dock default
selection restores a remembered valid DM/Channel first, then `#General`, and only
then falls back to `agent_restore_latest_conversation` for the legacy coordinator
DM. The Agent Dock conversation menu lists Channels before Direct Messages so the
primary surface recommends `#General`/named Channels first. Restoring a canonical
DM id is find-or-create; DMs are never user-created, renamed, deleted, or
membership-edited.
`agent_create_conversation` is the user-facing New Channel command: title is
optional, blank creation stores the untitled display sentinel, and creation does
not accept an opening message. DMs never convert into Channels, and their
transcript is never shared into a Channel. `agent_rename_conversation` accepts a
blank title and restores the untitled display sentinel. Protected default
Channels cannot be renamed or deleted.

### Agent — messaging
`agent_send_message`, `agent_edit_message`, `agent_regenerate_message`,
`agent_retry_message`, `agent_switch_branch`, `agent_queue_follow_up`,
`agent_clear_follow_up`, `agent_steer_conversation`, `agent_clear_steer`,
`agent_stop_conversation`.

In a **DM**, `agent_send_message` resolves when the serial run settles (the
command spans the turn). In a **Channel** it **resolves on
acceptance**: it persists the user message and enqueues the addressed turns, then
returns without awaiting them — the runs drain asynchronously (`scheduleChannelIdleEmit`
emits the final idle projection on drain). `agent_edit_message`/`agent_regenerate_message`/
`agent_retry_message` follow the same DM-vs-Channel contract. `agent_steer_conversation`
is DM-only; Channels have no steer (a send while runs work dispatches a new addressed
turn). See `agent-architecture.md` (Channel runtime).

### Agent — delegated runs
`agent_run_detail`, `agent_run_transcript`, `agent_run_status`,
`agent_run_steer`, `agent_run_amend`, `agent_run_stop`.
`agent_run_transcript` replays the run's own ledger for the drill-in transcript.
`agent_run_detail` reads Run meta, ancestor breadcrumb metadata, the latest result
submission, and direct sub-run metadata from the Run index.
Runtime control surfaces use only the `agent_run_*` command names; the older
pre-release child-run command aliases are not accepted.

### Agent — debug
`agent_debug_view` (the conversation's run list + rollups), `agent_debug_run`
(one run's model-facing context, process, usage, and per-run snapshot),
`agent_payload_text`.

### Agent — providers and runtime settings
`agent_get_provider_settings`, `agent_update_runtime_settings`,
`agent_upsert_provider_config`, `agent_delete_provider_config`,
`agent_set_active_provider`, `agent_set_provider_api_key`,
`agent_delete_provider_api_key`, `agent_get_provider_secret_status`.

## Conventions

- A renderer module never mutates document state directly. UI changes that
  affect document content or tree structure must go through a command.
- Every mutating command persists the workspace snapshot before returning, and
  produces a `CommandOutcome` carrying the projection plus an optional
  `FocusHint` so the caller can restore focus deterministically.
- Origins are tagged on the underlying Loro transaction (`user:`, `agent:`,
  `system:`) so the scoped `UndoManager` can separate user undo from agent
  undo. See `src/core/loroDocument.ts`.
- `NodeType` reserves `command` plus `CommandNode.commandSchedule`,
  `CommandNode.sysLastRunAt`, `CommandNode.sysLastAttemptAt`, and
  `NodeBase.protectedFields`
  (descriptive metadata only — the bright line is enforced inline on the
  `command` node-type invariant, not on this array) for scheduled-routines work.
  The Schedule config field row surfaces that scalar through the built-in system
  field `sys:commandSchedule` (see `src/core/systemFields.ts`).
- When adding or renaming a command, update `DOCUMENT_COMMANDS` or
  `AGENT_COMMANDS` and the matching dispatcher in `src/main/documentService.ts`
  (and `src/main/agentRuntime.ts` for agent commands). Update this category
  list when adding a whole new category, not for individual additions.
