#!/usr/bin/env bash
# 验证「成功声明不算证据」：造一个假成功脚本，断言它 exit 0、日志说 ok、且没有进程
set -uo pipefail
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
cat > "$d/start.sh" <<'EOS'
#!/usr/bin/env bash
echo "starting" >> task.log
sleeep 60 >/dev/null 2>&1 &
echo "task started ok" >> task.log
EOS
chmod +x "$d/start.sh"
( cd "$d" && ./start.sh ) >/dev/null 2>&1; rc=$?
grep -q 'task started ok' "$d/task.log" || { echo "断言失败：日志没有 ok 行"; exit 1; }
[ "$rc" = 0 ] || { echo "断言失败：exit=$rc"; exit 1; }
if pgrep -x sleeep >/dev/null 2>&1; then echo "断言失败：sleeep 竟然在跑"; exit 1; fi
echo "OK 复现成功：exit 0 + 日志 ok + 无进程 ⇒ 成功声明不可信"
