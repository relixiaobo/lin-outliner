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

Built-in resource paths are display-safe pseudo identities and are never exposed
as writable local paths. Mutable Skills resolve to their real `SKILL.md` files.

## Format

YAML frontmatter may define description, usage guidance, allowed tools,
arguments, model, effort, path conditions, and execution mode. The Markdown body
contains the instructions. Resource references resolve from the Skill directory.

Execution mode is `inline` or `isolated`:

- `inline` loads instructions into the current Turn.
- `isolated` creates a child Thread with a bounded tool catalog and returns its
  terminal output to the parent Item.

Invalid frontmatter fails the Skill load rather than silently changing mode.

## Discovery And Invocation

The runtime lists available Skills in compact system context. Listing state is
tracked per Thread execution so the same unchanged catalog is not repeatedly
announced. A changed file identity is announced again.

The `skill` model tool invokes a selected Skill. User-invocable Skills may also
be adapted to slash input. Loading is idempotent within the active Thread: once
instructions are present, a repeated call does not duplicate them.

Path-conditional Skills become available after matching files are touched.
Dynamic discovery respects project ignore rules and can observe a Skill created
after an earlier miss.

## Tool Ceiling

Skill metadata may narrow the tool set but cannot widen the effective Thread
catalog. Isolated execution intersects the Skill list with the parent ceiling;
read-only isolation removes write action kinds. Plugins and MCP servers obey the
same parent ceiling through child configuration.

Embedded shell snippets execute through the standard shell capability and its
Full Access capability evaluation. A Skill never bypasses explicit blocks.

## Compaction Restore

Structured reminders preserve which Skill identities and content hashes were
listed or invoked. After context compaction, the runtime restores the minimum
state needed to avoid duplicate listing and to retain active guidance.

Isolated child output is not restored as reusable Skill guidance. A future call
starts a new child Turn under current configuration.

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
runtimes through a catalog refresh. Settings do not rewrite Thread history.
