#!/usr/bin/env bash
# 验证「输出通道黑洞」的判据：诊断写 stdout 会被黑洞吞掉，写 stderr 能存活
set -uo pipefail
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
# ① 诊断写 stdout，stdout 被丢进 /dev/null ⇒ 文件里什么都没有
bash -c 'echo "DATA-only-on-stdout"' >/dev/null 2>"$d/a.err"
[ -s "$d/a.err" ] && { echo "断言失败：stdout 竟然进了 err 文件"; exit 1; }
# ② 诊断写 stderr，stdout 同样被丢 ⇒ stderr 仍在
bash -c 'echo "DIAG-on-stderr" >&2' >/dev/null 2>"$d/b.err"
grep -q 'DIAG-on-stderr' "$d/b.err" || { echo "断言失败：stderr 没被捕获"; exit 1; }
# ③ 两路都重定向（启动器正确做法）⇒ 两条都在
bash -c 'echo OUT; echo ERR >&2' >"$d/c.out" 2>"$d/c.err"
grep -q OUT "$d/c.out" && grep -q ERR "$d/c.err" || { echo "断言失败：双路重定向不全"; exit 1; }
echo "OK 复现成功：stdout 黑洞会吞诊断，stderr 存活；双路重定向后两条都在"
