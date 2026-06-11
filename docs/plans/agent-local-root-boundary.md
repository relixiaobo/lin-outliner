---
status: draft
owner: codex
updated: 2026-06-11
---

# Agent Local Root Boundary

## Goal

Verify and fix the agent local file root used by packaged builds before shipping
any broader Full Access permission mode.

The current launch-time fallback is:

```ts
const agentLocalFileRoot = process.env.LIN_AGENT_LOCAL_ROOT ?? process.cwd();
```

In development this usually resolves to a repo clone, which is a sensible local
file boundary. In a packaged app launched from Finder, `process.cwd()` may be
`/`. If confirmed, the permission engine treats the whole disk as inside the
allowed file area, so ordinary non-sensitive reads/writes outside any intended
project boundary can default to in-root behavior.

## Non-goals

- Do not introduce a full folder/workspace product surface.
- Do not implement the safety-mode ladder here.
- Do not change Electron renderer hardening.

## Plan

1. Verify packaged behavior:
   - Build or run a packaged-equivalent app with `LIN_AGENT_LOCAL_ROOT` unset.
   - Record `process.cwd()` and the resolved agent local root.
   - Confirm whether Finder launch resolves to `/`.
2. If the root is unsafe, change the packaged fallback:
   - Use a dedicated safe directory under app `userData`; or
   - leave file tools effectively rootless/deny until an explicit folder handoff
     exists.
3. Keep development behavior unchanged:
   - `LIN_AGENT_LOCAL_ROOT` continues to override.
   - source/dev fallback may remain `process.cwd()` or clone-specific script root
     if tests depend on it.
4. Add tests for root resolution:
   - packaged + unset env does not resolve to `/`;
   - env override wins;
   - dev behavior remains stable.
5. Update `docs/spec/agent-tool-permissions.md` with the resolved allowed-file
   boundary semantics.

## Acceptance Criteria

- Packaged app with no `LIN_AGENT_LOCAL_ROOT` never treats `/` as the allowed file
  area.
- Ordinary file tools cannot default-allow arbitrary disk paths through a cwd
  fallback.
- Sensitive path redlines remain unchanged.
- Full Access implementation is sequenced after this boundary is fixed.
