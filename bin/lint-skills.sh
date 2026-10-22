#!/usr/bin/env bash
# L2 技能 frontmatter 合规（借 anthropics/skills 的结构）
#   ① name / description / whenToUse 三件齐全
#   ② description ≤ 200 字（目录注入预算）
#   ③ 正文 ≤ 2000 token（粗估 字符数÷3）
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=${SKILLS_DIR:-$ROOT/L2-skills}
fail=0
red() { printf 'FAIL %s\n' "$*"; fail=1; }
count=0
for f in "$DIR"/*/SKILL.md; do
  [ -f "$f" ] || continue
  count=$((count+1))
  n=$(basename "$(dirname "$f")")
  for k in name description whenToUse; do
    grep -qE "^${k}:" "$f" || red "$n 缺 frontmatter 键 $k"
  done
  desc=$(grep -oP '^description:\s*\K.*' "$f" | head -1 | sed 's/^["'\'']//; s/["'\'']$//')
  dlen=$(printf '%s' "$desc" | wc -m)
  [ "$dlen" -le 200 ] || red "$n description ${dlen} 字，超过 200（目录注入预算）"
  body=$(awk 'BEGIN{fm=0} /^---$/{fm++; next} fm>=2{print}' "$f")
  tok=$(( $(printf '%s' "$body" | wc -m) / 3 ))
  [ "$tok" -le 2000 ] || red "$n 正文约 ${tok} token，超过 2000 上限"
done
[ "$fail" = 0 ] && echo "OK 技能 frontmatter 全绿（$count 个）" || echo "SKILL LINT RED"
exit "$fail"
