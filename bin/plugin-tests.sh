#!/usr/bin/env bash
# 插件测试总闸：改插件前后都跑；任何一项红 ⇒ 不许重启、不许部署。
# 2026-10-22 建立：execute 漏绑参数（ReferenceError）在语法检查与纯函数单测下全绿，只有真跑才暴露。
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
status=0
run() {
  local name=$1; shift
  printf '%-30s ' "$name"
  if "$@" >"/tmp/plugin-test-${name//\//_}.log" 2>&1; then
    tail -1 "/tmp/plugin-test-${name//\//_}.log"
  else
    tail -1 "/tmp/plugin-test-${name//\//_}.log"
    echo "   ↑ 失败，详见 /tmp/plugin-test-${name//\//_}.log"
    status=1
  fi
}
for t in "$HOME"/dsh-self-recall/test/*.mjs; do run "self-recall/$(basename "$t" .mjs)" node "$t"; done
for t in "$ROOT"/L3-guards/tool-guard/test/*.mjs; do run "guard/$(basename "$t" .mjs)" node "$t"; done
echo
[ "$status" -eq 0 ] && echo "PLUGIN TESTS GREEN" || echo "PLUGIN TESTS RED"
exit $status
