#!/usr/bin/env bash
# Exit 0: the requested step succeeded (including no prior PR for disarm).
# Exit 1: a guard, GitHub operation, or post-merge check failed. Stop the run.
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ ( ${CEZ_BASE:-} == smoke-base || ${CEZ_BASE:-} == origin/smoke-base ) && ${CEZ_BRANCH:-} == cez/* ]] ||
  fail 'Smoke requires a Cezar task branch based on smoke-base.'
[[ "$(git branch --show-current)" == "$CEZ_BRANCH" ]] ||
  fail 'The worktree is on the wrong branch.'
base=refs/remotes/origin/smoke-base
git rev-parse --verify --quiet "$base^{commit}" >/dev/null ||
  fail 'The temporary remote base is missing.'
reviewed_file=$(git rev-parse --git-path cezar-smoke-reviewed) ||
  fail 'Could not locate the worktree git directory.'

# Read the PR state again before merging. The GitHub merge request also
# carries the reviewed SHA, so an intervening push makes GitHub reject it.
read_pr() {
  local data base_name head_name cross state sha draft auto_merge
  data=$(gh pr view "$1" --json baseRefName,headRefName,isCrossRepository,state,headRefOid,isDraft,autoMergeRequest \
    --jq '[.baseRefName, .headRefName, .isCrossRepository, .state, .headRefOid, .isDraft, (.autoMergeRequest != null)] | @tsv' 2>/dev/null) ||
    fail 'Could not query the smoke pull request.'
  IFS=$'\t' read -r base_name head_name cross state sha draft auto_merge <<< "$data"
  [[ "$base_name" == smoke-base && "$head_name" == "$CEZ_BRANCH" && "$cross" == false &&
    "$state" == "$2" && "$sha" =~ ^[0-9a-f]{40}$ &&
    "$draft" =~ ^(true|false)$ && "$auto_merge" =~ ^(true|false)$ ]] ||
    fail 'The smoke pull request has an unexpected base, head, or state.'
  pr_sha=$sha
  pr_draft=$draft
  pr_auto_merge=$auto_merge
}

validate_change() {
  local stat summary worktree_status
  worktree_status=$(git status --porcelain) || fail 'Could not inspect the worktree.'
  [[ -z "$worktree_status" ]] || fail 'The worktree is not clean.'
  stat=$(git diff --numstat --no-renames "$base"...HEAD --) || fail 'Could not inspect the README change.'
  [[ "$stat" == $'1\t0\tREADME.md' ]] || fail 'Smoke must add one README line and change nothing else.'
  summary=$(git diff --summary "$base"...HEAD --) || fail 'Could not inspect file modes.'
  [[ -z "$summary" ]] || fail 'Smoke cannot change file modes.'
  git diff --check "$base"...HEAD -- || fail 'The README change has whitespace errors.'
}

case ${1:-} in
  scope)
    git merge-base --is-ancestor "$base" HEAD || fail 'The worktree is not based on smoke-base.'
    ;;

  validate)
    validate_change
    if [[ -f "$reviewed_file" ]]; then
      [[ "$(git rev-parse HEAD)" != "$(cat "$reviewed_file")" ]] ||
        fail 'The retry must submit a new commit.'
    fi
    ;;

  disarm)
    number=$(gh pr list --head "$CEZ_BRANCH" --state open --limit 2 --json number \
      --jq 'if type != "array" then error("invalid response") elif length == 0 then "none" elif length == 1 then .[0].number else "ambiguous" end' 2>/dev/null) ||
      fail 'Could not look up an existing pull request.'
    [[ "$number" != none ]] || exit 0
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || fail 'Expected at most one open pull request.'
    read_pr "$number" OPEN
    if [[ "$pr_auto_merge" == true ]]; then
      gh pr merge "$number" --disable-auto >/dev/null 2>&1 || fail 'Could not disable existing auto-merge.'
    fi
    if [[ "$pr_draft" == false ]]; then
      gh pr ready "$number" --undo >/dev/null 2>&1 || fail 'Could not restore draft status.'
    fi
    read_pr "$number" OPEN
    [[ "$pr_draft" == true && "$pr_auto_merge" == false ]] || fail 'The pull request is not safely in draft.'
    ;;

  mark)
    number=${2:-}
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || fail 'Cezar did not return a pull request number.'
    expected_sha=$(git rev-parse HEAD)
    # GitHub can briefly report the previous PR head after a successful push.
    for attempt in 1 2 3 4 5; do
      read_pr "$number" OPEN
      [[ "$pr_draft" == true && "$pr_auto_merge" == false ]] ||
        fail 'The smoke pull request is not safely in draft.'
      if [[ "$pr_sha" == "$expected_sha" ]]; then
        printf '%s\n' "$pr_sha" > "$reviewed_file"
        printf '%s\n' "$pr_sha"
        exit 0
      fi
      [[ "$attempt" == 5 ]] || sleep 2
    done
    fail 'GitHub did not confirm the submitted commit after five checks.'
    ;;

  merge)
    number=${2:-}
    [[ "$number" =~ ^[1-9][0-9]*$ && -f "$reviewed_file" ]] || fail 'The reviewed pull request was not recorded.'
    reviewed_sha=$(cat "$reviewed_file")
    [[ "$reviewed_sha" =~ ^[0-9a-f]{40}$ && "$reviewed_sha" == "$(git rev-parse HEAD)" ]] ||
      fail 'The local commit changed after review.'
    validate_change
    read_pr "$number" OPEN
    [[ "$pr_sha" == "$reviewed_sha" && "$pr_auto_merge" == false ]] ||
      fail 'The pull request changed after review.'
    if [[ "$pr_draft" == true ]]; then
      gh pr ready "$number" >/dev/null 2>&1 || fail 'Could not mark the smoke pull request ready.'
    fi
    read_pr "$number" OPEN
    [[ "$pr_sha" == "$reviewed_sha" && "$pr_draft" == false && "$pr_auto_merge" == false ]] ||
      fail 'The ready pull request does not match the reviewed commit.'
    merged=$(gh api --method PUT "repos/{owner}/{repo}/pulls/$number/merge" \
      --field "sha=$reviewed_sha" --field merge_method=squash --jq '.merged' 2>/dev/null) ||
      fail 'GitHub rejected the immediate merge.'
    [[ "$merged" == true ]] || fail 'GitHub did not confirm a merge.'
    read_pr "$number" MERGED
    [[ "$pr_sha" == "$reviewed_sha" ]] || fail 'The merged pull request did not match the reviewed commit.'
    printf 'Merged smoke PR #%s at %s.\n' "$number" "$reviewed_sha"
    ;;

  *)
    fail 'Usage: smoke.sh scope|validate|disarm|mark <PR>|merge <PR>'
    ;;
esac
