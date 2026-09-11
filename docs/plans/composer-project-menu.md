# Composer Project Menu

## Goal

Give chat users one Project choice in the composer, with a recent-project flyout
and a direct New Project action. Remove the competing manual work-folder choice
from the product and its mutation surface. This is one complete feature in one PR.

## Non-goals

Do not remove task-level execution addresses, change permissions, change scheduling, or mutate admitted execution addresses.
Remove the retired conversation-folder reader and writer without a migration.

## Design

### Evidence and constraints

- The supplied screenshot shows three flat Add actions and a menu displaced to
  the left of its trigger. `ConversationControls` uses `AnchoredActionMenu`'s
  trailing alignment and omits the item classes used by the composer model menu.
- `ProjectDialog` previously preserved an existing conversation's folder unless
  the user checks Use project primary folder. Membership and saved folder were
  separate revisioned settings. The replacement lives in the
  [Core contract](../spec/agent-core.md#optional-project-catalog).
- The catalog currently sorts by name; Project `updatedAt` measures edits, not
  use. Do not present that timestamp as recent usage.

### Interaction and rules

- **FR-1:** Add opens above the plus button, aligned to its leading edge, with
  consistent menu rows: Add attachment, a separator, and Project with a trailing
  chevron. Remove Set work folder and its composer detail-dialog edit actions.
- **FR-2:** Hovering Project opens a flyout to its right; window-edge collision
  flips it left. Clicking or Right Arrow also opens it. Moving into the flyout
  keeps it open; Left Arrow returns to the parent, Escape dismisses, and closing
  restores focus. Reuse the existing composer flyout and keyboard mechanisms.
- **FR-3:** The flyout contains inline search and the complete
  project list with folder icons and the current choice checked. Up to six recent
  choices lead the remaining catalog; the list scrolls while New Project stays
  fixed below a separator. Search filters the whole catalog without another dialog.
  Recent IDs persist as local UI metadata and record only successful selections
  or explicit project-chat creation; stale IDs are filtered against the catalog.
- **BR-1:** An explicit composer Project selection binds the Project. Each subsequent task
  resolves its default from that Project's current primary folder, or Application
  default for No Project or a folderless Project. No independent conversation
  work-folder preference remains. The full conversation picker uses the same selection rule;
  remove its extra Use project primary folder confirmation step.
- **BR-2:** New Project opens a creation form directly with a close button, an icon/name input,
  and a large bordered Add folders button when empty. Added folders expose primary
  selection and removal. Create project submits; direct-entry Cancel closes. Saving creates
  the Project and selects it for the target conversation. If creation succeeds
  but binding fails, retain the created Project and offer selection retry without
  creating another Project. Cancel never changes the conversation selection.
- **BR-3:** Selection affects subsequent task admissions only. Existing Tasks and
  historical evidence retain their immutable execution addresses. Project primary
  edits affect subsequent admissions in member conversations; deletion detaches
  membership so subsequent admissions use Application default. Explicit task cwd
  remains; remove folder-only CLI mutations and their persistence.
- **FR-4:** Show the selected Project in the location chip; Edit Project opens its
  name, source folders and primary folder directly through a trailing pencil
  on that Project row, with deletion confirmation. The pencil appears on row
  hover or keyboard focus in a reserved slot, including on unselected Projects.
  Saving edits updates the Project without rebinding the conversation. Clicking the
  chip opens the picker directly; a separate remove icon clears membership without
  deleting the Project. The composer owns all chat Project operations; the Thread
  chooser retains grouping but removes management and assignment actions. Failures keep the chip and report the error. Loading, missing paths, stale revisions,
  and failures cannot report successful selection or fall back silently.

The Project chip stays beside Add in the bottom composer toolbar. Its leading
folder icon switches in place to the remove button on hover or keyboard focus;
neutral pill hover feedback groups the icon and name without changing geometry.
Add, Project and model selection share the control-hover fill. All four toolbar
controls, including Send, use the 28px control-size-xl height and vertical center
in both resting and hover states. Add has a circular
hit area; text controls size to their displayed content plus padding, with width
ceilings for truncation instead of growing into the toolbar spacer. Narrow model
controls retain horizontal padding and the dropdown caret; only the model name
truncates inside the available content area.

The parent Project row displays the selected Project name, or Choose project when
unselected. The child shows a bottom Don't work in a project action, with a close icon,
only when there is a selection to clear. It follows New Project, remains available
while searching, and clears chat membership without deleting the Project.
With an empty catalog, show only New Project: omit search, status text,
separators and the deselection row. With available projects and no selection, show the
searchable catalog directly without a redundant checked empty choice.

### Implementation scope and collision check

Expected files: `ConversationControls`, `ProjectDialog`, `ThreadDock`, private
Project-menu/recent-selection helpers, `ThreadList`, `styles/projects.css`, the two i18n message
catalogs, renderer tests, `tests/e2e/agent-projects.spec.ts`, and owning Agent specifications. Retire independent folder fields in
`core/agent/project.ts`, execution-context snapshots, `ProjectCatalogStore`,
`ProjectService`, `ProjectCliService`, `ToolRuntime`, local tool resolution, native
Project review and the built-in projects Skill; update their tests. No dependency
or infrastructure-ownership file changes are planned.

The image and service-readiness repairs share owning Agent specification files.
Reconcile their final contracts without changing image admission or Task readiness
policy. Service-readiness fixtures that previously changed a conversation folder
must instead select a Project and change its primary, preserving the original
cross-directory evidence acceptance cases.

### Acceptance

- **AC-1:** Verify placement, rows, hover traversal, click and full keyboard flow
  in light/dark appearance, a narrow dock, and at the window edge.
- **AC-2:** Verify recent ordering after successful choices and restart, deletion
  filtering, current checkmarks, empty state, full search, creation and cancellation.
- **AC-3:** Switch from Project A to B and then No Project; the next task uses B's
  primary and then Application default. An already admitted task keeps its address.
- **AC-4:** Verify folderless Projects, primary-folder edits, explicit task overrides, unavailable folders,
  concurrent changes, and create-success/bind-failure retry without duplicate creation.
- **AC-5:** Run typecheck, relevant renderer/Core tests, focused Project E2E and
  design guards, docs:check, and diff checks before making the PR ready.

Add folders opens a native directory picker with multiselection. Cancellation
leaves the draft unchanged. A batch appends distinct new paths in picker order;
the first added folder supplies the initial name suggestion and primary only
when the source list was empty. Existing names and primaries remain unchanged.
A batch exceeding the 20-folder total is rejected with a visible message,
without partially adding its folders.

Project folder rows are single-line and share icon, path, primary-action and
remove columns. The Project dialog is 560px wide, capped to the viewport with
16px outer insets. The final folder name takes its intrinsic width before the
parent path receives the remaining space; only names exceeding the entire path
column are themselves truncated. Long paths elide parent segments first;
hover titles preserve the full path. Make primary appears on row hover or
keyboard focus while its column stays reserved, so neither text nor neighbors
move. The selected Primary label stays visible. Editing feedback appears above
the action row, and closing restores focus to the Project chip or Add after
deleting the selected Project.

## Open questions

None. Project owns the default directory; task-level overrides remain execution
inputs. Project primary changes apply only to subsequent task admissions.
