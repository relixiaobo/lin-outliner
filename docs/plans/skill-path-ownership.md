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
  content validators before the loader can admit the result. Admission also
  validates every existing support file in the prospective bundle. This keeps
  support-first authoring from smuggling executable, secret-looking, symlinked,
  or oversized content into a Skill while leaving the files ordinary when no
  definition is ever admitted.

Ownership is independent of invocation state. Path-conditional Skills and
valid physical roots hidden by canonical-name precedence still own their own
files. Enablement cannot turn write governance on or off. When convention and
bound candidates overlap, the most specific valid Skill root wins; source-loop
order never decides ownership.

### Registry-owned snapshot

Skill-directory enumeration distinguishes convention namespaces from explicit
bound containers. Physically identical search directories are scanned once,
with convention policy taking precedence, while every logical alias remains
available for path attribution. While loading a bound container, the registry
records each mutable physical Skill root that passes source precedence. A
complete load atomically publishes that ownership set; partial or failed loads
never expose a half-built set. A previously admitted root remains owned while
its directory is still bound and present even if its definition is temporarily
unparseable, so repair cannot open an ungoverned support-file window.

Path resolution is asynchronous and waits for the current registry generation.
Binding invalidates the registry synchronously, and the first later resolution
loads and publishes the new directory set before deciding the write. Definition
writes and managed-content changes only invalidate the registry; they do not
hold the initiating mutation behind a full scan. Any later Skill resolution,
catalog projection, or invocation awaits that scan and fails closed at the
write boundary if it cannot complete.

Resolution filters the published set through the currently configured bound
directories. Unbinding therefore removes ownership before the next path
decision. Canonical path identities match symlinked aliases without allowing a
path that resolves outside an admitted root to inherit ownership. Every target
is canonicalized once asynchronously; candidate roots use identities computed
during registry loading. Owner selection prefers the logical root traversed by
the requested path and then the deepest logical root, so physical symlink depth
and source enumeration order cannot change attribution.

The immutable built-in-directory, built-in-root, and managed-content fences run
before mutable ownership resolution and remain authoritative when paths overlap.

### Verification

Core tests exercise the resolver and the real file-tool admission path:

- convention directories still govern new definitions and support paths by
  shape;
- an admitted bound Skill governs its definition and support content;
- unloaded, invalid, and ordinary bound children do not own support content;
- an exact bound `SKILL.md` creation or repair remains governed;
- support-first executable, secret-looking, symlinked, and oversized bundles
  fail definition admission;
- conditional, duplicate-name, reload, unbind, and symlink cases preserve the
  ownership rules;
- runtime binding, logical aliases, convention aliases, temporary definition
  failure, and immutable-name shadows preserve ownership and precedence;
- built-in and managed paths remain immutable.

## Open Questions

None. The PM ratified the ownership boundary before implementation.

## Implementation Checklist

- Separate convention and bound-container search-root policy.
- Publish admitted bound-root ownership from the registry load.
- Resolve bound writes through that ownership plus exact definition admission.
- Update the current Agent Skills specification.
- Add focused resolver, registry, and file-tool regression coverage.
