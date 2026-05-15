# Agent System

This module defines Lin's agent interaction model. It uses
`/Users/lixiaobo/Documents/Coding/sider-agent` as a reference for mature
side-panel AI interaction, but Lin must keep its own shell, density, tokens, and
outliner-first product model.

## Reference Boundary

Sider-agent is useful for interaction structure:

- Persistent side-panel chat that stays independent from the main workspace.
- Compact header with session/title controls.
- Assistant turns that merge text, thinking, and tool calls into one readable
  turn.
- Process blocks that group contiguous thinking and tool calls.
- Tool-call summaries that are action-based instead of raw JSON-first.
- Composer behavior for streaming, steering, send/stop, IME, and auto-resize.
- Shared floating menus for model and settings choices.
- Sticky-bottom chat scrolling only when the user is already near the bottom.

Do not copy sider-agent as visual style:

- Do not use its warm paper palette, heavy paper shadow, or Chrome-extension
  side-panel assumptions.
- Do not hide scrollbars globally.
- Do not introduce large card stacks inside the dock.
- Do not make onboarding or settings feel like a separate product page.
- Do not copy Chrome storage, browser tooling, VM tooling, or skill-specific
  behavior unless Lin explicitly owns that feature.

## Lin Agent Principles

- The agent dock is persistent across workspace tabs.
- The dock is subordinate to the outliner workspace. It should assist work, not
  compete with panels for visual dominance.
- Agent UI uses Lin foundations: neutral zinc text, pale gray app background,
  white surfaces, sparse semantic color, low elevation, and compact controls.
- The agent may reference outliner context, but workspace panels remain the
  primary editing surface.
- Empty states and suggestions must perform real sends or real configuration
  actions.

## Dock Contract

The dock is a shell surface, not a tab surface.

- Default width: `344px`.
- Resize range: `280px` to `520px`.
- Collapsed width: `0px`.
- Header stays compact and aligned with the top chrome rhythm.
- Current title pattern remains `# conversation`.
- Collapse state does not reset active tab, panel layout, chat draft, or
  conversation state.
- Resize uses the shared `ResizeHandle` contract.

## Turn Model

An assistant response should be rendered as a turn, not as disconnected message
fragments.

- Merge contiguous assistant entries that belong to the same model turn.
- Final prose is the primary content.
- Thinking and tool calls are process-layer details attached to the turn.
- Thinking and tool calls should be grouped under a single process block for
  the turn, not scattered between final response paragraphs.
- Copying an assistant turn copies user-visible assistant content and relevant
  tool results, not hidden thinking by default.
- A failed turn without prose should keep process/error details visible.
- Message action visibility may be hover/focus-within, but keyboard access must
  remain available.

## Process Blocks

Process blocks make agent work legible without turning the chat into a log
viewer.

- Group contiguous thinking and tool calls under one compact header.
- Header contains status icon, concise summary, and disclosure chevron.
- Pending process may expand while live.
- Process collapses after final prose appears unless the user explicitly opened
  it.
- User expand/collapse overrides must survive streaming updates and re-renders.
- Default after a successful final response is collapsed summary-first. Expanded
  details are for inspection, debugging, or trust, not the normal reading mode.
- Details may show a timeline or left rule, but must stay visually lighter than
  final assistant text.
- Thinking rows are independently collapsible inside the process timeline:
  collapsed shows a one-line preview, expanded shows the full thinking text.
- Tool rows should sit inside the process hierarchy. Avoid per-tool card
  backgrounds in normal states; use indentation, a light timeline rule, stable
  icon slots, and text hierarchy first.
- Default tool state is a single action-summary row.
- Expanded tool state may reveal input and output payload details under that row.
- Tool input/output payloads are often long; render them in bounded, scrollable
  detail areas with compact labels and monospace only where exact values matter.
- Current product structure maps this contract to `AgentProcessBlock`,
  `AgentProcessTimeline`, `AgentThinkingBlock`, `AgentToolCallBlock`, and
  `AgentToolCallDisclosure`.

Tool summaries should be action-based:

- Good: `Reading current outline`, `Searched "design system"`,
  `Updated provider settings`.
- Avoid: raw tool names, raw JSON as the primary row label, or vague labels such
  as `Tool call`.

## Composer Contract

The composer is the bottom dock control surface.

- Textarea is the primary affordance.
- Auto-resize the textarea up to a bounded maximum height.
- Enter sends unless Shift is held or IME composition is active.
- Send and stop share the same primary action slot.
- Attachment, model, reasoning, and settings controls live in a secondary
  toolbar row and must not compete with the textarea.
- Queued follow-up actions, attachment chips, model button, model/reasoning
  menu, reasoning switch, and send/stop action slot are separate control
  components.
- While streaming, typed text becomes steering or a queued follow-up rather than
  forcing a second layout mode.
- Queued steering/follow-up appears as a compact preview above the composer.
- Model, reasoning, attachment, and settings controls are secondary toolbar
  controls.
- On send failure, restore draft and attachments only if the user has not
  started a new draft.

Attachments are optional for Lin's first agent pass. If added, they should use a
compact chip contract and must not expand the dock into a file manager.

## Scroll And Navigation

- Auto-scroll to bottom only when the user is already near the bottom.
- If the user scrolls upward, preserve their reading position during streaming.
- Show a compact scroll-to-bottom affordance when new content arrives offscreen.
- A chat minimap is optional and only useful after enough user turns exist; it
  should never be required for basic navigation.

## Settings And Menus

- Model picker, reasoning picker, and agent settings use shared `MenuSurface`,
  `MenuItem`, `Dialog`, and `FormField` contracts.
- Floating menus are portal-based, viewport-aware, and dismiss on Escape and
  outside pointer down.
- Composer menu controls use shared item/switch semantics; textarea draft,
  provider updates, attachments, and queue/stop behavior stay in
  `AgentComposer`.
- Agent settings is configuration, not a landing page.
- Provider secrets are masked and never shown in full after saving.

## Refactor Sequence

1. Align current `AgentDock`, `AgentChatPanel`, `AgentMessageRow`,
   `AgentMessageFrame`, `AgentBranchNavigator`, `AgentProcessBlock`,
   `AgentProcessTimeline`, `AgentThinkingBlock`, `AgentToolCallBlock`,
   `AgentToolCallDisclosure`, `AgentComposer`, `AgentComposerControls`,
   `AgentComposerModelMenu`, and `AgentSettingsDialog` to this contract.
2. Extract shared primitives only where they preserve current behavior:
   `IconButton`, `MenuSurface`, `MenuItem`, `Dialog`, `FormField`.
3. Normalize turn rendering before polishing visual details.
4. Normalize composer behavior before adding attachment or minimap features.
5. Validate the design-system site specimen against the real product source
   map after implementation.
