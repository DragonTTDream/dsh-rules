#!/usr/bin/env bash
# 外部对拍闸门（无模型参与）。红了即非零退出。
# 用法: CODE_LANE_BENCH=<工作台> lane-check.sh <对拍命令...>
set -uo pipefail
BENCH="${CODE_LANE_BENCH:-}"
if [ -z "$BENCH" ] || [ ! -x "$BENCH/bin/check.sh" ]; then
  echo "code-edit-lane: 缺 CODE_LANE_BENCH（指向代码 lane 工作台目录）；位置查工作区档。" >&2
  exit 2
fi
exec bash "$BENCH/bin/check.sh" "$@"
