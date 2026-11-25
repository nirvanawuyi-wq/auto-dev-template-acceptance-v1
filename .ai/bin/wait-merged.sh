#!/usr/bin/env bash
# Usage: wait-merged.sh <PR> <minutes>.
# Exit 0: the PR is MERGED at the approved SHA.
# Exit 1: the PR changed, is blocked, timed out, or could not be verified.
set -euo pipefail
# shellcheck source=integration-pr.sh
source "$(dirname "$0")/integration-pr.sh"

pr=${1:-}
minutes=${2:-}
[[ "$pr" =~ ^[1-9][0-9]*$ && "$minutes" =~ ^[0-9]{1,3}$ ]] || exit 1
require_integration_task && read_approved_sha "$pr" || exit 1
deadline=$((SECONDS + 60 * 10#$minutes))

while true; do
  if ! read_integration_pr "$pr"; then
    restore_draft "$pr" || true
    printf '%s\n' 'Could not verify merge status.' >&2
    exit 1
  fi
  if [[ "$pr_state" == MERGED ]]; then
    [[ "$pr_sha" == "$approved_sha" ]]
    exit
  fi
  [[ "$pr_state" == OPEN ]] || exit 1
  remaining=$((deadline - SECONDS))
  if [[ "$pr_sha" != "$approved_sha" || "$pr_policy" == BEHIND || "$pr_policy" == DIRTY ]] ||
    (( remaining <= 0 )); then
    if restore_draft "$pr"; then
      printf '%s\n' 'Merge was not confirmed; PR returned to draft.' >&2
    else
      printf '%s\n' 'Merge was not confirmed; draft status also could not be confirmed.' >&2
    fi
    exit 1
  fi
  if (( remaining < 60 )); then sleep "$remaining"; else sleep 60; fi
done
