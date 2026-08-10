# Skill Path Ownership

## Goal

Make Skill write governance agree with the ownership that the runtime actually
admitted. Convention Skill directories remain namespaces in which path shape
governs prospective and existing Skill content. A user-bound directory remains
an ordinary user directory: only an admitted child Skill owns its definition
and support files.

This is shape (a): one complete feature in one PR.

## Non-goals

- Loading a bound directory that is itself a Skill. That remains the dependent
  `skill-directory-is-itself-a-skill` task.
- Changing Skill identity, source precedence, enablement, invocation, or local
  directory picker behavior.
- Adding migration, compatibility, or renderer UI.
- Changing built-in or managed Skill mutability.

## Design

### Ownership rules

Convention directories (`~/.agents/skills`, the workspace `.agents/skills`,
and dynamically discovered nested `.agents/skills`) are dedicated Skill
namespaces. Their direct child name owns deeper paths by directory shape, even
before a `SKILL.md` exists, so first-write authoring remains governed.

An explicitly bound directory is a discovery container, not a dedicated
namespace. A child root owns its files only after the loader successfully
admits that root as a Skill. Therefore:

- an admitted `<bound>/alpha` owns `<bound>/alpha/SKILL.md` and visible support
  files below it;
- `<bound>/taxes/2025.md` is ordinary content when `taxes` did not load as a
  Skill;
- `<bound>/Research Notes/summary.md` is ordinary content rather than a Skill
  write rejected for the folder name;
- an exact `<bound>/<name>/SKILL.md` write is still a governed admission
  attempt, so creation and repair pass through the existing identity and
  content validators before the loader can admit the result.

Ownership is independent of invocation state. Path-conditional Skills and
valid physical roots hidden by canonical-name precedence still own their own
files. Enablement cannot turn write governance on or off. When convention and
bound candidates overlap, the most specific valid Skill root wins; source-loop
order never decides ownership.

### Registry-owned snapshot

Skill-directory enumeration distinguishes convention namespaces from explicit
bound containers. While loading a bound container, the registry records every
successfully parsed mutable physical Skill root. A complete load atomically
publishes that ownership set; partial or failed loads never expose a half-built
set. Reload invalidation retains the last complete set until its replacement is
ready, so sequential writes in one Turn cannot fall through governance.

Resolution filters the published set through the currently configured bound
directories. Unbinding therefore removes ownership immediately even before a
later catalog reload. Canonical path identities match symlinked aliases without
allowing a path that resolves outside an admitted root to inherit ownership.

The immutable built-in-directory, built-in-root, and managed-content fences run
before mutable ownership resolution and remain authoritative when paths overlap.

### Verification

Core tests exercise the resolver and the real file-tool admission path:

- convention directories still govern new definitions and support paths by
  shape;
- an admitted bound Skill governs its definition and support content;
- unloaded, invalid, and ordinary bound children do not own support content;
- an exact bound `SKILL.md` creation or repair remains governed;
- conditional, duplicate-name, reload, unbind, and symlink cases preserve the
  ownership rules;
- built-in and managed paths remain immutable.

## Open Questions

None. The PM ratified the ownership boundary before implementation.

## Implementation Checklist

- Separate convention and bound-container search-root policy.
- Publish admitted bound-root ownership from the registry load.
- Resolve bound writes through that ownership plus exact definition admission.
- Update the current Agent Skills specification.
- Add focused resolver, registry, and file-tool regression coverage.
