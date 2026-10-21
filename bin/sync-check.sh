#!/usr/bin/env bash
# 仓库副本 vs 本机真源的漂移检测。
# 两类期望不同：
#   L2 技能 —— 必须逐字节一致（本仓是原样收录）
#   L4 插件 —— 允许恰好一处差异：endpoint 默认值被脱敏成空串
# 用法: bin/sync-check.sh      退出码 0=无漂移 1=有漂移
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS="${HOME}/.dsh/skills"
fail=0

for d in "$ROOT"/L2-skills/*/; do
  s=$(basename "$d")
  [ -f "$d/SKILL.md" ] || continue
  src="$SKILLS/$s/SKILL.md"
  [ -f "$src" ] || { echo "MISSING  本机没有该技能: $s"; fail=1; continue; }
  cmp -s "$d/SKILL.md" "$src" || { echo "DRIFT    技能内容不一致: $s"; fail=1; }
done

for p in self-recall vision-forward; do
  a="$ROOT/L4-plugins/$p/index.js"; b="${HOME}/dsh-$p/index.js"
  [ -f "$a" ] && [ -f "$b" ] || { echo "MISSING  插件缺文件: $p"; fail=1; continue; }
  # 归一化：把本机的 endpoint 值抹成空串后比对
  # 归一化：抹掉 endpoint 取值与它后面的脱敏注释（仓里有公开说明，本机没有）
  norm() { sed -E 's#(endpoint: )"[^"]*".*#\1""#' "$1"; }
  diff -q <(norm "$a") <(norm "$b") >/dev/null || { echo "DRIFT    插件内容不一致: $p"; fail=1; }
done

[ "$fail" -eq 0 ] && echo "OK 仓库与本机真源一致（技能逐字一致；插件仅允许 endpoint 脱敏差异）"
exit "$fail"
