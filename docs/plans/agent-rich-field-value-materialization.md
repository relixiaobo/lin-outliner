# Agent Rich Field Value Materialization

Shape: **(a) ONE complete feature in one PR.** The Agent materialization path,
regression coverage, and current specifications land together.

## Goal

Make the first value written through an existing field definition use the same
canonical `RichText` representation that Agent reconciliation uses for later
values. Creating or editing a node with a marked, linked, or inline-reference
field value must produce exactly one stored value while preserving all rich-text
semantics.

## Non-goals

- Do not change field-value identity or collapse intentional duplicate values.
- Do not change `appendText` semantics for renderer, Table, or other callers.
- Do not add a new Core command or shared protocol variant.
- Do not migrate or automatically deduplicate existing document data.
- Do not alter option, options-from-supertag, or whole-value reference behavior.

## Design

`materializeFieldValuesForDefinition` owns the transition from a virtual field
slot to its first stored entry and value. For non-option values that are not
whole-value references, it sends the already-supported `appendNodes` field-slot
mutation with one `CreateNodeTree`. The tree content comes from
`richTextFromOutlineText(outlineValueSource(first))`, which is the same
conversion used by `outlineValueKey` and later rich-text value creation.

Core remains the atomic write boundary: `updateFieldSlot` creates the backing
entry and materializes the supplied rich-text node in one mutation. Option
selection, collected options, options-from-supertag values, and whole-value
references keep their specialized mutation paths.

Reconciliation continues to match full rich-text identity, including marks,
link destinations, and inline-reference targets. It consumes one existing
value per desired value, so two intentionally identical desired values remain
two stored children rather than being deduplicated.

Focused Core tests extend the Agent test host to forward `appendNodes`. A
regression covers a reused plain field definition whose first value combines
inline code, a link, and an inline Node reference; it asserts one stored child
with all semantics preserved. A multiplicity regression covers two identical
desired values and asserts both survive.

Current specifications document `appendNodes` as a slot materialization
operation and state that Agent field creation and reconciliation share canonical
rich-text identity.

Files in scope:

- `src/main/agent/capabilities/agentNodeTools.ts`
- `tests/core/agentNodeTools.test.ts`
- `docs/spec/commands.md`
- `docs/spec/agent-tool-design.md`

The collision self-check found no overlap with open PR #575, whose claim is the
Agent trajectory protocol and workspace.

## Open questions

None. The existing Core `appendNodes` contract provides the required atomic
write without expanding the shared command protocol.

## Verification

- Run the focused `agentNodeTools` Core tests.
- Run typecheck and the full Core test suite.
- Run the documentation checks.
- Run the whitespace error check.
