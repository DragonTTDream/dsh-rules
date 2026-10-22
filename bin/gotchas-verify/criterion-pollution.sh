#!/usr/bin/env bash
# 证明两件事：
#   ① 判据 token 写进被检文件后，报错回显（把源码原样吐出）就能让它"命中"——
#      脚本根本没执行成功，判据却 PASS。
#   ② 判据不落进被检文件（运行时由外部注入）+ 外部量四条，才能可靠收口。
set -u
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
TOK="done-$$-$RANDOM"

# ① 污染形态：判据在源码里，失败退出 + 报错回显 ⇒ 判据照样命中
s="$d/polluted.sh"
printf 'echo "%s"\nexit 1\n' "$TOK" > "$s"
[ "$(grep -c "$TOK" "$s")" -gt 0 ] || { echo "FAIL grep -c 没抓到污染"; exit 1; }
cat "$s" > "$d/echo-back.log"            # 报错回显的等价物
grep -q "$TOK" "$d/echo-back.log" || { echo "FAIL 回显没带出 token"; exit 1; }
[ "$(bash "$s" >/dev/null 2>&1; echo $?)" -ne 0 ] || { echo "FAIL 脚本本该失败"; exit 1; }

# ② 正解形态：token 不写进被检脚本，外部量四条全过才算 PASS
s2="$d/clean.sh"; out="$d/produced.log"
printf 'printf "%%s\\n" "$1" > "$2"\n' > "$s2"
[ "$(grep -c "$TOK" "$s2")" -eq 0 ] || { echo "FAIL token 出现在被检脚本里"; exit 1; }
sleep 1
bash "$s2" "$TOK" "$out"; rc=$?
if [ "$rc" -eq 0 ] && [ -f "$out" ] \
   && [ "$(stat -c %Y "$out")" -gt "$(stat -c %Y "$s2")" ] \
   && grep -q "$TOK" "$out"; then
  echo "OK 判据与被检对象解耦后，四条外部量成立"
else
  echo "FAIL 外部量判据不成立 rc=$rc"; exit 1
fi
