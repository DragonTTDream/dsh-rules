#!/usr/bin/env bash
# 规则冲突检测。只做**机械可判**的三类，不猜语义（猜语义=假阳性噪音）。
#
#   ① 声明对称：A 的 conflicts_with 含 B ⇒ B 必须含 A，且两边都要有 resolution
#   ② 重复：title 相同，或 judge 完全相同
#   ③ 同源：同一条 evidence 被 ≥3 条规则引用（可能是应该合并的一组）
#
# 用法: bin/conflict-check.sh     退出码 0=无冲突 1=有问题
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0; warn=0
field() { awk -F': *' -v k="$1" '$0 ~ "^"k":" {print $2; exit}' "$2"; }

declare -A OWN RES
for f in L0-always-on/R-*.md; do
  [ -f "$f" ] || continue
  id=$(basename "$f" .md | cut -d- -f1-2)
  OWN[$id]=$(field conflicts_with "$f")
  RES[$id]=$(field resolution "$f")
done

echo "=== ① 声明对称性 ==="
for id in "${!OWN[@]}"; do
  [ -n "${OWN[$id]:-}" ] || continue
  [ -n "${RES[$id]:-}" ] || { echo "FAIL $id: 声明了 conflicts_with 但没有 resolution"; fail=1; }
  for other in $(echo "${OWN[$id]}" | tr -d '[]' | tr ',' ' '); do
    [ -n "$other" ] || continue
    if ! echo "${OWN[$other]:-}" | grep -q "$id"; then
      echo "FAIL $id ↔ $other: 单向声明（$other 未声明冲突）"; fail=1
    else echo "OK   $id ↔ $other 双向声明，分辨率已写"; fi
  done
done
[ -s /dev/null ] 2>/dev/null || true

echo "=== ② 重复检查 ==="
dupt=$(grep -h '^title:' L0-always-on/R-*.md | sort | uniq -d)
[ -z "$dupt" ] && echo "OK   title 无重复" || { echo "FAIL title 重复: $dupt"; fail=1; }
dupj=$(grep -h '^judge:' L0-always-on/R-*.md | sort | uniq -d)
[ -z "$dupj" ] && echo "OK   judge 无重复" || { echo "FAIL judge 完全相同: $dupj"; fail=1; }

echo "=== ③ 同源检查（同一 evidence 被 ≥3 条引用）==="
multi=$(grep -h '^evidence:' L0-always-on/R-*.md | sed 's/^evidence: *//' | sort | uniq -c | grep -v INBOX | awk '$1>=3')
if [ -z "$multi" ]; then echo "OK   没有 3 条以上规则共用同一事故"; else
  echo "WARN 以下事故支撑了 3 条以上规则，考虑合并规则而不是合并证据："; echo "$multi"; warn=1; fi

[ "$fail" -eq 0 ] && echo -e "\n结论：无冲突（WARN $warn 项）"
exit "$fail"
