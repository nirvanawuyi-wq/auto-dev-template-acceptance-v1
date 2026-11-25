#!/usr/bin/env bash
set -euo pipefail
umask 077

target=${1:?用法：setup-worktree.sh <worktree-dir> [env-file]}
source_env=${2:-${CEZAR_WORKTREE_ENV_FILE:-}}
if [[ -n "$source_env" ]]; then
  [[ -f "$source_env" && ! -L "$source_env" ]] || { echo '提供普通测试环境文件。' >&2; exit 1; }
  source_env=$(realpath -e -- "$source_env")
fi

for tool in git node corepack install timeout; do
  command -v "$tool" >/dev/null || { echo "缺少工具 $tool。" >&2; exit 1; }
done

cd -- "$target"
worktree_root=$(git rev-parse --show-toplevel)
if [[ "$(pwd -P)" != "$(cd -- "$worktree_root" && pwd -P)" ||
      ! -f pnpm-lock.yaml || ! -f .env.example || ! -f scripts/check-stage0.mjs ||
      ! -f .ai/bin/delivery.sh ]]; then
  echo '请在已同步地基、锁文件、环境校验脚本和 Cezar 脚本的工作树根目录运行。' >&2
  exit 1
fi

if [[ -z "$source_env" ]]; then
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
  clone_dir=${common_dir%/*}
  project=${CEZAR_PROJECT_NAME:-${clone_dir##*/}}
  [[ "$project" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] ||
    { echo '用 CEZAR_WORKTREE_ENV_FILE 指定该项目的测试环境文件。' >&2; exit 1; }
  source_env="$HOME/secrets/$project.env.local"
fi

[[ -f "$source_env" && ! -L "$source_env" && ! -L .env.local ]] ||
  { echo '请检查项目的测试环境文件与工作树目标。' >&2; exit 1; }
git check-ignore -q .env.local || { echo '先从 Git 排除 .env.local。' >&2; exit 1; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 13) process.exit(1)' ||
  { echo '安装 Node 24.13 或更高的 24.x 版本。' >&2; exit 1; }
expected=$(node -p 'require("./package.json").packageManager.split("@")[1]')
[[ "$(corepack pnpm --version)" == "$expected" ]] ||
  { echo '用 Corepack 获取 packageManager 固定的 pnpm。' >&2; exit 1; }

node scripts/check-stage0.mjs --env-file "$source_env"
tmp=$(mktemp .env.local.XXXXXX)
trap 'rm -f -- "$tmp"' EXIT
install -m 0600 -- "$source_env" "$tmp"
mv -fT -- "$tmp" .env.local
corepack pnpm install --frozen-lockfile
if ! timeout 20 node --input-type=module -e 'import { chromium } from "@playwright/test"; const browser = await chromium.launch(); await browser.close()'; then
  echo '安装当前项目锁定的浏览器及系统依赖：corepack pnpm exec playwright install --with-deps chromium' >&2
  exit 1
fi
