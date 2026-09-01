# Agent Tool Result Envelope Contract

## Goal

Give built-in and collaboration tools one compact, predictable model-visible result
contract without changing provider-native tool roles or forcing durable internal
details into that visible envelope.

This plan is one complete feature in one PR based on merged PR #610. It is
separate from model-visible Turn context because tool results are machine
exchanges, not dynamic context prose.

## Non-goals

- Do not wrap tool results in `<system-reminder>` or `<context>`.
- Do not change tool definitions, JSON arguments, provider call/result identity,
  or media ordering.
- Do not make every tool family's durable `details` use one storage schema.
- Do not expose diagnostic, audit, recovery, or provider metadata merely for
  visible consistency.
- Do not redesign renderer presentation of completed tools.

## Design

### Product decision

- **OBJ-1:** the model can determine whether any tool succeeded, changed nothing,
  partially completed, was denied, or failed without learning family-specific
  status dialects.
- **CON-1 hard:** provider-native tool-call and tool-result roles remain intact.
- **CON-2 hard:** durable family-owned details remain authoritative for audit,
  replay, rendering, and recovery.
- **CON-3 dependency:** merged PR #610 owns the provider tool-call identity
  boundary. Repeat the collision check before implementation against that final
  contract.
- **DEC-1:** normalization applies only to the model-visible result projection.
- **DEC-2:** `ok` is the only success/failure discriminator. The existing compact
  optional `status` distinguishes unchanged, partial, and denied outcomes when
  needed.
- **DEC-3:** empty fields and synonymous status/message fields are omitted.

### Visible envelope

The shared contract is equivalent to:

```ts
type ModelToolResult<T> =
  | { ok: true; data?: T; status?: 'unchanged' | 'partial'; instructions?: string; warnings?: string[] }
  | { ok: false; status?: 'denied'; error: { code: string; message: string }; instructions?: string; warnings?: string[] };
```

`success` is represented by `ok: true` with no status. `unchanged` and
`partial` remain successful outcomes. `denied` remains unsuccessful but distinct
from execution failure. Tool-specific payload remains under `data` only when the
model needs it for the next decision.

Native media parts follow the JSON result in their existing provider order. Durable
details may contain richer status, recovery, audit, timing, resource, or provider
fields and are not parsed from the visible envelope.

### Before and after

| Block | Before | After | Reason |
| --- | --- | --- | --- |
| Built-in success | `{ "ok": true, "data": { "path": "report.md" } }` | Unchanged | Already matches the target contract. |
| Collaboration success | `{ "success": true, "message": "Message queued for delivery to 0199...", "pin": { "id": "0199...", "name": "0199...", "ref": "0199a001" } }` | `{ "ok": true, "data": { "agentId": "0199...", "delivery": "queued" } }` | One success discriminator and only actionable identity/state. |
| Unchanged result | `{ "ok": true, "status": "no_change", "changed": false }` | `{ "ok": true, "status": "unchanged" }` | Use the existing informative status and remove synonyms. |
| Partial result | Family-specific prose such as `Completed 8 of 10` | `{ "ok": true, "status": "partial", "data": { "completed": 8, "total": 10 } }` | Preserve actionable completeness in a common shape. |
| Denied result | `{ "success": false, "message": "Agent admission is incomplete; messaging is unavailable." }` | `{ "ok": false, "status": "denied", "error": { "code": "agent_admission_incomplete", "message": "Agent admission is incomplete; messaging is unavailable." } }` | Distinguish policy/admission denial from execution failure. |
| Error result | Raw exception text or family-specific error object | `{ "ok": false, "error": { "code": "...", "message": "..." } }` | Predictable error handling without exposing stack or diagnostics. |
| Tool-result media | JSON/prose plus native image parts | Compact envelope followed by the same native image parts | Preserve provider ordering and media semantics. |

### Boundary consistency

| Boundary | Contract |
| --- | --- |
| Tool definition | JSON Schema |
| Tool arguments | JSON |
| Tool result | Compact shared model-visible envelope plus native media |
| Dynamic context | Separate `<system-reminder>` contract; never used here |
| Durable storage/diagnostics | Tool-family-owned typed details |

## Requirements

- **FR-1:** built-in and collaboration tools project through one model-visible
  envelope with `ok`, optional informative status, actionable data, and bounded
  error.
- **FR-2:** success, unchanged, partial, denied, and error have exactly one visible
  representation each.
- **FR-3:** durable internal details remain family-owned and Host-private unless a
  specific field is needed for the model's next action.
- **FR-4:** provider-native tool roles, call/result pairing, and native media order
  remain unchanged.
- **NFR-1:** visible envelopes are bounded, deterministic, and JSON serializable.

## Acceptance criteria

- **AC-1:** fixtures from built-in and collaboration families parse through the
  same visible success, unchanged, partial, denied, and error union.
- **AC-2:** exact output contains no duplicate `success`, `status`, `changed`,
  `reason`, or empty fields when `ok` and the normalized status already express the
  result.
- **AC-3:** durable detail fixtures retain their owning family fields without making
  them required to parse model-visible output.
- **AC-4:** media fixtures preserve the same JSON/media ordering and provider-native
  tool-result role before and after normalization.
- **AC-5:** malformed internal detail degrades through the owning tool's existing
  recovery path and does not leak stack traces or diagnostic payloads.
- **AC-6:** typecheck, focused tool/runtime tests, complete relevant suites, and
  `docs:check` pass; current behavior is folded into `agent-tool-design.md` and
  collaboration runtime specifications.

## Execution

- Start from the merged #610 baseline and repeat the collision check at the
  provider-result boundary.
- Reuse the existing built-in model-visible envelope abstraction as the normal form.
- Add collaboration result adapters without replacing durable collaboration details.
- Test every informative status across both families and preserve native media
  order.
- Update the owning tool and collaboration specifications in the same PR.

Likely implementation areas are `agentToolEnvelope`, collaboration result adapters,
provider projection, and focused tool/runtime fixtures.

## Open questions

None. DEC-1 through DEC-3 preserve the existing built-in visible-envelope language
and extend it to collaboration tools; implementation starts only after PM
ratification.
