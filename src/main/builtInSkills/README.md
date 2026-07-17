This directory is the source root for Tenon-owned resource-backed built-in skills.

Each Tenon-owned resource-backed skill lives in a child directory:

```text
<skill-name>/
  SKILL.md
  references/
  scripts/
  assets/
```

The Electron package does not copy this directory directly. `bun run skills:sync`
stages only these Tenon-owned skills into `build/generated/built-in-skills`, then
`electron-builder` copies that generated root to `Resources/built-in-skills`.

Keep built-in skill files immutable at runtime; user and agent-authored skills
belong under `.agents/skills` instead. Shared reusable skills that are not
Tenon-specific are distributed through the managed-skill catalog and are never
part of packaged built-in resources.
