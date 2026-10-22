#!/usr/bin/env bash
# static-verdict.sh —— 给静态检查台账的一条命中标「误报 / 属实」
#
# 用法：
#   bin/static-verdict.sh <台账行号N> <fp|true> [备注]
#   bin/static-verdict.sh --ledger <路径> <台账行号N> <fp|true> [备注]   # 指到临时台账自测用
#     N    = 命中行号（bin/static-stats.sh 报的就是这个行号；从 1 数，只数命中行）
#     fp   = 误报（false positive）⇒ 进 precision 的分母，是收窄规则的依据
#     true = 属实（真错，拦得对）⇒ 进 precision 的分子
#     备注 = fp 必填（没有备注的 fp 无从复盘）；true 可省
#
# 只追加，不改原行：往台账尾部写一行
#   {"kind":"verdict","ref":N,"verdict":"fp|true","note":"…","ts":"…"}
# 原行的 verdict 字段保持 "unreviewed" —— 历史行不许改写，统计口径才稳定。
#
# 台账路径：--ledger > $GUARD_STATIC_LOG（守卫测试用）> ~/.dsh/static-check.jsonl（固定，与守卫一致）
# 失效症状：标完 stats 里 fp/true 不涨 ⇒ 多半 ref 越界（N 大于命中行数）；本脚本会直接拒绝并说明。
set -uo pipefail

LEDGER="${GUARD_STATIC_LOG:-$HOME/.dsh/static-check.jsonl}"
if [ "${1:-}" = "--ledger" ]; then LEDGER="${2:?--ledger 后面要给路径}"; shift 2; fi

if [ $# -lt 2 ]; then
  echo "用法: $0 <台账行号N> <fp|true> [备注]   （台账: $LEDGER）" >&2
  exit 2
fi
ref="$1"; verdict="$2"; note="${3:-}"

case "$ref" in ''|*[!0-9]*) echo "行号必须是正整数，收到: '$ref'" >&2; exit 2 ;; esac
case "$verdict" in fp|true) : ;; *) echo "verdict 只能是 fp 或 true，收到: '$verdict'" >&2; exit 2 ;; esac
if [ "$verdict" = "fp" ] && [ "${#note}" -lt 3 ]; then
  echo "fp 必须写备注（≥3 字）：没有备注的误报标记事后没法复盘" >&2
  exit 2
fi
[ -f "$LEDGER" ] || { echo "台账不存在: $LEDGER（守卫没命中过就没有台账）" >&2; exit 1; }

# 命中行 = 既不是 verdict 行也不是 exempt 行的行（这两类是控制行，不占命中行号）
hits=$(awk 'index($0,"\"kind\":\"verdict\"")==0 && index($0,"\"kind\":\"exempt\"")==0 {n++} END{print n+0}' "$LEDGER")
if [ "$ref" -gt "$hits" ]; then
  echo "台账只有 $hits 条命中行，ref=$ref 越界 ⇒ 不写（越界标记会静默失效，宁可拒绝）" >&2
  exit 1
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
note_clean=$(printf '%s' "$note" | tr -d '\n"\\')
row=$(printf '{"kind":"verdict","ref":%s,"verdict":"%s","note":"%s","ts":"%s"}' "$ref" "$verdict" "$note_clean" "$ts")
printf '%s\n' "$row" >> "$LEDGER"

echo "已追加标记（原行 $ref 不动，其 verdict 字段保持 unreviewed）："
echo "  $row"
echo "台账: $LEDGER  命中行数=$hits  复核进度见 bin/static-stats.sh"
