#!/usr/bin/env bash
# 代码 lane 在**窗口内**执行的命令 —— 由 DSH 用 arbitrate_run 提交（它持有回合等到 marker）：
#   同模型：arbitrate_run(script="CODE_LANE_BENCH=<工作台> bash <本脚本> clone-worker <prompt>", unload=false, warm=false)
#   异模型 / 无模型重活：同一条 script，unload=true, warm=true
#   ⛔ 不要用 run_in_background / & 提交：工具一返回主会话就继续生成，会与 worker 抢同一条推理序列。
# 工作台目录由 CODE_LANE_BENCH 提供（本机事实不写进技能；位置查工作区档）。
# 用法: CODE_LANE_BENCH=<工作台> lane-run.sh [--model <provider>/<id>] [--no-prewarm] [--allow-swap] <agent名> <prompt文件>
set -uo pipefail
BENCH="${CODE_LANE_BENCH:-}"
if [ -z "$BENCH" ] || [ ! -x "$BENCH/bin/run-worker.sh" ]; then
  echo "code-edit-lane: 缺 CODE_LANE_BENCH（指向代码 lane 工作台目录）；位置查工作区档。" >&2
  echo "marker=bench-missing"
  exit 0
fi
exec bash "$BENCH/bin/run-worker.sh" "$@"
