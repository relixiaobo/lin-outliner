# Project Labels in Thread History

This catalog-label alternative does not establish a conversation work folder.
The broader design is [Conversation Work Folders](conversation-work-folders.md).

## Goal

Help readers switching between Projects identify a conversation's current Project
directly in history and return to recently used conversations across Projects.
The reference screenshot shows a title with a quieter folder/name subtitle.
This design is one complete UI feature delivered in one PR.

## Non-goals

Project filters, a permanent history sidebar, date sections, new binding actions,
automatic Project inference, and changes to execution directories or permissions.
Agent-operated Project management is restored separately by
[Agent Project Capability Parity](agent-project-cli-parity.md); showing a label
does not replace that executable capability.

## Design

### Evidence and decision

`ThreadList` already receives the Project catalog and memberships, but partitions
the recent Thread sequence into Project sections. Each row shows its title and
source/time metadata; Project identity exists only in the section heading.

FR-1: Use the existing recent-update sequence as one list. Replace Project section
headings with a folder icon and current Project name in each eligible row's
secondary line. This trades contiguous Project sections for direct identification
and recency across Projects. Project management and Move to Project remain in
their existing entry points.

### Flow, row rules, and failure states

FR-2: Opening the existing Thread chooser exposes title, Project identity, and
time before selection. Selecting a row opens that conversation and closes the
chooser. The existing action menu owns management operations.

- The first line remains the conversation title and existing activity indicator.
- The second line places Project identity on the left and relative update time
  on the right. Both remain visible at rest; neither depends on hover. Long names
  truncate to one line; the complete name remains in the accessible text and a
  native tooltip. The folder icon is decorative and neutral.
- A persistent user Chat with an explicit null membership shows `No Project`.
  An assigned Chat shows the current catalog name, including after rename or move.
  Use membership identity, never a directory basename or execution-context hint.
- System and temporary conversations retain their existing source/time metadata;
  they do not acquire a user-Chat membership label inferred from their work.
- Before an eligible Chat's membership is read, show `Loading Projects…` in its
  metadata slot. After a failed read, or an unresolved non-null Project reference,
  show `Unavailable Project`. Unknown membership must not claim `No Project`.
  During a pending refresh, a previously resolved value may stay visible until
  success replaces it or failure marks it unavailable. Existing focus/mutation
  refreshes recover the label without blocking selection or conversation use.
- Project deletion follows the existing Host behavior: after successful refresh,
  preserved Chats show `No Project`. This feature performs no membership writes.
- Startup quarantine/dependency information remains visible and accessible. When
  present, retain it on a separate compact status line so a long Project name
  cannot hide the reason a conversation is unavailable.
- Clicking the title or subtitle selects the conversation. The subtitle adds no
  nested action. Selection, action-menu slots, scrolling, keyboard dismissal,
  and focus restoration retain their existing behavior.

Use existing font, spacing, neutral-color, and icon tokens. Ordinary rows remain
two lines in light/dark themes and at narrow widths; hover never changes geometry.

### Implementation scope and collision check

Reuse `useProjectCatalog` and pass its read state through `ThreadDock` into
`ThreadList`. Keep `threadStore` sorting, Project storage, and IPC unchanged.
Expected files: `src/renderer/agent/components/ThreadList.tsx`,
`src/renderer/agent/components/ThreadDock.tsx`, `src/renderer/styles/thread.css`,
`src/renderer/styles/projects.css`, `tests/e2e/agent-projects.spec.ts`, focused
renderer tests, and `docs/spec/agent-thread-rendering.md`. Include
`src/renderer/agent/projects/useProjectCatalog.ts` only if tests expose ambiguity
between unresolved memberships and its retained view. Existing localized Project
labels cover the proposed states.

Collision evidence: PR #664 is merged into `origin/main` at `41a6c0dc` and changes
both components and the rendering spec; its `ThreadList` change adds availability
metadata to the existing secondary line. Build against its merged result and
preserve that information. Open PR #668 is a
scheduled-work design file with no direct file overlap. The board's unified-record
work can later affect history; repeat the claim-time check before implementation.
No infrastructure-ownership file is required.

## Open questions

- OQ-1: Ratify replacing Project sections with one recent-update list and per-row
  Project labels. The fallback is retaining sections and adding the same row
  labels, accepting repeated Project names and cross-Project recency fragmentation.

## Acceptance and verification

- AC-1: Interleaved updates from two Projects and an unassigned Chat appear in
  existing global recency order, with the correct label on each eligible row.
- AC-2: Rename, move, unassign, and deletion refresh labels without deleting a
  Chat or changing its execution context; directory-less Projects work identically.
- AC-3: Delayed, failed, and missing-reference reads never display false
  `No Project` claims and never block otherwise healthy conversation selection.
- AC-4: System-source labels, background activity, and startup availability remain
  discoverable; long Project names cannot hide startup failure information.
- AC-5: Long titles/names, selected/unselected rows, hover, keyboard focus, and
  light/dark themes fit the existing chooser width without reflow on hover.
- AC-6: Project management and row-menu operations remain reachable; metadata
  does not introduce another focus target or change conversation-selection behavior.

Run typecheck, relevant renderer tests, focused Project/history Playwright tests,
the applicable design guards, docs checks, and diff checks. Inspect light/dark
screenshots with mixed memberships and long names before marking the PR ready.
