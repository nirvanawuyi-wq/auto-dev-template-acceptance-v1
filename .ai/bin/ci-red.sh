#!/usr/bin/env bash
# Exit 0 only when wait-checks.sh recorded an actual failure for this PR.
# Exit 1 for an absent result, timeout, query error, or successful gate.
set -euo pipefail

pr=${1:-}
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || exit 1
result_file=$(git rev-parse --git-path cezar-ci-result)
sha=$(git rev-parse HEAD)
[[ -f "$result_file" && "$(cat "$result_file")" == "red $pr $sha" ]]
