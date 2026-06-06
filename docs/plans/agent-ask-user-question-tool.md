---
status: draft
priority: P1
owner: relixiaobo
created: 2026-06-03
updated: 2026-06-03
---

# Agent Ask User Question Tool

Scope: the agent runtime user-interaction contract, the agent composer
interaction surface, and the renderer UI used when an agent needs a decision or
additional user-provided context before continuing.

This is a full product/tool design, not an MVP. It intentionally does **not**
include cc-2.1-style preview single-choice questions.

## Goal

Add a complete `ask_user_question` tool that lets the agent pause for structured
user input, then resume with a structured answer payload.

The tool must support:

- single-choice questions;
- multi-choice questions;
- free-text questions;
- optional "Other" text on choice questions;
- `@` references inside answers, including node references and local-file
  references;
- an attachment button in the answer input, using the same attachment/resource
  pipeline as the main agent composer;
- a "discuss / clarify" path so the user can send feedback instead of finalizing
  the answer immediately.

The tool must be separate from permission approval. Permission approval answers
"may the agent do this?". `ask_user_question` answers "what should the agent do
next / what information should it use?".

## Non-goals

- No preview single-choice UI and no `preview` field in the Tenon tool schema.
- No generic cc-2.1 permission-card reuse as the runtime contract. Tenon should
  not encode user questions as approval requests with updated tool input.
- No change to security defaults or permission policy semantics.
- No committed changes to `docs/TASKS.md` or `CHANGELOG.md` from this dev-agent
  plan. Those remain main-agent-owned.

## Reference: cc-2.1

Reference repo: `/Users/lixiaobo/Coding/.research-repos/cc-2.1`.

Relevant files:

- `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`
- `src/tools/AskUserQuestionTool/prompt.ts`
- `src/components/permissions/PermissionRequest.tsx`
- `src/components/permissions/AskUserQuestionPermissionRequest/*`
- `src/hooks/useCanUseTool.tsx`
- `src/hooks/toolPermission/handlers/interactiveHandler.ts`

cc-2.1 exposes a tool named `AskUserQuestion`.

Input shape:

```ts
{
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
      preview?: string;
    }>;
    multiSelect?: boolean;
  }>;
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
  metadata?: { source?: string };
}
```

Important cc-2.1 behavior:

- `questions` has min 1, max 4.
- each question has 2-4 options.
- question texts must be unique.
- option labels must be unique within one question.
- `shouldDefer: true`, `isReadOnly()`, `isConcurrencySafe()`, and
  `requiresUserInteraction()` are all used.
- `checkPermissions()` returns an `ask` permission request.
- the permission UI writes `answers` and `annotations` back into `updatedInput`;
  `call()` then returns the updated input as the tool result.

cc-2.1 supports these implicit question types:

- normal single choice: `multiSelect` is false and no option has `preview`;
- multi choice: `multiSelect` is true;
- preview single choice: at least one option has `preview`;
- "Other" is automatically available for normal questions, but not for preview
  questions.

cc-2.1 can include pasted images with text in an answer. The visible answer
string may include an image-attached marker, while the actual image travels as a
model image content block. It does not provide a generic file-input contract for
arbitrary files.

## Current Tenon State

### Agent composer states

Tenon currently does not have one explicit `ComposerState` enum. The visible
composer mode is derived from props and local state:

- normal compose/input;
- sending;
- streaming/steering;
- queued steer note;
- pending approval, when `pendingApproval` exists;
- transient UI states such as drag-active, attachment error, menu-open, and local
  file-picker state.

Selecting "allow permission" is **not** a composer state. It is resolution of an
agent permission request. The composer only renders an approval card while a
`pendingApproval` object is present.

Relevant files:

- `src/renderer/ui/agent/AgentComposer.tsx`
- `src/renderer/ui/agent/AgentComposerEditor.tsx`
- `src/renderer/ui/agent/AgentComposerControls.tsx`
- `src/renderer/agent/runtime.ts`
- `src/main/agentRuntime.ts`
- `src/core/agentTypes.ts`
- `src/core/agentEventLog.ts`

### Edit-user-message composer

Editing a user message currently uses a separate textarea-like edit card inside
`AgentMessageRow`, not the main `AgentComposer` / `AgentComposerEditor` stack.
It is visually and behaviorally inconsistent with the main composer and is only
available for text-only user messages without attachments.

Relevant file:

- `src/renderer/ui/agent/AgentMessageRow.tsx`

This plan should reuse or extract shared composer primitives where useful, but
it does not require the historical-message edit surface to become a full
replacement `AgentComposer`. The product boundary must be decided explicitly:
historical user-message editing can either remain text-only, or support the same
structured references and attachments as new input.

## Product Decisions

- Build the complete `ask_user_question` tool, not a minimal version.
- Do not support preview single-choice questions.
- Use `@` references as the primary way to answer with structured context:
  nodes and local files should be structured refs, not plain text markers only.
- Add an attachment icon to the answer input.
- Support file/image attachments as first-class answer payload data.
- Keep user questions separate from approval requests in runtime state and event
  naming.
- Composer state should become explicit enough to represent pending user
  questions cleanly, instead of treating every blocking interaction as approval.

## Design

### 1. Runtime interaction model

Introduce a distinct pending interaction for user questions. Either add
`pendingUserQuestion` alongside `pendingApproval`, or replace both with a
discriminated shape:

```ts
type PendingAgentInteraction =
  | { kind: "approval"; approval: AgentApprovalRequestView }
  | { kind: "user_question"; question: AgentUserQuestionRequestView };
```

The runtime must guarantee only one blocking interaction is active **per run** (not "per
session" — after the program's F2/F5 split, blocking is a property of the executing `Run`,
so parallel runs in one conversation each gate independently; see [[agent-data-model]] /
[[agent-program]] F5). If an approval request and a user question can both be queued within
a run, the queue preserves order and exposes only that run's active item to the renderer.

### 2. Tool contract

Use a snake-case tool name:

```ts
"ask_user_question"
```

Proposed input:

```ts
type AgentUserQuestionKind = "single_choice" | "multi_choice" | "free_text";

interface AskUserQuestionInput {
  questions: AgentUserQuestionInputItem[];
  submitLabel?: string;
}

interface AgentUserQuestionInputItem {
  id: string;
  type: AgentUserQuestionKind;
  header?: string;
  question: string;
  required?: boolean;
  allowOther?: boolean;
  allowReferences?: boolean;
  allowAttachments?: boolean;
  options?: AgentUserQuestionOptionInput[];
}

interface AgentUserQuestionOptionInput {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}
```

Validation:

- `questions.length` should be 1-4.
- `id` values must be stable and unique within the request.
- `single_choice` and `multi_choice` require 2-6 options.
- `free_text` must not require options.
- no `preview` field is accepted.
- `allowOther` only applies to choice questions.
- `allowReferences` and `allowAttachments` default to true for `free_text`, and
  false for choice-only questions unless explicitly enabled.

### 3. Answer contract

The result should be structured by question id, not keyed by question text:

```ts
interface AskUserQuestionResult {
  requestId: string;
  answers: AgentUserQuestionAnswer[];
}

interface AgentUserQuestionAnswer {
  questionId: string;
  selectedOptionIds?: string[];
  text?: string;
  notes?: string;
  nodeRefs?: AgentComposerNodeReference[];
  fileRefs?: AgentComposerFileReference[];
  attachments?: AgentComposerAttachment[];
}
```

Choice questions use `selectedOptionIds`. The "Other" value, additional notes,
and free-text answers use `text` / `notes`. Structured references and attachments
travel in dedicated arrays so the model and local tools can see both the
human-readable answer and the referenced resources.

### 4. UI surface

Render pending user questions as an expanded interaction surface near the bottom
of the agent panel, anchored to the composer area but allowed to grow taller than
the normal single-line composer.

Required UI behavior:

- show 1-4 questions in order;
- single choice uses radio-style selection;
- multi choice uses checkbox-style selection;
- free text uses the shared rich composer editor primitives;
- per-question required validation blocks submit until satisfied;
- optional "Other" opens an answer field with references/attachments when
  allowed;
- attachment button is visible in answer inputs where `allowAttachments` is true;
- `@` trigger is available where `allowReferences` is true;
- user can submit the final structured answer;
- user can cancel/decline if the runtime supports cancellation;
- user can send a clarification message back to the agent without finalizing the
  question.

The clarification path should be modeled separately from final answer
submission. It can become a normal user steering message that keeps the pending
question open, or a dedicated `feedback` action on the pending question. The
implementation should choose one contract deliberately and document it in
`docs/spec/`.

### 5. Composer state cleanup

Introduce explicit renderer-level interaction modes around the composer:

```ts
type AgentComposerMode =
  | "compose"
  | "sending"
  | "steering"
  | "queued_steer"
  | "pending_approval"
  | "pending_user_question";
```

Keep drag-active, attachment error, file picker, and menus as transient UI state,
not primary composer modes.

`pending_approval` and `pending_user_question` should be mutually exclusive in
the rendered composer. Both may share chrome primitives, but their actions and
payloads must remain separate.

### 6. References and attachments

The answer input should reuse the main composer reference model:

- node references from `@node` should remain structured node refs;
- local file references from `@file` / local-file aliases should remain
  structured local-file refs;
- picker and paste attachments should flow through the same composer attachment
  pipeline;
- images should support both model-visible image content and file/resource
  visibility where the composer attachment path model provides it;
- arbitrary local files should be addressable through local-file refs rather
  than serialized into plain answer text.

This plan depends on, or should coordinate with, the path-first attachment work
in `docs/plans/agent-composer-attachment-path-model.md`.

### 7. Event log and persistence

Add user-question request and resolution events instead of overloading approval
events.

Candidate events:

```ts
type AgentEvent =
  | { kind: "user_question_requested"; request: AgentUserQuestionRequestView }
  | { kind: "user_question_answered"; requestId: string; result: AskUserQuestionResult }
  | { kind: "user_question_cancelled"; requestId: string; reason?: string };
```

The implementation must decide whether pending user questions survive app
restart. If they do, event replay must restore the unresolved request and keep
attachment/resource references valid. If they do not, restart behavior must
write a terminal cancellation event or otherwise unblock the runtime.

### 8. Edit-user-message alignment

Extract shared visual/editor primitives so the main composer, ask-user-question
answer fields, and user-message edit card do not drift further apart.

Minimum alignment:

- consistent radius, border, focus ring, typography, and toolbar placement;
- consistent disabled/sending/validation states;
- consistent attachment-chip styling where attachments are supported.

Open product decision:

- keep historical user-message editing text-only for now; or
- allow editing user messages with references and attachments using the same
  draft model as the main composer.

This decision should be made before implementation if the ask-user-question work
touches `AgentMessageRow.tsx`.

## Files In Scope

Likely protocol/runtime files:

- `src/core/agentTypes.ts`
- `src/core/agentEventLog.ts`
- `src/main/agentRuntime.ts`
- `src/main/agentTools.ts`
- `src/main/agentToolEnvelope.ts`
- `src/preload/index.ts`
- `src/renderer/api/client.ts`
- `src/renderer/agent/runtime.ts`

Likely UI files:

- `src/renderer/ui/agent/AgentComposer.tsx`
- `src/renderer/ui/agent/AgentComposerEditor.tsx`
- `src/renderer/ui/agent/AgentComposerControls.tsx`
- `src/renderer/ui/agent/AgentMessageRow.tsx`
- `src/renderer/styles/agent-composer.css`
- related agent-message styles if the edit surface is aligned

Spec files to update in the implementation PR:

- `docs/spec/agent-tool-design.md`
- `docs/spec/agent-pi-mono-implementation.md`
- any existing permissions/runtime spec that describes approval request flow

## Collision Self-check

Result from the planning pass:

- no open GitHub PR claim was returned by `gh pr list --limit 30`;
- `docs/plans/agent-composer-attachment-path-model.md` overlaps on
  `AgentComposer.tsx`, `AgentComposerEditor.tsx`, attachment conversion, and
  local-file reference semantics;
- `docs/plans/agent-empty-state-onboarding.md` overlaps lightly on
  `AgentComposer.tsx` send-guard/composer rendering;
- `docs/plans/outliner-local-file-references.md` is present as an untracked plan
  in this clone and overlaps conceptually on local-file reference behavior.

Implementation should coordinate with or land after the path-first attachment
model work. If both plans proceed in parallel, land the shared composer draft /
reference model first, then build the user-question UI on top of it.

## Risks

- This touches core protocol and renderer runtime state; it is plan-track work
  and should not be batched with unrelated UI polish.
- Encoding questions as approval requests would be faster but would make the
  product model wrong. Avoid that shortcut.
- Attachment support creates persistence and restart edge cases if unresolved
  questions survive across app relaunch.
- Multi-question validation and clarification flow can race with runtime abort or
  new-turn steering unless the pending interaction lifecycle is explicit.
- Historical user-message editing may expand the scope if it is upgraded to
  support attachments and references.

## Open Questions

- Should unresolved user questions persist across app restart, or be cancelled on
  restart?
- Should cancellation be exposed to the user, or should the user always answer /
  clarify?
- Should partial answers be allowed when only some questions are marked
  `required`?
- Should the max question count match cc-2.1 at 4, or should Tenon choose a
  different cap?
- Should historical user-message editing remain text-only in this phase?
- Should clarification be represented as a normal steering message, or as a
  dedicated user-question feedback action?

## Checklist

- [ ] Finalize the protocol shape and update core types.
- [ ] Add the `ask_user_question` tool definition and validation.
- [ ] Add runtime request, answer, cancel, and optional feedback handling.
- [ ] Add event-log support and restart semantics.
- [ ] Add renderer pending-interaction state.
- [ ] Add the user-question UI surface.
- [ ] Reuse composer editor primitives for answer fields.
- [ ] Wire `@` references and attachment button into answer inputs.
- [ ] Align or explicitly defer user-message edit composer consistency.
- [ ] Update `docs/spec/` with the shipped behavior.
- [ ] Run `bun run typecheck` and relevant renderer/runtime tests.
- [ ] Run light/dark visual verification for the pending-question UI.

## Integration notes (added at the merge gate, 2026-06-03)

Added by the main agent when landing this as a backlog artifact, to reconcile the
plan with `main` as it stands. These do not change the design above; fold them in
when the build is scheduled.

- **OpenAI function-schema constraint (lesson from PR #90).** The `questions[].type`
  discriminator and the conditional rules (`options` required for choice types,
  forbidden for `free_text`; `allowOther` only for choice) MUST NOT be encoded as a
  top-level `oneOf`/`anyOf`/`allOf`/`enum`/`not` in the tool's JSON schema — OpenAI's
  function-schema validation rejects those at the root (it 400s). Keep the schema
  permissive at the top level (one object with a `questions` array) and enforce the
  per-type shape at runtime in `normalize*`-style helpers, mirroring the node tools'
  fix in `agentNodeToolSchemas.ts`. Nested `anyOf`/`enum` inside property subschemas
  is fine.
- **Collision section is now stale (resolved dependencies).**
  `agent-composer-attachment-path-model.md` (PR #86) and
  `outliner-local-file-references.md` are both **merged + archived (`done`)** — the
  stated "land after the path-first attachment work" precondition is already
  satisfied, so the answer-input refs/attachments can build directly on the shipped
  path model. Also, "Files In Scope" lists `src/renderer/styles/agent-composer.css`,
  but PR #89 moved inline-mention rendering out of it into `inline-ref.css` (the
  `.agent-composer-inline-file*` chip classes were deleted); rebase the file scope
  onto post-#86/#89 `main`.
- **Security (A3).** File/image refs carried back in an answer payload must flow
  through the same `realpath`-based local-root jail PR #86 added (out-of-root reject,
  size cap, TTL pruning). State explicitly that the jail applies to answer
  attachments — `ask_user_question` must not become a read sink that bypasses it.

## Directional decisions outstanding (PM GO before build)

Deferred at the PM's instruction; resolve at build kickoff, not now:

- Do unresolved questions persist across app restart (event replay restores the
  pending request + valid attachment refs), or are they cancelled on restart?
- Does historical user-message editing stay text-only this phase (keeps
  `AgentMessageRow.tsx` out of scope), or gain refs/attachments?
- Is "clarify / discuss" a normal steering message that keeps the question open, or
  a dedicated `feedback` action on the pending question?

Recommended build sequencing (WIP discipline / shared-interface-first): (1) protocol
+ tool + event-log contract as an interface-first PR; (2) renderer pending-interaction
state + base UI; (3) refs/attachments in answers; (4) composer-state cleanup +
edit-message alignment.
