#!/usr/bin/env bash
# Exit 0 means the batch finished or another invocation already owns the lock.
# Exit nonzero means configuration or a required local operation failed.
set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$PATH"

batch=${1:-}
project=${CEZAR_PROJECT_NAME:-}
root=${CEZAR_PROJECT_ROOT:-}
if [[ ! "$batch" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ || ! "$project" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ||
      "$root" != /* || ! -d "$root" ]]; then
  printf '%s\n' 'Set CEZAR_PROJECT_ROOT, CEZAR_PROJECT_NAME and pass a valid batch name.' >&2
  exit 1
fi
directory="$HOME/cezar-state/$project"
mkdir -p "$directory"
exec 9>"$directory/submit-modules.lock"
if ! flock -n 9; then
  printf '%s\n' 'A submit service already owns this project lock.'
  exit 0
fi
exec node "$root/.ai/bin/submit-modules.mjs" "$batch"
