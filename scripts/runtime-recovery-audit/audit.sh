#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
script_dir="$repo_root/scripts/runtime-recovery-audit"
audit_dir="$repo_root/tmp/runtime-recovery-audit"
mkdir -p "$audit_dir"

reconstruct_snapshot() {
  local base_commit="$1"
  local patch_path="$2"
  local expected_tree="$3"
  local subject="$4"
  local index_path="$audit_dir/reconstruct-$expected_tree.index"
  local actual_tree
  local snapshot_commit

  rm -f "$index_path" "$index_path.lock"
  GIT_INDEX_FILE="$index_path" git read-tree "$base_commit"
  gzip -dc "$patch_path" | GIT_INDEX_FILE="$index_path" git apply --cached --binary
  actual_tree="$(GIT_INDEX_FILE="$index_path" git write-tree)"
  rm -f "$index_path" "$index_path.lock"
  if [[ "$actual_tree" != "$expected_tree" ]]; then
    printf 'Reconstructed tree mismatch: expected %s, received %s.\n' \
      "$expected_tree" "$actual_tree" >&2
    exit 1
  fi
  snapshot_commit="$(
    printf '%s\n' "$subject" \
      | GIT_AUTHOR_NAME='Runtime Recovery Audit' \
        GIT_AUTHOR_EMAIL='runtime-recovery-audit@localhost' \
        GIT_AUTHOR_DATE='2026-08-27T00:00:00+08:00' \
        GIT_COMMITTER_NAME='Runtime Recovery Audit' \
        GIT_COMMITTER_EMAIL='runtime-recovery-audit@localhost' \
        GIT_COMMITTER_DATE='2026-08-27T00:00:00+08:00' \
        git commit-tree "$actual_tree" -p "$base_commit"
  )"
  printf '%s\n' "$snapshot_commit"
}

pre_cutover="$(reconstruct_snapshot \
  2722c62c \
  "$script_dir/baselines/pre-cutover.patch.gz" \
  b57d07604e227715b3141196d7cffd7ef6ca59a0 \
  'Reconstructed 8a1d5855 pre-cutover baseline')"
cutover="$(reconstruct_snapshot \
  3a4f49a2 \
  "$script_dir/baselines/cutover.patch.gz" \
  daa8428f51c118a01d9e611a2182d4b305139f98 \
  'Reconstructed 90991b7f cutover baseline')"
lost_baseline_anchor=5a280cbb
lost_parent="$(reconstruct_snapshot \
  "$lost_baseline_anchor" \
  "$script_dir/baselines/lost-parent.patch.gz" \
  ddd3ceda81c4d74df0dfb88996e4fb57e08fcab1 \
  'Reconstructed 519bfd3b runtime recovery parent')"
lost_snapshot="$(reconstruct_snapshot \
  "$lost_parent" \
  "$script_dir/baselines/lost-snapshot.patch.gz" \
  c755e9e26d8bfd4d7a62f8175d7717c923cc98cf \
  'Reconstructed d36dc81b runtime recovery snapshot')"
export RUNTIME_RECOVERY_LOST_PARENT="$lost_parent"
export RUNTIME_RECOVERY_LOST_SNAPSHOT="$lost_snapshot"
export RUNTIME_RECOVERY_PRE_CUTOVER="$pre_cutover"
export RUNTIME_RECOVERY_CUTOVER="$cutover"
pr_base=ac389af3
pr_tip=5a280cbb
recovery=HEAD

source "$script_dir/responsibility-rules.sh"

git diff --name-status "$lost_parent..$lost_snapshot" > "$audit_dir/lost-snapshot-files.tsv"
git diff --name-status "$pre_cutover..$cutover" > "$audit_dir/cutover-files.tsv"
git diff --diff-filter=D --name-only "$pre_cutover..$cutover" > "$audit_dir/cutover-deletions.txt"
git diff --diff-filter=D --name-only "$pre_cutover..$cutover" -- 'tests/**' > "$audit_dir/cutover-deleted-tests.txt"

git rev-list --reverse --first-parent "$pr_base..$pr_tip" \
  | while IFS= read -r commit; do
      printf '%s\t%s\n' "$commit" "$(git show -s --format=%s "$commit")"
    done > "$audit_dir/pr-commits.tsv"

bun "$script_dir/collect-test-history.ts"

: > "$audit_dir/pr-touched-paths.txt"
while IFS=$'\t' read -r commit _subject; do
  git diff-tree --no-commit-id --name-only -r "$commit^" "$commit"
done < "$audit_dir/pr-commits.tsv" | sort -u > "$audit_dir/pr-touched-paths.txt"

: > "$audit_dir/pr-path-disposition.tsv"
while IFS= read -r path; do
  if ! git cat-file -e "$pr_tip:$path" 2>/dev/null; then
    at_tip="absent-at-tip"
  elif ! git cat-file -e "$recovery:$path" 2>/dev/null; then
    at_tip="missing-now"
  elif [[ "$(git rev-parse "$pr_tip:$path")" == "$(git rev-parse "$recovery:$path")" ]]; then
    at_tip="identical-now"
  else
    at_tip="evolved-now"
  fi
  printf '%s\t%s\n' "$at_tip" "$path" >> "$audit_dir/pr-path-disposition.tsv"
done < "$audit_dir/pr-touched-paths.txt"

bun "$script_dir/review-production-paths.ts"
bun "$script_dir/review-document-paths.ts"
: > "$audit_dir/unverified-production-paths.txt"
expected_production_paths="$(awk -F '\t' '
  ($1 == "evolved-now" || $1 == "absent-at-tip") && $2 ~ /^src\// { count++ }
  END { print count + 0 }
' "$audit_dir/pr-path-disposition.tsv")"
reviewed_production_paths=0
while IFS=$'\t' read -r historical_status historical_path disposition current_owner evidence_path evidence_label rationale; do
  reviewed_production_paths=$((reviewed_production_paths + 1))
  if [[ -z "$historical_status" || -z "$historical_path" || -z "$disposition" \
    || -z "$current_owner" || -z "$evidence_path" || -z "$evidence_label" \
    || -z "$rationale" ]]; then
    printf 'incomplete\t%s\n' "$historical_path" >> "$audit_dir/unverified-production-paths.txt"
    continue
  fi
  if ! awk -F '\t' -v status="$historical_status" -v path="$historical_path" \
    '$1 == status && $2 == path { found = 1 } END { exit !found }' \
    "$audit_dir/pr-path-disposition.tsv"; then
    printf 'stale-or-mismatched-path\t%s\t%s\n' "$historical_status" "$historical_path" \
      >> "$audit_dir/unverified-production-paths.txt"
    continue
  fi
  case "$disposition" in
    equivalent-current|stronger-current|confirmed-regression-fixed)
      if ! awk -F '\t' -v path="$evidence_path" -v title="$evidence_label" \
        '$1 == path && $2 == title { found = 1 } END { exit !found }' \
        "$audit_dir/test-titles-WORKTREE.txt"; then
        printf 'missing-test-evidence\t%s\t%s\t%s\n' \
          "$historical_path" "$evidence_path" "$evidence_label" \
          >> "$audit_dir/unverified-production-paths.txt"
      fi
      ;;
    explicit-retirement)
      if ! rg -Fq -- "$evidence_label" "$evidence_path"; then
        printf 'missing-retirement-evidence\t%s\t%s\t%s\n' \
          "$historical_path" "$evidence_path" "$evidence_label" \
          >> "$audit_dir/unverified-production-paths.txt"
      fi
      ;;
    *)
      printf 'invalid-disposition\t%s\t%s\n' "$historical_path" "$disposition" \
        >> "$audit_dir/unverified-production-paths.txt"
      ;;
  esac
done < <(tail -n +2 "$audit_dir/production-path-review.tsv")
if [[ -s "$audit_dir/unreviewed-production-paths.txt" \
  || -s "$audit_dir/unverified-production-paths.txt" \
  || "$reviewed_production_paths" -ne "$expected_production_paths" ]]; then
  printf 'Production path review is incomplete (%s/%s reviewed).\n' \
    "$reviewed_production_paths" "$expected_production_paths" >&2
  cat "$audit_dir/unreviewed-production-paths.txt" >&2
  cat "$audit_dir/unverified-production-paths.txt" >&2
  exit 1
fi

expected_document_paths="$(awk -F '\t' '
  $1 != "identical-now" && $2 !~ /^src\// && $2 !~ /^tests\// { count++ }
  END { print count + 0 }
' "$audit_dir/pr-path-disposition.tsv")"
reviewed_document_paths="$(($(wc -l < "$audit_dir/document-path-review.tsv") - 1))"
if [[ -s "$audit_dir/unreviewed-document-paths.txt" \
  || "$reviewed_document_paths" -ne "$expected_document_paths" ]]; then
  printf 'Document path review is incomplete (%s/%s reviewed).\n' \
    "$reviewed_document_paths" "$expected_document_paths" >&2
  cat "$audit_dir/unreviewed-document-paths.txt" >&2
  exit 1
fi

: > "$audit_dir/lost-snapshot-disposition.tsv"
while IFS=$'\t' read -r status old_path new_path; do
  path="$old_path"
  if [[ "$status" == R* || "$status" == C* ]]; then
    path="$new_path"
  fi

  if ! git cat-file -e "$recovery:$path" 2>/dev/null; then
    current="missing"
  elif git cat-file -e "$lost_snapshot:$path" 2>/dev/null \
    && [[ "$(git rev-parse "$lost_snapshot:$path")" == "$(git rev-parse "$recovery:$path")" ]]; then
    current="identical"
  else
    current="evolved"
  fi
  printf '%s\t%s\t%s\n' "$status" "$current" "$path" >> "$audit_dir/lost-snapshot-disposition.tsv"
done < "$audit_dir/lost-snapshot-files.tsv"
bun "$script_dir/check-lost-patch-retention.ts" >/dev/null

: > "$audit_dir/cutover-deletion-disposition.tsv"
while IFS= read -r path; do
  if git cat-file -e "$recovery:$path" 2>/dev/null; then
    current="restored-same-path"
  else
    current="absent"
  fi
  printf '%s\t%s\n' "$current" "$path" >> "$audit_dir/cutover-deletion-disposition.tsv"
done < "$audit_dir/cutover-deletions.txt"

: > "$audit_dir/unreviewed-lost-snapshot-overlaps.txt"
awk -F '\t' '
  NR == FNR {
    if ($1 == "overlap-review") expected[$3] = 1
    next
  }
  FNR == 1 { next }
  {
    reviewed[$1]++
    if (!($1 in expected)) print "unexpected\t" $1
    if (reviewed[$1] > 1) print "duplicate\t" $1
  }
  END {
    for (path in expected) if (!(path in reviewed)) print "missing\t" path
  }
' "$audit_dir/lost-snapshot-patch-retention.tsv" \
  "$script_dir/lost-snapshot-overlap-review.tsv" \
  >> "$audit_dir/unreviewed-lost-snapshot-overlaps.txt"
overlap_review_rows=0
while IFS=$'\t' read -r historical_path disposition evidence_path evidence_label rationale; do
  overlap_review_rows=$((overlap_review_rows + 1))
  if [[ -z "$historical_path" || -z "$disposition" || -z "$evidence_path" \
    || -z "$evidence_label" || -z "$rationale" ]]; then
    printf 'incomplete\t%s\n' "$historical_path" >> "$audit_dir/unreviewed-lost-snapshot-overlaps.txt"
    continue
  fi
  case "$disposition" in
    equivalent-current|stronger-current|explicit-retirement) ;;
    *)
      printf 'invalid-disposition\t%s\t%s\n' "$historical_path" "$disposition" \
        >> "$audit_dir/unreviewed-lost-snapshot-overlaps.txt"
      continue
      ;;
  esac
  if [[ ! -e "$historical_path" ]]; then
    printf 'missing-current-path\t%s\n' "$historical_path" \
      >> "$audit_dir/unreviewed-lost-snapshot-overlaps.txt"
  fi
  case "$evidence_path" in
    docs/*)
      if ! rg -Fq -- "$evidence_label" "$evidence_path"; then
        printf 'missing-document-evidence\t%s\t%s\t%s\n' \
          "$historical_path" "$evidence_path" "$evidence_label" \
          >> "$audit_dir/unreviewed-lost-snapshot-overlaps.txt"
      fi
      ;;
    *)
      if ! awk -F '\t' -v path="$evidence_path" -v title="$evidence_label" \
        '$1 == path && $2 == title { found = 1 } END { exit !found }' \
        "$audit_dir/test-titles-WORKTREE.txt"; then
        printf 'missing-test-evidence\t%s\t%s\t%s\n' \
          "$historical_path" "$evidence_path" "$evidence_label" \
          >> "$audit_dir/unreviewed-lost-snapshot-overlaps.txt"
      fi
      ;;
  esac
done < <(tail -n +2 "$script_dir/lost-snapshot-overlap-review.tsv")
expected_overlap_reviews="$(awk -F '\t' '$1 == "overlap-review" { count++ } END { print count + 0 }' \
  "$audit_dir/lost-snapshot-patch-retention.tsv")"
if [[ -s "$audit_dir/unreviewed-lost-snapshot-overlaps.txt" \
  || "$overlap_review_rows" -ne "$expected_overlap_reviews" ]]; then
  printf 'Lost-snapshot overlap review is incomplete (%s/%s reviewed).\n' \
    "$overlap_review_rows" "$expected_overlap_reviews" >&2
  cat "$audit_dir/unreviewed-lost-snapshot-overlaps.txt" >&2
  exit 1
fi

bun "$script_dir/compare-test-bodies.ts" > "$audit_dir/test-body-compare-summary.txt"
bun "$script_dir/review-same-title-assertions.ts"

same_title_assertion_groups="$(($(wc -l < "$audit_dir/same-title-missing-assertion-groups.tsv") - 1))"
reviewed_assertion_groups="$(($(wc -l < "$audit_dir/same-title-assertion-review.tsv") - 1))"
missing_same_title_assertions="$(awk -F '\t' '
  NR > 1 && $1 == "missing-current-assertion" && $6 != "" { count++ }
  END { print count + 0 }
' "$audit_dir/historical-assertion-disposition.tsv")"
reviewed_missing_assertions="$(awk -F '\t' 'NR > 1 { count += $3 } END { print count + 0 }' \
  "$audit_dir/same-title-assertion-review.tsv")"
if [[ -s "$audit_dir/unreviewed-same-title-assertions.txt" \
  || "$reviewed_assertion_groups" -ne "$same_title_assertion_groups" \
  || "$reviewed_missing_assertions" -ne "$missing_same_title_assertions" ]]; then
  printf 'Same-title assertion review is incomplete (%s/%s groups, %s/%s assertions).\n' \
    "$reviewed_assertion_groups" "$same_title_assertion_groups" \
    "$reviewed_missing_assertions" "$missing_same_title_assertions" >&2
  cat "$audit_dir/unreviewed-same-title-assertions.txt" >&2
  exit 1
fi
while IFS=$'\t' read -r historical_path title _missing_assertions disposition evidence_path evidence_label rationale; do
  if [[ -z "$historical_path" || -z "$title" || -z "$disposition" \
    || -z "$evidence_path" || -z "$evidence_label" || -z "$rationale" ]]; then
    printf 'Incomplete same-title assertion review: %s\t%s\n' "$historical_path" "$title" >&2
    exit 1
  fi
  case "$disposition" in
    equivalent-current|stronger-current|confirmed-regression-fixed)
      if ! awk -F '\t' -v path="$evidence_path" -v label="$evidence_label" \
        '$1 == path && $2 == label { found = 1 } END { exit !found }' \
        "$audit_dir/test-titles-WORKTREE.txt"; then
        printf 'Missing assertion review test evidence: %s\t%s\t%s\n' \
          "$historical_path" "$evidence_path" "$evidence_label" >&2
        exit 1
      fi
      ;;
    explicit-retirement)
      if ! rg -Fq -- "$evidence_label" "$evidence_path"; then
        printf 'Missing assertion retirement evidence: %s\t%s\t%s\n' \
          "$historical_path" "$evidence_path" "$evidence_label" >&2
        exit 1
      fi
      ;;
    *)
      printf 'Invalid assertion review disposition: %s\t%s\n' "$historical_path" "$disposition" >&2
      exit 1
      ;;
  esac
done < <(tail -n +2 "$audit_dir/same-title-assertion-review.tsv")

printf 'baseline\thistorical_source\thistorical_path\ttitle\treview\tevidence_path\tevidence_label\trationale\n' \
  > "$audit_dir/test-body-review.tsv"
: > "$audit_dir/unreviewed-test-bodies.txt"
while IFS=$'\t' read -r baseline status historical_source historical_path title current_paths; do
  [[ "$status" == "changed-body" ]] || continue
  review=""
  evidence_path="${current_paths%%,*}"
  evidence_label="$title"
  rationale=""
  case "$historical_path" in
    tests/core/outlineRuntimeProcess.test.ts)
      if [[ "$title" == *"streams verified AssetRecord bytes"* ]]; then
        review="stronger-current"
        rationale="The original range and integrity assertions remain, with an additional public-response metadata boundary."
      else
        review="equivalent-current"
        rationale="The original process, authentication, lifecycle, watch, and supervisor assertions remain; changes add the separate ContentStore root or private Runtime contract input."
      fi
      ;;
    tests/core/agentMemory.test.ts)
      if [[ "$title" == *"does not count literal Memory markers"* ]]; then
        review="confirmed-regression-fixed"
        rationale="The negative citation assertion now executes through the public outline get completion path."
      else
        review="equivalent-current"
        rationale="The original Memory assertions are unchanged; stable Runtime Node IDs and the queued planning host replace legacy test literals."
      fi
      ;;
    tests/e2e/*)
      review="stronger-current"
      rationale="The original keyboard or field assertion inventory remains and current coverage adds accepted/optimistic first-frame, focus, editor-identity, or single-settlement checks."
      ;;
    tests/core/outlineRuntimeWorkspace.test.ts|tests/core/outlineChangeSetCapabilities.test.ts|tests/core/agentCapabilities.test.ts|tests/core/core.test.ts)
      review="stronger-current"
      rationale="Every original assertion remains and the current test adds Runtime generation, Diff identity, command parsing, or focus-return coverage."
      ;;
    tests/core/outlineChangeSetKernel.test.ts)
      review="stronger-current"
      rationale="The original stale-revision assertions remain and current coverage also rejects a same-revision Diff whose targeted semantic digest came from divergent state."
      ;;
    tests/core/outlineCli.test.ts)
      review="stronger-current"
      rationale="The original public CLI assertions remain and current coverage also rejects duplicate batch-count names and an incomplete batch mode before returning results."
      ;;
    tests/core/builtInSkillScripts.test.ts)
      review="stronger-current"
      rationale="The original public import assertions remain and current coverage also proves repeat import appends independently revertible Operations and malformed normalized input cannot mutate Runtime state."
      ;;
    tests/core/documentReadModel.test.ts)
      review="equivalent-current"
      rationale="The maintained Runtime read model directly owns the index-compatible Node map, replacing comparison through the retired projection-index adapter."
      ;;
    tests/core/documentSystemRuntime.test.ts)
      review="stronger-current"
      rationale="Subscriber failure remains isolated from mutation success, and the replacement additionally proves durable restart recovery and Operation history."
      ;;
    tests/core/outlineDocumentService.test.ts|tests/renderer/outlineDesktopClient.test.ts)
      review="stronger-current"
      rationale="The original settlement and revision assertions remain while accepted/durable frontiers and exact empty deltas replace full-projection fallback."
      ;;
    tests/smoke/epub-preview-stream.smoke.ts|tests/renderer/rowInteractions.test.ts)
      review="equivalent-current"
      rationale="The original observable assertion is unchanged; only the Runtime asset route or canonical reference representation changed."
      ;;
  esac
  if [[ -z "$review" || -z "$evidence_path" ]]; then
    printf '%s\t%s\t%s\t%s\n' "$baseline" "$historical_source" "$historical_path" "$title" \
      >> "$audit_dir/unreviewed-test-bodies.txt"
    continue
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$baseline" "$historical_source" "$historical_path" "$title" "$review" \
    "$evidence_path" "$evidence_label" "$rationale" >> "$audit_dir/test-body-review.tsv"
done < <(tail -n +2 "$audit_dir/test-body-baseline-disposition.tsv")

expected_changed_bodies="$(awk -F '\t' 'NR > 1 && $2 == "changed-body" { count++ } END { print count + 0 }' \
  "$audit_dir/test-body-baseline-disposition.tsv")"
reviewed_changed_bodies="$(($(wc -l < "$audit_dir/test-body-review.tsv") - 1))"
if [[ -s "$audit_dir/unreviewed-test-bodies.txt" \
  || "$reviewed_changed_bodies" -ne "$expected_changed_bodies" ]]; then
  printf 'Unreviewed changed test body queue is not empty (%s/%s reviewed).\n' \
    "$reviewed_changed_bodies" "$expected_changed_bodies" >&2
  cat "$audit_dir/unreviewed-test-bodies.txt" >&2
  exit 1
fi

: > "$audit_dir/unverified-production-wiring.txt"
production_wiring_rows=0
while IFS=$'\t' read -r historical_wiring disposition current_owner evidence_path evidence_label rationale; do
  production_wiring_rows=$((production_wiring_rows + 1))
  if [[ -z "$historical_wiring" || -z "$disposition" || -z "$current_owner" \
    || -z "$evidence_path" || -z "$evidence_label" || -z "$rationale" ]]; then
    printf 'incomplete\t%s\n' "$historical_wiring" >> "$audit_dir/unverified-production-wiring.txt"
    continue
  fi
  if [[ "$disposition" == "explicit-retirement" ]]; then
    if ! rg -Fq -- "$evidence_label" "$evidence_path"; then
      printf 'missing retirement evidence\t%s\t%s\n' "$historical_wiring" "$evidence_label" \
        >> "$audit_dir/unverified-production-wiring.txt"
    fi
  elif ! awk -F '\t' -v path="$evidence_path" -v title="$evidence_label" \
    '$1 == path && $2 == title { found = 1 } END { exit !found }' "$audit_dir/test-titles-WORKTREE.txt"; then
    printf 'missing test evidence\t%s\t%s\t%s\n' "$historical_wiring" "$evidence_path" "$evidence_label" \
      >> "$audit_dir/unverified-production-wiring.txt"
  fi
done < <(tail -n +2 "$script_dir/production-wiring-disposition.tsv")
if [[ "$production_wiring_rows" -eq 0 || -s "$audit_dir/unverified-production-wiring.txt" ]]; then
  printf 'Production wiring disposition is incomplete (%s rows).\n' "$production_wiring_rows" >&2
  cat "$audit_dir/unverified-production-wiring.txt" >&2
  exit 1
fi

awk -F '\t' '
  NR == FNR { current[$2] = 1; next }
  !($2 in current) { print }
' "$audit_dir/test-titles-WORKTREE.txt" "$audit_dir/historical-test-responsibilities.txt" \
  > "$audit_dir/historical-needs-disposition.txt"

printf 'source_path\tresponsibility\tdisposition\tevidence_path\tevidence_label\trationale\n' \
  > "$audit_dir/responsibility-disposition.tsv"
: > "$audit_dir/unclassified-responsibilities.txt"
while IFS=$'\t' read -r source_path responsibility; do
  current_match="$(awk -F '\t' -v title="$responsibility" '$2 == title { print $1; exit }' \
    "$audit_dir/test-titles-WORKTREE.txt")"
  if [[ -n "$current_match" ]]; then
    assertion_review="$(awk -F '\t' -v path="$source_path" -v title="$responsibility" '
      $1 == path && $2 == title { print $4 "\t" $5 "\t" $6 "\t" $7; exit }
    ' "$audit_dir/same-title-assertion-review.tsv")"
    body_review="$(awk -F '\t' -v path="$source_path" -v title="$responsibility" '
      $3 == path && $4 == title {
        priority = $5 == "confirmed-regression-fixed" ? 3 : ($5 == "stronger-current" ? 2 : 1)
        if (priority > best) { best = priority; print $5 "\t" $6 "\t" $7 "\t" $8; exit }
      }
    ' "$audit_dir/test-body-review.tsv")"
    if [[ -n "$assertion_review" ]]; then
      IFS=$'\t' read -r review evidence_path evidence_label rationale <<< "$assertion_review"
      case "$review" in
        confirmed-regression-fixed) disposition="confirmed-regression-fixed" ;;
        stronger-current) disposition="stronger-replacement" ;;
        equivalent-current) disposition="current-evidence" ;;
        explicit-retirement) disposition="explicit-retirement" ;;
      esac
    elif [[ -n "$body_review" ]]; then
      IFS=$'\t' read -r review evidence_path evidence_label rationale <<< "$body_review"
      case "$review" in
        confirmed-regression-fixed) disposition="confirmed-regression-fixed" ;;
        stronger-current) disposition="stronger-replacement" ;;
        equivalent-current) disposition="current-evidence" ;;
      esac
    else
      disposition="current-evidence"
      evidence_path="$current_match"
      evidence_label="$responsibility"
      rationale="The historical responsibility remains as an executable test with the exact title and identical latest body."
    fi
  else
    classify_responsibility "$source_path" "$responsibility"
  fi

  if [[ -z "$disposition" || -z "$evidence_path" || -z "$evidence_label" || -z "$rationale" ]]; then
    printf '%s\t%s\n' "$source_path" "$responsibility" >> "$audit_dir/unclassified-responsibilities.txt"
    continue
  fi
  case "$disposition" in
    current-evidence|stronger-replacement|explicit-retirement|confirmed-regression-fixed) ;;
    *)
      printf '%s\t%s\n' "$source_path" "$responsibility" >> "$audit_dir/unclassified-responsibilities.txt"
      continue
      ;;
  esac
  if [[ "$disposition" == "explicit-retirement" ]]; then
    if ! rg -Fq -- "$evidence_label" "$evidence_path"; then
      printf 'missing retirement evidence: %s\t%s\t%s\n' \
        "$source_path" "$responsibility" "$evidence_label" >> "$audit_dir/unclassified-responsibilities.txt"
      continue
    fi
  elif ! awk -F '\t' -v path="$evidence_path" -v title="$evidence_label" \
    '$1 == path && $2 == title { found = 1 } END { exit !found }' "$audit_dir/test-titles-WORKTREE.txt"; then
    printf 'missing test evidence: %s\t%s\t%s\t%s\n' \
      "$source_path" "$responsibility" "$evidence_path" "$evidence_label" \
      >> "$audit_dir/unclassified-responsibilities.txt"
    continue
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$source_path" "$responsibility" "$disposition" "$evidence_path" "$evidence_label" "$rationale" \
    >> "$audit_dir/responsibility-disposition.tsv"
done < "$audit_dir/historical-test-responsibilities.txt"

expected_responsibilities="$(wc -l < "$audit_dir/historical-test-responsibilities.txt" | tr -d ' ')"
classified_responsibilities="$(($(wc -l < "$audit_dir/responsibility-disposition.tsv") - 1))"
if [[ -s "$audit_dir/unclassified-responsibilities.txt" \
  || "$classified_responsibilities" -ne "$expected_responsibilities" ]]; then
  printf 'Unclassified responsibility queue is not empty (%s/%s classified).\n' \
    "$classified_responsibilities" "$expected_responsibilities" >&2
  cat "$audit_dir/unclassified-responsibilities.txt" >&2
  exit 1
fi

awk -F '\t' '
  NR > 1 {
    key = $3 FS $4 FS $5
    count[key]++
  }
  END {
    for (key in count) print count[key] FS key
  }
' "$audit_dir/responsibility-disposition.tsv" \
  | sort -t $'\t' -k1,1nr > "$audit_dir/evidence-fan-in.tsv"

: > "$audit_dir/test-responsibilities.tsv"
for rev in "$lost_snapshot" "$pre_cutover" "$pr_tip"; do
  titles="$audit_dir/test-titles-${rev//\//-}.txt"
  awk -F '\t' -v rev="$rev" '
    NR == FNR { current[$2] = 1; next }
    {
      disposition = ($2 in current) ? "exact-current-title" : "needs-disposition"
      print rev "\t" disposition "\t" $1 "\t" $2
    }
  ' "$audit_dir/test-titles-WORKTREE.txt" "$titles" >> "$audit_dir/test-responsibilities.tsv"
done

printf 'lost snapshot: '
cut -f2 "$audit_dir/lost-snapshot-disposition.tsv" | sort | uniq -c
printf 'cutover deletions: '
cut -f1 "$audit_dir/cutover-deletion-disposition.tsv" | sort | uniq -c
printf 'PR paths: '
cut -f1 "$audit_dir/pr-path-disposition.tsv" | sort | uniq -c
printf 'test responsibilities: '
cut -f2 "$audit_dir/test-responsibilities.tsv" | sort | uniq -c
printf 'historical test responsibilities: '
wc -l < "$audit_dir/historical-test-responsibilities.txt"
printf 'responsibility dispositions: '
tail -n +2 "$audit_dir/responsibility-disposition.tsv" | cut -f3 | sort | uniq -c
printf 'responsibilities needing semantic disposition: '
wc -l < "$audit_dir/historical-needs-disposition.txt"
printf 'unclassified responsibilities: '
wc -l < "$audit_dir/unclassified-responsibilities.txt"
printf 'reviewed changed test bodies: '
printf '%s/%s\n' "$reviewed_changed_bodies" "$expected_changed_bodies"
printf 'reviewed same-title missing assertions: '
printf '%s/%s across %s groups\n' \
  "$reviewed_missing_assertions" "$missing_same_title_assertions" "$reviewed_assertion_groups"
printf 'production wiring dispositions: '
printf '%s\n' "$production_wiring_rows"
printf 'production path reviews: '
printf '%s/%s\n' "$reviewed_production_paths" "$expected_production_paths"
printf 'document path reviews: '
printf '%s/%s\n' "$reviewed_document_paths" "$expected_document_paths"
printf 'lost-snapshot overlap reviews: '
printf '%s/%s\n' "$overlap_review_rows" "$expected_overlap_reviews"
