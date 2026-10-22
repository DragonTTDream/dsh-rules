#!/usr/bin/env bash
# 验证「毫秒级退出」= 命令不存在：exit 127 而不是崩溃
set -uo pipefail
bash -c 'definitely_not_a_cmd_xyz' >/dev/null 2>&1; rc=$?
[ "$rc" = 127 ] || { echo "断言失败：exit=$rc（期望 127）"; exit 1; }
echo "OK 复现成功：不存在的命令 exit=127 ⇒ 秒退零输出优先查启动失败"
