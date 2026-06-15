This directory is the source root for resource-backed built-in skills.

Each shipped skill lives in a child directory:

```text
<skill-name>/
  SKILL.md
  references/
  scripts/
  assets/
```

The Electron package copies this directory to `Resources/built-in-skills`.
Keep built-in skill files immutable at runtime; user and agent-authored skills
belong under `.agents/skills` instead.
