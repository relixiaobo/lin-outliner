# Search Query Grammar

Search nodes use one canonical query representation:

```ts
type SearchQueryExpr =
  | { kind: "group"; logic: "AND" | "OR" | "NOT"; children: SearchQueryExpr[] }
  | {
      kind: "rule";
      op: QueryOp;
      fieldDefId?: string;
      tagDefId?: string;
      targetId?: string;
      text?: string;
      operands?: Array<{ text?: string; targetId?: string }>;
    };
```

The model-facing outline is a serialization of this tree:

```text
- %%search%% Open work
  - AND
    - HAS_TAG
      - tag:: [[node:#task^node_task_tag]]
    - FIELD_IS
      - field:: [[node:Status^node_status_field]]
      - value:: Open
    - LT
      - field:: [[node:Due^node_due_field]]
      - value:: 2026-05-20
```

Rules:

- `%%search%%` marks the root node as a search node. The remaining root text is
  the search title.
- A search root has exactly one query root child.
- `AND`, `OR`, and `NOT` are group nodes and may be nested.
- QueryOp names are rule nodes.
- Rule operands use `field::`, `tag::`, `target::`, `value::`, or `operand::`.
- `field::`, `tag::`, and `target::` must be exact node references or node ids.
- Date operands use the canonical date field value language:
  `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `start/end` with `/`.
- JSON object DSL is allowed as an internal/debug shape only. It is not the
  canonical search outline syntax.
