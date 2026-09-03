#!/usr/bin/env bash

legacy_create_tool="node""_create"
legacy_delete_tool="node""_delete"
legacy_read_tool="node""_read"
legacy_search_tool="node""_search"
legacy_skill_name="tenon""-import"
legacy_runtime_test="tests/core/tenon""ImportRuntime.test.ts"

evidence_test() {
  disposition="$1"
  evidence_path="$2"
  evidence_label="$3"
  rationale="$4"
}

evidence_retirement() {
  disposition="explicit-retirement"
  evidence_path="$1"
  evidence_label="$2"
  rationale="$3"
}

classify_node_tool() {
  local title="$1"
  if [[ "$title" == *"schemas use operational descriptions"* || "$title" == *"catalog independently explains"* ]]; then
    evidence_retirement \
      "docs/spec/agent-tool-design.md" \
      "The Agent catalog has no document-native model tools." \
      "The six private model tools were deliberately replaced by the registry-owned public CLI and Skill."
  elif [[ "$title" == *"undo"* || "$title" == *"history"* || "$title" == *"Loro undo step"* ]]; then
    evidence_test \
      "stronger-replacement" \
      "tests/core/outlineCli.test.ts" \
      "queries history by idempotency key and runs guarded revert, undo, and redo" \
      "Durable Runtime Operations and guarded revert replace the process-local native-tool undo surface."
  elif [[ "$title" == *"$legacy_search_tool"* || "$title" == *"saved-search"* || "$title" == *"search validation"* ]]; then
    if [[ "$title" == *"operands keep tag annotation"* \
      || "$title" == *"configuration lines keep separate direct-child grammars"* \
      || "$title" == *"model-visible result returns one annotated outline"* ]]; then
      evidence_retirement \
        "docs/plans/outliner-runtime-recovery.md" \
        "six native \`node_*\` Agent tools and their private outline parser" \
        "Typed QueryExpr and Projection schemas deliberately replace the private saved-search outline grammar."
    elif [[ "$title" == *"recall"* ]]; then
      evidence_retirement \
        "docs/spec/agent-tool-design.md" \
        "Memory adds no parallel tools and no Agent-specific document projection filter." \
        "Agent-specific search recall side effects were retired; actor-neutral CLI reads remain."
    elif [[ "$title" == *"pagination"* ]]; then
      evidence_test \
        "stronger-replacement" \
        "tests/core/outlineChangeSetKernel.test.ts" \
        "paginates a Projection at one bound revision and rejects a stale cursor" \
        "Revision-bound opaque cursors replace native next_offset pagination and fail closed after document movement."
    elif [[ "$title" == *"count"* ]]; then
      evidence_test \
        "stronger-replacement" \
        "tests/core/outlineCli.test.ts" \
        "runs exact and batch counts, live Saved Searches, and multi-ID reads through the CLI" \
        "The public CLI owns bounded reads, pagination, exact counts, and batch counts."
    elif [[ "$title" == *"personal access ranking"* ]]; then
      evidence_test \
        "confirmed-regression-fixed" \
        "tests/core/outlineDocumentService.test.ts" \
        "synchronizes personal access ranking into Runtime and restores it after reconnect" \
        "The cutover retained the ranker and access store but omitted the desktop-to-Runtime production wiring."
    elif [[ "$title" == *"indexed relevance"* || "$title" == *"keyword search"* ]]; then
      evidence_test \
        "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "uses text index relevance for loose multi-term string matches" \
        "The shared search engine and maintained text index replace the native-tool ranker."
    elif [[ "$title" == *"does not apply query budgets"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "rejects over-budget saved-search configs before mutating nodes" \
        "Query budgets apply to executable query expressions, not ordinary Node content."
    elif [[ "$title" == *"saved search title as an implicit condition"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "treats empty saved search condition groups as no query" \
        "Saved Search titles remain presentation, never an implicit executable condition."
    elif [[ "$title" == *"tag conditions"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchQueryOutline.test.ts" \
        "parses nested groups with typed definition and literal operands" \
        "The public parser resolves typed tag definitions into QueryExpr operands."
    elif [[ "$title" == *"attachment-backed media"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "executes media facets from image nodes and explicit attachment MIME families" \
        "Shared media facets execute attachment MIME families directly."
    elif [[ "$title" == *"nested canonical query groups"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "executes saved search AND OR and NOT groups" \
        "Canonical QueryExpr preserves nested boolean groups."
    elif [[ "$title" == *"unresolved structured conditions"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchQueryOutline.test.ts" \
        "rejects directives, wrong reference types, and incomplete rules" \
        "The public query parser fails closed on unresolved or incomplete structured conditions."
    elif [[ "$title" == *"completion and date query mistakes"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineCli.test.ts" \
        "publishes only executable query operators through schema and completion metadata" \
        "Schema-derived completion exposes only executable operators and canonical date forms."
    elif [[ "$title" == *"reference conditions as links-to"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "LINKS_TO uses canonical linked reference sources" \
        "The shared engine executes canonical linked-reference sources."
    elif [[ "$title" == *"field conditions"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "executes field equality and the five virtual-slot state operators" \
        "The shared engine executes stored and projected field conditions."
    elif [[ "$title" == *"document read model"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineDocumentService.test.ts" \
        "uses Runtime-ranked search and keeps sparse Node reads fresh in input order" \
        "The long-lived Runtime read model replaces per-call projection rebuilding."
    else
      evidence_test \
        "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "classifies every query operator as executable or explicitly unsupported" \
        "The executable query registry and shared search engine replace temporary native-tool outline parsing."
    fi
  elif [[ "$title" == *"old_string"* \
    || "$title" == *"root shorthand"* \
    || "$title" == *"root line fragments"* \
    || "$title" == *"annotated"* \
    || "$title" == *"model-visible"* \
    || "$title" == *"literal syntax"* \
    || "$title" == *"serializer"* \
    || "$title" == *"directive"* \
    || "$title" == *"fence"* \
    || "$title" == *"out-of-root local-file markers"* \
    || "$title" == *"ignored field clears"* ]]; then
    evidence_retirement \
      "docs/plans/outliner-runtime-recovery.md" \
      "six native \`node_*\` Agent tools and their private outline parser" \
      "This assertion belonged to the deliberately retired native presentation and text-edit grammar."
  elif [[ "$title" == *"materializes markdown inline marks and links"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "parses inline markdown marks while preserving node reference markers" \
      "The maintained Markdown/RichText boundary owns mark and reference materialization independently of the retired native tool."
  elif [[ "$title" == *"materializes bare URLs"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "materializes bare URLs as link marks without double-linking protected ranges" \
      "The maintained Markdown/RichText boundary still materializes bare links without parser overlap."
  elif [[ "$title" == *"balanced parentheses"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "round-trips link destinations with balanced parentheses" \
      "The shared Markdown/RichText bridge preserves the exact link boundary outside the retired native tool."
  elif [[ "$title" == *"overlapping bold and link marks"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "round-trips a bare URL covered by an overlapping Markdown mark" \
      "The shared Markdown/RichText bridge retains overlapping link and emphasis marks."
  elif [[ "$title" == *"crossing bold and link marks"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "round-trips crossing Markdown mark ranges by closing and reopening marks" \
      "The shared Markdown/RichText bridge retains crossing link and emphasis marks."
  elif [[ "$title" == *"three simultaneously active marks"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "round-trips canonical serialization with three simultaneously active marks" \
      "The shared Markdown/RichText bridge retains three concurrent marks."
  elif [[ "$title" == *"keeps CSS hex colors as text"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/textSyntax.test.ts" \
      "extracts canonical tag forms and excludes bare CSS hex colors" \
      "The shared tag grammar still excludes CSS colors independently of the retired native outline parser."
  elif [[ "$title" == *"tree reference projection consumes raw inline-reference display snapshots"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "does not duplicate stored inline reference display text" \
      "The shared RichText boundary consumes stored reference display metadata without duplicating normalized text."
  elif [[ "$title" == *"ordinary colon-separated inline references as rich text"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "round-trips grammar-significant literal text without creating semantics" \
      "Structured RichText keeps grammar-like ordinary text literal without the retired duplicate marker protocol."
  elif [[ "$title" == *"private inline reference fallbacks as ordinary content"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "escapes private reference fallbacks against both insertion boundaries" \
      "The maintained Markdown boundary preserves safe display fallbacks without exposing private Node identities."
  elif [[ "$title" == *"direct reference mutations reject private Node ids"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/markdownRichText.test.ts" \
      "degrades private Node families to safe plain display text at the Markdown boundary" \
      "The public boundary continues to reject private identity exposure by degrading it to safe display text."
  elif [[ "$title" == *"serializes local-file inline refs as file markers"* \
    || "$title" == *"preserves out-of-root local-file inline refs"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/referenceMarkup.test.ts" \
      "round-trips structured rich text without serializing display metadata" \
      "The maintained structured-reference boundary preserves local-file identity and display metadata without the retired $legacy_read_tool envelope."
  elif [[ "$title" == *"presents inherited defaults without exposing template nodes"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/fieldSlots.test.ts" \
      "reads static template values as inherited defaults until a stored entry exists" \
      "Shared field-slot projection presents inherited defaults without turning template Nodes into stored owner values."
  elif [[ "$title" == *"duplicates a subtree from plain outline"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlinePorcelain.test.ts" \
      "expresses exact create, move, and duplicate placement through argv and exactly reverts each mutation" \
      "The public duplicate command preserves subtree placement and exact recovery without the retired text grammar."
  elif [[ "$title" == *"rolls back earlier mutations when a later host command fails"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlineChangeSetKernel.test.ts" \
      "rolls back every earlier change when a late operation fails" \
      "The public ChangeSet kernel retains one rollback frontier across every earlier mutation."
  elif [[ "$title" == *"reports a real no-op"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlineDocumentService.test.ts" \
      "keeps the desktop revision valid after a semantic no-change settlement" \
      "The public Runtime reports semantic no-change without inventing an Operation or invalidating the desktop revision."
  elif [[ "$title" == *"replace_outline uses sparse mutation facts"* ]]; then
    evidence_retirement \
      "docs/plans/outliner-runtime-recovery.md" \
      "six native \`node_*\` Agent tools and their private outline parser" \
      "The read-model host adapter was private native-tool machinery; the Runtime now owns selection and sparse mutation facts directly."
  elif [[ "$title" == *"rejects child-structure outline edits"* ]]; then
    evidence_retirement \
      "docs/plans/outliner-runtime-recovery.md" \
      "six native \`node_*\` Agent tools and their private outline parser" \
      "Typed public ChangeSets represent child structure directly, so the private text-replacement restriction no longer applies."
  elif [[ "$title" == *"edits a child directly by id"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlineChangeSetKernel.test.ts" \
      "rejects stale Diff and targeted digest changes without writing" \
      "Public ID selectors bind an exact target Node and its semantic digest before update."
  elif [[ "$title" == *"field reads preserve stored values for a trashed owner"* \
    || "$title" == *"field reads include trashed direct entries"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlineChangeSetKernel.test.ts" \
      "redacts and preserves field view and trash metadata through include controls" \
      "Public Projection include controls preserve deleted field rows only when the caller explicitly admits Trash metadata."
  elif [[ "$title" == *"requires expected_revision for non-preview whole editable outline replacement"* \
    || "$title" == *"whole editable outline revision covers field value changes"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlineChangeSetKernel.test.ts" \
      "rejects stale Diff and targeted digest changes without writing" \
      "Every reviewed public Diff binds both the Runtime revision and semantic digests for its selected Nodes before mutation."
  elif [[ "$title" == *"replaces the whole editable outline with revision guard"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlineChangeSetKernel.test.ts" \
      "previews without mutation and applies the exact fixed-ID result as one Operation" \
      "A reviewed typed ChangeSet replaces the private whole-outline text edit and applies its fixed identities atomically at the reviewed revision."
  elif [[ "$title" == *"rejects whole editable outline replacement with child structure"* ]]; then
    evidence_retirement \
      "docs/plans/outliner-runtime-recovery.md" \
      "six native \`node_*\` Agent tools and their private outline parser" \
      "The public typed ChangeSet represents child structure directly, so the private whole-outline parser restriction no longer applies."
  elif [[ "$title" == *"explicit effective list mode"* ]]; then
    evidence_retirement \
      "docs/spec/outliner-parity-matrix.md" \
      "Persist \`table\` / \`list\` on the owner's view definition" \
      "The current public view contract deliberately persists explicit modes instead of eliding the default list representation."
  elif [[ "$title" == *"updates saved search config without pruning ordinary children"* ]]; then
    evidence_test "stronger-replacement" \
      "tests/core/outlineChangeSetCapabilities.test.ts" \
      "executes view, search, template, and definition-merge behavior through one public union" \
      "The typed Search update preserves ordinary child Nodes while replacing query configuration."
  elif [[ "$title" == *"$legacy_delete_tool"* || "$title" == *"Trash"* || "$title" == *"trash"* || "$title" == *"restore"* ]]; then
    evidence_test \
      "stronger-replacement" \
      "tests/core/outlinePorcelain.test.ts" \
      "uses one normalized Diff/apply kernel across content and lifecycle commands" \
      "Trash, restore, purge, and preview now share the atomic public ChangeSet kernel."
  elif [[ "$title" == *"rich"* || "$title" == *"markdown"* || "$title" == *"URL"* || "$title" == *"code block"* || "$title" == *"checkbox"* ]]; then
    evidence_test \
      "stronger-replacement" \
      "tests/core/outlineChangeSetCapabilities.test.ts" \
      "preserves rich content, capture provenance, fields, definitions, and references" \
      "Public NodeDraft and Change schemas preserve rich content without the retired outline text grammar."
  elif [[ "$title" =~ (^|[[:space:]_-])view([[:space:]_.:-]|$) \
    || "$title" =~ (^|[[:space:]_-])display([[:space:]_.:-]|$) \
    || "$title" =~ (^|[[:space:]_-])table([[:space:]_.:-]|$) ]]; then
    if [[ "$title" == *"saved search"* || "$title" == *"search"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/searchEngine.test.ts" \
        "converts full saved search logic without a simple compatibility layer" \
        "Canonical QueryExpr and persisted Saved Search config replace directive parsing."
    elif [[ "$title" == *"initializing record fields as columns"* \
      || "$title" == *"auto-assigned order"* \
      || "$title" == *"re-entry initializes fields"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/core.test.ts" \
        "creates typed display fields atomically and assigns stable order" \
        "Core owns typed display-field identity and stable order independently of the retired directive grammar."
    elif [[ "$title" == *"malformed persisted view"* \
      || "$title" == *"validation fails closed with recovery grammar"* \
      || "$title" == *"rejects invalid owners and display numbers"* ]]; then
      evidence_retirement \
        "docs/plans/outliner-runtime-recovery.md" \
        "six native \`node_*\` Agent tools and their private outline parser" \
        "These assertions governed native-tool directive decoding and recovery text; typed Runtime schemas and renderer projection own the current boundaries."
    else
      evidence_test \
        "stronger-replacement" \
        "tests/core/outlineChangeSetCapabilities.test.ts" \
        "executes view, search, template, and definition-merge behavior through one public union" \
        "Typed view Changes replace native directive parsing while preserving domain behavior."
    fi
  elif [[ "$title" == *"field"* || "$title" == *"definition"* || "$title" == *"option"* || "$title" == *"supertag"* || "$title" == *"Done"* ]]; then
    if [[ "$title" == *"creates outline trees with tags fields descriptions and completion"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetCapabilities.test.ts" \
        "preserves rich content, capture provenance, fields, definitions, and references" \
        "One typed NodeDraft preserves content, descriptions, completion, tags, fields, and nested Nodes without the retired outline grammar."
    elif [[ "$title" == *"top-level field lines write structured fields"* \
      || "$title" == *"preserves multiplicity for identical values"* \
      || "$title" == *"same-owner field entry"* \
      || "$title" == *"distinct pure inline-reference field values"* \
      || "$title" == *"same label and distinct link destinations"* \
      || "$title" == *"does not treat owner focus as an empty projected field entry"* \
      || "$title" == *"does not copy template field values"* \
      || "$title" == *"preserves omitted fields and field values"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetCapabilities.test.ts" \
        "preserves field multiplicity, reference identity, omissions, template values, and one owner entry" \
        "The public ChangeSet path preserves duplicate values, target identity, stable owner entry identity, template-default exclusion, field ordering, and omission semantics together."
    elif [[ "$title" == *"definition creates a field definition without a field entry"* \
      || "$title" == *"exposes definition config for editable field definitions"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetCapabilities.test.ts" \
        "keeps explicit definition IDs stable and rejects same-name ID conflicts without writing" \
        "Public ensure creates only the stable field definition, exposes its typed config, and proves that no field entry is materialized."
    elif [[ "$title" == *"duplicate_id escapes an ordinary terminal inline Node reference"* \
      || "$title" == *"preserve marker-only ordinary inline references"* \
      || "$title" == *"reference-like markers in descriptions and field names"* ]]; then
      evidence_retirement \
        "docs/plans/outliner-runtime-recovery.md" \
        "six native \`node_*\` Agent tools and their private outline parser" \
        "Escaping and marker disambiguation belonged to the retired private outline text grammar; typed RichText and NodeDraft inputs carry references structurally."
    elif [[ "$title" == *"operation rejects fields from a different operation"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetKernel.test.ts" \
        "keeps a Diff self-contained across Runtime restart" \
        "A reviewed public Diff carries its complete field plan and fixed identities, so no field handle can leak from another operation."
    elif [[ "$title" == *"whole editable outline revision covers field value changes"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetKernel.test.ts" \
        "rejects stale Diff and targeted digest changes without writing" \
        "The public Diff binds the complete document revision and selected target digests, including field-value state, before mutation."
    elif [[ "$title" == *"merge"* ]]; then
      if [[ "$title" == *"supertag"* || "$title" == *"tag"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/core.test.ts" \
          "tag merge preserves same-name fields with distinct definitions" \
          "Core tag merge preserves definition identity while merging tags document-wide."
      elif [[ "$title" == *"option"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/core.test.ts" \
          "tag merge deduplicates option defaults by target identity" \
          "Option merges use stable target identity instead of presentation labels."
      else
        evidence_test "stronger-replacement" \
          "tests/core/core.test.ts" \
          "explicit field-definition merge remains document-wide" \
          "Definition merge remains a document-wide Core operation exposed by typed Changes."
      fi
    elif [[ "$title" == *"infers conservative field types"* || "$title" == *"pure inline references for typed fields"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/fieldResolution.test.ts" \
        "non-node inline references force plain inference and fail typed validation" \
        "The shared field resolver owns conservative inference and typed reference rejection."
    elif [[ "$title" == *"reuses existing typed field definitions by name"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/core.test.ts" \
        "reuses an existing field def by name across pasted field:: values" \
        "Core field materialization reuses the stable definition identity."
    elif [[ "$title" == *"reuse_field_definition"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/core.test.ts" \
        "reusing a field definition relinks the entry and drops the orphaned draft def" \
        "Typed reuse relinks the stored entry and preserves referenced definitions."
    elif [[ "$title" == *"configure_definition"* || "$title" == *"field type changes"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/core.test.ts" \
        "field type changes validate every existing value before mutating config" \
        "Core validates all existing values before committing definition type changes."
    elif [[ "$title" == *"options-from-supertag"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/core.test.ts" \
        "options from supertag selects tagged nodes instead of field children" \
        "The shared options resolver validates stable tagged-node selection."
    elif [[ "$title" == *"selects existing options"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/core.test.ts" \
        "smart-selects a matching option when pasting into an existing options field" \
        "Core resolves existing options before creating field values."
    elif [[ "$title" == *"duplicate owner fields"* || "$title" == *"ambiguous duplicate"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/fieldResolution.test.ts" \
        "requires entry-id disambiguation when same-layer owner entries coexist" \
        "The shared resolver rejects ambiguous owner entries and requires stable identity."
    elif [[ "$title" == *"inheritance chain"* || "$title" == *"specific definition"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/fieldResolution.test.ts" \
        "prefers the unique definition from the most specific owner tag layer" \
        "Specific-first tag inheritance now belongs to the shared resolver."
    elif [[ "$title" == *"projected Done"* || "$title" == *"writes Done"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/fieldResolution.test.ts" \
        "routes a projected Done slot through the mutable system field path" \
        "The mutable Done system field uses the same projected-slot resolver while read-only system fields remain protected."
    elif [[ "$title" == *"date field"* || "$title" == *"date fields"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/dateFieldValue.test.ts" \
        "formats date input into canonical field values" \
        "Canonical date parsing and formatting is shared by typed field mutations."
    elif [[ "$title" == *"empty draft fields"* || "$title" == *"Field placeholder"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/core.test.ts" \
        "empty draft fields do not reserve the display placeholder name" \
        "Placeholder rows remain excluded from concrete field-name resolution."
    elif [[ "$title" == *"trashed owner"* || "$title" == *"trashed direct entries"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetKernel.test.ts" \
        "redacts and preserves field view and trash metadata through include controls" \
        "Bounded public Projections preserve field data only when include controls admit Trash metadata."
    elif [[ "$title" == *"rolls back outline writes"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetKernel.test.ts" \
        "rolls back every earlier change when a late operation fails" \
        "One atomic ChangeSet rollback frontier replaces parser-local rollback."
    elif [[ "$title" == *"top-level fields preserve after_id"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlinePorcelain.test.ts" \
        "expresses exact create, move, and duplicate placement through argv and exactly reverts each mutation" \
        "Typed placement preserves exact root insertion independently of field materialization."
    elif [[ "$title" == *"inserts new fields before existing ordinary children"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetCapabilities.test.ts" \
        "preserves field multiplicity, reference identity, omissions, template values, and one owner entry" \
        "The public NodeDraft assertion keeps the one materialized field entry before the owner's ordinary child."
    elif [[ "$title" == *"field value kind changes"* ]]; then
      evidence_test "stronger-replacement" \
        "tests/core/fieldResolution.test.ts" \
        "scalar field types still reject node-reference values" \
        "Typed field validation rejects incompatible value kinds before mutation."
    elif [[ "$title" == *"register"* || "$title" == *"remove one field value"* ]]; then
      evidence_test \
        "stronger-replacement" \
        "tests/core/outlineChangeSetCapabilities.test.ts" \
        "registers reusable options and removes one field value through typed field instructions" \
        "Typed field-slot Changes replace the native parser while retaining definition, option, and value semantics."
    else
      evidence_test \
        "stronger-replacement" \
        "tests/core/outlineChangeSetCapabilities.test.ts" \
        "preserves rich content, capture provenance, fields, definitions, and references" \
        "Typed NodeDraft, field, and field-slot Changes preserve this field responsibility without the retired private outline grammar."
    fi
  elif [[ "$title" == *"reference"* || "$title" == *"duplicate_id"* ]]; then
    evidence_test \
      "stronger-replacement" \
      "tests/core/outlinePorcelain.test.ts" \
      "keeps retarget and content-to-reference replacement distinct and exactly reversible" \
      "Public reference Changes retain distinct add, retarget, replace, inline, and restore semantics."
  elif [[ "$title" == *"move"* || "$title" == *"merge"* ]]; then
    evidence_test \
      "stronger-replacement" \
      "tests/core/outlinePorcelain.test.ts" \
      "expresses exact create, move, and duplicate placement through argv and exactly reverts each mutation" \
      "Typed placement and merge Changes replace native action variants and retain exact recovery."
  elif [[ "$title" == *"$legacy_read_tool"* || "$title" == *"field reads"* ]]; then
    evidence_test \
      "stronger-replacement" \
      "tests/core/outlineCli.test.ts" \
      "runs exact and batch counts, live Saved Searches, and multi-ID reads through the CLI" \
      "Revision-bound public Projections replace annotated native-tool output and its private pagination grammar."
  else
    evidence_test \
      "stronger-replacement" \
      "tests/core/outlineChangeSetKernel.test.ts" \
      "previews without mutation and applies the exact fixed-ID result as one Operation" \
      "The typed ChangeSet/Diff/Operation path preserves atomic create and edit behavior without native tools."
  fi
}

classify_responsibility() {
  local source_path="$1"
  local title="$2"
  disposition=""
  evidence_path=""
  evidence_label=""
  rationale=""

  case "$source_path" in
    tests/core/agentNodeTools.test.ts)
      classify_node_tool "$title"
      ;;
    tests/core/agentOutlineParser.test.ts)
      evidence_retirement \
        "docs/plans/outliner-runtime-recovery.md" \
        "six native \`node_*\` Agent tools and their private outline parser" \
        "The private model outline grammar was intentionally removed; typed public schemas own these inputs."
      ;;
    tests/core/workspacePersistenceStore.test.ts)
      if [[ "$title" == *"legacy"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "rejects the superseded workspace format instead of reading or migrating it" \
          "The pre-release Runtime format rejects superseded snapshots instead of carrying legacy readers."
      elif [[ "$title" == *"fsync"* || "$title" == *"idempotently"* ]]; then
        if [[ "$title" == *"log is replaced during fsync"* ]]; then
          evidence_test "confirmed-regression-fixed" \
            "tests/core/outlineWorkspaceTransactionLog.test.ts" \
            "does not acknowledge an append when the log path is replaced during fsync" \
            "The cutover kept fsync settlement but dropped active log identity validation across the acknowledgement window."
        else
          evidence_test "stronger-replacement" \
            "tests/core/outlineWorkspaceTransactionLog.test.ts" \
            "retries every record idempotently after a batched fsync acknowledgement failure" \
            "Transaction idempotency resolves uncertain fsync acknowledgement without duplicate execution."
        fi
      elif [[ "$title" == *"active log inode is replaced"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "rejects an append when the active transaction log inode was replaced at the same size" \
          "The cutover checksum chain validated restart replay but omitted live inode and length validation before append."
      elif [[ "$title" == *"stale log whose records are newer"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "blocks a stale log whose complete records are newer than the snapshot" \
          "The cutover treated every older header as absorbed without checking whether its complete records crossed the snapshot sequence."
      elif [[ "$title" == *"different replica identity"* || "$title" == *"identity-mismatched records"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "rejects a transaction from a different workspace replica identity" \
          "The cutover retained replica coordinates in every persistence capture but stopped enforcing continuity with the snapshot and prior replay."
      elif [[ "$title" == *"malformed base64"* || "$title" == *"operation-history metadata"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "rejects malformed persistence bytes during replay and operation history before append" \
          "The cutover replay codec remained strict, but newly constructed transaction records bypassed it before durable append."
      elif [[ "$title" == *"does not extend the snapshot revision baseline"* \
        || "$title" == *"persistence revisions and metadata sequences"* \
        || "$title" == *"non-monotonic"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "rejects persistence coordinates that do not extend the replay baseline" \
          "The checksummed transaction sequence retains strict document and metadata coordinate monotonicity."
      elif [[ "$title" == *"version is not contained"* || "$title" == *"recorded version is not reached"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "fails reconstruction when a replay update does not reach its declared Loro version" \
          "Core reconstruction remains the semantic Loro update/version verification boundary."
      elif [[ "$title" == *"grows the log beyond the header read limit"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "appends a transaction batch with one fsync and replays every record after restart" \
          "The JSONL reader consumes the complete durable log rather than a bounded header prefix."
      elif [[ "$title" == *"trailing newline"* || "$title" == *"headerless"* \
        || "$title" == *"whitespace-only"* || "$title" == *"empty update log"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "discards an incomplete tail and truncates it before the next durable append" \
          "The current format repairs only a provably torn tail or empty stale log; complete malformed data fails closed instead of being guessed into shape."
      elif [[ "$title" == *"compaction"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "treats a snapshot rename before log reset as a complete compaction after restart" \
          "The versioned snapshot/log boundary is recoverable at the compaction replacement edge."
      elif [[ "$title" == *"round-trips"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "atomically replays document update Operation idempotency Event and recovery after restart" \
          "One transaction record now persists document and local recovery metadata together."
      else
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "keeps the verified prefix readable and blocks mutation after a complete-record checksum failure" \
          "Checksummed transaction records replace the old header/update-log format and fail closed on non-torn corruption."
      fi
      ;;
    tests/core/workspaceSaver.test.ts)
      if [[ "$title" == *"defers threshold compaction"* || "$title" == *"fresh idle window before retrying compaction"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeProcess.test.ts" \
          "runs foreground-idle storage maintenance while a watch stream holds the Runtime alive" \
          "Threshold compaction now belongs to Runtime foreground-idle maintenance, separately from the accepted-write durability scheduler."
      elif [[ "$title" == *"idle window"* || "$title" == *"max-wait"* || "$title" == *"fresh dirty epoch"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "coalesces sustained accepted edits at the maximum dirty age under one fsync" \
          "Runtime restores the 700 ms idle and five-second maximum dirty-age scheduler."
      elif [[ "$title" == *"replayed update count"* || "$title" == *"durable JSONL size"* ]]; then
        evidence_test "current-evidence" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "uses replayed record count and durable JSONL bytes for compaction thresholds" \
          "The current storage boundary directly freezes both compaction threshold inputs."
      elif [[ "$title" == *"automatic retries"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "freezes writes after deferred acknowledgement failure and retries without executing twice" \
          "The Runtime deliberately replaces invisible automatic backoff with frozen admission, an explicit durability drain, and idempotent retry."
      elif [[ "$title" == *"compaction"* ]]; then
        if [[ "$title" == *"mutation that arrives"* ]]; then
          evidence_test "stronger-replacement" \
            "tests/core/outlineRuntimeWorkspace.test.ts" \
            "accepts a desktop mutation while an idle compaction is in flight" \
            "Captured snapshots and post-snapshot transaction records make accepted desktop mutation safe while physical compaction is in flight."
        elif [[ "$title" == *"metadata captured"* || "$title" == *"failed compaction"* ]]; then
          evidence_test "stronger-replacement" \
            "tests/core/outlineRuntimeWorkspace.test.ts" \
            "retains a desktop mutation accepted while compaction fails after snapshot replacement" \
            "Restart proves the pre-compaction and accepted Operations remain unique and revision-contiguous after replacement failure."
        else
          evidence_test "stronger-replacement" \
            "tests/core/outlineRuntimeWorkspace.test.ts" \
            "accepts a desktop mutation while an idle compaction is in flight" \
            "Snapshot capture is linearized while physical compaction no longer blocks the mutation queue."
        fi
      elif [[ "$title" == *"replacement resnapshot"* || "$title" == *"update log frontier"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "treats a snapshot rename before log reset as a complete compaction after restart" \
          "The versioned snapshot/log boundary makes replacement recoverable without a second mutable-document resnapshot loop."
      elif [[ "$title" == *"yielding transaction"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineChangeSetKernel.test.ts" \
          "rolls back every earlier change when a late operation fails" \
          "The Runtime captures persistence only after the atomic ChangeSet transaction finishes or fully rolls back."
      elif [[ "$title" == *"append failure"* || "$title" == *"retry"* || "$title" == *"waiter"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "freezes writes after deferred acknowledgement failure and retries without executing twice" \
          "Accepted-write failure now freezes admission and retries by durable idempotency rather than an invisible background backoff loop."
      else
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "accepts desktop mutations before transaction-log fsync and drains the durable frontier" \
          "Captured transaction inputs decouple accepted editing from the ordered durability queue."
      fi
      ;;
    tests/core/documentServiceTextSearchIndex.test.ts)
      if [[ "$title" == *"text-search node map"* || "$title" == *"text, tag, and trash"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/documentReadModel.test.ts" \
          "updates text search in place without rebuilding the Node map or index" \
          "The Runtime read model mutates its stable map and text index in place."
      elif [[ "$title" == *"subtree crosses Trash"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/documentReadModel.test.ts" \
          "removes and restores every searchable descendant when a subtree crosses Trash" \
          "Trash dependency closure updates every searchable descendant incrementally."
      elif [[ "$title" == *"tag"* || "$title" == *"field"* || "$title" == *"reference"* || "$title" == *"projected"* || "$title" == *"template"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/documentReadModel.test.ts" \
          "refreshes tag, field, and reference dependents when their labels change" \
          "The Runtime-owned long-lived read model folds sparse deltas into the same projection and text-index generation."
      elif [[ "$title" == *"previous search generation"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/documentReadModel.test.ts" \
          "publishes one complete generation after a yielding bulk refresh" \
          "The previous generation remains readable at every yield until one complete replacement is published."
      elif [[ "$title" == *"revision deltas skip ahead"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/documentReadModel.test.ts" \
          "rejects discontinuous deltas so the owner can reseed" \
          "A discontinuous revision never patches a stale generation; the owner must reseed it."
      elif [[ "$title" == *"yielding bulk"* || "$title" == *"imports trees"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineChangeSetKernel.test.ts" \
          "yields a large import while preserving one searchable and undoable Operation" \
          "Runtime import keeps search publication, atomicity, and one recovery Operation across cooperative yields."
      elif [[ "$title" == *"indexed relevance"* || "$title" == *"live text index"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineDocumentService.test.ts" \
          "uses Runtime-ranked search and keeps sparse Node reads fresh in input order" \
          "Saved Search and table refresh share the maintained Runtime ranker."
      elif [[ "$title" == *"freeze"* || "$title" == *"queued mutations"* || "$title" == *"drain"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "freezes admission behind mutations already queued in the Runtime" \
          "Runtime owns the admission barrier and durable frontier."
      elif [[ "$title" == *"initial snapshot"* || "$title" == *"update log"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "atomically replays document update Operation idempotency Event and recovery after restart" \
          "The transaction log replaces DocumentService snapshot/update-log persistence."
      else
        evidence_test "stronger-replacement" \
          "tests/core/documentReadModel.test.ts" \
          "publishes one complete generation after a yielding bulk refresh" \
          "Bulk imports and index refreshes publish one complete read generation."
      fi
      ;;
    tests/core/documentServiceProjectionRouting.test.ts)
      if [[ "$title" == *"renderer-originated"* || "$title" == *"main-owned"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/renderer/outlineDesktopClient.test.ts" \
          "maps exact Runtime Event changes onto the existing delta reducer contract" \
          "Origin-tagged DocumentService broadcasts were replaced by ordered Runtime Events and desktop delta adaptation."
      elif [[ "$title" == *"keeps the document read model fresh"* \
        || "$title" == *"$legacy_read_tool through the read model"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineDocumentService.test.ts" \
          "uses Runtime-ranked search and keeps sparse Node reads fresh in input order" \
          "Runtime maintains the sparse read model independently of renderer projection listeners."
      elif [[ "$title" == *"delivers projection listeners before isolating observer failures"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "keeps a committed mutation successful when the observer commit fails" \
          "Ordered Runtime publication remains committed while observer failure is isolated from mutation settlement."
      elif [[ "$title" == *"plain typing"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/agentMemory.test.ts" \
          "reconciles Runtime projection events without full graph scans" \
          "Memory now consumes sparse Runtime Events and does not receive a parallel typing projection."
      elif [[ "$title" == *"through command deltas"* || "$title" == *"target-reference $legacy_create_tool"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineChangeSetKernel.test.ts" \
          "keeps accepted desktop commits off the full Core Projection path" \
          "Accepted public ChangeSets resolve targets and publish sparse deltas without rebuilding or fanning out the full Projection."
      else
        evidence_test "stronger-replacement" \
          "tests/core/outlineDocumentService.test.ts" \
          "uses Runtime-ranked search and keeps sparse Node reads fresh in input order" \
          "Desktop, Agent, and search reads share the Runtime read model rather than DocumentService adapters."
      fi
      ;;
    tests/core/assetService.test.ts)
      if [[ "$title" == *"asset:// URL hostname"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/assets.test.ts" \
          "round-trips Runtime logical IDs through one encoded path segment" \
          "The cutover introduced colon-bearing IDs that were invalid in the former hostname URL shape."
      elif [[ "$title" == *"PDF page"* || "$title" == *"WAV duration"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/outlineAssets.test.ts" \
          "derives metadata that follows the bounded ingestion head without loading the whole asset" \
          "Bounded-head ingestion now restores tail metadata through streamed or random-access parsing."
      elif [[ "$title" == *"PNG and GIF"* ]]; then
        evidence_test "current-evidence" \
          "tests/core/assetMetadata.test.ts" \
          "derives image dimensions, PDF page count, and WAV duration" \
          "PNG and GIF dimensions remain header-local and are preserved by the shared metadata helper."
      elif [[ "$title" == *"ingests an image buffer"* || "$title" == *"fresh service verifies"* || "$title" == *"content identity"* || "$title" == *"returned metadata"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineAssets.test.ts" \
          "persists immutable logical metadata with verified bytes across Runtime restart" \
          "Runtime ingestion preserves metadata and logical Asset identity across restart while ContentStore owns immutable physical bytes."
      elif [[ "$title" == *"path ingest"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineCli.test.ts" \
          "streams asset ingest, get, and verified export through the Runtime" \
          "The public Runtime path-ingest workflow preserves filename MIME inference, logical identity, and verified bytes."
      elif [[ "$title" == *"delete removes"* ]]; then
        evidence_retirement \
          "docs/spec/architecture.md" \
          "There is no public physical-delete capability." \
          "Sidecars and public physical deletion were retired in favor of logical AssetRecords, anchors, leases, and central GC."
      elif [[ "$title" == *"sidecar"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineAssets.test.ts" \
          "degrades only invalid AssetRecord metadata while retaining shared exact bytes" \
          "Checksummed Runtime AssetRecords replace sidecars; invalid logical metadata cannot bypass exact-byte verification or damage healthy records."
      elif [[ "$title" == *"serve streams"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeProcess.test.ts" \
          "streams verified AssetRecord bytes with browser-compatible range responses" \
          "Runtime AssetRecords now stream verified ranges across the authenticated process boundary."
      elif [[ "$title" == *"falls back to octet-stream"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineAssets.test.ts" \
          "uses octet-stream for asset bytes without a recognizable type" \
          "Runtime ingestion retains the portable fallback for unknown bytes."
      elif [[ "$title" == *"refuses to serve an asset file symlink"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/contentStore.test.ts" \
          "rejects a revision symlink without reading outside the ContentStore" \
          "ContentStore derives the physical path and rejects non-regular revisions before serving bytes."
      elif [[ "$title" == *"magic bytes"* ]]; then
        evidence_test "current-evidence" \
          "tests/core/assetMetadata.test.ts" \
          "detects common formats by magic bytes before filename fallback" \
          "Shared metadata helpers retain magic-byte precedence and filename fallback."
      elif [[ "$title" == *"filename extension"* || "$title" == *"EPUB"* || "$title" == *"unsupported types"* ]]; then
        evidence_test "current-evidence" \
          "tests/core/assetMetadata.test.ts" \
          "uses filename fallback while keeping EPUB distinct from ZIP" \
          "Shared metadata helpers retain filename fallback, EPUB specialization, and unsupported-type handling."
      elif [[ "$title" == *"preview MIME"* ]]; then
        evidence_test "current-evidence" \
          "tests/core/assetMetadata.test.ts" \
          "keeps media filename inference aligned with ingestion" \
          "Preview and ingestion share one filename MIME registry."
      else
        evidence_test "stronger-replacement" \
          "tests/core/contentStore.test.ts" \
          "quarantines physical corruption for every reference without changing anchor identity" \
          "ContentStore verification and immutable anchor identity replace mutable sidecar caches and path lookup."
      fi
      ;;
    tests/core/outlineAssets.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/outlineAssets.test.ts" \
        "deduplicates exact revisions while keeping logical records and leases distinct" \
        "Exact-revision deduplication is explicitly separated from logical AssetRecord identity."
      ;;
    tests/renderer/createAssetNode.test.ts)
      evidence_test "stronger-replacement" \
        "tests/renderer/createAssetNode.test.ts" \
        "routes a non-image asset to the attachment intent with full metadata" \
        "The renderer now emits typed Runtime intents while preserving complete metadata routing."
      ;;
    tests/core/contentStore.test.ts)
      if [[ "$title" == *"retains live pre-claim staging and reclaims it after the writer is killed"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/contentStore.test.ts" \
          "retains live pre-claim staging and durably reclaims it after the writer is killed" \
          "The same owner-liveness boundary now also proves the staging unlink is durable."
      else
        evidence_test "current-evidence" \
          "tests/core/contentStore.test.ts" \
          "retains admission before anchor creation and collects it only after lease expiry" \
          "ContentStore retains incomplete admission state until its writer lease can be safely reclaimed."
      fi
      ;;
    tests/core/agentImportService.test.ts)
      if [[ "$title" == *"local API"* || "$title" == *"native_daily"* || "$title" == *"atomic host seam"* ]]; then
        evidence_retirement \
          "docs/plans/outliner-runtime-recovery.md" \
          "Import Pack mutation APIs and the \`$legacy_skill_name\` writer" \
          "The scenario-specific import mutation API was retired; import is generic ChangeSet composition."
      elif [[ "$title" == *"causation"* || "$title" == *"root Agent Bash"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineCli.test.ts" \
          "forwards shell Item attestation outside public input and records Agent causation" \
          "Host-issued attestation replaces raw import-API causation tokens."
      elif [[ "$title" == *"scales import yield chunks"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/core.test.ts" \
          "yielding tree materialization caches pasted field resolution for config-heavy imports" \
          "The shared materializer replaces fixed estimated costs with cached field resolution and bounded node slices."
      elif [[ "$title" == *"previews and atomically appends"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/builtInSkillScripts.test.ts" \
          "atomically appends normalized import rows to existing and new Daily Notes" \
          "The public import plan composes existing and newly ensured dates into one verified and reversible Operation."
      elif [[ "$title" == *"re-imports native Daily Note packs"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/builtInSkillScripts.test.ts" \
          "atomically appends normalized import rows to existing and new Daily Notes" \
          "The public import workflow appends a second copy on a fresh plan and independently reverts each Operation."
      elif [[ "$title" == *"rejects malformed packs"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/builtInSkillScripts.test.ts" \
          "rejects malformed normalized input before Runtime mutation" \
          "The public normalized-input boundary rejects malformed source data before creating an Operation or changing document state."
      elif [[ "$title" == *"canonical duplicate tags and fields"* \
        || "$title" == *"retained staging root"* \
        || "$title" == *"staged verification failure data"* ]]; then
        evidence_retirement \
          "docs/plans/outliner-runtime-recovery.md" \
          "Import Pack mutation APIs and the \`$legacy_skill_name\` writer" \
          "Import Pack canonical-definition and retained-staging semantics were retired with that scenario-specific writer; generic normalized ChangeSets and exact revert own recovery."
      elif [[ "$title" == *"rolls back native Daily Note scaffolding"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/core.test.ts" \
          "yielding Daily Note import rolls back date scaffolding and tree chunks together" \
          "The shared transaction boundary rolls back both date scaffolding and committed tree chunks after a late yield failure."
      elif [[ "$title" == *"rolls back every materialization chunk"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/core.test.ts" \
          "yielding resolved content trees roll back every committed chunk after a late failure" \
          "The shared yielding materializer retains one rollback frontier across committed chunks."
      elif [[ "$title" == *"102 Daily Notes"* || "$title" == *"12,240"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineChangeSetKernel.test.ts" \
          "yields a large import while preserving one searchable and undoable Operation" \
          "One generic ChangeSet covers a large import with cooperative slices, indexed publication, and one durable undo intent."
      elif [[ "$title" == *"rollback"* || "$title" == *"atomically"* || "$title" == *"failure"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineChangeSetKernel.test.ts" \
          "rolls back every earlier change when a late operation fails" \
          "The generic ChangeSet rollback frontier replaces chunk-specific import rollback."
      else
        evidence_test "stronger-replacement" \
          "tests/core/builtInSkillScripts.test.ts" \
          "imports representative Tana data through public plan, apply, verify, and exact revert" \
          "Public inspect, plan, apply, verify, and revert replace Import Pack preview/commit endpoints."
      fi
      ;;
    tests/core/builtInSkillScripts.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/builtInSkillScripts.test.ts" \
        "imports representative Tana data through public plan, apply, verify, and exact revert" \
        "The consolidated outline Skill preserves normalized/Tana import with evidence-bound apply and verification."
      ;;
    "$legacy_runtime_test"|tests/core/outlineRuntime.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/outlineRuntime.test.ts" \
        "runs packaged CLI, Runtime, and source adapter bundles through one launcher" \
        "The packaged public launcher replaces the renamed import-only wrapper."
      ;;
    tests/core/agentSkills.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/agentSkills.test.ts" \
        "stages the complete public outline workflow into one packaged Skill" \
        "One immutable outline Skill replaces $legacy_skill_name while retaining both public workflows."
      ;;
    tests/core/documentSystemContract.test.ts)
      if [[ "$title" == *"trusted commands"* \
        || "$title" == *"deterministic keys and canonical receipt"* \
        || "$title" == *"feature payloads and noncanonical digests"* ]]; then
        evidence_retirement \
          "docs/plans/outliner-runtime-recovery.md" \
          "Memory mutation authorization as a second Outliner permission model" \
          "The private trusted-command and receipt protocol was retired; public Runtime Changes plus attested causation own the current boundary."
      elif [[ "$title" == *"locks definition identity mutations"* \
        || "$title" == *"resolves create, same-id restore, and idempotent ensure"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineChangeSetCapabilities.test.ts" \
          "protects deterministic Memory tags while permitting ordinary tag application" \
          "Runtime ensure and protected-definition admission preserve fixed identities while ordinary Nodes may still apply the tags."
      else
        evidence_test "stronger-replacement" \
          "tests/core/outlineChangeSetCapabilities.test.ts" \
          "keeps explicit definition IDs stable and rejects same-name ID conflicts without writing" \
          "Public Runtime ensure fails closed on name, type, and identity conflicts before writing."
      fi
      ;;
    tests/core/documentSystemRuntime.test.ts)
      if [[ "$title" == *"holds the host mutation coordinator through validation and document commit"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/outlineDocumentService.test.ts" \
          "plans Memory publication after earlier document mutations have updated the projection" \
          "The cutover kept the Memory-local gate but lost its linearization with ordinary DocumentService mutations; queued planning now captures one post-pending projection and revision."
      elif [[ "$title" == *"resolves every exact undo"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "scopes undo by origin and guards the selected Operation" \
          "Runtime selects one durable Operation by origin and exact expected ID before executing its guarded recovery patch."
      elif [[ "$title" == *"preflights branched multi-step history"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "reconstructs consecutive undo and redo history across Runtime restart" \
          "Durable Operation/revert chains replace the process-local Loro stack and reconstruct branch state across restart."
      elif [[ "$title" == *"no journal metadata"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineWorkspaceTransactionLog.test.ts" \
          "atomically replays document update Operation idempotency Event and recovery after restart" \
          "One checksummed transaction record atomically admits the update and its Operation/recovery metadata, so executable history cannot lack journal identity."
      elif [[ "$title" == *"ensures deterministic protected tags"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/outlineChangeSetCapabilities.test.ts" \
          "protects deterministic Memory tags while permitting ordinary tag application" \
          "The cutover retained fixed Memory tag IDs but removed their mutation protection; Runtime now enforces it across ChangeSet and revert paths."
      elif [[ "$title" == *"Memory guard"* || "$title" == *"mutation authorization"* || "$title" == *"Memory sensitivity"* || "$title" == *"undo metadata"* ]]; then
        evidence_retirement \
          "docs/plans/outliner-runtime-recovery.md" \
          "Memory mutation authorization as a second Outliner permission model" \
          "Memory no longer owns a second document authorization/history model; Runtime causation and public validation are authoritative."
      elif [[ "$title" == *"receipt"* || "$title" == *"durable acknowledgement"* || "$title" == *"committed trusted mutation"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/agentMemory.test.ts" \
          "finalizes an unknown-settlement publication from its idempotency receipt without writing twice" \
          "Prepared publication resolves through Runtime idempotency after uncertain durable settlement."
      elif [[ "$title" == *"mirrors transaction deltas"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/agentMemory.test.ts" \
          "reconciles Runtime projection events without full graph scans" \
          "Memory consumes immutable sparse Runtime Events instead of a second transaction-delta collector."
      elif [[ "$title" == *"preserves net-zero transactions"* ]]; then
        evidence_retirement \
          "docs/plans/outliner-runtime-recovery.md" \
          "one ordered accepted update and focus outcome" \
          "Runtime publishes only the atomic settled update; private intermediate observer deltas from a net-zero transaction no longer exist."
      elif [[ "$title" == *"persists Agent Turn causation"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeProcess.test.ts" \
          "records immutable Agent causation and consumes one attestation after a successful mutation" \
          "The Runtime persists immutable attested Agent causation directly on the committed Operation."
      elif [[ "$title" == *"observer"* || "$title" == *"deltas"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "keeps a committed mutation successful when the observer commit fails" \
          "Runtime Event observers are isolated from durable mutation settlement."
      else
        evidence_test "stronger-replacement" \
          "tests/core/agentMemory.test.ts" \
          "publishes created consolidation Nodes with durable evidence lineage" \
          "Memory publication uses one ordinary durable Runtime ChangeSet plus its control-store journal."
      fi
      ;;
    tests/core/agentMemory.test.ts)
      if [[ "$title" == *"projection filtering"* || "$title" == *"filtered read views"* || "$title" == *"projection root-only"* ]]; then
        evidence_retirement \
          "docs/spec/agent-tool-design.md" \
          "Memory adds no parallel tools and no Agent-specific document projection filter." \
          "The public document projection is actor-neutral; rollback suppression remains internal pipeline state."
      elif [[ "$title" == *"eligible foreground Memory writes"* || "$title" == *"Memory Node mutation"* ]]; then
        evidence_retirement \
          "docs/plans/outliner-runtime-recovery.md" \
          "Memory mutation authorization as a second Outliner permission model" \
          "Runtime authorization and attested causation replace the second Memory mutation permission model."
      elif [[ "$title" == *"routes Memory lookup"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/agentMemory.test.ts" \
          "routes Memory lookup without injecting prose and counts only an inline citation of an exact get" \
          "The cutover removed the production read/citation hooks; the public outline get path now restores exact cited-read accounting."
      elif [[ "$title" == *"deduplicates actually read Memory Nodes"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/agentMemory.test.ts" \
          "deduplicates shown Memory Nodes and bounds inline citation accounting" \
          "The restored production hook deduplicates and bounds successful Memory show results before citation accounting."
      elif [[ "$title" == *"does not count ordinary Nodes"* \
        || "$title" == *"citation"* \
        || "$title" == *"lookup"* \
        || "$title" == *"read Memory"* ]]; then
        evidence_test "confirmed-regression-fixed" \
          "tests/core/agentMemory.test.ts" \
          "does not count find results, ordinary Nodes, failed gets, or uncited Memory reads" \
          "The restored production hook retains negative filtering while retrieval uses the public CLI."
      elif [[ "$title" == *"Reset"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/agentMemory.test.ts" \
          "persists immutable admission, disable intervals, and reset barriers" \
          "Immutable admission epochs and reset barriers reject stale work."
      elif [[ "$title" == *"filters rollback-invalidated"* \
        || "$title" == *"targeted Turn read"* \
        || "$title" == *"cached explicit references"* \
        || "$title" == *"recovers canonical references"* ]]; then
        evidence_retirement \
          "docs/spec/agent-tool-design.md" \
          "Memory adds no parallel tools and no Agent-specific document projection filter." \
          "Actor-neutral Runtime projections deliberately replace per-Turn Memory filtering and its notification cache."
      elif [[ "$title" == *"reserved Memory tag names"* \
        || "$title" == *"feature Turns"* \
        || "$title" == *"Memory mutations by command targets"* \
        || "$title" == *"persisted history semantics"* \
        || "$title" == *"protects the day tag"* \
        || "$title" == *"transaction membership through the overlay"* \
        || "$title" == *"field slot writes by mutated nodes"* \
        || "$title" == *"by-name tag classification"* ]]; then
        evidence_retirement \
          "docs/plans/outliner-runtime-recovery.md" \
          "Memory mutation authorization as a second Outliner permission model" \
          "Runtime causation and public mutation validation deliberately replace the private command-target authorization index."
      elif [[ "$title" == *"plain typing projection-free"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/agentMemory.test.ts" \
          "reconciles Runtime projection events without full graph scans" \
          "Sparse Runtime Events preserve projection-free typing and synchronous derived reconciliation without a second document observer."
      else
        evidence_test "stronger-replacement" \
          "tests/core/agentMemory.test.ts" \
          "keeps incremental mutation membership equivalent to a full projection scan" \
          "Sparse Runtime Event classification replaces the old overlay/filter implementation."
      fi
      ;;
    tests/core/agentDocumentBeliefs.test.ts|tests/core/agentContextCompaction.test.ts)
      evidence_retirement \
        "docs/spec/agent-core.md" \
        "Agent Core does not maintain a second document-belief or drift-notice subsystem." \
        "Revisioned public reads and write preconditions replace replayed document beliefs."
      ;;
    tests/core/agentToolRuntimeProjectionFilter.test.ts)
      evidence_retirement \
        "docs/spec/agent-tool-design.md" \
        "Memory adds no parallel tools and no Agent-specific document projection filter." \
        "Projection, maintained reads, and text search now have one actor-neutral Runtime generation."
      ;;
    tests/core/agentThreadService.test.ts)
      if [[ "$title" == *"binds document tool mutations"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineCli.test.ts" \
          "forwards shell Item attestation outside public input and records Agent causation" \
          "Runtime Operations preserve immutable Thread, Turn, and Item causation."
      else
        evidence_retirement \
          "docs/spec/agent-core.md" \
          "Agent Core does not maintain a second document-belief or drift-notice subsystem." \
          "Drift notices and belief reconstruction were deliberately retired."
      fi
      ;;
    tests/core/outlineCli.test.ts)
      if [[ "$title" == *"history"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineCli.test.ts" \
          "queries history by idempotency key and runs guarded revert, undo, and redo" \
          "The current CLI exposes durable history and stable unavailable behavior."
      else
        evidence_test "stronger-replacement" \
          "tests/core/outlineCli.test.ts" \
          "runs read, direct commit, Diff, apply, and streaming export through the public CLI grammar" \
          "The current grammar adds direct commit while retaining read, Diff, apply, and export."
      fi
      ;;
    tests/core/agentCapabilities.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/agentCapabilities.test.ts" \
        "classifies outline shell commands from the public capability registry" \
        "Host classification derives from the public outline registry rather than $legacy_skill_name command text."
      ;;
    tests/core/agentCodexTools.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/agentCapabilities.test.ts" \
        "classifies outline shell commands from the public capability registry" \
        "Dynamic native outline undo mapping was replaced by registry-classified CLI history commands."
      ;;
    tests/core/agentSubagentToolPolicy.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/agentSubagentToolPolicy.test.ts" \
        "keeps the ordinary tool catalog stable across worktree isolation" \
        "Worktree containment is enforced at host action admission without a reduced Outline schema."
      ;;
    tests/core/agentToolCatalogStability.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/agentToolCatalogStability.test.ts" \
        "keeps data import behind the public Skill and CLI boundary" \
        "The current catalog guard freezes import behind the public Skill/CLI boundary."
      ;;
    tests/core/workspaceTodayPersistence.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/workspaceTodayPersistence.test.ts" \
        "the today node id is stable across a Runtime reopen with no mutations in between" \
        "Runtime startup compacts reconciled system state before accepting dependent writes."
      ;;
    tests/e2e/agent-thread.spec.ts)
      evidence_test "stronger-replacement" \
        "tests/e2e/agent-thread.spec.ts" \
        "renders used Memory as an inline Node reference while keeping supporting work in the process" \
        "Memory remains inspectable as ordinary Node references while native $legacy_read_tool is retired."
      ;;
    tests/e2e/outliner-triggers.spec.ts)
      if [[ "$title" == \#* ]]; then
        evidence_test "stronger-replacement" \
          "tests/e2e/outliner-triggers.spec.ts" \
          "# resolves through the shared structural transaction without remounting the editor" \
          "Optimistic tag materialization preserves draft and editor identity through Runtime settlement."
      elif [[ "$title" == @* ]]; then
        evidence_test "stronger-replacement" \
          "tests/e2e/outliner-triggers.spec.ts" \
          "@ resolves through the shared structural transaction without remounting the editor" \
          "Optimistic reference conversion preserves draft and editor identity through Runtime settlement."
      else
        evidence_test "stronger-replacement" \
          "tests/e2e/outliner-triggers.spec.ts" \
          "> in field value creates a nested field row" \
          "Empty field-name support and the shared field-slot transaction replace the former fallback."
      fi
      ;;
    tests/renderer/outlineDesktopClient.test.ts)
      evidence_test "stronger-replacement" \
        "tests/renderer/outlineDesktopClient.test.ts" \
        "returns an accepted desktop delta before the durable Operation Event arrives" \
        "The desktop adapter serializes ChangeSets at the folded revision and reconciles accepted/durable settlement once."
      ;;
    tests/renderer/threadDocumentIndex.test.tsx)
      evidence_test "stronger-replacement" \
        "tests/renderer/threadDocumentIndex.test.tsx" \
        "refreshes reference chips and derived color" \
        "The live document index still refreshes every visible Node-derived surface."
      ;;
    tests/renderer/threadToolCopy.test.ts)
      evidence_test "stronger-replacement" \
        "tests/renderer/threadToolCopy.test.ts" \
        "the tooltip carries the full subject list the label elided" \
        "Typed payload-backed tool subjects replace native node-search subject inference while preserving deduplication and copy detail."
      ;;
    tests/renderer/referenceSelectorReachability.test.tsx)
      evidence_test "stronger-replacement" \
        "tests/renderer/referenceSelectorReachability.test.tsx" \
        "keeps cold candidates inert without reordering or replacing the selected candidate" \
        "The current selection contract strengthens the old reset behavior by preserving both order and selected identity while reachability is cold."
      ;;
    tests/core/outlineRuntimeWorkspace.test.ts)
      if [[ "$title" == *"prunes eligible recovery"* ]]; then
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "prunes eligible recovery during restarted maintenance with the new Runtime identity" \
          "The renamed test additionally verifies restart and Runtime identity."
      else
        evidence_test "stronger-replacement" \
          "tests/core/outlineRuntimeWorkspace.test.ts" \
          "does not reverse a durable Operation when later compaction maintenance fails" \
          "The renamed test keeps post-settlement maintenance failure non-transactional."
      fi
      ;;
    tests/core/outlineCliGoldenFlows.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/outlineCliGoldenFlows.test.ts" \
        "2. executes the documented Daily Note table ChangeSet through one Diff and one apply" \
        "The canonical table fixture now executes the documented Daily Note workflow."
      ;;
    tests/core/outlineChangeSetKernel.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/outlineChangeSetKernel.test.ts" \
        "returns a Node and its backlinks in separately bounded Projection pages" \
        "Node and backlink pages now carry independent bounds at one revision."
      ;;
    tests/core/claudeSubagentParityFixtures.test.ts)
      evidence_test "stronger-replacement" \
        "tests/core/claudeSubagentParityFixtures.test.ts" \
        "keeps launch helpers byte-aligned while lowering child output to typed context" \
        "The current fixture separates captured bytes from normalized typed output evidence."
      ;;
    *)
      ;;
  esac
}
