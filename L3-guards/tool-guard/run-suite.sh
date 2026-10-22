#!/usr/bin/env bash
# 跑守卫全套（不含 snap-gate，那是既有老红）
# 2026-10-22 加 test/unparsable-gate.mjs（不可解析输入闸，10 个文件）。
# 2026-10-22 加 test/static-check-samples.mjs（静态检查分级放行样本，11 个文件）。
# 2026-10-23 加 test/shellcheck-adapter.mjs（shellcheck 接管 bash 语法 + pwsh 显式降级，12 个文件）。
# 2026-10-23 加 test/pwsh-parser.mjs（pwsh 真判据 tree-sitter 动态 import + 缺口1/3/4，13 个文件）。
#   本轮快照回退（原样可粘贴）：
#     cp -p /home/loong/dsh-tool-guard/index.js.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/index.js
#     cp -p /home/loong/dsh-tool-guard/test/run-suite.sh.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/run-suite.sh
#     cp -p /home/loong/dsh-tool-guard/test/shellcheck-adapter.mjs.bak-20261023-pre-pwsh-parser /home/loong/dsh-tool-guard/test/shellcheck-adapter.mjs
#     rm -f /home/loong/dsh-tool-guard/test/pwsh-parser.mjs
#   跑批约定：**不用管道吃 rc**（上一轮 `node ... | tail` 把 rc 吃成 0 ⇒ marker 假阳性）；
#   下面 `out=$(node "$t" 2>&1); rc=$?` 是直接取 rc，管道只用在打印已捕获的变量上。
# 2026-10-22 修：原来 `cd "$(dirname "$0")/.."` 在相对路径调用时会 cd 到父目录，
# 结果一个测试都没跑就打印 GREEN —— 假绿比红更危险，故改用绝对路径解析。
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here" || exit 2
[ -f index.js ] || { echo "run-suite: 不在守卫仓库根（$here）" >&2; exit 2; }
fail=0
ran=0
for t in test/static-check.mjs test/static-check-samples.mjs test/shellcheck-adapter.mjs test/pwsh-parser.mjs test/mask-shapes.mjs test/session-isolation.mjs test/session-scope.mjs test/plan-gate.mjs test/unparsable-gate.mjs test/remote-exec-guards.mjs test/vault-gates.mjs test/gotcha-gate.mjs test/matrix.mjs; do
  if [ ! -f "$t" ]; then printf '%-32s MISSING\n' "$t"; fail=1; continue; fi
  ran=$((ran + 1))
  out=$(node "$t" 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    printf '%-32s OK   %s\n' "$t" "$(printf '%s' "$out" | tail -1)"
  else
    printf '%-32s FAIL\n' "$t"
    printf '%s\n' "$out" | tail -6
    fail=1
  fi
done
echo "--- 跑了 $ran 个测试文件"
[ $fail -eq 0 ] && echo "GUARD SUITE GREEN" || echo "GUARD SUITE RED"
exit $fail
