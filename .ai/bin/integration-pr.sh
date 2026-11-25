#!/usr/bin/env bash
# Shared by the module-delivery PR checks.
set -euo pipefail

require_integration_task() {
  [[ ${CEZ_BASE:-} == integration || ${CEZ_BASE:-} == origin/integration ]] &&
    [[ -n ${CEZ_BRANCH:-} && "$(git branch --show-current)" == "$CEZ_BRANCH" ]]
}

read_integration_pr() {
  local response values
  response=$(timeout 20s gh pr view "$1" --json headRefOid,baseRefName,headRefName,state,isCrossRepository,isDraft,autoMergeRequest,mergeStateStatus 2>/dev/null) ||
    return 1
  values=$(jq -er --arg branch "$CEZ_BRANCH" '
    select(.baseRefName=="integration" and .headRefName==$branch and
      .isCrossRepository==false and (.isDraft|type)=="boolean" and
      (.headRefOid|test("^[0-9a-f]{40}$")) and
      (.state=="OPEN" or .state=="MERGED" or .state=="CLOSED"))
    | [.headRefOid,.state,.isDraft,has("autoMergeRequest") and .autoMergeRequest!=null,
      (.mergeStateStatus // "UNKNOWN")] | @tsv' <<< "$response") || return 1
  IFS=$'\t' read -r pr_sha pr_state pr_draft pr_auto pr_policy <<< "$values"
}

restore_draft() {
  local pr=$1
  read_integration_pr "$pr" || return 1
  [[ "$pr_state" == OPEN ]] || return 1
  if [[ "$pr_auto" == true ]]; then
    timeout 20s gh pr merge "$pr" --disable-auto >/dev/null 2>&1 || return 1
  fi
  if [[ "$pr_draft" == false ]]; then
    timeout 20s gh pr ready "$pr" --undo >/dev/null 2>&1 || return 1
  fi
  read_integration_pr "$pr" &&
    [[ "$pr_state" == OPEN && "$pr_draft" == true && "$pr_auto" == false ]]
}

read_approved_sha() {
  local pr=$1 head_file result_file
  head_file=$(git rev-parse --git-path cezar-ci-head) || return 1
  result_file=$(git rev-parse --git-path cezar-ci-result) || return 1
  [[ -f "$head_file" && -f "$result_file" && "$(cat "$result_file")" == "green $pr" ]] || return 1
  approved_sha=$(cat "$head_file") || return 1
  [[ "$approved_sha" =~ ^[0-9a-f]{40}$ ]]
}
