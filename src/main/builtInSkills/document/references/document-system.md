# Document System

## Archetypes

Choose the shape that matches the reader's job:

- `decision_memo`: decision, context, options, recommendation, risks, next steps
- `brief`: thesis, key facts, implications, action
- `proposal`: problem, approach, scope, timeline, risks, ask
- `report`: summary, method, findings, interpretation, appendix
- `policy`: rule, rationale, scope, procedure, exceptions
- `review`: findings, evidence, severity, recommendations
- `playbook`: objective, operating principles, steps, checklists, escalation
- `form_or_rfi`: instructions, response fields, evidence requirements, signature/approval

## Design Presets

Use a preset for new documents and major rewrites. Preserve existing style for
small edits unless the user asks for a redesign.

- `plain_editorial`: Markdown-first drafts, specs, and collaborative memos. Clear headings, short paragraphs, minimal decoration.
- `business_brief`: executive memos, board briefs, proposals, and reports. Strong title, tight hierarchy, restrained accent, readable tables.
- `operator_reference`: checklists, playbooks, launch guides, negotiation briefs. Dense but scannable; labels, steps, and compact tables.
- `formal_record`: policy, contract-adjacent, legal, HR, compliance. Conservative typography, explicit definitions, stable numbering, minimal color.

Resolve the preset into concrete decisions before drafting:

- title block and opening summary
- heading ladder and paragraph rhythm
- list style and indentation
- table and callout treatment
- footer/header needs
- source/citation pattern

## Form Factors

Map each major content unit to its natural form:

- prose section: narrative, rationale, background
- lead callout: recommendation, decision, or non-obvious takeaway
- numbered steps: sequence, procedure, setup, approval flow
- grouped bullets: factors, requirements, pros/cons, risks
- checklist: acceptance criteria, action list, review checks
- note box: warning, caveat, constraint, assumption
- definition list: terms, metadata, roles, responsibilities
- table: repeated comparable records with shared fields
- form layout: response fields, questionnaire, RFI/compliance matrix
- source list: citations, appendix, evidence register

Use the lightest structure that makes the reader's job easier. Avoid visual
variety for its own sake.

## Table Gate

Use tables only for repeated row/column data, side-by-side comparison, lookup,
or form fields. Do not use tables to package normal prose.

Before finalizing a table:

- confirm every column has a stable role
- keep short fields compact and narrative fields wider
- avoid equal-width columns unless content is genuinely equal
- ensure headers repeat or remain clear when a table spans pages
- prefer bullets/prose when cells become paragraph-length

## Writing Rules

- Make headings specific enough to stand alone in a table of contents.
- Keep paragraphs short and purposeful.
- Prefer concrete nouns and active verbs.
- Define specialized terms before using them heavily.
- Separate facts, interpretation, and recommendations.
- Put caveats near the claims they qualify.
- Keep lists parallel and ordered by importance or sequence.

## Review-Ready Output

- Keep one primary idea per paragraph.
- Preserve source attributions when available.
- Mark assumptions plainly.
- Use consistent terminology.
- Remove drafting scaffolds before delivery.
- Report intentional unresolved comments, redlines, or placeholders.

## Tone

- Executive: concise, decision-forward, few caveats.
- Technical: precise, explicit assumptions, reproducible details.
- Legal/policy: scoped, careful, exception-aware.
- Marketing/proposal: audience value first, proof immediately after.
- Operator: action-oriented, terse labels, clear owner/status language.
