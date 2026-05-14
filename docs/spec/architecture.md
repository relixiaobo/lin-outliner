# Lin Outliner Architecture

Lin Outliner is a clean rebuild of the nodex outliner experience.

The repository does not carry migrated nodex product code. nodex remains an
external behavior reference only.

## Runtime Boundaries

- `src/core`: pure TypeScript outliner state machine.
- `src/main`: Electron main process, persistence, IPC command bridge, and agent runtime.
- `src/preload`: narrow Electron preload bridge exposed as `window.lin`.
- `src/renderer`: React view and interaction layer.

There is no Rust, Cargo, Tauri, or `src-tauri` product runtime in this repository.
Document state, agent tools, parser logic, preview/validation, and persistence
are all implemented in TypeScript.

The TypeScript core is the only document writer. React keeps UI-only state such
as focus, expanded rows, selection, popovers, and transient editor drafts.

## Command Flow

```txt
React interaction
  -> preload IPC command
  -> Electron main document service
  -> TypeScript core mutation
  -> persisted workspace snapshot
  -> DocumentProjection returned to React
```

No renderer module may directly mutate document state. UI changes that affect
document content or tree structure must use commands.

## Type Boundary

Protocol-shaped TypeScript types live in `src/core/types.ts` and are re-exported
to the renderer through `src/renderer/api/types.ts`. The renderer API client
keeps command names stable so UI code does not depend on Electron internals.
