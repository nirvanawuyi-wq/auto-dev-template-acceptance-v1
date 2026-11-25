#!/usr/bin/env bash
# Exit 0: the requested delivery operation was confirmed. Exit 1: stop delivery.
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

action=${1:-}
phase=${2:-}
branch=${CEZ_BRANCH:-}
[[ -n "$branch" && "$(git branch --show-current)" == "$branch" ]] || fail 'Unexpected task branch.'

case "$phase" in
  foundation)
    base=main
    [[ "$branch" == stage-0 ]] || fail 'Foundation must use stage-0.'
    item=foundation
    note=docs/stage0-report.md
    ;;
  module)
    base=integration
    case "$branch" in
      module/*) item=${branch#module/} ;;
      fix/*)
        item=${branch#fix/}
        [[ "$item" =~ -[0-9]+$ ]] || fail 'A fix branch must include its sequence number.'
        item=${item%-*}
        ;;
      *) fail 'Expected a module or fix branch.' ;;
    esac
    [[ "$item" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]] || fail 'Invalid module ID.'
    note="docs/decisions/$item.md"
    ;;
  report)
    base=integration
    [[ "$branch" =~ ^report/[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail 'Expected a dated report branch.'
    item=report
    note=docs/run-report.md
    ;;
  *) fail 'Unknown delivery phase.' ;;
esac
[[ ${CEZ_BASE:-} == "$base" || ${CEZ_BASE:-} == "origin/$base" ]] || fail 'Unexpected delivery base.'

mode_file=$(git rev-parse --git-path cezar-delivery-mode)
mode() {
  local value=${1:-}
  if [[ -z "$value" && -f "$mode_file" ]]; then value=$(cat "$mode_file"); fi
  case "$value" in
    handoff|needs-human|blocked) printf '%s\n' "$value" ;;
    '') printf 'blocked\n' ;;
    *) fail 'Invalid delivery mode.' ;;
  esac
}

read_pr() {
  local data values
  data=$(timeout 20s gh pr view "$1" --json baseRefName,headRefName,state,isCrossRepository,isDraft,autoMergeRequest 2>/dev/null) ||
    fail 'Could not read the delivery pull request.'
  values=$(jq -er --arg branch "$branch" --arg base "$base" '
    select(.baseRefName==$base and .headRefName==$branch and .isCrossRepository==false and
      .state=="OPEN" and (.isDraft|type)=="boolean") | [.isDraft,.autoMergeRequest!=null] | @tsv' <<< "$data") ||
    fail 'The pull request is outside this delivery scope.'
  IFS=$'\t' read -r draft auto <<< "$values"
}

case "$action" in
  scope)
    git merge-base --is-ancestor "refs/remotes/origin/$base" HEAD ||
      fail 'The delivery branch does not include its base.'
    ;;
  mode)
    value=$(mode "${3:-}") || exit 1
    printf '%s\n' "$value" > "$mode_file"
    printf '%s\n' "$value"
    ;;
  validate)
    [[ -z "$(git ls-files -u)" ]] || fail 'The worktree has unresolved conflicts.'
    git ls-files --error-unmatch -- "$note" >/dev/null 2>&1 ||
      fail 'The delivery note has not been recorded.'
    [[ -f "$note" && ! -L "$note" && -s "$note" ]] || fail 'The delivery note is empty or invalid.'
    changes=$(git diff --no-renames --name-only "refs/remotes/origin/$base"...HEAD --) ||
      fail 'Could not inspect the proposed changes.'
    [[ -n "$changes" ]] || fail 'No delivery changes are present.'
    if [[ "$phase" == report && "$changes" != "$note" ]]; then fail 'Only the final report may be published.'; fi
    ;;
  draft)
    if [[ "$phase" == module ]]; then exec bash "$(dirname "$0")/automerge.sh" --disarm; fi
    number=$(timeout 20s gh pr list --head "$branch" --state open --limit 2 --json number \
      --jq 'if length==0 then "none" elif length==1 then .[0].number else "ambiguous" end' 2>/dev/null) ||
      fail 'Could not verify whether a delivery pull request exists.'
    [[ "$number" != none ]] || exit 0
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || fail 'Expected one open delivery pull request.'
    read_pr "$number"
    if [[ "$auto" == true ]]; then
      timeout 20s gh pr merge "$number" --disable-auto >/dev/null 2>&1 || fail 'Could not disable auto-merge.'
    fi
    if [[ "$draft" == false ]]; then
      timeout 20s gh pr ready "$number" --undo >/dev/null 2>&1 || fail 'Could not restore draft status.'
    fi
    read_pr "$number"
    [[ "$draft" == true && "$auto" == false ]] || fail 'Could not confirm a safe draft.'
    ;;
  body)
    number=${3:-}
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || fail 'A delivery pull request number is required.'
    read_pr "$number"
    [[ "$draft" == true && "$auto" == false ]] || fail 'Only a safe draft may be updated.'
    value=$(mode "${4:-}") || exit 1
    case "$value" in
      blocked) title="[未通过] $item"; blocking="本次交付停在检查或审查。处理记录见 $note。" ;;
      needs-human) title="[需要你决定] $item"; blocking="需要维护者决定。推荐与后续步骤见 $note。" ;;
      handoff) title="[待验收] $item"; blocking="待维护者验收草稿。交接步骤见 $note。" ;;
    esac
    body=$(mktemp)
    trap 'rm -f -- "$body"' EXIT
    printf '## 完成内容\n\n本次变更见 PR，交付状态见 %s。\n\n## 决策\n\n见 %s。\n\n## 需要地基变更\n\n如有要求，见 %s。\n\n## 卡点\n\n%s\n' \
      "$note" "$note" "$note" "$blocking" > "$body"
    timeout 20s gh pr edit "$number" --title "$title" --body-file "$body" >/dev/null 2>&1 ||
      fail 'Could not update the delivery draft.'
    ;;
  log)
    project=${CEZ_PROJECT_ID:-}
    run=${CEZ_RUN_ID:-}
    [[ "$project" =~ ^[A-Za-z0-9_-]{1,100}$ && "$run" =~ ^[A-Za-z0-9_-]{1,100}$ ]] || fail 'Missing run identity.'
    umask 077
    directory="$HOME/cezar-logs/$project"
    mkdir -p "$directory"
    printf -- '- %s · %s · %s · Cezar %s。交付未能确认，详见运行事件和 %s。\n' \
      "$(date -u +'%FT%TZ')" "$item" "$(mode)" "$run" "$note" >>"$directory/blocker-log.md"
    ;;
  notify)
    value=$(mode "${3:-}") || exit 1
    if [[ "$value" == handoff ]]; then value=needs-human; fi
    exec bash "$HOME/cezar-bin/notify.sh" "$item" "$value"
    ;;
  *) fail 'Unknown delivery operation.' ;;
esac
