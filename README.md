# Tenon

Local-first structured thinking and agent workbench with an Electron shell, a
TypeScript core, and a React renderer. Loro CRDT under the hood. It uses an
outliner-shaped interface, but the product is aimed at structuring context,
directing local agents, and keeping work inspectable.

> Status: pre-release, single-developer project. Public so others can read the
> code and follow along.

## What's interesting in here

- **TypeScript-only stack.** No Rust, no Tauri, no `src-tauri`. Document state,
  agent runtime, tools, parsing, validation, and persistence are all
  TypeScript in `src/core` and `src/main`.
- **Loro-backed document model** with patch-based rich text
  (`RichTextPatchOp`) so concurrent edits compose cleanly when sync arrives.
- **Command-driven core.** Every mutation goes through a named command
  returning a `CommandOutcome { projection, focus? }`, with a scoped
  `UndoManager` so user undo and agent undo don't tangle.
- **Local agent.** An in-app dock backed by [pi-ai/pi-agent-core], with
  file/bash/web tools, skills, subagents, an event-sourced session log, and
  Claude Code–style permission policy. See
  [`docs/spec/agent-event-log-rendering.md`](docs/spec/agent-event-log-rendering.md).

## Repo Layout

```txt
src/
  core/      TypeScript outliner state machine, command list, search engine.
  main/      Electron main process: IPC, persistence, agent runtime, tools.
  preload/   Narrow Electron preload bridge exposed as `window.lin`.
  renderer/  React UI, outliner views, agent dock.
tests/
  core/      Pure TS tests against the core.
  renderer/  Renderer unit tests.
  e2e/       Playwright end-to-end tests.
docs/
  spec/      Current intended behavior. Read these to understand the code.
  plans/     Forward-looking plans. Read these to see where we're going.
```

## Development

```sh
# Install (bun is what the repo uses; npm/pnpm should also work).
bun install

# Run the desktop app in development.
bun run dev

# Run the renderer only against a stub document (useful for UI work).
bun run renderer:dev

# Type-check.
bun run typecheck

# Tests.
bun run test:core
bun run test:renderer
bun run test:e2e           # Playwright; needs the dev app to start

# Build a packaged macOS DMG.
bun run app:build
```

## Documentation

Everything that's intentional about how this code is shaped lives under
[`docs/spec/`](docs/spec/README.md). Start there. Plans for work that hasn't
landed yet live under [`docs/plans/`](docs/plans/); the active-plan index is on
[`docs/TASKS.md`](docs/TASKS.md).

The most useful entry points:

- [`docs/spec/architecture.md`](docs/spec/architecture.md) — runtime
  boundaries (core / main / preload / renderer).
- [`docs/spec/commands.md`](docs/spec/commands.md) — the IPC command surface.
- [`docs/spec/ui-behavior.md`](docs/spec/ui-behavior.md) — outliner
  interaction model.
- [`docs/spec/outliner-parity-matrix.md`](docs/spec/outliner-parity-matrix.md) —
  pointer/keyboard/trigger parity with nodex, plus the tests pinning each
  row.
- [`docs/plans/nodex-parity-decisions.md`](docs/plans/nodex-parity-decisions.md) —
  what we did and didn't carry over from nodex, with rationale.

## License

[MIT](LICENSE).

[pi-ai/pi-agent-core]: https://www.npmjs.com/package/@earendil-works/pi-agent-core
