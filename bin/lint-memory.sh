#!/usr/bin/env bash
# 热档（MEMORY.md）位置与体积检查
#   bash bin/lint-memory.sh [目标目录]      默认 = 本仓上一级（Harnessworks）
#
# 原则（用户口径）：每个热档都该在自己项目的专属目录里；跨项目根不许有热档。
#
# 规则：
#   ① 跨项目根（原则化判定）：TARGET/MEMORY.md 存在，且 TARGET 下**≥2 个子目录各自也有热档**
#      ⇒ TARGET 只是若干独立项目的共同父目录 ⇒ FAIL。
#   ② 合法性：该目录含 README.md / AGENTS.md 或有子目录 ⇒ 算工作区/项目根；什么都没有 ⇒ WARN。
#   ③ 体积闸门：≤15 KB / ≤200 行，超了 WARN 并给倍数（只报，不改别人的文件）。
#   ④ 父子两层都有热档 ⇒ WARN（可能工作区 + 项目各自一份，需人确认）。
set -uo pipefail
TARGET=${1:-$(cd "$(dirname "$0")/.." && pwd)/..}
MAXB=${MEMORY_MAX_BYTES:-15360}; MAXL=${MEMORY_MAX_LINES:-200}
fail=0; warn=0
red() { printf 'FAIL %s\n' "$*"; fail=1; }
wrn() { printf 'WARN %s\n' "$*"; warn=1; }
list() { find "$TARGET" -maxdepth 4 -name 'MEMORY.md' -not -path '*/node_modules/*' 2>/dev/null | sort; }

# ① 跨项目根
if [ -f "$TARGET/MEMORY.md" ]; then
  subs=0
  while IFS= read -r f; do
    [ "$(dirname "$f")" = "$TARGET" ] || subs=$((subs+1))
  done < <(list)
  [ "$subs" -ge 2 ] && red "$TARGET/MEMORY.md 在跨项目根（下面 $subs 个目录各自带热档）——热档必须在被服务项目内"
fi

# ②③ 逐个热档
while IFS= read -r f; do
  d=$(dirname "$f")
  has_doc=0
  [ -f "$d/README.md" ] || [ -f "$d/AGENTS.md" ] && has_doc=1
  has_sub=$(find "$d" -maxdepth 1 -mindepth 1 -type d ! -name '.*' -print -quit 2>/dev/null)
  if [ "$has_doc" = 0 ] && [ -z "$has_sub" ]; then
    wrn "$f 所在目录既无 README/AGENTS 也无子目录（无法判定服务对象）"
  fi
  b=$(stat -c%s "$f"); l=$(wc -l < "$f")
  [ "$b" -le "$MAXB" ] || wrn "$f ${b} 字节，超闸门 ${MAXB}（$(awk "BEGIN{printf \"%.1f\", $b/$MAXB}") 倍）"
  [ "$l" -le "$MAXL" ] || wrn "$f ${l} 行，超闸门 ${MAXL}"
done < <(list)

# ④ 父子两层都有
while IFS= read -r f; do
  up=$(dirname "$(dirname "$f")")
  [ -f "$up/MEMORY.md" ] && wrn "两层都有热档：$up/MEMORY.md 与 $f（确认是否故意：工作区 + 项目）"
done < <(list)

if [ "$fail" = 0 ]; then
  [ "$warn" = 0 ] && echo "OK 热档位置/体积全绿（$TARGET）" || echo "OK 无硬错（有 WARN，见上）"
else
  echo "MEMORY LINT RED"
fi
exit "$fail"
