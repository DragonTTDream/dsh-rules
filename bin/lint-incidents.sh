#!/usr/bin/env bash
# incidents 统一形状检查（模板 templates/incident.md）
#   · 新事故（since >= 2026-10-22）：四小节 + fault_layer 必须齐全，缺即 FAIL
#   · 旧事故（更早/无 since）：只统计为 WARN，不阻塞——历史债可见但不拦 CI
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=${INCIDENTS_DIR:-$ROOT/incidents}
CUTOFF=${INCIDENT_CUTOFF:-2026-10-22}
fail=0; n=0; legacy=0
red() { printf 'FAIL %s\n' "$*"; fail=1; }
for f in "$DIR"/*.md; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  case "$b" in INBOX.md|INDEX.md|_template.md|README.md) continue;; esac
  n=$((n+1))
  since=$(grep -oP '^since:\s*\K\d{4}-\d{2}-\d{2}' "$f" | head -1)
  is_new=0
  [ -n "$since" ] && [[ ! "$since" < "$CUTOFF" ]] && is_new=1
  if [ "$is_new" = 0 ]; then legacy=$((legacy+1)); continue; fi
  grep -qE '^## (现象|症状)' "$f" || red "$b 缺「现象」小节"
  grep -qE '^## (级联路径|取证|关键判断)' "$f" || red "$b 缺「级联路径」小节"
  grep -qE '^## (根因归属|哪层漏了|根因)' "$f" || red "$b 缺「根因归属」小节"
  grep -qE '^## (带走什么|判据|修补|回归)' "$f" || red "$b 缺「带走什么」小节"
  grep -qE '^fault_layer:\s*(harness|model|interaction)' "$f" || red "$b 缺 fault_layer（harness|model|interaction）"
done
[ "$legacy" -gt 0 ] && printf 'WARN 旧事故 %s 篇未按新模板（历史债，不阻塞）\n' "$legacy"
[ "$fail" = 0 ] && echo "OK incidents 形状全绿（$n 篇，其中新模板 $((n-legacy)) 篇）" || echo "INCIDENTS LINT RED"
exit "$fail"
