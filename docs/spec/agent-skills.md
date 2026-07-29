# Agent Skills

A Skill is a local `SKILL.md` instruction bundle selected by Thread
configuration. Skills add reusable procedural guidance; they do not create a new
execution entity or capability authority.

## Sources And Identity

Skill discovery uses this precedence:

1. immutable code-registered or packaged built-ins
2. project Skills under `.agents/skills/`
3. user Skills under the configured user root
4. explicitly configured additional Skill directories
5. dynamically discovered nested Skill directories

Canonical identity is the directory name. A loaded Skill records source,
resolved file identity, content hash, metadata, and resource root. Symlinked
paths that resolve to the same file are deduplicated.

Built-in identities are display-safe pseudo paths and are never presented as mutable
Skill definitions. A resource-backed built-in may separately expose its normalized
bundle directory as a live read locator. Mutable Skills resolve to their real
`SKILL.md` files.

## Format

YAML frontmatter may define description, usage guidance, allowed tools,
arguments, model, effort, path conditions, and execution mode. The Markdown body
contains the instructions. Resource references resolve from the Skill directory.

Execution mode is `inline` or `isolated`:

- `inline` loads instructions into the current Turn.
- `isolated` creates a child Thread with a bounded tool catalog and returns its
  terminal output to the parent Item.

Inline Skills are side-effect-free instructions. `allowed-tools`, `model`, `effort`,
`shell`, and embedded shell expansion are valid only with `execution: isolated`;
file-tool authoring and runtime loading both reject an inline declaration or body
containing any execution override. Invalid content fails instead of silently changing
mode or partially applying metadata.

## Discovery And Invocation

Every ordinary start or steering admission refreshes the current Skill registry and
builds one deterministic bounded snapshot. The canonical reducer compares it with the
Thread journal and records:

- one complete `skillCatalog` baseline for the first model-visible Turn in an epoch;
- no Item and no provider tokens when the catalog hash is unchanged; or
- one delta containing only added, changed, and removed entries, chained to the
  previous catalog hash.

Registry results are filtered through the Turn-stable Configuration Profile or Role
Skill ceiling before cataloging or invocation. `*` keeps every discovered Skill,
an explicit name list is an allow-list, and an empty list disables all Skills. The same
filter applies to catalog evidence, composer slash choices, direct slash admission, and
the model `skill` tool.

Catalog evidence is appended at the current user tail, never interpolated into the
stable system prompt, so a new or changed Skill preserves every previously exposed
provider byte. Refresh preserves activated path-conditional Skills and dynamically
discovered nested Skill directories. A Skill created through file tools can append a
delta before the next provider request in the same Turn; a Skill added or edited
outside Tenon appears on the next accepted input in an existing Thread.

The runtime acknowledges a pending refresh checkpoint only after the canonical catalog
Item is published. A failed publication therefore remains retryable, and a concurrent
later refresh cannot be consumed by an older snapshot.

The `skill` model tool invokes a selected Skill. User-invocable inline Skills may also
be resolved from direct slash input. An isolated slash Skill remains ordinary user
input until the model invokes it through the canonical `skill` tool. Both paths publish typed `skillInvocation`
evidence before instructions can affect the model. Direct invocation evidence is
admitted before the unchanged canonical `userMessage`; model invocation evidence is
durable after the complete Skill tool Item and before the next provider request.

An invocation snapshots canonical identity, content hash, exact rendered instructions,
arguments, source, execution mode, resource root, constraints, invocation source, and
time. Inline instructions project as application guidance; isolated instructions remain
child-only while the parent receives identity, constraints, and the tool result for
audit. There is no prompt overlay, private steering queue, or text parser. Restart
replays the same payload bytes from canonical Items. A later invocation of the same
canonical name is authoritative from that point forward without deleting or rebinding
older evidence.

`resourceRoot` is deliberately a live Skill-bundle locator, not a Thread-owned payload
or a compatibility copy. Skill support files are external executable inputs and are read
through the ordinary Full Access file tools and capability policy; the runtime does not
maintain a second Skill-specific read-root authority. Once read, their exact observed
content is frozen by the canonical tool Item and complete output reference. If the live
bundle later changes or disappears, a new read observes that current state or fails
normally, while replay of prior instructions and tool results remains unchanged. Forking
copies only resources already admitted into canonical Thread history; it does not clone
an installed Skill bundle.

Path-conditional Skills become available after matching files are touched.
Dynamic discovery respects project ignore rules and can observe a Skill created
after an earlier miss.

## Tool Ceiling

Only isolated Skill metadata may select tools or execution settings, and it cannot
widen the effective parent catalog. Isolated execution intersects its declared tools
with the parent ceiling; read-only isolation removes write action kinds. Plugins and
MCP servers obey the same parent ceiling through child configuration.

Embedded shell snippets are valid only in isolated Skills and execute from the already
recorded canonical `skill` tool Item through the standard shell capability and its Full
Access capability evaluation. A Skill never bypasses explicit blocks.

## Compaction Restore

The reducer reconstructs catalog state and the latest active inline invocation for each
canonical name from Thread-owned payload Items. It validates any existing compaction
checkpoint against full prior catalog entries and invocation payload references and
fails closed rather than inventing display metadata from a sparse checkpoint.

The provider projector selects the latest context epoch and replaces compacted raw
history with the summary plus validated checkpoint. It restores the exact active inline
Skill payload references as application instructions. `/clear` ends the journal and
active invocation set; the next ordinary admission records a complete baseline from the
then-current registry. No reducer state is reconstructed from reminder text or current
Skill files during replay.

Reduction recursively includes typed inherited Turns and prior compaction checkpoints.
Child admission uses that inherited catalog hash and announced-entry state when comparing
the current registry: an unchanged registry costs no additional Item or provider tokens,
while a newly added, changed, or removed Skill appends the same deterministic delta used
by an older root conversation. Repeated compaction carries active invocation references
forward instead of re-reading mutable Skill files.

Isolated child output is not restored as reusable Skill guidance. A future call
starts a new child Turn under current configuration.

Every isolated Skill catalog entry appends a host-derived execution constraint.
The constraint states that invocation runs once in a single isolated child Thread
under an explicit tool ceiling. When that ceiling does not declare
`collaboration.spawn_agent`, the catalog explicitly tells the parent that the Skill
cannot perform Subagent fan-out and that parallel orchestration belongs in the
parent Thread. This capability fact is derived from the effective Skill definition;
it is not hand-maintained prose in individual Skill bodies. Catalog budgeting
reserves every isolated execution constraint before allocating space to authored
descriptions, so pressure cannot silently remove the capability contract.

The isolated Skill tool result records the child Turn outcome separately from the
Skill execution mode. A completed outcome wraps the child's final non-commentary
text as a result to synthesize directly and tells the parent not to repeat covered
work unless the result reports a gap or independent verification is explicitly
required. The Skill tool is the only model-facing result channel for that isolated
child; collaboration listing and waiting exclude it. Failed or interrupted outcomes
are labeled as partial evidence rather than being described as completed.

## Authoring And Trust

Mutable Skill edits are ordinary file mutations. Provenance records accepted
content hashes separately from current bytes. A later model edit clears the
accepted hash; a user edit remains usable but no longer claims the prior accepted
version.

Undo restores only the version immediately preceding the latest model write and
is refused after a subsequent user edit. Built-ins and configured immutable
resource roots cannot be authoring targets.

`skillify` is the built-in authoring workflow. It derives a concrete Skill
contract from an explicit request, writes the mutable bundle, and relies on the
same provenance and capability checks as any file edit.

## Built-In Floor

The packaged platform floor contains `data-cleanup`. Development registration
also provides the authoring and research workflows used by the runtime. Packaged
resource staging is explicit; arbitrary optional Skills are not copied into the
application bundle.

## Settings

Agent settings control additional directories and disabled Skill identities.
Changes apply to newly assembled tool catalogs and to active per-Turn Skill
runtimes through a catalog refresh. Accept, revoke, and undo actions refresh every
active runtime from persisted provenance; undo also reloads the restored bytes and
appends a catalog delta before the next provider request when the content hash changed.
An unchanged trust-only catalog comparison emits no Item. Settings never rewrite
Thread history.
