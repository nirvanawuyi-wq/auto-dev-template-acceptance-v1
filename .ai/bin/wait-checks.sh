#!/usr/bin/env bash
# Usage: wait-checks.sh <pull-request> <minutes>. Zero minutes checks once.
# Exit 0: the four named checks passed on the current, published commit.
# Exit 1: a check failed, timed out, or could not be verified. ci-red.sh
# distinguishes an actual failure from an unavailable or incomplete result.
set -euo pipefail

pr=${1:-}
minutes=${2:-}
result_file=$(git rev-parse --git-path cezar-ci-result)
head_file=$(git rev-parse --git-path cezar-ci-head)
rm -f -- "$result_file" "$head_file"

finish() {
  printf '%s %s %s\n' "$1" "$pr" "${sha:-none}" > "$result_file"
  printf '%s\n' "$2" >&2
  exit 1
}

[[ "$pr" =~ ^[1-9][0-9]*$ && "$minutes" =~ ^[0-9]{1,3}$ ]] ||
  finish query-error 'A pull request number and a timeout in minutes are required.'
if [[ ${CEZ_BASE:-} != integration && ${CEZ_BASE:-} != origin/integration ]]; then
  finish query-error 'The CI gate requires an integration task.'
fi
[[ -n ${CEZ_BRANCH:-} && "$(git branch --show-current)" == "$CEZ_BRANCH" ]] ||
  finish query-error 'The worktree does not match the task branch.'
sha=$(git rev-parse HEAD)
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || finish query-error 'Could not determine the submitted commit.'
deadline=$((SECONDS + 60 * 10#$minutes))

pr_head() {
  local data
  data=$(timeout 20s gh pr view "$pr" --json headRefOid,baseRefName,headRefName,state,isCrossRepository,isDraft 2>/dev/null) ||
    return 1
  jq -er --arg branch "$CEZ_BRANCH" '
    select(.baseRefName=="integration" and .headRefName==$branch and
      .state=="OPEN" and .isCrossRepository==false and .isDraft==true)
    | .headRefOid | select(test("^[0-9a-f]{40}$"))' <<< "$data"
}

check_state() {
  local repo='repos/{owner}/{repo}' runs statuses
  runs=$(timeout 20s gh api "$repo/commits/$sha/check-runs?filter=latest&per_page=100" --paginate --slurp 2>/dev/null) ||
    return 1
  statuses=$(timeout 20s gh api "$repo/commits/$sha/statuses?per_page=100" --paginate --slurp 2>/dev/null) ||
    return 1
  printf '%s\n%s\n' "$runs" "$statuses" | jq -ers --arg sha "$sha" '
    if length!=2 or (.[0]|type)!="array" or (.[1]|type)!="array" or
      (.[0]|length)==0 or (.[1]|length)==0 or
      any(.[0][]; (.check_runs|type)!="array") or any(.[1][]; type!="array")
    then error("invalid response") else . end
    | (.[0] | map(.check_runs[]) | map(select(.head_sha==$sha and .app.slug=="github-actions"))) as $actions
    | (.[1] | add | map(select(.context=="Vercel" and .creator.login=="vercel[bot]")) | first) as $vercel
    | (["verify","guard","e2e"] | map(. as $name |
        ($actions | map(select(.name==$name)) | max_by(.id)) as $item |
        if $item.status!="completed" then "pending"
        elif $item.conclusion=="success" then "green"
        elif $item.conclusion=="failure" or $item.conclusion=="timed_out" or
             $item.conclusion=="startup_failure" or $item.conclusion=="action_required" then "red"
        else "pending" end)) +
      [(if $vercel.state=="success" then "green"
        elif $vercel.state=="failure" or $vercel.state=="error" then "red"
        else "pending" end)]
    | if any(.[]; .=="red") then "red"
      elif all(.[]; .=="green") then "green"
      else "pending" end'
}

while true; do
  [[ "$(git rev-parse HEAD)" == "$sha" ]] || finish query-error 'The local commit changed while waiting for CI.'
  observed=$(pr_head) || finish query-error 'Could not verify the open integration draft.'
  if [[ "$observed" == "$sha" ]]; then
    state=$(check_state) || finish query-error 'Could not retrieve the named CI results.'
    if [[ "$state" != pending ]]; then
      confirmed=$(pr_head) || finish query-error 'Could not recheck the pull request head.'
      [[ "$confirmed" == "$sha" && "$(git rev-parse HEAD)" == "$sha" ]] ||
        finish query-error 'The pull request commit changed during the CI check.'
      [[ "$state" != red ]] || finish red 'A required check failed on the current commit.'
      [[ "$state" == green ]] || finish query-error 'Unexpected CI result.'
      printf '%s\n' "$sha" > "$head_file"
      printf 'green %s\n' "$pr" > "$result_file"
      printf '%s\n' "$sha"
      exit 0
    fi
  fi
  remaining=$((deadline - SECONDS))
  (( remaining > 0 )) || finish timeout 'The current commit did not receive all four successful checks before the deadline.'
  if (( remaining < 10 )); then sleep "$remaining"; else sleep 10; fi
done
