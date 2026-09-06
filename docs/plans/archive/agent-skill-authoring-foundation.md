# Agent Skill Identity And Script Authoring

**Shape:** ONE complete Skill authoring foundation in one PR.

## Goal

Settle what an explicitly selected local directory means, then allow an
explicit root-user `skillify` workflow to author validated textual support
scripts without granting execution authority.

Combining identity/loading with executable support authoring avoids rebuilding
write governance against an ambiguous Skill root. The PR delivers one complete
result: a user can bind the Skill directory itself, author a safe script into an
admitted mutable Skill, reload it, and still require ordinary process permission
to execute it.

## Non-goals

- No model-facing Skill CRUD family, marketplace, plugin, MCP, scheduler, or
  Skill sandbox.
- No write path for `built-in` or `managed` Skills.
- No execution permission, capability-ceiling expansion, or child inheritance
  from authoring admission.
- No binary/native package, installer, dynamic library, hidden executable, or
  runtime not proven present in the packaged macOS product.

## Design

### Explicit directory identity

An additional local binding persists an explicit mode: `skill` for the selected
directory itself or `container` for its direct child candidates. Admission
chooses `skill` when the selected directory contains a valid direct `SKILL.md`;
otherwise it records `container`. The recorded mode, not source enumeration or
ordered parent/child guesses, owns reload, display, unbind, conditional discovery,
and write attribution. A user who wants sibling discovery selects the parent.

Exact Skill bindings publish one admitted root. Container bindings publish only
successfully admitted child roots. Symlink-equivalent roots deduplicate by
physical identity; the most specific admitted root owns content. Unbinding drops
Tenon's pointer and never deletes user files. Existing immutable built-in/
managed fences and #513 path-ownership rules remain authoritative.

### Turn-scoped script authoring

Only an explicit root-user `skillify` invocation may mint an admission naming
mutable Skill identity, target path, purpose, inputs/outputs, and canonical tool
expected to execute it later. A normal Turn, child, or fabricated metadata cannot
mint or inherit it.

The authoring gateway atomically replaces one allowlisted UTF-8 text script only
when the target remains inside the admitted `user` or `project` Skill, is not
hidden or symlink-escaped, fits size/count budgets, contains no binary/NUL or
recognized secret, preserves valid resource references, and leaves the complete
bundle valid. It records previous-content provenance and bundle hash, then
invalidates/refreshes the registry through the settled identity owner.

Writing grants no execution right. A later run still requires the ordinary
shell/process tool, effective tool ceiling, explicit blocks, Full Access policy,
and OS behavior.

### Dependencies and collisions

`desktop-host-cutover` lands first because Settings binding and registry refresh
target final Host transport/owners. This plan must not overlap another Skill
registry/settings claim. `agent-skill-curation-report` follows it and consumes
the final identity/provenance contract.

### Verification

Tests cover exact-Skill versus container binding across reload, unbind, overlap,
symlink, invalid direct `SKILL.md`, create/repair, path-conditional discovery,
all four Skill sources, explicit/fabricated authoring scope, binary/secret/size/
path rejection, undo provenance, hash refresh, and denied later execution.
Settings receives narrow/light/dark/keyboard evidence.

### Acceptance criteria

- Selecting a valid Skill directory binds that exact Skill and survives reload
  without widening to its siblings.
- Container bindings remain explicit and never infer ownership from enumeration
  order.
- Root `skillify` can author one admitted textual script and reload the Skill.
- Previous-content provenance, exact bundle hash, undo evidence, and registry
  refresh survive restart without granting additional authority.
- No write grants execution or widens a parent/child capability ceiling.
- Built-in, managed, escaped, hidden, binary, oversized, secret-bearing, or
  fabricated targets fail before commit.
- Unbinding never deletes user content.

## Open questions

The initial executable extension set is selected by a clean packaged-runtime
probe. Unsupported interpreters remain excluded.

## Implementation checklist

- [ ] Add explicit binding mode and exact-Skill loading across every path.
- [ ] Route ownership, reload, create/repair, and unbind through that identity.
- [ ] Add root-only script admission and atomic validated authoring.
- [ ] Update current Skill/Settings specs and run security, registry, packaged-
      runtime, renderer, E2E, docs, and visual checks.
