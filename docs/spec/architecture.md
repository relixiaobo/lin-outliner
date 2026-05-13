# Lin Outliner Architecture

Lin Outliner is a clean rebuild of the nodex outliner experience.

The repository does not carry migrated nodex product code. nodex remains an
external behavior reference only.

## Runtime Boundaries

- `crates/lin-core`: pure Rust outliner state machine.
- `src-tauri`: Tauri desktop shell and command bridge.
- `src/renderer`: React view and interaction layer.

Rust core is the only document writer. React keeps UI-only state such as focus,
expanded rows, selection, popovers, and transient editor drafts.

## Command Flow

```txt
React interaction
  -> Tauri command
  -> lin-core mutation
  -> persisted workspace snapshot
  -> DocumentProjection returned to React
```

No renderer module may directly mutate document state. UI changes that affect
document content or tree structure must use commands.

## Type Boundary

Rust structs in `lin-core::model` are serialized with `serde` using camelCase.
The TypeScript mirror lives in `src/renderer/api/types.ts`. The mirror is kept
small and protocol-shaped; it should match Rust model fields exactly.

When the protocol stabilizes, this boundary should move to generated types.
