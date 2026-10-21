#!/usr/bin/env bash
# 生成事故反向索引：一条事故 → 它催生/强化了哪些规则。写进 incidents/INDEX.md。
# 用法: bin/index.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/incidents/INDEX.md"

{
  echo "# 事故 → 规则 反向索引"
  echo
  echo "> 由 \`bin/index.sh\` 生成，**不要手改**。正向引用看各规则的 \`evidence:\` 字段。"
  echo
  echo "| 事故 | 日期 | 状态 | 覆盖/催生的规则 |"
  echo "|---|---|---|---|"
  for f in "$ROOT"/incidents/INC-*.md; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .md)
    date=$(awk -F': *' '/^date:/{print $2; exit}' "$f")
    st=$(awk -F': *' '/^status:/{print $2; exit}' "$f")
    rules=$(awk -F'[][]' '/^rules:/{print $2; exit}' "$f" | tr -d ' ' | sed 's/,/、/g')
    echo "| [$id]($id.md) | ${date:-?} | ${st:-?} | ${rules:-—} |"
  done
  echo
  echo "## 反向查：某条规则由哪些事故支撑"
  echo
  for r in $(ls "$ROOT"/L0-always-on/R-*.md | xargs -n1 basename | sed 's/\.md$//' | cut -d- -f1-2); do
    ev=$(awk -F': *' '/^evidence:/{print $2; exit}' "$ROOT/L0-always-on/$r"-*.md 2>/dev/null || true)
    echo "- **$r** ← ${ev##*/}"
  done
} > "$OUT"
echo "已生成: ${OUT#$ROOT/}（$(grep -c '^| \[' "$OUT") 条事故）"
