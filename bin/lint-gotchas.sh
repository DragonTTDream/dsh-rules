#!/usr/bin/env bash
# 经验库写法规格的可执行检查（对应 经验库/写法规格.md 与 防复发规格.md）
#
#   bash bin/lint-gotchas.sh            只检查，不改文件
#   bash bin/lint-gotchas.sh --refresh  对每条执行 verify_cmd；通过则把 verified_at 盖成当天
#
# 设计依据（社区）：
#   - runbook 时间戳放 front matter 让 CI 读（datadef.io / borghei staleness 脚本）
#   - "verified" 的定义是**真的执行过**，不是读过（review = verify）
#   - 跑得起来才算数（executable documentation）
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=${GOTCHAS_DIR:-$ROOT/经验库}
REFRESH=0
[ "${1:-}" = "--refresh" ] && REFRESH=1
TODAY=$(date +%F)
fail=0
red() { printf 'FAIL %s\n' "$*"; fail=1; }

for f in "$DIR"/*.md; do
  b=$(basename "$f")
  case "$b" in INDEX.md|README.md|写法规格.md|防复发规格.md) continue;; esac

  # ① 五段齐全
  for sec in 症状 判据 正解 反例 边界; do
    grep -qE "^## .*${sec}" "$f" || red "$b 缺「${sec}」段"
  done

  # ② 时间戳三件套
  va=$(grep -oP '^verified_at:\s*\K\d{4}-\d{2}-\d{2}' "$f" | head -1)
  vc=$(grep -oP '^verify_cmd:\s*\K.*' "$f" | head -1)
  sla=$(grep -oP '^verify_sla_days:\s*\K\d+' "$f" | head -1); sla=${sla:-90}
  [ -n "$va" ] || red "$b 缺 verified_at（YYYY-MM-DD）"
  [ -n "$vc" ] || red "$b 缺 verify_cmd（验不了的写 skip 并注明原因）"
  fl=$(grep -oP '^fault_layer:\s*\K\w+' "$f" | head -1)
  case "$fl" in model|harness|interaction) ;; *) red "$b 缺或错的 fault_layer（model|harness|interaction）";; esac
  grep -q '^fault_why:' "$f" || red "$b 缺 fault_why（一句话说明该在哪层修）"
  grep -qE '^strength:\s*(must|should|never)' "$f" || red "$b 缺 strength（must|should|never）"

  # ③ 过期判定（review = verify；过 SLA 即降级）
  if [ -n "$va" ]; then
    days=$(( ( $(date -d "$TODAY" +%s) - $(date -d "$va" +%s) ) / 86400 ))
    [ "$days" -gt "$sla" ] && red "$b verified_at 已过 ${days} 天（SLA ${sla} 天）"
  fi

  # ④ 去标识化
  grep -qE '/home/[a-z]|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|127\.0\.0\.1:[0-9]+' "$f" \
    && red "$b 含本机路径或 IP（写法规格第 10 条）"

  # ⑤ 长度预算：单条 <2000 token（粗估 字符数÷3）
  t=$(python3 -c 'import sys;print(len(open(sys.argv[1],encoding="utf-8").read())//3)' "$f")
  [ "$t" -le 2000 ] || red "$b 约 ${t} token，超过 2000 上限"

  # ⑥ --refresh：执行 verify_cmd，通过则盖当天日期
  if [ "$REFRESH" = 1 ] && [ -n "$vc" ] && [ "$vc" != "skip" ]; then
    if ( cd "$ROOT" && bash -c "$vc" ) >/dev/null 2>&1; then
      if [ "$va" != "$TODAY" ]; then
        sed -i "s/^verified_at:.*/verified_at: ${TODAY}/" "$f"
        echo "REFRESH $b → $TODAY"
      fi
    else
      red "$b verify_cmd 执行失败：$vc"
    fi
  fi
done

# ⑦ 条目总数上限（防膨胀硬指标）
total=$(ls "$DIR"/*.md | grep -vcE 'INDEX|README|写法规格|防复发规格')
[ "$total" -le 20 ] || red "条目数 ${total} 超过 active 上限 20（按防复发规格第六节要合并/下沉/删除）"

# ⑧ INDEX 的「按归属层看」统计必须与文件实际一致
idx="$DIR/INDEX.md"
if [ -f "$idx" ]; then
  for layer in model harness interaction; do
    actual=$(grep -l "^fault_layer: $layer" "$DIR"/*.md 2>/dev/null | grep -vcE 'INDEX|README|写法规格|防复发规格' || true)
    claimed=$(awk '/^## 按归属层看/{f=1} f' "$idx" | grep -oP "\| \`$layer\` \| \K\d+" | head -1)
    if [ -n "$claimed" ] && [ "$claimed" != "$actual" ]; then
      red "INDEX 归属统计不一致：$layer 声称 ${claimed}，实际 ${actual}"
    fi
  done
fi

if [ "$fail" = 0 ]; then
  echo "OK 经验库规格检查全绿（$(ls "$DIR"/*.md | wc -l) 个文件，条目 $total 条）"
else
  echo "GOTCHAS LINT RED"
fi
exit "$fail"
