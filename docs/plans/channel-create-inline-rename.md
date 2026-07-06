# Channel Create And Inline Rename

## Goal

Make Channel creation a low-friction action. A user clicks New Channel, lands in a
new untitled Channel, and starts typing. Naming is a later inline edit on the
Channel row, not a blocking setup step.

## Non-goals

- Do not add Channel deletion.
- Do not redesign per-Channel Dream-data inclusion.
- Do not add a replacement creation form or opening-message workflow.
- Do not change protected default Channel behavior beyond hiding ordinary rename
  controls.

## Design

This is shape (a): one complete feature in one PR.

### Create

The Channels section `+` creates a Channel immediately through
`agent_create_conversation` without opening `ChannelConfigWindow`. The runtime
accepts a missing or blank title and persists an untitled display state. After
creation, the dock navigates to the new Channel and focuses the composer.

Creation no longer accepts or persists `seedText`. The old "Opening message"
field wrote a static `user_message.created` event without starting a run, so it
looked inert and could pollute history. The first real Channel message is the
first message the user sends from the composer.

### Rename

Ordinary Channel rows expose a trailing edit icon instead of a More menu. The
protected General and Dream Channels do not show the edit icon.

Clicking the edit icon turns the row title into an inline text input with the
current visible title selected. `Enter` saves, `Escape` cancels, and blur saves.
A blank save restores the untitled display state instead of showing a validation
error.

Inline editing is scoped to one row at a time. While a rename save is in flight,
the input stays disabled and the row keeps its layout stable.

## Files It Will Touch

- `src/renderer/ui/agent/AgentChatPanel.tsx`
- `src/renderer/ui/agent/ChannelConfigWindow.tsx`
- `src/main/agentRuntime.ts`
- `src/main/main.ts`
- `src/core/types.ts`
- `src/core/i18n/messages/en.ts`
- `src/core/i18n/messages/zh-Hans.ts`
- `docs/spec/agent-architecture.md`
- `docs/spec/commands.md`
- `docs/spec/design-system/surfaces.md`
- targeted core/renderer/e2e tests

## Collision Result

`gh pr list` returned no open PRs. Existing specs contain the old required-name
and opening-message contract; this plan replaces that contract.

## Acceptance Criteria

- When the user clicks the Channels `+`, the app creates a new untitled Channel
  without opening a modal or child window.
- When creation succeeds, the dock navigates to the new Channel and the composer
  receives focus.
- Newly created Channels contain no seed/opening user message.
- Ordinary Channel rows show a direct edit icon, not a More menu.
- Protected default Channels do not show rename controls.
- When the user chooses inline rename, `Enter` saves, `Escape` cancels, and blur
  saves.
- Saving a blank Channel name returns the Channel to the untitled display state.
- Specs no longer say New Channel requires a name or has an opening message.
