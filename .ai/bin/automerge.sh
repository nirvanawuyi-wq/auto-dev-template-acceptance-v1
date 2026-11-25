#!/usr/bin/env bash
# Usage: automerge.sh <PR> or automerge.sh --disarm [<PR>].
# Exit 0: the reviewed SHA was merged, or disarm found no open PR/safely drafted it.
# Exit 3: the approved commit changed or the PR is behind/conflicted; retry from sync.
# Exit 1: the PR, approval record, or requested operation could not be verified.
set -euo pipefail
# shellcheck source=integration-pr.sh
source "$(dirname "$0")/integration-pr.sh"

fail() {
  printf '%s\n' "$2" >&2
  exit "$1"
}

require_integration_task || fail 1 'Expected an integration task worktree.'
if [[ ${1:-} == --disarm ]]; then
  pr=${2:-}
  if [[ -z "$pr" ]]; then
    pr=$(timeout 20s gh pr list --head "$CEZ_BRANCH" --state open --limit 2 --json number \
      --jq 'if length==0 then "none" elif length==1 then .[0].number else "ambiguous" end' 2>/dev/null) ||
      fail 1 'Could not determine whether an open PR exists.'
    [[ "$pr" != none ]] || exit 0
  fi
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || fail 1 'Expected one open pull request.'
  restore_draft "$pr" || fail 1 'Could not confirm a safe draft PR.'
  exit 0
fi

pr=${1:-}
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || fail 1 'A pull request number is required.'
read_approved_sha "$pr" || fail 1 'The approved CI commit record is missing.'
read_integration_pr "$pr" || fail 1 'Could not verify the integration PR.'
if [[ "$pr_state" == MERGED && "$pr_sha" == "$approved_sha" ]]; then
  exit 0
fi
[[ "$pr_state" == OPEN ]] || fail 1 'The integration PR is no longer open.'

check_approval() {
  [[ "$pr_state" == OPEN ]] || fail 1 'The integration PR is no longer open.'
  if [[ "$pr_sha" != "$approved_sha" || "$(git rev-parse HEAD)" != "$approved_sha" ||
        "$pr_policy" == BEHIND || "$pr_policy" == DIRTY ]]; then
    restore_draft "$pr" || fail 1 'Could not safely return the changed PR to draft.'
    fail 3 'The PR changed or needs a base sync; review is required again.'
  fi
  [[ "$pr_auto" == false ]] || fail 1 'The PR still has auto-merge enabled.'
}

if [[ "$pr_auto" == true ]]; then
  restore_draft "$pr" || fail 1 'Could not clear pre-existing auto-merge.'
fi
check_approval
if [[ "$pr_draft" == true ]]; then
  timeout 20s gh pr ready "$pr" >/dev/null 2>&1 || fail 1 'Could not mark the reviewed pull request ready.'
fi
read_integration_pr "$pr" || fail 1 'Could not recheck the ready pull request.'
check_approval
[[ "$pr_draft" == false ]] || fail 1 'Could not confirm the PR is ready.'

# Immediate merge with a server-side SHA constraint. No queued approval can
# carry forward to a later commit.
merged=$(timeout 20s gh api --method PUT "repos/{owner}/{repo}/pulls/$pr/merge" \
  --field "sha=$approved_sha" --field merge_method=squash --jq '.merged' 2>/dev/null) || merged=''
if [[ "$merged" == true ]]; then
  exit 0
fi
read_integration_pr "$pr" || fail 1 'Merge outcome could not be confirmed.'
if [[ "$pr_state" == MERGED && "$pr_sha" == "$approved_sha" ]]; then
  exit 0
fi
check_approval
restore_draft "$pr" || fail 1 'Merge did not complete and draft status could not be restored.'
fail 1 'GitHub did not accept the immediate merge.'
