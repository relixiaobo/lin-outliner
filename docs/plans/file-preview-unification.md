# File Preview Unification — One File Surface, Two Lifecycle States

## Goal

A file should look and behave the same whether it is a node in the outliner or a
loose file the agent just produced. Today there are two surfaces:

- **file-as-node** (`#241`) — a file node opens as an outliner *node page*
  (`NodePanel`): outliner breadcrumb, an **editable** title (currently shows
  `Untitled`), the shared preview hero, and the node's children outline.
- **agent file chip** — clicking a `[[file:…]]` marker opens a *standalone pane*
  (`FilePreviewPanel`): back-arrow + filename header, the shared preview hero, an
  "add to outline" action. No breadcrumb, no children.

The two render the **same preview hero** already (`FilePreviewShell` + the
`FILE_PREVIEW_RENDERERS` registry), but wrap it in two different frames reached
by two different panel view-kinds. This plan collapses them into **one
subject-keyed file surface** with two lifecycle states:

```text
loose (a trusted local file, not yet a node)  --add to outline-->  ingested (a file node)
```

The frame is identical in both states. Only two things change with state, and
they change **in place** (no navigation, no remount, no "jump"):

| Element        | loose                          | ingested                       |
|----------------|--------------------------------|--------------------------------|
| title          | **read-only filename**         | **read-only filename**         |
| preview hero   | shared `FilePreviewShell`      | shared `FilePreviewShell`      |
| breadcrumb     | the file's filesystem path     | the node's outliner ancestry   |
| children       | none                           | the file node's outline        |

"Add to outline" is a **loose → ingested rebind of the same mounted surface**:
the breadcrumb re-sources from path to outliner ancestry, the children outline
mounts, and the hero (and its scroll/zoom/page state) is untouched.

## Non-goals

- **Not** making out-of-trusted-root or unsupported files previewable. The
  screenshot's `.pptx` fails for two orthogonal reasons — it lives outside the
  trusted roots (`workdir`/`scratch`) and Office formats have no renderer. Those
  belong to the permission redesign (produce-into-delegated-root via typed
  `file_convert`, `agent-permission-redesign.md` PR-3) and to preview-capability
  work, not here. This plan assumes the file is trust-resolvable and renderable;
  when it is not, the unified surface simply shows its existing "unavailable"
  state under a path breadcrumb.
- **Not** adding new file-type renderers (PPT/Office/etc.).
- **Not** changing the trusted-local-file security gate
  (`localFileReferenceSecurity.ts` / `resolveTrustedLocalFileReference`).
- **Not** keeping (or adding) inline-editable titles for files. A file's name is
  read-only on this surface in both states; renaming, if ever wanted, is a
  separate explicit action, out of scope here.

## Design

### One subject-keyed FileView

Extract a shared `FileView` that both entry points render, keyed by the **file
subject** (a stable identity), not by panel view-kind:

- subject identity: the asset id when ingested; the resolved realpath/asset when
  loose. A loose file that gets ingested must map to the same identity so the view
  does not remount.
- the view renders: read-only filename title · breadcrumb (sourced per state) ·
  the shared preview hero · an optional children outline (only when ingested).

Both entry points open this one view:

- **outliner** — navigating to a file node opens `FileView` in the ingested state
  (today this is `NodePanel`'s file-node branch at `NodePanel.tsx:167, 821-826`).
- **agent chat** — clicking a `[[file:…]]` chip opens `FileView` in the loose
  state (today this is the `{kind:'file-preview'}` panel view →
  `FilePreviewPanel`).

### The no-jump constraint (the load-bearing part)

The requirement "add to outline causes no state jump, only the breadcrumb (and
children) change" forces the unification: if ingest handed off from the
`file-preview` view-kind to the `NodePanel` node-page view-kind, that is a
cross-view remount — a jump that loses preview/scroll/zoom state. Therefore
ingest must mutate the **subject of the same mounted `FileView`** (loose →
ingested), never navigate to a different view. This is why a shared subject-keyed
view is required rather than two cosmetically-matched components.

### Read-only filename title (also fixes "Untitled")

The node-page title is currently an editable `RichTextEditor` bound to the node's
`content` (`NodePanel.tsx:169, 646-699`), which renders the `Untitled` placeholder
whenever `content.text` is empty — even though the real filename is available on
the node (`originalFilename`) and the standalone pane already shows it via
`sourceTitle(source)`. Converge both states on a **read-only filename** derived
from the real name (`content.text || originalFilename || resolved source title`).
This removes the `Untitled` bug as a direct consequence.

Note: this makes file nodes deliberately different from every other node (no
inline-editable title). That is intended (see Non-goals).

### Breadcrumb with two sources

The breadcrumb component gains a filesystem-path source in addition to its
current node-ancestry source:

- loose → render the file's path as breadcrumb segments (a directory path is the
  natural shape; collapse the home/userData prefix the way the outliner collapses
  long ancestries).
- ingested → render the node's outliner ancestry (unchanged from today).

### Children, conditional on state

The children outline (already rendered for file nodes by `NodePanel`) mounts only
in the ingested state; the loose state shows the hero alone. On ingest the
children section appears in place.

## Shape & build order

**Shape (b): a SET of independent complete PRs.** Each is independently
reviewable and shippable.

- **PR-1 — read-only filename title + fix `Untitled`.** Converge the file-node
  title to a read-only real filename across both surfaces; drop the editable
  title for file nodes. Small, low-risk, removes the visible `Untitled` bug on its
  own. Ships first.
  - Files: `src/renderer/ui/NodePanel.tsx` (title region), the file-node title
    derivation (`src/renderer/ui/preview/fileNode.ts`, `FilePreviewBody.tsx`),
    `FilePreviewPanel.tsx` (already uses `sourceTitle` — confirm parity), i18n if
    copy changes, renderer tests.
- **PR-2 — unify into one subject-keyed `FileView` + in-place loose↔ingested
  transition.** Extract the shared `FileView`; route both the outliner file-node
  navigation and the agent `file-preview` view to it; add the path breadcrumb
  source; mount children only when ingested; make "add to outline" an in-place
  subject rebind (no remount). Builds on PR-1's title convergence.
  - Files: `src/renderer/ui/NodePanel.tsx` (file-node branch), the panel-view
    system (`src/renderer/ui/useWorkspaceLayout.ts`, `WorkspaceCanvas.tsx`,
    `filePreviewView`), `FilePreviewPanel.tsx` / `FilePreviewBody.tsx`
    (collapse into the shared view), the breadcrumb component, the preview-target
    open flow (`previewEvents.ts`, `App.tsx`), renderer + e2e tests.
  - Shared and untouched: `FilePreviewShell` + `FILE_PREVIEW_RENDERERS`
    (`previewRenderers.tsx`) and the main-process `previewSource.ts` resolver —
    the hero is already common.

## Upstream dependency (not in this plan)

A loose **agent-produced** file can only use this surface if it is
trust-resolvable (inside `workdir`/`scratch`). Agent outputs that land outside
those roots (e.g. a `bash`-written `.pptx` in the repo cwd) are gated by the
trusted-file resolver and show "unavailable" regardless of this UI. Producing
agent outputs into delegated roots is `agent-permission-redesign.md` PR-3 (typed
`file_convert`); Office/PPT rendering is separate preview-capability work. This
plan does not depend on them landing, but the end-to-end "open the PPT Neva made"
experience does.

## Open questions

- **Loose breadcrumb format** — full absolute path segments, directory-only, or a
  collapsed form (hide the `userData`/home prefix)? (Leaning: directory segments,
  collapsed prefix.)
- **Subject identity mapping** — confirm a loose file's identity (realpath/asset)
  maps to the created node's asset on ingest, so the same `FileView` instance
  survives the transition.
- **Rename entry point** — with the title read-only, where does an explicit
  rename live (context menu / meta action), or is rename simply out of scope for
  now?
