# Agent Thread Rendering

The Agent dock renders canonical Thread DTOs directly. There is no second event
projection or UI-only execution model.

## Surface Structure

The dock has three stable regions:

1. A Thread list with selection, creation, rename, fork, and delete actions.
2. A scrollable Thread view containing ordered Turns and Items.
3. A composer for starting, steering, or interrupting the active Turn.

Child Threads are visibly nested under their parent. Forks remain top-level user
Threads and expose their source lineage in details rather than masquerading as
children.

The selected Thread ID is renderer state. Thread catalog, loaded pages, active
input requests, and Goals live in `threadStore`; components do not maintain
parallel copies.

## Item Rendering

`ThreadItemView` switches exhaustively on the canonical Item discriminant:

- user and agent messages render readable text at the same content register as
  the outliner
- plans render their current step list without becoming a separate work object
- reasoning is visually quieter and remains distinct from final output
- command, file, MCP, dynamic-tool, search, and image Items expose the fields on
  their DTOs
- collaboration Items link child activity to its child Thread
- compaction renders as a history boundary

Unknown Item kinds are protocol errors, not generic fallback cards. Item status
comes from the Item itself; the renderer never infers completion from missing
events.

Normal Thread UI may visually group Items by Turn without printing every Turn ID.
Details and diagnostics must show the same Thread, Turn, and Item identities as
the transport.

## Interaction States

An empty dock offers immediate Thread creation. Starting a Thread resolves the
current provider and working directory at the main-process boundary.

For an idle Thread, submit starts a Turn. For an active Thread, submit steers the
exact active Turn. Stop interrupts that Turn. Buttons remain dimensionally stable
while their icon and label state changes.

The composer submits `ThreadUserContent[]` directly. Text, attachments, and
Outliner Node references remain distinct structured parts. Sending a Node from
its context menu adds a removable Node-reference part to the composer; it never
inserts reference markup into text. Edit replaces only the message text, while
retry and regenerate replay the complete original structured input. An
attachment-only or Node-reference-only Turn is therefore sendable and retryable.

`request_user_input` renders an in-dock blocking form tied to one Item. It is a
product-input surface, never a permission prompt. A response includes the exact
Thread, Turn, and Item IDs and is rejected if the request is no longer active.

Rename uses the shared `Dialog`; delete uses `ConfirmDialog`. Browser-native
prompt and confirm APIs are not used. Fork creates and selects the new Thread
without mutating the source. Deleting the selected Thread chooses the next
catalog Thread and loads both its Turns and Goal before presenting it.

## Pagination And Notifications

Thread list and history reads use opaque cursors. Persistent and ephemeral
Threads share one `(updatedAt, id, direction)` keyset and one cursor after they
are merged, so an ephemeral row cannot displace a persistent row between pages.
The store may append live notifications to loaded pages, but a reload always
reconstructs the same view from canonical paged reads.

Each history load carries a per-Thread generation and observes the Thread's live
notification revision. A superseded request is discarded. If a notification
lands during an older request, the response is merged monotonically: a terminal
Turn cannot return to `inProgress`, completed Items cannot be replaced by older
Items, and live-only Turns remain present.

Notifications are decoded before entering renderer state. A notification for an
unloaded Thread updates catalog metadata without manufacturing partial history.
When a page is loaded, Item order follows persisted rollout position.

## Visual Contract

The Agent dock follows the shared design system:

- content text uses the outliner reading size and line height
- chrome uses tokenized neutral states and icon controls
- dialogs and menus use shared overlay primitives
- focus remains visible, motion respects user preference, and hover never moves
  layout
- the header reserves the global rail-toggle zone so Thread actions do not
  overlap window chrome

All user-facing copy comes from typed i18n messages. UI nouns are Thread, Turn,
Item, Goal, Role, and Subagent.
