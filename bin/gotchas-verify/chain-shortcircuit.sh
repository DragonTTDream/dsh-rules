#!/usr/bin/env bash
# 证明两件事：
#   ① `A && B` 只传递退出码，不传递"实物是否到位"——上游失败时下游被静默跳过，
#      终端里没有错误行，整条链的最终退出码反映的是**第一个失败步**。
#   ② 每步显式判据能在当场指名是"源缺失"还是"搬运失败"。
set -u
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
src="$d/missing.bin"      # 等价于"源路径凭记忆写错"：源不存在
dst="$d/dst.bin"

# ① 坑的形态：短路让下游的"成功回显"整体消失，没人知道搬没搬
out=$( cp "$src" "$dst" 2>/dev/null && echo "REGISTERED OK" )
[ -z "$out" ] || { echo "FAIL 短路没有跳过下游"; exit 1; }
[ ! -e "$dst" ] || { echo "FAIL 目标不该存在"; exit 1; }

# ② 正解形态：显式判据当场指名失败步
msg=$( [ -f "$src" ] || echo "SRC MISSING: $src" )
case "$msg" in
  *"SRC MISSING"*) echo "OK 短路会吞掉失败；显式判据能当场指名";;
  *) echo "FAIL 正解没报出源缺失"; exit 1;;
esac
