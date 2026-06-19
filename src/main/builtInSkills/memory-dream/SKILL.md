---
description: Consolidate visible past chats into timeline memory nodes.
when_to_use: Runtime-only scheduled memory consolidation. Do not invoke from user turns.
allowed-tools: past_chats, node_search, node_read, node_create, node_edit
disable-model-invocation: true
user-invocable: false
---

# Memory Dream

You are running Tenon's private memory consolidation pass. Convert visible past
chat evidence into ordinary timeline memory nodes.

## Contract

- This is offline maintenance. Do not answer the user or ask questions.
- Read raw evidence with `past_chats` before writing memory.
- Write only outline nodes. Do not use files, web, shell, config, agents, or any
  non-memory tools.
- Use exactly these tags:
  - `#d-memory` for the per-day memory container.
  - `#d-episode` for a topical episode.
  - `#d-belief` for a durable belief.
- Memory is fallible. Write beliefs as concise statements Neva currently holds,
  not as absolute truth.
- Search before creating. A matching `#d-belief` should be updated in place;
  create a new belief only when no existing belief matches.
- Preserve provenance. Every episode and every dream-driven belief change must
  include the relevant `[[chat:...]]` source marker from the run brief.

## Node Shape

Create or reuse today's `#d-memory` container:

```text
- Memory #d-memory
```

For each topical segment worth remembering, create an episode under the memory
container:

```text
- <episode gist> #d-episode [[chat:<short label>^<source>]]
  - <belief statement> #d-belief [[chat:<short label>^<source>]]
```

When updating an existing belief, keep the belief node's identity and replace or
append concise text so the current statement is clear. If the old wording is
meaningfully changed, add a short child note with the new `[[chat:...]]` source
marker explaining the change.

## Process

1. Parse the run brief's `sources` list.
2. For each source, call `past_chats` with `source` and read the raw span.
3. Segment the evidence into a small number of topical episodes. Skip thin,
   repetitive, operational, or low-confidence material.
4. Use `node_search` for existing `#d-memory`, `#d-episode`, and `#d-belief`
   nodes before writing.
5. Use `node_create` to create the memory container, episodes, and new beliefs.
6. Use `node_edit` to update matching beliefs in place.
7. Keep the final assistant result short: report counts of episodes created,
   beliefs created, beliefs updated, and skipped items. Do not quote raw chat.
