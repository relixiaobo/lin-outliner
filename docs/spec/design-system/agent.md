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
- Shared floating menus for model choices and a single header-owned settings
  entry.
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
- Header, chat scroll content, steering preview, and composer share a single
  internal dock inset: `--agent-dock-inset-x` (`8px` at the current scale),
  matching the sidebar's right inset.
- Current title pattern remains `# conversation`.
- The title trigger uses content-width geometry with internal padding; its
  hover/active background must not stretch across unused header space.
- Header actions are real commands only. Do not add decorative status dots or
  placeholder circles.
- Conversation rename keeps the same row height as the read-only session row so
  editing a title does not move the menu contents.
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
- Header contains one measured disclosure/status slot and a concise summary.
- The status/tool icon and disclosure chevron share that slot: default state
  communicates the status or tool type, while hover/focus/expanded state reveals
  the disclosure affordance without moving text.
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
  backgrounds in normal states; use indentation, a light timeline rule, the
  shared disclosure/status slot, and text hierarchy first.
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

## Debug Surface

Agent debug is an inspection panel for provider payloads, token accounting, and
runtime history. It must not become the normal chat presentation.

- Organize the panel as Overview, Request Context, and Provider Timeline.
- Overview shows session count, model, context budget, and status as compact
  metrics.
- Request Context contains system prompt, tools, and request JSON.
- Provider Timeline contains query and round groups. Request messages and the
  provider response are rendered as one ordered message list; response must not
  become a separate side column.
- Debug payloads are bounded and scrollable; raw JSON is never the primary row
  label.
- Debug surfaces use the same white panel background as the workspace; subtle
  section separation comes from light borders and spacing, not tinted page
  backgrounds.
- Refresh and copy use shared icon-button affordances.

## Approval And Tool Preview

Current product state:

- The runtime type system contains `AgentApprovalRequestEvent`, but the
  renderer does not currently ship an interactive approval overlay.
- Node mutation tools expose `previewOnly`; preview results are returned as
  compact tool-result data rather than shown as a blocking confirmation UI.

Contract:

- Approval UI, when shipped, is a modal or anchored inspection state attached to
  the agent turn that requested it. It must not appear as an outliner card or a
  separate settings page.
- Tool previews must summarize status, affected references, change counts, and
  next read step before raw JSON.
- Preview bodies stay bounded and scrollable; exact payloads belong in expanded
  detail, not the primary row.
- Approve/deny actions use the same button hierarchy as settings: primary for
  approve/apply, secondary for cancel/deny, danger only for destructive
  irreversible operations.
- Until a real approval workflow exists, the design system documents the
  boundary and product code should not render fake approval controls.

## Composer Contract

The composer is the bottom dock control surface. It stays bottom-aligned inside
the dock and uses the same horizontal inset as the header and chat scroll
content. Its bottom edge aligns with the workspace panel bottom edge. Because
the composer is an input surface with corner controls, it uses the larger
`--agent-composer-radius` instead of the normal panel radius.

- Assistant prose, user bubbles, and composer input use the same primary content
  typography as the outliner: `--font-content / --line-content`.
- Process summaries, thinking rows, and tool summaries use
  `--font-meta / --line-meta` so they remain subordinate to final prose.
- Textarea is the primary affordance.
- Auto-resize the textarea up to a bounded maximum height.
- Enter sends unless Shift is held or IME composition is active.
- Send and stop share the same primary action slot.
- Attachment, model, and reasoning controls live in a secondary toolbar row and
  must not compete with the textarea.
- The composer surface stays visually unified. Do not insert a divider between
  textarea and toolbar.
- Composer surface radius uses `--agent-composer-radius`; model, attachment,
  send, and stop controls share `--agent-composer-corner-radius`.
- Corner controls inside the composer follow the corner containment rule: the
  control's horizontal inset equals its bottom inset, and its radius derives
  from `surface radius - inset` so the corner centers align without making the
  controls feel square.
- Focus on the composer/input surface uses the neutral dark focus border, not
  brand/accent color.
- Stop uses a filled square glyph in the shared primary action slot, not an
  outlined square icon.
- Queued follow-up actions, attachment chips, model button, model/reasoning
  menu, reasoning switch, and send/stop action slot are separate control
  components.
- While streaming, typed text becomes steering or a queued follow-up rather than
  forcing a second layout mode.
- Active assistant waiting, tool, and text-streaming states share the same
  assistant turn shell. The processing indicator must not move between a
  temporary row and the final message row when text starts.
- Queued steering/follow-up appears as a compact preview above the composer.
- Model, reasoning, and attachment controls are secondary toolbar controls.
  Provider settings has one entry in the agent header, not duplicated in the
  composer toolbar or model menu.
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
  `MenuItem`, `Dialog`, `FormField`, `TextInputControl`, `SelectControl`,
  `ButtonControl`, and `CheckboxControl` contracts.
- Floating menus are portal-based, viewport-aware, and dismiss on Escape and
  outside pointer down.
- Composer menu controls use shared item/switch semantics; textarea draft,
  provider updates, attachments, and queue/stop behavior stay in
  `AgentComposer`.
- Composer model choices are derived only from providers that are enabled and
  have a saved or environment API key; unconnected SDK providers are not shown
  as selectable models.
- Agent settings is configuration, not a landing page. Provider choice,
  connection credentials, model behavior, and destructive actions are separate
  sections.
- Settings may expose the provider catalog through Provider ID entry, but model
  controls appear only after the selected provider has credentials.
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
