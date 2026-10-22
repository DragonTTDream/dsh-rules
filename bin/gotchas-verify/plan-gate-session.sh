#!/usr/bin/env bash
# 验证「计划门跨会话」：别的会话的 draft 不拦本会话（回归用例）
set -uo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root/L3-guards/tool-guard" || exit 1
out=$(node test/plan-gate.mjs 2>&1); rc=$?
echo "$out" | grep -q 'PLAN-GATE GREEN' || { echo "断言失败：$out" | tail -3; exit 1; }
[ "$rc" = 0 ] || exit 1
echo "OK 回归通过：跨会话不拦 + 本会话 draft 仍拦"
