---
status: done
---

# Agent tool result trim — strip model-visible redundancy

> **Shipped** in PR #128. Design folded into
> `docs/spec/agent-tool-design.md` § *Model-visible redundancy rule*
> (the shared `modelVisibleEnvelope` projector). This plan is kept as history.

## Goal

The model-visible result of every agent tool (the JSON in `content[0].text`)
should carry **only information the model cannot cheaply derive** from its own
call plus the rest of the payload. Today many tools echo their own identity,
emit derivable discriminants/counts, or carry a second status vocabulary. Strip
all of it in one sweep. The full runtime envelope stays intact in `details` (UI /
telemetry); only the model-facing projection shrinks.

## Non-goals

- No change to the runtime `ToolEnvelope` stored in `details`, the `isToolEnvelope`
  guard, or `afterToolCall` — those keep every field.
- Not unifying the two node-id inline formats (`%%node:id%%` edit handle vs
  `[[node:Label^id]]` citation) or fixing the `%%node:node:…%%` double prefix —
  separate, larger protocol change (backlog).
- Not touching the renderer: `AgentToolCallBlock` treats visible `content.text`
  as opaque JSON (pretty-print) and reads structured state from `details`, so it
  is unaffected.

## The redundancy rubric

A model-visible field is **redundant** (cut it) when it is:

1. **Echoed identity** — `tool` (the model knows which tool it called).
2. **Derivable discriminant** — a `kind`/`action`/`mode`/`type` implied by the
   tool name + the args the model itself passed (`count:true`, `preview_only`,
   the chosen action variant), or by the payload's own shape.
3. **Double status** — an envelope `status` plus a `data.status` encoding the
   same state in two vocabularies; or `status:'success'`/`'error'` that merely
   restates `ok` + `error`.
4. **Derivable count** — a number equal to the length of an array already in the
   payload (`returned_items == items.length`).
5. **Cross-field / intra-object duplication** — the same id/path/string in
   multiple fields, or a pure reformat of fields already present.

Otherwise the field is **load-bearing** — keep it.

## Design — the cut list

### Shared envelope (`modelVisibleEnvelope`, `nodeVisibleEnvelope`)

- Drop `tool` (#1).
- Emit `status` **only when it is not `success` or `error`** (#3). `ok` carries
  success; `ok:false` + `error` carries failure; the informative states that
  remain are `unchanged` / `partial` / `denied`.
- Project the visible `error` to `{ code, message }` — drop `recoverable`
  (hardcoded `true`, #5/constant).

### Node tools (`agentNodeToolVisibility.ts`, `agentNodeToolTypes.ts`)

- Drop `data.kind` from every result (#2). Refactor `nodeInstructions` to branch
  on `envelope.tool` (+ payload shape for search-vs-count) instead of `data.kind`.
- Mutations: drop `data.status` (#3). Drop `data.action` for **create** and
  **delete** (#2); **keep** it for **edit** (it summarizes a non-obvious
  created/moved/trashed mix). Keep `changes` (the categorized ledger) and
  `outline`.
- Add `FINAL_ANSWER_NODE_REFERENCE_GUIDANCE` to the **create** and **edit**
  instructions so the model knows how to cite a just-written node
  (`[[node:Title^id]]` / `[[node:^id]]`, id taken from the outline marker). No
  `references[]` added to mutations — the outline already carries id + title +
  edit handle, so a reference array would re-introduce duplication.

### Local tools (`agentLocalTools.ts`)

- **`file_read` projection leak (biggest fix):** text / notebook / pdf /
  `file_unchanged` paths currently return with **no** `modelData`, leaking the
  full `FileReadData`. Only the image path projects. Apply a visible projection
  to all paths.
  - Drop `type` (#2, every shape), `file.numLines` (#4), `file.totalCells` (#4),
    pdf `file.count` (#4), pdf `file.outputDir` (#5 internal temp dir), pdf
    `file.extractedText.chars` (#4). De-dup notebook `content` vs `cells`.
- **`file_edit`:** drop `replaceAll` (#1 arg echo) and `userModified` (constant
  `false`, #5).
- **`task_stop`:** drop `task_id` (#1 echo of the sole arg) and `data.status`
  (#3, constant `stopped` beside envelope status).
- **`file_grep`:** drop `mode` (#2 — payload shape already discriminates).
- `file_glob` / `file_write` / `bash` already project tightly — no cuts beyond
  the shared envelope.

### past_chats (`agentPastChatsTool.ts`, `visiblePastChatsResult`)

- Drop `returned_items` (recent), `returned_hits` (search), `message_count`
  (read) — all #4 array-length dupes (the standing `past-chats-output-polish`
  backlog item).
- Drop `anchor_message_id` (read, #1 echo of the `message_id` arg).
- Drop `mode` in all four shapes (#2).
- Error mode: drop `data.code` + `data.message` (#3/#5 dup of envelope
  `error.{code,message}`); keep `nearby_message_ids` + the rest.

### Subagent / skills

- Subagent (`Agent`/`AgentStatus`/`AgentSend`/`AgentStop`): `data` already lean;
  the shared envelope fix removes its always-`success` envelope status (its real
  state is `data.status`).
- Skills: the model sees plain text, not an envelope — out of scope.

### Deliberately kept (borderline, not chased)

`web_fetch` read-mode `truncated`, `bash` `interrupted`, `file_write` empty
`structuredPatch` on create, `operation_history` top-level `action`, past_chats
`truncated` — derivable but the explicit flag is clearer; not worth the diff.

## Files

- `src/main/agentToolEnvelope.ts` — `modelVisibleEnvelope`, visible error.
- `src/main/agentNodeToolVisibility.ts`, `src/main/agentNodeToolTypes.ts`.
- `src/main/agentLocalTools.ts`.
- `src/main/agentPastChatsTool.ts`.
- `docs/spec/agent-tool-design.md` — visible-envelope section (A6, same change).
- Tests: `tests/core/agentNodeTools.test.ts`, plus local / past_chats / web specs
  that assert dropped fields.

## Risks

- Model-visible is a protocol surface, but pre-launch needs no back-compat, and
  `details` keeps the full envelope for any code consumer.
- `nodeInstructions` refactor must preserve every existing guidance string —
  covered by `agentNodeTools.test.ts`.
- Collision: none. PR #126/#125 are renderer CSS only.
