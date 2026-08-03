# Agent New Thread Slash Command

## Goal

Let a user start a clean root Thread from the Thread composer by submitting
`/new`. The command must be a first-class entry in the existing slash menu and
must behave like the Thread list's New Thread action: create and select one new
root user Thread, focus its empty composer, and leave the prior Thread intact.

This is **one complete feature in one PR**. It extends the existing composer
command surface without adding a protocol, persistence format, or second Thread
creation path.

### Purpose and evidence

- **EVD-1:** The Thread list already creates and selects a root user Thread
  through one dock-owned action, so the requested product operation exists.
- **EVD-2:** The Thread composer already exposes reserved `/compact` and
  `/clear` entries and preserves unknown slash text as ordinary input, so
  `/new` has an established discovery and fallback contract to extend.

## Non-goals

- Adding New Thread to the global unified command surface or defining that
  surface's shortcut and context-transfer behavior.
- Replacing or moving the Thread list's New Thread button.
- Clearing, archiving, deleting, renaming, or interrupting the prior Thread.
- Treating `/new` as a model instruction, Skill, completed feature Turn, or
  alias for `/clear`.
- Changing child, Automation, Memory, or other read-only Thread surfaces, which
  do not expose the composer.
- Changing `thread/start`, `turn/start`, renderer-to-main IPC, or Agent Core
  protocol types.

## Design

### Objectives and constraints

- **OBJ-1:** Give keyboard-first users a predictable clean-Thread action without
  requiring a trip through the Thread list.
- **CON-1:** Thread creation remains gated by an available provider and uses the
  existing `thread/start` request.
- **CON-2:** Structured composer content is never discarded to execute a slash
  command.
- **CON-3:** The separately claimed unified command surface retains ownership of
  global launcher behavior; this feature owns only the Thread composer.

### Decision summary

- `/new` is a reserved, exact-match Thread composer command.
- Submission reuses the dock-owned New Thread operation and never starts a Turn.
- Structured content alongside `/new` blocks submission instead of changing the
  command into a model message or discarding the content.
- Creation eligibility, active-Turn behavior, and failure recovery match the
  existing Thread list action.

### DEC-1: One reserved composer command

Add `/new` to the established runtime slash-command catalog alongside
`/compact` and `/clear`. Its localized description is "Start a new Thread" and
its menu selection inserts the complete `/new` text without a trailing space.
Selection does not execute immediately: it follows the existing command-menu
contract by returning focus to the composer, where Enter submits the visible
command.

`/new` is case-sensitive and reserved when the submitted composer text trims to
exactly `/new`. It executes only when the composer otherwise contains no
attachments, Node references, file references, or other structured content. If
structured content accompanies the reserved command, keep the complete draft,
start neither a Thread nor a Turn, and show the localized inline validation
message "Remove attachments and references before starting a new Thread." The
user can remove the structured content and retry without reconstructing the
draft.

Additional text such as `/new project`, casing variants such as `/New`, and
unknown slash text remain ordinary Turn input. This preserves the current Skill
and prompt fallback without letting a first-class reserved command silently
change meaning when structured content is present.

### DEC-2: Renderer-owned routing through the existing creation action

Recognize the exact command before the composer calls `turn/start`. Route it to
the same `thread/start` store action used by the Thread list's New Thread button.
No user-message Item, feature Turn, model request, Skill admission, or context
boundary is recorded for `/new`.

Keep the command renderer-owned because it changes the selected workspace
surface and already has a canonical renderer-to-main creation request. Agent
Core does not need a second command or a special Turn variant.

### FLOW-1: Start a Thread from the composer

- **Actor:** A user in an editable root user Thread.
- **Entry path:** Type `/` and select `/new`, or type `/new` directly.
- **Entry state:** Thread creation is eligible under the same provider rule as
  the Thread list's New Thread button.
- **Mainline:**
  1. The composer contains only `/new`.
  2. The user presses Enter or activates Send.
  3. Tenon creates exactly one root user Thread through `thread/start`.
  4. Tenon selects the new Thread and focuses its empty composer.
- **Result state:** The prior Thread and all of its history remain unchanged;
  `/new` is not present in either transcript.
- **Failure/recovery:** If creation fails, remain on the prior Thread, restore
  the `/new` draft, surface the existing dock action error, and permit retry.
  If structured content accompanies `/new`, remain on the prior Thread, preserve
  the whole draft, show the inline validation message, and permit retry after the
  user removes the attachments or references.

### DEC-3: Match New Thread eligibility, including background work

Use the same provider-loading and usable-provider decision as the existing New
Thread button. If the selected Thread's provider cannot send but another usable
provider still permits Thread creation, `/new` remains executable; it is an
escape from the unusable Thread rather than an attempted Turn on it. If Thread
creation itself is unavailable, `/new` must not bypass the provider gate.

An active Turn does not block `/new`. Creating the new Thread does not steer or
interrupt that Turn; the prior Thread continues in the background and retains
the existing background-work presentation. The current duplicate-submission
guard applies so repeated Enter presses cannot create multiple Threads.

An active `request_user_input` continues to replace the composer, so `/new` is
not reachable from that blocked surface. The Thread list remains the escape path
in that state.

### DEC-4: Preserve established interaction and accessibility contracts

The new entry uses the existing Thread slash-command listbox, filtering,
keyboard selection, focus restoration, and localized description presentation.
No new overlay or CSS treatment is introduced. The Thread list button and its
focus behavior remain unchanged.

### Requirements and acceptance criteria

- **FR-1:** The Thread composer exposes `/new` as a localized reserved command.
- **FR-2:** Sole-text `/new` creates and selects one root user Thread without
  starting a Turn.
- **FR-3:** `/new` shares the dock's creation eligibility, pending guard, focus,
  and failure recovery.
- **FR-4:** Structured content accompanying `/new` blocks submission without
  losing the draft; non-exact and unknown slash text retain the ordinary Turn
  path.

- **AC-1:** When an editable root Thread opens the slash menu, the menu shall
  include `/new` with a localized New Thread description alongside `/compact`,
  `/clear`, and user-invocable Skills.
- **AC-2:** When the user selects `/new`, the composer shall contain exactly
  `/new`, keep focus, and wait for explicit submission.
- **AC-3:** When the user submits sole-text `/new`, Tenon shall issue exactly one
  `thread/start`, select its returned root user Thread, focus its empty composer,
  and issue no `turn/start`.
- **AC-4:** While the prior Thread has an active Turn, submitting `/new` shall
  leave that Turn running and expose its existing background-work state after
  the new Thread is selected.
- **AC-5:** If `/new` is accompanied by structured composer content, Tenon shall
  preserve all content, start neither a Thread nor a Turn, and show the localized
  inline validation message until the user edits the draft or retries.
- **AC-6:** If the selected Thread cannot send but Thread creation remains
  eligible through another usable provider, `/new` shall still create a Thread.
  If creation is ineligible, it shall remain subject to the existing provider
  gate.
- **AC-7:** If `thread/start` fails, Tenon shall keep the prior Thread selected,
  restore the `/new` draft, show the existing action error, and create no partial
  Thread in renderer state.
- **AC-8:** Repeated submission while creation is pending shall create at most
  one Thread.

### Implementation boundaries

Extend the runtime command model and localized labels in the Thread dock. Give
the Thread view an explicit New Thread action and classify the submitted
structured content before applying the ordinary provider-send gate. Reuse the
store's existing `createThread` implementation and the dock's creation/error/
focus coordination rather than calling the API from the composer.

Update the Agent Thread rendering specification so the reserved-command list,
routing ownership, eligibility, and unknown-slash fallback match the product.
Add focused renderer/E2E coverage for command discovery, exact routing,
provider-gate parity, active-Turn preservation, structured-content validation,
failure recovery, and duplicate submission. Run typecheck, renderer tests, the
focused Agent Thread E2E, documentation checks, and light/dark visual verification
of the unchanged slash-menu surface.

## Edge cases, failure recovery, and risks

- Command recognition at only the display or submit layer could let `/new`
  reach the model or create a Thread while silently dropping attachments. One
  exact structured-content classifier must own action eligibility, validation,
  and routing.
- A separate creation callback could drift from the Thread list's provider,
  error, focus, or duplicate-submission behavior. Both entry paths must share
  one dock-owned operation.
- Switching away from an active Turn could accidentally interrupt it if Thread
  selection is coupled to cancellation. Regression coverage must prove the Turn
  remains active in the prior Thread.

## Open questions

None.
