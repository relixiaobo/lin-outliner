---
status: done
owner: codex
updated: 2026-06-11
---

# Agent Local Root Boundary

**Shape: (a) ONE complete feature in one PR.**

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

## Design

1. `src/main/agentLocalRoot.ts` owns local-root resolution:
   - non-empty `LIN_AGENT_LOCAL_ROOT` resolves as an explicit override;
   - source/dev runs with no override keep using `process.cwd()`;
   - packaged runs with no override use `<userData>/agent-local-root`, never
     `process.cwd()`.
2. `src/main/main.ts` passes the resolved root into `AgentRuntime` and creates
   the packaged fallback directory at startup so bash/file tools have an existing
   cwd without widening to the app's full `userData` directory.
3. `docs/spec/agent-tool-permissions.md` is the authority for the shipped
   allowed-file-area semantics.

## Acceptance Criteria

- [x] Packaged-equivalent root resolution with cwd `/` and no
      `LIN_AGENT_LOCAL_ROOT` resolves to `<userData>/agent-local-root`, not `/`.
- [x] Ordinary file tools cannot default-allow arbitrary disk paths through the
      packaged cwd fallback.
- [x] Sensitive path redlines remain unchanged.
- [x] Full Access implementation is sequenced after this boundary is fixed.
- [x] Verification: `bun run typecheck`; `bun test tests/core/agentLocalRoot.test.ts`;
      `bun run test:core`.
