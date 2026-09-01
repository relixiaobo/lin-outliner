# Agent Tool Result Protocol

## Goal

Give every Tenon-owned model tool one enforced semantic result protocol so the
model can determine whether the requested operation succeeded, changed nothing,
partially completed, was denied, or failed without learning tool-specific result
dialects.

The protocol separates compact decision data from large text, native media, and
Host-private details. A new internal tool cannot bypass the contract by directly
constructing arbitrary provider content.

This plan is ONE complete feature in one PR. The internal protocol, Kernel
projection, all 22 current Tenon-owned tools, persistence behavior, specifications,
and guards ship together; none is a separately releasable groundwork slice.

## Non-goals

- Do not wrap tool results in the `system-reminder` element or dynamic context
  prose.
- Do not change tool definitions, input arguments, provider call/result identity,
  tool ordering, execution scheduling, or native media ordering.
- Do not impose Tenon's result schema on successful owner-native MCP, extension,
  plugin, or other external dynamic-tool results.
- Do not make family-owned durable details use one storage schema.
- Do not expose audit, recovery, metrics, paths, provider metadata, or renderer
  state merely to make visible results look uniform.
- Do not redesign completed-tool UI, delegated settlement, direct-parent
  notification truth, generation receipts, or Agent status presentation.
- Do not standardize transient execution-progress updates as final model results.

## Design

### Objective, constraints, and selected target

- **OBJ-1:** one result grammar covers every Tenon-owned tool and every
  Host-generated rejection or execution failure.
- **Minimum acceptable outcome:** no Tenon-owned tool returns naked JSON, raw
  status prose, or a family-specific success discriminator to the model.
- **Clean-slate best answer:** tools return semantic outcome, actionable data,
  supplemental content, and private details; the Kernel alone compiles provider
  content.
- **Selected target:** implement that clean model behind the current provider
  transport, preserving existing durable Item families and external-tool payloads.

### Decision

- **DEC-1:** every Tenon-owned tool returns semantic result state; the Kernel is
  the only owner that compiles it into provider-visible content.
- **DEC-2:** `ok` is the only visible success/failure discriminator. Optional
  `status` adds only `unchanged`, `partial`, or `denied` meaning.
- **DEC-3:** duplicate and empty success, status, message, reason, and changed
  fields are omitted.
- **DEC-4:** external successful and owner-returned-error results remain native;
  Tenon standardizes only failures created by its own Kernel.
- **DEC-5:** large text and native media follow one compact JSON header as separate
  ordered content parts.
- **DEC-6:** documented durability transforms may replace ephemeral path/image
  facts, but history never reparses output to normalize its structure.

Constraints:

- **CON-1 hard:** provider-native tool-call and tool-result roles, IDs, pairing,
  and content-part ordering remain intact.
- **CON-2 hard:** family-owned details remain authoritative for rendering, audit,
  recovery, and diagnostics, but never regenerate or override visible outcome.
- **CON-3 hard:** runtime-path and artifact substitutions may create a distinct
  durable text projection. They may change documented ephemeral fields only; they
  cannot perform a second structural result normalization.
- **CON-4 hard:** malformed internal results and unexpected execution failures
  degrade to bounded tool errors rather than failing the Turn projection path.
- **CON-5 dependency:** merged PRs #610 and #612 define provider identity and
  Continue/Rerun behavior. PR #614 owns delegated generation and presentation
  truth and currently overlaps shared Agent specifications and Core protocol
  surfaces, not result construction. Rebase onto its merged result before build.

Rejected alternatives:

- **OPT-1 rejected:** add adapters only to `agent` and `agent_message`. This leaves
  naked Core results and permits future tools to recreate the inconsistency.
- **OPT-2 rejected:** normalize arbitrary `content` later in history or context
  projection. That requires parsing tool prose and creates multiple owners.
- **OPT-3 rejected:** wrap external successful results in the Tenon schema. Tenon
  does not own their payload semantics and could destroy information.

### Evidence

- The current `AgentToolResult` permits any tool to construct arbitrary `content`
  and `details`; registration does not encode result ownership.
- Ten local, Web, and image capability tools already use the compact visible
  envelope, while Core control, Automation, and collaboration tools still return
  naked JSON or prose.
- `task_stop` proves the split can occur inside one tool: its shell branch uses the
  envelope and its Agent branch returns family-specific JSON.
- The Kernel currently turns unknown tools, invalid arguments, aborts, and thrown
  exceptions into raw text, then copies final `content` directly into the provider
  result.
- Persistence intentionally parses a bounded set of built-in JSON results to remove
  ephemeral artifact paths and stabilize generated-image guidance.

### Ownership boundary

`MODEL_TOOL_CATALOG` is the authoritative Tenon-owned set. Its current 22 tools
must return the semantic result form. Registration APIs make that requirement a
type-level distinction from owner-native external tools.

MCP, extension, plugin, and other external dynamic tools retain their native
successful content and returned error payloads. When Tenon's Kernel itself rejects
or cannot execute any tool call, Tenon owns that failure and emits the common
bounded error form regardless of tool origin.

### Internal result model

The semantic contract is equivalent to:

```ts
type ToolOutcome =
  | { ok: true; status?: 'unchanged' | 'partial' }
  | {
      ok: false;
      status?: 'denied';
      error: { code: string; message: string };
    };

interface TenonToolResult {
  kind: 'tenon';
  outcome: ToolOutcome;
  data?: JsonValue;
  instructions?: string;
  warnings?: readonly string[];
  content?: readonly (TextContent | ImageContent)[];
  details: unknown;
  resourceRefs?: readonly ThreadResourceReference[];
  persistedTextReplacements?: readonly AgentToolTextReplacement[];
  terminate?: boolean;
}

interface NativeToolResult {
  kind: 'native';
  content: readonly (TextContent | ImageContent)[];
  details: unknown;
  resourceRefs?: readonly ThreadResourceReference[];
  terminate?: boolean;
}
```

This shape is behavioral, not a commitment to the exact TypeScript names above.
The implementation must nevertheless preserve the discriminated ownership and
prevent a Tenon-owned registration from returning `kind: 'native'`.

Rules:

- `ok` is the only visible success/failure discriminator.
- `status` appears only when it adds `unchanged`, `partial`, or `denied` meaning.
- `data` contains only bounded information needed for the model's next decision.
- `instructions` are tool-owned next-step guidance, not application-authority
  dynamic-context instructions.
- `warnings` report bounded non-fatal omissions or degradation.
- `content` contains supplemental document/report text or native media, never a
  second success/error header. Bounded text whose field identity is actionable,
  such as `stdout` versus `stderr`, may remain in `data`.
- `details` remain Host-private and family-owned. They may retain richer or
  historically duplicated fields but cannot be parsed to recreate visible output.
- `outputSchema` on each Tenon-owned `ModelToolContract` explicitly contains a
  schema or `null`. A schema describes visible `data`; `null` declares that the
  tool returns no data. Result construction validates this contract and degrades an
  invalid internal result to a bounded implementation error.

### Result flow and single projection boundary

The Kernel compiles a Tenon result once:

1. Serialize one deterministic compact JSON header from `outcome`, `data`,
   `instructions`, and `warnings`, omitting empty fields in stable key order.
2. Append supplemental text or image parts in their original order.
3. Copy Host-private details and lifecycle fields without exposing them.
4. Deliver the compiled native provider `ToolResultMessage`.

For example, a foreground Agent result is not JSON-escaped into `data`:

```text
Part 1: {"ok":true,"data":{"agentId":"{{agentId}}"}}
Part 2: {{boundedAgentMarkdownReport}}
```

Generated images follow the same rule: compact JSON first, then existing native
image parts. A tool with no supplemental content has only the JSON part.

The live compiled content is the only structural projection. Persistence may
remove or replace documented ephemeral artifact paths and may replace live image
instructions with durable equivalents. Restart and Continue reuse the persisted
content bytes; Rerun executes the tool again and may produce a new result.

### Result-state rules

| State | Visible header | Provider `isError` |
| --- | --- | --- |
| Success | `{"ok":true,"data":{{actionableData}}}` | `false` |
| Unchanged | `{"ok":true,"status":"unchanged"}` | `false` |
| Partial usable result | `{"ok":true,"status":"partial","data":{{availableData}},"warnings":[...]}` | `false` |
| Expected denial | `{"ok":false,"status":"denied","error":{"code":"{{stableCode}}","message":"{{boundedMessage}}"}}` | `false` |
| Expected tool failure | `{"ok":false,"error":{"code":"{{stableCode}}","message":"{{boundedMessage}}"}}` | `false` |
| Kernel rejection, abort, or exception | Same bounded error header | `true` |

A failed operation may still attach safe partial data or supplemental content when
the model can use it; the error remains the outcome authority. Internal stack,
audit, and diagnostic payloads never enter the visible header.

### Complete Tenon-owned tool inventory

| Tools | Current model-visible result | Target result |
| --- | --- | --- |
| `file_read` | Standard visible envelope with text in JSON and native images | Emit compact metadata in `data`; move document text to supplemental content and preserve image order. |
| `file_glob` | Standard envelope with filenames | Preserve visible data in the compact header; construct semantic result. |
| `file_grep` | Standard envelope with matches | Preserve mode-specific visible data in the compact header; construct semantic result. |
| `file_edit` | Standard envelope with path and patch | Preserve visible data in the compact header; construct semantic result. |
| `file_write` | Standard envelope with path and patch | Preserve visible data in the compact header; construct semantic result. |
| `file_delete` | Standard envelope with trash target and kind | Preserve visible data in the compact header; construct semantic result. |
| `bash` | Standard envelope with output and background state | Preserve visible meaning and durable path replacement; construct semantic result. |
| `web_search` | Standard envelope with bounded results | Preserve visible data in the compact header; construct semantic result. |
| `web_fetch` | Standard envelope plus fetched text or optional resource | Emit compact metadata in `data`; use supplemental text when content is document-like; preserve resources and durability transforms. |
| `generate_image` | Standard envelope plus native images | Preserve visible meaning and media order; construct semantic result. |
| `skill` | Envelope whose `data` repeats `success` and may embed isolated output | Remove duplicate `success`; emit mode/identity as data and isolated long output as supplemental text. |
| `agent` | Background launch prose or foreground handoff prose | Emit compact Agent identity/state header; append foreground handoff as supplemental text. |
| `agent_message` | Family JSON using `success`, `message`, `pin`, and `resumedAgentId` | Emit `ok` plus one `agentId` and `delivery` state; use stable denied errors. |
| `task_stop` | Shell branch uses envelope; Agent branch returns `message/task_id/task_type/command` | Both branches emit `ok` plus `taskId`, `taskType`, and final state. |
| `thread_search` | Naked `results/untrusted/instructions` JSON | Emit `ok`, bounded results under `data`, and guidance under `instructions`. |
| `thread_read` | Naked bounded Thread page | Emit `ok` and the page under `data`; retain untrusted-content treatment. |
| `automation_update` | Create/update/view/delete return different naked response shapes | Emit `ok` and mode-appropriate automation data under one contract. |
| `request_user_input` | Returns answers plus internal Thread/Turn/Item correlation IDs | Emit `ok`, answers, and auto-resolution fact; keep correlation IDs private. |
| `update_plan` | Repeats the complete input plan | Emit `{"ok":true}` because arguments already contain the accepted state. |
| `get_goal` | Naked `{ goal }` | Emit `ok` and goal under `data`. |
| `create_goal` | Naked `{ goal }` | Emit `ok` and goal under `data`. |
| `update_goal` | Naked `{ goal }` | Emit `ok` and goal under `data`. |

### Kernel-owned failures

Unknown tool, invalid arguments, capability or policy refusal, cancellation, and
unexpected execution exceptions use stable codes and bounded messages. The Kernel
does not expose raw exception strings without secret redaction and classification.
At minimum, fixtures cover `tool_not_exposed`, `invalid_arguments`, `denied`,
`aborted`, `operation_unavailable`, `invalid_internal_result`, and
`execution_failed`.

Capability audit, policy reason, recovery metadata, and stack information remain in
Host-private details or diagnostics. Expected returned failures remain ordinary
completed tool results; only Kernel-owned rejection or execution failure sets
provider-native `isError: true`.

## Requirements

- **FR-1:** all current and future `MODEL_TOOL_CATALOG` entries use the semantic
  Tenon result form and cannot register an owner-native result implementation.
- **FR-2:** the Kernel is the only structural model-visible projection owner for
  Tenon results.
- **FR-3:** every Tenon result exposes exactly one success/failure discriminator
  and at most one informative status.
- **FR-4:** document/report text and native media use supplemental content parts
  after the compact JSON header; bounded text with meaningful field identity may
  remain in `data`.
- **FR-5:** every Tenon-owned contract validates the bounded visible `data` shape.
- **FR-6:** external owner-native results remain byte- and order-preserving unless
  Tenon's Kernel owns the rejection or execution failure.
- **FR-7:** family details, resources, termination, capability audit, and durable
  path replacement retain their current Host behavior without becoming visible.
- **FR-8:** persisted content is never reparsed to perform structural
  normalization; restart and Continue reuse it, while Rerun executes anew.
- **NFR-1:** header serialization is deterministic, bounded, compact, JSON-safe,
  secret-redacted, and provider-neutral.
- **NFR-2:** malformed result state degrades locally and does not kill the Turn.

## Acceptance criteria

- **AC-1 (FR-1):** an exhaustive catalog test accounts for all 22 current tools;
  adding a catalog entry without result ownership and output-data validation fails.
- **AC-2 (FR-2, FR-3):** no Tenon-owned execution path bypasses the semantic builder
  by returning provider result content directly, and exact fixtures contain no
  duplicate `success`, `changed`, `reason`, status prose, or empty fields.
- **AC-3 (FR-4):** foreground Agent, isolated Skill, file, Web, and generated-image
  fixtures preserve large text/media bytes and ordering after one compact header.
- **AC-4 (FR-5):** valid data passes each contract; invalid internal data produces
  `invalid_internal_result`, records diagnostics, and lets the Turn continue.
- **AC-5 (FR-6):** successful and owner-returned-error MCP/extension fixtures are
  unchanged; unknown, invalid, aborted, and throwing external calls receive only
  the Kernel-owned common error.
- **AC-6 (FR-7):** raw durable details and renderer projections remain equivalent;
  capability audit and internal paths are absent from model-visible headers.
- **AC-7 (FR-8):** live and durable fixtures differ only by documented path/image
  durability transforms; restart and Continue reuse durable bytes without another
  normalization pass; Rerun records a newly executed result.
- **AC-8 (NFR-1, NFR-2):** size, secret-redaction, malformed-result, and exception
  fixtures prove bounded degradation and deterministic output.
- **AC-9:** typecheck, focused Core/runtime/capability tests, complete relevant
  suites, and `docs:check` pass; current behavior is folded into
  `agent-tool-design.md`, `agent-model-runtime.md`, and collaboration specifications.

## Implementation suggestions

- Make result ownership a discriminant in `kernel/types`; split transient update
  payload typing if reusing the final-result type would weaken the invariant.
- Replace `agentToolEnvelope` with one semantic builder and one Kernel compiler;
  prohibit JSON serialization in individual Tenon tool implementations.
- Populate `ModelToolContract.outputSchema` for every Tenon-owned tool and enforce
  it at result construction without adding a renderer or history validator.
- Migrate Core control tools in `ToolRuntime`, collaboration results in
  `SubagentCollaboration`, Automation, Skills, local/Web/image capabilities, and
  Kernel-owned error paths in one build-ordered PR.
- Preserve `agentToolResultPersistence` as the narrowly documented durability
  transform, then persist the exact resulting content rather than rebuilding it
  from details.
- Add guard tests over `MODEL_TOOL_CATALOG` and source-level factory ownership so
  future tools cannot bypass the protocol.

Likely implementation areas are `core/agent/tools`, `kernel/types`, `kernel`,
`ToolRuntime`, `agentToolEnvelope`, `agentToolResultPersistence`,
`SubagentCollaboration`, `AutomationTool`, local/Web/image/Skill tools,
`PiTurnExecutor`, and focused Core/runtime/renderer fixtures. Shared specifications
must be rebased after #614 before edits begin.

## Open questions

None. The ownership boundary, semantic states, content ordering, durability
exception, external-tool behavior, and complete internal-tool inventory are the
proposed PM decisions.

## Implementation checklist

- [ ] Introduce the discriminated result ownership and Kernel compiler (FR-1 to FR-4).
- [ ] Add output-data schemas and migrate all 22 catalog tools (FR-1, FR-5).
- [ ] Normalize Kernel-owned rejection, abort, and exception paths (FR-3, NFR-2).
- [ ] Preserve external-native and durable lifecycle behavior (FR-6 to FR-8).
- [ ] Add exhaustive guards, lifecycle fixtures, and owning spec updates (AC-1 to AC-9).
