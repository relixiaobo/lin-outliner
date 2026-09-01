# Skill Invocation Input Contract

**Shape:** ONE complete model-facing Skill invocation behavior change in one PR.

## Goal

Make the model omit redundant `args` when loading an ordinary inline Skill while
preserving explicit arguments for parameterized inline Skills and exact task input
for isolated Skills.

## Non-goals

- No rename or removal of the shared `skill` tool `args` field.
- No change to argument substitution, isolated child execution, slash parsing, or
  persisted invocation evidence.
- No renderer suppression of the raw tool arguments the model actually sent.
- No dynamic per-Skill tool schema or new Skill execution mode.

## Design

### One host-derived invocation contract

The bounded Skill catalog remains the model's discovery surface. Each entry gains a
short host-derived invocation contract inside its description:

- inline Skills without declared arguments are load-only and explicitly require the
  model to omit `args`, unless their body contains a supported argument placeholder;
- inline Skills with declared arguments expose their authored `argument-hint`, or
  their ordered argument names when no hint exists; accepted placeholder-only Skills
  receive a generic input hint;
- isolated Skills state that `args` carries the exact user task because the child
  does not inherit the parent conversation.

The contract is generated from parsed `SkillDefinition` state, never duplicated in
individual Skill prose. Contracts that require input are reserved before authored
descriptions, using the same bounded listing mechanism as the existing isolated
execution constraint. Under extreme catalog pressure, repeated load-only contracts
are elided and the tool-level default treats entries without input labels as load-only.
If full input contracts still do not fit, compact labels preserve the three invocation
classes and the isolated fan-out boundary. If names plus minimum labels exceed the
budget, the sorted model-visible catalog retains the longest fitting prefix without
changing the omitted Skills' existing invocation eligibility.

### Conditional tool guidance

The `skill` tool keeps one optional `args` string because the tool serves every
Skill. Its parameter and tool descriptions tell the model to consult the catalog:
omit `args` for load-only Skills, pass only declared variable input for parameterized
inline Skills, and pass the exact user task plus explicit constraints for isolated
Skills. Examples cover all three modes without presenting full-task copying as the
default.

Runtime admission stays tolerant. A stale or mistaken non-empty `args` value is not
rejected, because forcing a retry would add latency and duplicate invocation work.
The raw call remains visible in Trajectory for audit, while existing inline rendering
continues to substitute only authored placeholders.

### Verification

Focused Core tests prove that catalog descriptions distinguish load-only,
parameterized, and isolated Skills; argument hints take precedence over generated
name lists; listing budgets retain every host-derived invocation contract; and the
tool schema/guidance keeps `args` optional while describing its conditional use.

### Acceptance criteria

- The built-in `outline` catalog entry tells the model to invoke without `args`.
- A parameterized inline Skill advertises its expected variable input.
- An isolated Skill tells the parent to pass the exact user task through `args`.
- Catalog pressure cannot silently remove the invocation contract.
- The catalog never exceeds its 8,000-character accounting budget; pressure first uses
  compact contracts and then a deterministic fitting prefix.
- Existing argument substitution, isolated execution, persistence, and raw tool-call
  rendering behavior remain unchanged.

## Open questions

None.

## Implementation checklist

- [ ] Generate and reserve the per-Skill invocation contract in catalog listings.
- [ ] Make the `skill` tool guidance conditional on that catalog contract.
- [ ] Add focused Core coverage for all input modes and bounded listings.
- [ ] Update the current Skill specification and verification evidence.
