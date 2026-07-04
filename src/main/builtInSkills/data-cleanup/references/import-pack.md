# Import Pack v1

Import Pack v1 is the boundary between source adapters and Tenon's import
CLI/API. Adapters emit this file; `tenon-import preview` validates it and
`tenon-import commit` stages it through the running Tenon app.

Required top-level fields:

- `version: 1`
- `source`: `{ kind, path, sourceId? }`
- `options`: fidelity/date/tag/field/done-state choices
- `stats`: computed aggregate counts
- `coverage`: source-record accounting
- `warnings`: structured warnings
- `sections`: importable outline sections

Each `ImportNode` may contain:

- `title`
- `description`
- `tags`
- `checked`
- `code`
- `fields`
- `children`
- `sourceId`

Adapters should keep source-specific concepts out of the write path. Convert
them to user-meaningful Tenon content, warnings, or dropped/unsupported coverage
entries.
